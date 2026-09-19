/**
 * The composition graph under Jest: D's mocks behind the flag, fake expo
 * backends for A's own services, and a fake native module for the live shape.
 */
import demoStore from '../../fixtures/stores/demo-store-01.json';
import { bridgeAppStore, createMockServices } from '../../mocks';
import { track } from '../../mocks/fixtures';
import type { PerceptionNativeModule } from '../../modules/perception';
import type { GeoFix, ModeProfile } from './contracts';
import type { AudioChannelBackend } from './audio';
import { createEventBus } from './bus';
import { SITUATE_REENTRY_MS } from './situate';
import { composeApp, plannerFetch, type AppPlatform } from './composeApp';
import { createMemoryPrefsStorage, serializePrefs } from './prefs';
import type { SensorSources } from './sensors';
import { services } from './services';
import type { SpeechBackend } from './speech';
import { bindStoreToBus, createAppStore } from './store';
import type { PlannerClient } from '../outdoor/planner';
import { createOutdoorStore } from '../outdoor/store';

const T0 = 1_700_000_000_000;
const CONFIG = { proxyUrl: 'http://proxy.test:8787', proxyWs: 'ws://proxy.test:8787/ws', mock: true };

interface FakePlatform extends AppPlatform {
  spoken: string[];
  impacts: number;
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
  const p: FakePlatform = {
    spoken,
    impacts: 0,
    hapticBackend: {
      impact: () => {
        p.impacts += 1;
      },
      notificationError: () => undefined,
    },
    speechBackend,
    audioBackend,
    fetchImpl: (async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch,
  };
  return p;
}

type AnyListener = (e: unknown) => void;

function fakeNative() {
  const calls: Array<[string, unknown[]]> = [];
  const listeners = new Map<string, Set<AnyListener>>();
  const rec = (name: string, ...args: unknown[]) => {
    calls.push([name, args]);
  };
  const native = {
    calls,
    addListener(event: string, cb: AnyListener) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(cb);
      return { remove: () => set!.delete(cb) };
    },
    async start(p: ModeProfile) {
      rec('start', p);
    },
    setProfile(p: ModeProfile) {
      rec('setProfile', p);
    },
    stop() {
      rec('stop');
    },
    setCrossingBearing(b: number | null) {
      rec('setCrossingBearing', b);
    },
    setCourseReference(b: number | null) {
      rec('setCourseReference', b);
    },
    setBodyOffsetDeg(d: number) {
      rec('setBodyOffsetDeg', d);
    },
    setKnownSigns(w: string[]) {
      rec('setKnownSigns', w);
    },
    async snapshotJPEG(w: number) {
      return { base64: 'AAAA', width: w, height: (w * 3) / 4, seq: 1, timestamp: 0 };
    },
    getTrackingState: () => 'NORMAL' as const,
    getStats: () => ({ detectorFps: 15, depthFps: 10, ocrFps: 3, frameToEventMs: 80, thermalState: 'nominal' }),
    async startDebugExport() {},
    async stopDebugExport() {
      return null;
    },
    nativeLog: () => [] as string[],
  };
  return native as typeof native & PerceptionNativeModule;
}

function setupStore() {
  const bus = createEventBus();
  const store = createAppStore({ bus, warn: () => undefined });
  const unbind = bindStoreToBus(store, bus);
  return { bus, store, unbind };
}

