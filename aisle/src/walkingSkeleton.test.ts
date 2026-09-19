/**
 * Walking skeleton (06 "Integration", 01 §12 mock mode): the whole graph wired the
 * way App.tsx / composeApp does it, with D's mocks replaying fixtures/track.json and
 * fixtures/perception under Jest fake timers, and the real TransitionDetector,
 * CrossingController, LegRunner and indoor controller bound. Nothing is stubbed
 * below the platform edge: speech and haptics are A's real services over fake
 * expo backends, exactly as in mock mode on the phone.
 *
 * "Max speed" here means fake timers: ~250 s of replay wall clock is advanced in
 * milliseconds. The harness stays at 1x so every wall-clock rule in the tracks
 * (speech pacing, curb dwell, transition debounce, the 3 s TRANSITION cap) sees the
 * fixture at the pace it was authored for.
 *
 * Run 1 drives one trip from ITEM_REQUESTED with only the inputs 01 §1 gives the
 * user: "next" at the item (AT_ITEM → CHECKOUT_NAV). The one place the fixtures are
 * behind the spec — `indoor-aisle-walk` carries no CHECKOUT sign — is bridged by the
 * DebugPanel's event injection (01 §5: mock mode may emit any event) and pinned by a
 * `test.failing` in the 'known gaps' block, so the suite stays green and flips loudly
 * when C/D close it. Run 2 replays the stale-WALK pack at the curb.
 *
 * `SKELETON_TRACE=1 npm test -- walkingSkeleton` prints each run's timeline.
 */
import demoStore from '../fixtures/stores/demo-store-01.json';
import { bridgeAppStore, createMockServices, type MockServices } from '../mocks';
import { track } from '../mocks/fixtures';
import type { AudioChannelBackend } from './core/audio';
import { createEventBus, type AppEventBus, type BusRecord } from './core/bus';
import { composeApp, type AppComposition, type AppPlatform } from './core/composeApp';
import { TRANSITION_CAP_MS } from './core/config';
import type { AppEvent, AppMode, HapticPattern, SpeechRequest } from './core/contracts';
import { LONG_PHRASE_ALLOWLIST, MAX_UTTERANCE_WORDS, PHRASES, countWords, findForbiddenTerm, hasDigit } from './core/phrases';
import { createMemoryPrefsStorage, serializePrefs } from './core/prefs';
import { services } from './core/services';
import type { SpeechBackend } from './core/speech';
import { bindStoreToBus, createAppStore, type AppStore } from './core/store';
import { CURB_STILL_MS } from './crossing/crossingLogic';
import { createOutdoorStore } from './outdoor/store';

const T0 = 1_700_000_000_000;
const CONFIG = { proxyUrl: 'http://proxy.test:8787', proxyWs: 'ws://proxy.test:8787/ws', mock: true };
const STEP_MS = 250;

/** Timing anchors from the fixture itself (fixtures/README.md "The track"). */
const META = track.meta as typeof track.meta & { expectedTransitionWindowS?: [number, number] };
const CURB = META!.curb!;
const DOOR_S = META!.door.t;
const STEP_OFF_S = CURB.arriveT + CURB.dwellS;
const [FUSE_MIN_S, FUSE_MAX_S] = META?.expectedTransitionWindowS ?? [5, 15];
const TRACK_END_S = track.samples[track.samples.length - 1]!.t;

/** 01 §1, the demo path: returning user (no ONBOARDING), one crossing, no ITEM_PICKUP beat. */
const EXPECTED_MODES: readonly AppMode[] = [
  'IDLE', 'OUTDOOR_NAV', 'APPROACH_CROSSING', 'AT_CURB', 'CROSSING', 'OUTDOOR_NAV',
  'TRANSITION', 'INDOOR_NAV', 'AT_ITEM', 'CHECKOUT_NAV', 'DONE',
];
const CROSSING_PHASE: ReadonlySet<AppMode> = new Set<AppMode>(['APPROACH_CROSSING', 'AT_CURB', 'CROSSING']);