describe('composeApp (mock mode)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    services.reset();
  });
  afterEach(() => {
    services.reset();
    jest.useRealTimers();
  });

  it('registers the seven services, walks a trip from ITEM_REQUESTED to OUTDOOR_NAV off the fixtures, and tears down on abort', async () => {
    const { bus, store, unbind } = setupStore();
    const mocks = createMockServices({ bus, store: bridgeAppStore(store), latencyScale: 0 });
    const platform = fakePlatform();
    platform.prefsStorage = createMemoryPrefsStorage(serializePrefs({ firstRun: false, trainingMode: false, speechRate: 1, bodyOffsetDeg: 0 }));
    const outdoor = createOutdoorStore();
    const app = composeApp({ config: CONFIG, bus, store, platform, mocks, fixtureTrack: track, loadStoreMap: () => demoStore, outdoor });

    expect(services.names().sort()).toEqual(['bus', 'conversation', 'haptics', 'perception', 'sensors', 'speech', 'store']);
    expect(services.get('store')).toBe(store);
    expect(services.get('perception')).toBe(mocks.perception);
    expect(services.get('sensors')).toBe(mocks.sensors);
    expect(app.harness).toBe(mocks.harness);
    expect(app.wsTransport).toBeNull();
    expect(app.betaNotice).toMatch(/beta/i);

    await app.start();
    expect(store.getState().firstRun).toBe(false);
    expect(store.getState().trainingMode).toBe(false);
    expect(platform.spoken).toEqual([]); // returning user: no disclaimer
    expect(mocks.harness.isRunning()).toBe(true);

    bus.emit({ type: 'ITEM_REQUESTED', item: 'eggs', source: 'keyboard' });
    await jest.advanceTimersByTimeAsync(3000);

    expect(store.getState().mode).toBe('OUTDOOR_NAV');
    expect(store.getState().targetAisleId).toBe('a3');
    expect(store.getState().storeId).toBe('demo-store-01');
    expect(bus.history().some((r) => r.event.type === 'ROUTE_READY')).toBe(true);
    expect(outdoor.getState().legs).toHaveLength(4);
    expect(outdoor.getState().crossings).toHaveLength(1);
    expect(app.trip.isActive()).toBe(true);
    expect(app.trip.getDebugState().runner?.running).toBe(true);
    expect(mocks.perception.debug().running).toBe(true);
    expect(mocks.perception.debug().profile).toBe('OUTDOOR_NAV');
    expect(app.haptics.isCourseRunning()).toBe(true);
    // Spoken through the real queue (expo-speech fallback: no cached files in this checkout);
    // the walking-beta warning arrives in its ≤ 12-word spoken form, never the 20-word display text.
    expect(platform.spoken.length).toBeGreaterThan(0);
    expect(platform.spoken).toContain('Walking directions are in beta. Use caution.');
    expect(platform.spoken.every((t) => t.split(/\s+/).length <= 12 || /prototype/.test(t))).toBe(true);
    expect(app.metrics.illegalTransitions).toBe(0);

    store.getState().abort();
    await jest.advanceTimersByTimeAsync(100);
    expect(store.getState().mode).toBe('IDLE');
    expect(app.trip.isActive()).toBe(false);
    expect(outdoor.getState().legs).toHaveLength(0);
    expect(app.haptics.isCourseRunning()).toBe(false);
    expect(mocks.perception.debug().profile).toBe('INDOOR_NAV');   // IDLE keeps the camera up for the awareness loop

    app.dispose();
    expect(mocks.harness.isRunning()).toBe(false);
    unbind();
  });

  it('round 4 through the keyboard: "take me to the eggs in my fridge" runs a guided task; "take me to CVS" looks, plans, and reports no place with the proxy down', async () => {
    const { bus, store, unbind } = setupStore();
    const mocks = createMockServices({ bus, store: bridgeAppStore(store), latencyScale: 0 });
    const platform = fakePlatform();
    platform.prefsStorage = createMemoryPrefsStorage(serializePrefs({ firstRun: false, trainingMode: false, speechRate: 1, bodyOffsetDeg: 0 }));
    const outdoor = createOutdoorStore();
    const app = composeApp({ config: CONFIG, bus, store, platform, mocks, fixtureTrack: track, loadStoreMap: () => demoStore, outdoor });
    await app.start();

    // The mock planner's parseIntent replays fixtures; the local fallback parser classifies the goal.
    await app.voice.submitText('take me to the eggs in my fridge');
    await jest.advanceTimersByTimeAsync(3000);
    expect(store.getState().mode).toBe('GUIDED_TASK');
    expect(store.getState().taskGoal).toBe('eggs in my fridge');
    // The echo plays at once; the speech queue holds one NAV item and keeps a
    // four-second gap, so the look prompt follows it and the step comes after.
    expect(platform.spoken).toEqual(['Eggs in my fridge. Got it.']);
    await jest.advanceTimersByTimeAsync(4000);
    expect(platform.spoken).toEqual(['Eggs in my fridge. Got it.', 'Walk to the kitchen door frame.']);
    expect(app.guidedTask.isActive()).toBe(true);
    const dbg = app.guidedTask.getDebugState();
    expect(dbg.total).toBeGreaterThanOrEqual(3);
    expect(dbg.context).toBe('home');
    // The first step is spoken and sits on the band.
    const stepEvents = bus.history().filter((r) => r.event.type === 'TASK_STEP');
    expect(stepEvents).toHaveLength(1);
    expect(app.conversation.entries().some((e) => e.role === 'aisle' && /^Plan: /.test(e.text))).toBe(true);
    // Hands-free "next" walks the steps; the last one completes the task.
    for (let i = 0; i < dbg.total; i += 1) {
      await app.guidedTask.onVoiceOutcome({ output: { intent: 'unknown', item: null, reply: '' }, transcript: 'next' });
      await jest.advanceTimersByTimeAsync(50);
    }
    expect(store.getState().mode).toBe('DONE');
    expect(app.guidedTask.isActive()).toBe(false);
    await jest.advanceTimersByTimeAsync(5000);
    expect(platform.spoken[platform.spoken.length - 1]).toBe('Done. Task complete.');
    store.getState().abort();
    await jest.advanceTimersByTimeAsync(50);
    expect(store.getState().mode).toBe('IDLE');

    // A place: the look and the planning prompt come first; the places lookup fails fast (no proxy) → no_place_found → IDLE.
    platform.spoken.length = 0;
    await app.voice.submitText('take me to CVS');
    await jest.advanceTimersByTimeAsync(3000);
    expect(platform.spoken).toEqual(['CVS. Got it.']);
    // The transcript blurb keeps every line of both flows, spoken or skipped by the queue.
    expect(app.conversation.entries().map((e) => `${e.role}:${e.text}`)).toEqual([
      'you:take me to the eggs in my fridge',
      'aisle:Eggs in my fridge. Got it.',
      'aisle:Let me see your surroundings.',
      'aisle:Shelves on both sides. Aisle sign ahead.',
      'aisle:Plan: 5 steps to eggs in my fridge.',
      'aisle:Walk to the kitchen door frame.',
      'aisle:Next step.',
      'aisle:Turn toward the kitchen counter.',
      'aisle:Walk to the fridge.',
      'aisle:Open the fridge door.',
      'aisle:Look inside the fridge.',
      'aisle:Done. Task complete.',
      'you:take me to CVS',
      'aisle:CVS. Got it.',
      'aisle:Let me see your surroundings.',
      'aisle:Planning your route.',
      'aisle:I could not find that place nearby.',
    ]);
    // Newest NAV wins: by the time the gap ends the lookup has failed, so the queue speaks the outcome.
    // The awareness loop's "show me" waits out its re-entry hold and follows, never replacing it.
    await jest.advanceTimersByTimeAsync(SITUATE_REENTRY_MS);
    expect(platform.spoken).toEqual(['CVS. Got it.', 'I could not find that place nearby.', 'Turn slowly. Show me your surroundings.']);
    expect(store.getState().mode).toBe('IDLE');
    expect(store.getState().targetItem).toBeNull();
    expect(app.trip.isActive()).toBe(false);

    app.dispose();
    unbind();
  });

  it('first launch: start() speaks nothing (OnboardingScreen step 0 owns the disclaimer); the manual-signal facade drives the ticker', async () => {
    const { bus, store, unbind } = setupStore();
    const mocks = createMockServices({ bus, store: bridgeAppStore(store), latencyScale: 0 });
    const platform = fakePlatform();
    platform.prefsStorage = createMemoryPrefsStorage(null);
    const app = composeApp({ config: CONFIG, bus, store, platform, mocks, fixtureTrack: track, loadStoreMap: () => demoStore, outdoor: createOutdoorStore() });
    await app.start();
    expect(store.getState().firstRun).toBe(true);
    // One owner for the ~12 s disclaimer: the first-run onboarding step (cacheKey 'disclaimer'),
    // reached by IDLE → ONBOARDING on the first ITEM_REQUESTED. start() must not recite it too.
    expect(platform.spoken).toEqual([]);
    expect(app.speech.getStats().spoken).toBe(0);

    app.crossingPort.setManualSignal('WALK');
    expect(app.audio.ticker.getState()).toBe('WALK');
    bus.emit({ type: 'SIGNAL_STATE', state: 'DONT_WALK', fresh: false, confidence: 1 });
    expect(app.audio.ticker.getState()).toBe('WALK'); // override wins over the live stream
    app.crossingPort.setManualSignal(null);
    expect(app.audio.ticker.getState()).toBe('UNKNOWN');
    bus.emit({ type: 'SIGNAL_STATE', state: 'COUNTDOWN', fresh: false, confidence: 1 });
    expect(app.audio.ticker.getState()).toBe('COUNTDOWN');

    // forceEnter is wired even before any trip (the store drops the illegal edge, loudly).
    app.transitionPort.forceEnter();
    expect(store.getState().mode).toBe('IDLE');
    expect(bus.history().some((r) => r.event.type === 'STORE_ENTERED')).toBe(true);
    app.dispose();
    unbind();
  });
});