// ---------------------------------------------------------------------------
// Platform edge: A's fake expo backends (same shape as composeApp.test.ts).
// ---------------------------------------------------------------------------

interface FakePlatform extends AppPlatform {
  /** What the speech backend actually played (expo-speech fallback: nothing is cached in this checkout). */
  spoken: string[];
  impacts: number;
  fetchSpy: jest.Mock;
}

function fakePlatform(): FakePlatform {
  const spoken: string[] = [];
  const player = () => ({ play: () => undefined, stop: () => undefined, dispose: () => undefined });
  const speechBackend: SpeechBackend = {
    hasCached: () => false,
    playCached: () => null,
    playFile: () => null,
    playUrl: () => null,
    speak(text, _rate, onDone) {
      spoken.push(text);
      const t = setTimeout(onDone, 300);
      return { backend: 'expo-speech', stop: () => clearTimeout(t) };
    },
    synthesize: async () => null,
    streamUrl: (id) => `stream/${id}`,
  };
  const audioBackend: AudioChannelBackend = { beaconLeft: player(), beaconRight: player(), tick: player(), setAudioMode: async () => undefined };
  const fetchSpy = jest.fn(async () => {
    throw new TypeError('Network request failed');
  });
  const p: FakePlatform = {
    spoken,
    impacts: 0,
    fetchSpy,
    hapticBackend: {
      impact: () => {
        p.impacts += 1;
      },
      notificationError: () => undefined,
    },
    speechBackend,
    audioBackend,
    fetchImpl: fetchSpy as unknown as typeof fetch,
  };
  return p;
}

// ---------------------------------------------------------------------------
// The skeleton: composeApp in mock mode plus recorders on every seam we assert on.
// ---------------------------------------------------------------------------

interface ModeStep { mode: AppMode; atS: number }
interface SaidRecord extends SpeechRequest { mode: AppMode; atS: number }
interface HapticSample { pattern: HapticPattern | null; patternAt: number | null; now: number; mode: AppMode; atS: number }

interface Skeleton {
  app: AppComposition;
  bus: AppEventBus;
  store: AppStore;
  mocks: MockServices;
  platform: FakePlatform;
  warn: jest.Mock;
  modes: ModeStep[];
  /** Every say() from every track, recorded before A's queue decides what plays. */
  said: SaidRecord[];
  events: BusRecord[];
  /** Haptic debug state sampled synchronously inside each VEHICLE_APPROACHING dispatch. */
  vehicleHaptics: HapticSample[];
  globalFetch: jest.Mock;
  globalWs: jest.Mock;
  replayS(): number;
  /** Advance fake time in STEP_MS slices until `pred` holds or `maxMs` elapsed. */
  until(pred: () => boolean, maxMs: number): Promise<boolean>;
  advance(ms: number): Promise<void>;
  dispose(): void;
}