describe('composeApp (live shape)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    services.reset();
  });
  afterEach(() => {
    services.reset();
    jest.useRealTimers();
  });

  it('wires real sensors to the native-backed perception, keeps the socket closed, and a dead proxy reports ERROR{route} plus offline_notice', async () => {
    const { bus, store, unbind } = setupStore();
    const native = fakeNative();
    const fix: GeoFix = { lat: 40.4453, lng: -79.945, accuracyM: 5, courseDeg: 120, speedMps: 1.2, timestamp: T0 };
    const sources: SensorSources = {
      requestPermissions: async () => ({ location: true, motion: false }),
      watchHeading: async () => () => undefined,
      watchPosition: async (cb) => {
        cb(fix);
        return () => undefined;
      },
      watchSteps: async () => () => undefined,
    };
    const platform = fakePlatform();
    platform.sensorSources = sources;
    platform.nativePerception = native;
    platform.prefsStorage = createMemoryPrefsStorage(serializePrefs({ firstRun: false, trainingMode: true, speechRate: 1, bodyOffsetDeg: 4 }));
    const app = composeApp({ config: { ...CONFIG, mock: false }, bus, store, platform, loadStoreMap: () => demoStore, outdoor: createOutdoorStore(), fixTimeoutMs: 500 });

    expect(app.harness).toBeNull();
    expect(app.wsTransport).not.toBeNull();
    expect(native.calls.some(([name]) => name === 'setBodyOffsetDeg')).toBe(true);
    const sensors = services.get('sensors') as { attachPerception?: unknown };
    expect(typeof sensors.attachPerception).toBe('function');

    await app.start();
    await jest.advanceTimersByTimeAsync(10);
    expect(store.getState().lastFix?.lat).toBe(40.4453);
    expect(store.getState().bodyOffsetDeg).toBe(4);
    expect(native.calls.filter(([name]) => name === 'setBodyOffsetDeg').at(-1)?.[1]).toEqual([4]);

    bus.emit({ type: 'ITEM_REQUESTED', item: 'eggs', source: 'voice' });
    await jest.advanceTimersByTimeAsync(2000);
    const errorScopes = bus.history().filter((r) => r.event.type === 'ERROR').map((r) => (r.event as { scope: string }).scope);
    expect(errorScopes).toContain('route');
    expect(platform.spoken.some((t) => /^Offline\./.test(t))).toBe(true);
    expect(app.trip.isActive()).toBe(false);
    expect(store.getState().mode).toBe('IDLE');
    expect(app.wsTransport?.isOpen()).toBe(false);
    app.dispose();
    unbind();
  });
});

describe('plannerFetch', () => {
  it('answers POST /api/plan from the planner, rejects bad jobs, and fails fast elsewhere', async () => {
    const planner: PlannerClient = {
      async run(job, input) {
        return { job, output: { intent: 'find_item', item: 'eggs', reply: 'Eggs. Finding a route.', echoed: input } as never, fallback: false, latencyMs: 3 };
      },
    };
    const f = plannerFetch(planner);
    const res = await f('http://proxy.test/api/plan', { method: 'POST', body: JSON.stringify({ job: 'parseIntent', input: { transcript: 'eggs', mode: 'IDLE', knownItems: ['eggs'] } }) });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { job: string; fallback: boolean };
    expect(body.job).toBe('parseIntent');
    expect(body.fallback).toBe(false);
    const bad = await f('http://proxy.test/api/plan', { method: 'POST', body: JSON.stringify({ job: 'nope' }) });
    expect(bad.status).toBe(400);
    const badJson = await f('http://proxy.test/api/plan', { method: 'POST', body: '{' });
    expect(badJson.status).toBe(400);
    await expect(f('http://proxy.test/api/tts', { method: 'POST', body: '{}' })).rejects.toThrow(/Network request failed/);
    const fallback = jest.fn(async () => ({ ok: true, status: 204 }) as unknown as Response);
    const g = plannerFetch(planner, fallback as unknown as typeof fetch);
    await g('http://proxy.test/api/health');
    expect(fallback).toHaveBeenCalled();
  });
});