async function buildSkeleton(): Promise<Skeleton> {
  const globalFetch = jest.fn(async () => {
    throw new TypeError('Network request failed');
  });
  const globalWs = jest.fn(function WebSocketStub() {
    throw new Error('WebSocket must not be constructed in mock mode');
  });
  const g = globalThis as unknown as { fetch?: unknown; WebSocket?: unknown };
  const prevFetch = g.fetch;
  const prevWs = g.WebSocket;
  g.fetch = globalFetch;
  g.WebSocket = globalWs;

  const bus = createEventBus({ historySize: 500 });
  const warn = jest.fn();
  const store = createAppStore({ bus, warn });
  const unbind = bindStoreToBus(store, bus);
  const mocks = createMockServices({ bus, store: bridgeAppStore(store), latencyScale: 0 });
  const platform = fakePlatform();
  platform.prefsStorage = createMemoryPrefsStorage(serializePrefs({ firstRun: false, trainingMode: false, speechRate: 1, bodyOffsetDeg: 0 }));
  const outdoor = createOutdoorStore();
  const app = composeApp({ config: CONFIG, bus, store, platform, mocks, fixtureTrack: track, loadStoreMap: () => demoStore, outdoor });

  const replayS = (): number => Math.round(mocks.harness.getTimeS() * 10) / 10;
  const modes: ModeStep[] = [{ mode: store.getState().mode, atS: 0 }];
  const unsubMode = store.subscribe((s, prev) => {
    if (s.mode !== prev.mode) modes.push({ mode: s.mode, atS: replayS() });
  });

  const said: SaidRecord[] = [];
  const realSay = app.speech.say.bind(app.speech);
  app.speech.say = (req: SpeechRequest): void => {
    said.push({ ...req, mode: store.getState().mode, atS: replayS() });
    realSay(req);
  };

  const events: BusRecord[] = [];
  const unsubAny = bus.onAny((r) => events.push(r));
  const vehicleHaptics: HapticSample[] = [];
  const unsubVehicle = bus.on('VEHICLE_APPROACHING', () => {
    const d = app.haptics.getDebugState();
    vehicleHaptics.push({ pattern: d.lastPattern, patternAt: d.lastPatternAt, now: Date.now(), mode: store.getState().mode, atS: replayS() });
  });

  await app.start();

  const advance = async (ms: number): Promise<void> => {
    await jest.advanceTimersByTimeAsync(ms);
  };
  const until = async (pred: () => boolean, maxMs: number): Promise<boolean> => {
    let elapsed = 0;
    while (!pred() && elapsed < maxMs) {
      await advance(STEP_MS);
      elapsed += STEP_MS;
    }
    return pred();
  };

  return {
    app, bus, store, mocks, platform, warn, modes, said, events, vehicleHaptics, globalFetch, globalWs, replayS, until, advance,
    dispose() {
      unsubVehicle();
      unsubAny();
      unsubMode();
      app.dispose();
      unbind();
      g.fetch = prevFetch;
      g.WebSocket = prevWs;
    },
  };
}

const modeSeen = (sk: Skeleton, m: AppMode): boolean => sk.modes.some((s) => s.mode === m);
const modeList = (sk: Skeleton): AppMode[] => sk.modes.map((s) => s.mode);
const modeAt = (sk: Skeleton, m: AppMode, nth = 0): number => sk.modes.filter((s) => s.mode === m)[nth]!.atS;
const count = (sk: Skeleton, type: AppEvent['type']): number => sk.events.filter((r) => r.event.type === type).length;
const firstEvent = <T extends AppEvent['type']>(sk: Skeleton, type: T): Extract<AppEvent, { type: T }> | undefined =>
  sk.events.find((r) => r.event.type === type)?.event as Extract<AppEvent, { type: T }> | undefined;
const eventAtS = (sk: Skeleton, type: AppEvent['type']): number => {
  const r = sk.events.find((x) => x.event.type === type);
  return r ? Math.round(((r.ts - T0) / 1000) * 10) / 10 : Number.NaN;
};
const saidKeys = (sk: Skeleton): string[] => sk.said.map((s) => s.cacheKey ?? `text:${s.text}`);

/** 01 §3 utterance rule, applied to one text. `disclaimer` is the only long-phrase exemption. */
function utteranceViolations(text: string, cacheKey?: string): string[] {
  const out: string[] = [];
  const exemptLong = cacheKey !== undefined && LONG_PHRASE_ALLOWLIST.has(cacheKey);
  if (!exemptLong && countWords(text) > MAX_UTTERANCE_WORDS) out.push(`${countWords(text)} words`);
  if (!exemptLong && hasDigit(text)) out.push('digit');
  const term = findForbiddenTerm(text);
  if (term) out.push(`forbidden "${term}"`);
  return out;
}

function expectUtterancesClean(sk: Skeleton): void {
  const bad = sk.said
    .map((s) => ({ text: s.text, key: s.cacheKey, v: utteranceViolations(s.text, s.cacheKey) }))
    .filter((x) => x.v.length > 0);
  expect(bad).toEqual([]);
  const badSpoken = sk.platform.spoken.filter((t) => utteranceViolations(t).length > 0);
  expect(badSpoken).toEqual([]);
  expect(sk.said.length).toBeGreaterThan(0);
  expect(sk.platform.spoken.length).toBeGreaterThan(0);
}

function expectNoNetwork(sk: Skeleton): void {
  expect(sk.platform.fetchSpy).not.toHaveBeenCalled();
  expect(sk.globalFetch).not.toHaveBeenCalled();
  expect(sk.globalWs).not.toHaveBeenCalled();
  expect(sk.app.wsTransport).toBeNull();
}

function expectNoIllegalTransitions(sk: Skeleton): void {
  expect(sk.store.getState().illegalTransitions).toBe(0);
  expect(sk.warn).not.toHaveBeenCalled();
  expect(sk.events.filter((r) => r.event.type === 'ERROR' && (r.event as { scope: string }).scope === 'store')).toEqual([]);
  expect(sk.app.metrics.illegalTransitions).toBe(0);
}

/** `SKELETON_TRACE=1 npm test -- walkingSkeleton` prints each run's timeline (integration-day aid). */
function dumpTrace(label: string, sk: Skeleton, extra: Record<string, unknown> = {}): void {
  if (!process.env.SKELETON_TRACE) return;
  const err = (r: BusRecord): string => (r.event.type === 'ERROR' ? ` ${(r.event as { scope: string; message: string }).scope}: ${(r.event as { message: string }).message}` : '');
  // eslint-disable-next-line no-console
  console.log(`[skeleton] ${label}\n` + JSON.stringify({
    modes: sk.modes.map((m) => `${m.atS}s ${m.mode}`),
    said: sk.said.map((x) => `${x.atS}s ${x.mode} [${x.priority}] ${x.cacheKey ?? '-'}: ${x.text}`),
    spoken: sk.platform.spoken,
    events: sk.events.map((r) => `${Math.round((r.ts - T0) / 100) / 10}s ${r.event.type}${err(r)}`).filter((t, i, a) => !/SIGNAL_STATE$/.test(t) || !/SIGNAL_STATE$/.test(a[i - 1] ?? '')),
    vehicleHaptics: sk.vehicleHaptics,
    illegal: sk.store.getState().illegalTransitions,
    speech: sk.app.speech.getStats(),
    trip: sk.app.trip.getDebugState(),
    perception: sk.mocks.perception.debug(),
    ...extra,
  }, null, 1));
}

// ---------------------------------------------------------------------------
// Run 1: one trip off the fixtures.
// ---------------------------------------------------------------------------

interface TripLog {
  nextFromItemAtS: number | null;
  /** CHECKOUT_REACHED count before the test injected one (the pack has no CHECKOUT sign). */
  checkoutFromPack: number;
  checkoutInjectedAtS: number | null;
}

async function walkTrip(sk: Skeleton): Promise<TripLog> {
  const log: TripLog = { nextFromItemAtS: null, checkoutFromPack: 0, checkoutInjectedAtS: null };
  sk.bus.emit({ type: 'ITEM_REQUESTED', item: 'eggs', source: 'keyboard' });
  // Outdoors, the crossing, the handoff and the aisle walk run on the replayers alone.
  expect(await sk.until(() => modeSeen(sk, 'AT_ITEM'), (TRACK_END_S + 60) * 1000)).toBe(true);
  await sk.advance(5_000);
  // The user's "next" at the item (01 §1: AT_ITEM → CHECKOUT_NAV; the stretch beat has no mock stimulus).
  log.nextFromItemAtS = sk.replayS();
  sk.app.trip.nextFromItem();
  expect(await sk.until(() => sk.store.getState().mode === 'CHECKOUT_NAV', 2_000)).toBe(true);
  // Give the navigator its chance at a CHECKOUT landmark read, then bridge the fixture gap.
  await sk.advance(15_000);
  log.checkoutFromPack = count(sk, 'CHECKOUT_REACHED');
  log.checkoutInjectedAtS = sk.replayS();
  sk.bus.emit({ type: 'CHECKOUT_REACHED' });
  await sk.advance(2_000);
  return log;
}

describe('walking skeleton — one trip on fixtures/track.json + the perception packs', () => {
  let sk: Skeleton;
  let log: TripLog;

  beforeAll(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    services.reset();
    sk = await buildSkeleton();
    try {
      log = await walkTrip(sk);
    } finally {
      dumpTrace('trip', sk, { log });
    }
  }, 60_000);

  afterAll(() => {
    sk.dispose();
    services.reset();
    jest.useRealTimers();
  });

  it('visits IDLE → OUTDOOR_NAV → APPROACH_CROSSING → AT_CURB → CROSSING → OUTDOOR_NAV → TRANSITION → INDOOR_NAV → AT_ITEM → CHECKOUT_NAV → DONE in order with zero illegal transitions', () => {
    expect(modeList(sk)).toEqual(EXPECTED_MODES);
    expectNoIllegalTransitions(sk);
    expect(sk.app.trip.isActive()).toBe(false); // DONE ends the session (trip.ts)
    expect(sk.mocks.perception.debug().profile).toBe('IDLE');
    expect(sk.app.haptics.isCourseRunning()).toBe(false);
  });

  it('the route comes from the fixture track, not the network: one ROUTE_READY, four legs, one crossing, no re-plan', () => {
    expect(count(sk, 'ROUTE_READY')).toBe(1);
    expect(firstEvent(sk, 'ROUTE_READY')).toEqual({ type: 'ROUTE_READY', legCount: 4, destName: 'Demo Grocery', crossingCount: 1 });
    expect(sk.store.getState().targetAisleId).toBe('a3');
    expect(sk.store.getState().storeId).toBe('demo-store-01');
    expect(saidKeys(sk)).toEqual(expect.arrayContaining(['turn_right_soon', 'turn_right_now', 'text:Crossing ahead: Forbes. Signalized.']));
  });

  it('the crossing runs on the real controller: CROSSING_AHEAD ≤ 25 m out, CURB_REACHED from the 2 s stop on the track, CROSSING_STARTED after the step-off, FAR_CURB_REACHED at the far curb, "Far curb." spoken', () => {
    const order = ['CROSSING_AHEAD', 'CURB_REACHED', 'CROSSING_STARTED', 'FAR_CURB_REACHED'] as const;
    const idx = order.map((t) => sk.events.findIndex((r) => r.event.type === t));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    for (const t of order) expect(count(sk, t)).toBe(1);
    expect(count(sk, 'CROSSING_ABORTED')).toBe(0);
    expect(firstEvent(sk, 'CROSSING_AHEAD')).toMatchObject({ crossingId: 'crossing-forbes-01', street: 'Forbes', signalized: true, bearingDeg: 180 });
    expect(firstEvent(sk, 'CROSSING_AHEAD')!.distanceM).toBeLessThanOrEqual(25);
    // Curb stop: the track stands still from arriveT; the controller needs CURB_STILL_MS of it.
    expect(eventAtS(sk, 'CURB_REACHED')).toBeGreaterThanOrEqual(CURB.arriveT + CURB_STILL_MS / 1000);
    expect(eventAtS(sk, 'CURB_REACHED')).toBeLessThanOrEqual(CURB.arriveT + CURB_STILL_MS / 1000 + 2);
    // Off the curb only after the fixture's step-off, and across a 22 m crossing (not instant).
    expect(modeAt(sk, 'CROSSING')).toBeGreaterThanOrEqual(STEP_OFF_S);
    expect(modeAt(sk, 'OUTDOOR_NAV', 1) - modeAt(sk, 'CROSSING')).toBeGreaterThan(5);
    expect(saidKeys(sk)).toContain('far_curb');
    expect(sk.said.find((s) => s.cacheKey === 'far_curb')?.mode).toBe('CROSSING');
  });

  it('a fresh WALK onset at the curb yields "Walk signal on." (the curb pack arms on the AT_CURB edge, after DONT_WALK)', () => {
    const walk = sk.said.find((s) => s.cacheKey === 'walk_signal_on');
    expect(walk).toBeDefined();
    expect(walk!.text).toBe(PHRASES.walk_signal_on);
    expect(walk!.text).toMatch(/^Walk signal on/);
    expect(walk!.mode).toBe('AT_CURB');
    expect(walk!.atS).toBeLessThanOrEqual(modeAt(sk, 'CROSSING'));
    expect(sk.platform.spoken).toContain(PHRASES.walk_signal_on);
    // The onset rule (01 §5): never "already on" for a fresh WALK; DONT_WALK precedes it in this pack.
    expect(saidKeys(sk)).not.toContain('walk_already_on_wait');
    expect(saidKeys(sk).indexOf('dont_walk')).toBeLessThan(saidKeys(sk).indexOf('walk_signal_on'));
    expect(sk.said.find((s) => s.cacheKey === 'dont_walk')?.mode).toBe('AT_CURB');
  });

  it('VEHICLE_APPROACHING → STOP haptic in the same tick, before the bus event, in the crossing phase; the CRITICAL phrase follows', () => {
    expect(sk.vehicleHaptics.length).toBeGreaterThan(0);
    for (const h of sk.vehicleHaptics) {
      expect(h.pattern).toBe('STOP');
      expect(h.patternAt).toBe(h.now);
      expect(CROSSING_PHASE.has(h.mode)).toBe(true);
    }
    expect(firstEvent(sk, 'VEHICLE_APPROACHING')?.direction).toBe('RIGHT');
    const vehicle = sk.said.find((s) => s.cacheKey === 'vehicle_right');
    expect(vehicle?.priority).toBe('CRITICAL');
    expect(vehicle?.text).toBe(PHRASES.vehicle_right);
    expect(sk.platform.spoken).toContain(PHRASES.vehicle_right);
  });

  it('STORE_ENTERED exactly once, fused by the real detector inside the track\'s 5–15 s post-door window; TRANSITION ends within the 3 s cap; the handoff script runs once', () => {
    expect(count(sk, 'STORE_ENTERED')).toBe(1);
    const entered = firstEvent(sk, 'STORE_ENTERED')!;
    expect(entered.reason).toBe('FUSED');
    expect(entered.confidence).toBeGreaterThanOrEqual(0.6);
    const firedAfterDoorS = modeAt(sk, 'TRANSITION') - DOOR_S;
    expect(firedAfterDoorS).toBeGreaterThanOrEqual(FUSE_MIN_S);
    expect(firedAfterDoorS).toBeLessThanOrEqual(FUSE_MAX_S);
    expect((modeAt(sk, 'INDOOR_NAV') - modeAt(sk, 'TRANSITION')) * 1000).toBeLessThanOrEqual(TRANSITION_CAP_MS + STEP_MS);
    expect(sk.said.filter((s) => s.cacheKey === 'entering_store')).toHaveLength(1);
    expect(sk.platform.spoken).toContain(PHRASES.entering_store);
    expect(sk.said.filter((s) => s.cacheKey === 'looking_for_signs')).toHaveLength(1);
    expect(sk.app.trip.getDebugState().runner?.running ?? false).toBe(false); // B's runner stopped on the accepted edge
  });

  it('the indoor controller reaches aisle three from the replayed signs: TARGET_AISLE_REACHED {a3, RIGHT}, "Aisle three. Eggs on your right.", the hazard on the bus', () => {
    expect(firstEvent(sk, 'TARGET_AISLE_REACHED')).toEqual({ type: 'TARGET_AISLE_REACHED', aisleId: 'a3', side: 'RIGHT' });
    expect(count(sk, 'TARGET_AISLE_REACHED')).toBe(1);
    expect(count(sk, 'AISLE_IDENTIFIED')).toBeGreaterThanOrEqual(2);
    const arrival = sk.said.find((s) => /^Aisle three\. Eggs on your right\./.test(s.text));
    expect(arrival).toBeDefined();
    expect(['INDOOR_NAV', 'AT_ITEM']).toContain(arrival!.mode);
    expect(sk.platform.spoken.some((t) => /^Aisle three\. Eggs on your right\./.test(t))).toBe(true);
    expect(count(sk, 'HAZARD')).toBeGreaterThan(0);
    expect(sk.said.find((s) => /^Person ahead/.test(s.text))?.priority).toBe('INFO');
  });

  it('every utterance is ≤ 12 words, digits as words, and free of forbidden words — at say() and at the backend', () => {
    expectUtterancesClean(sk);
    expect(sk.said.some((s) => s.priority === 'CRITICAL')).toBe(true);
    expect(sk.said.some((s) => s.priority === 'INFO')).toBe(true);
  });

  it('mock mode makes zero fetch and zero WebSocket calls', () => {
    expectNoNetwork(sk);
  });

  it('the only inputs beyond ITEM_REQUESTED were the user\'s "next" at the item and the checkout injection', () => {
    expect(log.nextFromItemAtS).toBeGreaterThan(modeAt(sk, 'AT_ITEM'));
    expect(modeAt(sk, 'CHECKOUT_NAV')).toBeGreaterThanOrEqual(log.nextFromItemAtS!);
    expect(log.checkoutInjectedAtS).toBeGreaterThan(modeAt(sk, 'CHECKOUT_NAV'));
    expect(modeAt(sk, 'DONE')).toBeGreaterThanOrEqual(log.checkoutInjectedAtS!);
  });

  describe('known gaps (code behind spec; the test flips to a real failure when fixed — promote it then)', () => {
    test.failing('C/D indoor: `indoor-aisle-walk` has no CHECKOUT sign, so CHECKOUT_NAV → DONE needs an injected CHECKOUT_REACHED instead of the navigator\'s landmark match', () => {
      expect(log.checkoutFromPack).toBe(1);
      expect(saidKeys(sk)).toContain('checkout_ahead');
    });
  });
});

// ---------------------------------------------------------------------------
// Run 2: stale WALK (the `curb-walk-already-on` pack, pinned the way the DebugPanel does).
// ---------------------------------------------------------------------------

describe('walking skeleton — stale WALK at the curb', () => {
  let sk: Skeleton;

  beforeAll(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    services.reset();
    sk = await buildSkeleton();
    // Pin the stale pack on the AT_CURB edge, after the harness applied its mode-keyed default.
    const off = sk.store.subscribe((s, prev) => {
      if (s.mode === 'AT_CURB' && prev.mode !== 'AT_CURB') sk.mocks.harness.selectPack('curb-walk-already-on', 0);
    });
    sk.bus.emit({ type: 'ITEM_REQUESTED', item: 'eggs', source: 'keyboard' });
    await sk.until(() => sk.said.some((s) => s.cacheKey === 'walk_already_on_wait') || sk.replayS() > STEP_OFF_S + 30, (STEP_OFF_S + 40) * 1000);
    off();
    dumpTrace('stale WALK', sk);
  }, 60_000);

  afterAll(() => {
    sk.dispose();
    services.reset();
    jest.useRealTimers();
  });

  it('WALK already showing when tracking began (fresh: false) yields "Walk already on. Wait for next." and never "Walk signal on."', () => {
    expect(modeSeen(sk, 'AT_CURB')).toBe(true);
    expect(sk.mocks.perception.debug().pack).toBe('curb-walk-already-on');
    const stale = sk.said.find((s) => s.cacheKey === 'walk_already_on_wait');
    expect(stale).toBeDefined();
    expect(stale!.text).toBe(PHRASES.walk_already_on_wait);
    expect(stale!.text).toMatch(/^Walk already on\. Wait for next/);
    expect(stale!.mode).toBe('AT_CURB');
    expect(sk.platform.spoken).toContain(PHRASES.walk_already_on_wait);
    expect(saidKeys(sk)).not.toContain('walk_signal_on');
    expectNoIllegalTransitions(sk);
    expectUtterancesClean(sk);
    expectNoNetwork(sk);
  });
});
