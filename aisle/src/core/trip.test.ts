import demoStore from '../../fixtures/stores/demo-store-01.json';
import type { GeoFix, SpeechRequest } from './contracts';
import { createEventBus } from './bus';
import { bindStoreToBus, createAppStore } from './store';
import { validateStoreMap, type AisleStoreMap } from '../indoor/storeMap';
import type { ResolveOutcome, ResolvedTarget } from '../indoor/storeResolver';
import { RouteClientError } from '../outdoor/routeClient';
import { createOutdoorStore } from '../outdoor/store';
import { REACH_RE, wireTrip, type TripDeps, type TripSession } from './trip';

const T0 = 1_700_000_000_000;

function loadMap(): AisleStoreMap {
  const v = validateStoreMap(demoStore);
  if (!v.ok) throw new Error(v.errors.join('; '));
  return v.map;
}

function fix(lat = 40.4453, lng = -79.9450): GeoFix {
  return { lat, lng, accuracyM: 5, courseDeg: 120, speedMps: 1.2, timestamp: Date.now() };
}

interface Harness {
  deps: TripDeps;
  said: SpeechRequest[];
  haptic: string[];
  sessions: Array<{ start: jest.Mock; stop: jest.Mock; answer: jest.Mock; setManualSignal: jest.Mock; curbReached: jest.Mock; dispose: jest.Mock }>;
  fireTarget(outcome: ResolveOutcome): void;
  pushFix(f?: GeoFix): void;
  hooks: { onTransition: jest.Mock; onTripEnd: jest.Mock; onManualSignal: jest.Mock; startPickup: jest.Mock; stopPickup: jest.Mock };
}

function harness(opts: { firstRun?: boolean; map?: AisleStoreMap | null; lastFix?: GeoFix | null; startImpl?: () => Promise<unknown> } = {}): Harness {
  const bus = createEventBus();
  const store = createAppStore({ bus, warn: () => undefined, initial: { firstRun: opts.firstRun ?? false } });
  bindStoreToBus(store, bus);
  const said: SpeechRequest[] = [];
  const haptic: string[] = [];
  const targetListeners = new Set<(t: ResolvedTarget | null, o: ResolveOutcome) => void>();
  const fixListeners = new Set<(f: GeoFix) => void>();
  let lastFix: GeoFix | null = opts.lastFix === undefined ? fix() : opts.lastFix;
  const map = opts.map === undefined ? loadMap() : opts.map;
  const sessions: Harness['sessions'] = [];
  const hooks = { onTransition: jest.fn(), onTripEnd: jest.fn(), onManualSignal: jest.fn(), startPickup: jest.fn(async () => undefined), stopPickup: jest.fn() };

  const createSession = (): TripSession => {
    const s = {
      start: jest.fn(opts.startImpl ?? (async () => {
        bus.emit({ type: 'ROUTE_READY', legCount: 2, destName: 'Demo Grocery', crossingCount: 1 });
        return {};
      })),
      stop: jest.fn(),
      answer: jest.fn(async (q: string) => (q === 'repeat' ? 'Turn right in sixty feet.' : 'About two hundred feet.')),
      setManualSignal: jest.fn(),
      curbReached: jest.fn(),
      dispose: jest.fn(),
    };
    sessions.push(s);
    return {
      runner: { start: s.start as never, stop: s.stop, answer: s.answer as never, getDebugState: () => ({ running: true }) as never },
      controller: { setManualSignal: s.setManualSignal, curbReached: s.curbReached, getDebugState: () => ({ state: 'ARMED' }) as never },
      dispose: s.dispose,
    };
  };

  const deps: TripDeps = {
    bus,
    store,
    speech: { say: (r) => { said.push(r); } },
    haptics: { play: (p) => { haptic.push(p); } },
    sensors: {
      getLastFix: () => lastFix,
      subscribeLocation: (cb) => {
        fixListeners.add(cb);
        return () => { fixListeners.delete(cb); };
      },
    },
    resolver: {
      onTarget: (cb) => {
        targetListeners.add(cb);
        return () => { targetListeners.delete(cb); };
      },
      getMap: () => map,
      ensureMap: async () => map,
    },
    outdoor: createOutdoorStore(),
    createSession,
    indoor: { startPickup: hooks.startPickup, stopPickup: hooks.stopPickup },
    onTransition: hooks.onTransition,
    onTripEnd: hooks.onTripEnd,
    onManualSignal: hooks.onManualSignal,
    fixTimeoutMs: 1000,
  };
  return {
    deps,
    said,
    haptic,
    sessions,
    hooks,
    fireTarget(outcome) {
      const t = outcome.kind === 'resolved' ? outcome.target : null;
      for (const cb of Array.from(targetListeners)) cb(t, outcome);
    },
    pushFix(f = fix()) {
      lastFix = f;
      for (const cb of Array.from(fixListeners)) cb(f);
    },
  };
}

const resolved: ResolveOutcome = {
  kind: 'resolved',
  target: { storeId: 'demo-store-01', item: 'eggs', requestedItem: 'eggs', aisleId: 'a3', order: 3, spokenLabel: 'Aisle three', sideWhenAscending: 'RIGHT', source: 'index' },
};

async function flush(ms = 0): Promise<void> {
  await jest.advanceTimersByTimeAsync(ms);
}

describe('wireTrip', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
  });
  afterEach(() => jest.useRealTimers());

  it('starts one outdoor session with the store-JSON entrance once the item resolves, and the route moves the mode', async () => {
    const h = harness();
    const trip = wireTrip(h.deps);
    h.deps.bus.emit({ type: 'ITEM_REQUESTED', item: 'eggs', source: 'keyboard' });
    h.fireTarget(resolved);
    await flush();
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0].start).toHaveBeenCalledWith({
      storeId: 'demo-store-01',
      entrance: { lat: 40.4443, lng: -79.9436, radiusM: 35 },
      destName: 'Demo Grocery',
      origin: { lat: 40.4453, lng: -79.945 },
    });
    expect(h.deps.store.getState().mode).toBe('OUTDOOR_NAV');
    expect(trip.isActive()).toBe(true);
    expect(trip.getDebugState().starts).toBe(1);
    // A second resolution mid-trip (a new item) does not start a second route.
    h.fireTarget(resolved);
    await flush();
    expect(h.sessions).toHaveLength(1);
    trip.dispose();
  });

  it('waits for the first GPS fix, and reports ERROR{location} when none arrives in time', async () => {
    const h = harness({ lastFix: null });
    const trip = wireTrip(h.deps);
    h.deps.bus.emit({ type: 'ITEM_REQUESTED', item: 'eggs', source: 'keyboard' });
    h.fireTarget(resolved);
    await flush();
    expect(h.sessions[0].start).not.toHaveBeenCalled();
    h.pushFix(fix(1, 2));
    await flush();
    expect(h.sessions[0].start).toHaveBeenCalledWith(expect.objectContaining({ origin: { lat: 1, lng: 2 } }));
    trip.dispose();

    const h2 = harness({ lastFix: null });
    const trip2 = wireTrip(h2.deps);
    h2.deps.bus.emit({ type: 'ITEM_REQUESTED', item: 'eggs', source: 'keyboard' });
    h2.fireTarget(resolved);
    await flush(1000);
    const errors = h2.deps.bus.history().filter((r) => r.event.type === 'ERROR');
    expect(errors.map((r) => (r.event as { scope: string }).scope)).toEqual(['location']);
    expect(h2.sessions[0].dispose).toHaveBeenCalled();
    expect(trip2.isActive()).toBe(false);
    trip2.dispose();
  });

  it('a network failure on the route reports ERROR{route}, says offline_notice once and ends the session', async () => {
    const h = harness({ startImpl: async () => { throw new RouteClientError('route: network error', 'network'); } });
    const trip = wireTrip(h.deps);
    h.deps.bus.emit({ type: 'ITEM_REQUESTED', item: 'eggs', source: 'keyboard' });
    h.fireTarget(resolved);
    await flush();
    const errors = h.deps.bus.history().filter((r) => r.event.type === 'ERROR');
    expect(errors).toHaveLength(1);
    expect((errors[0].event as { scope: string }).scope).toBe('route');
    expect(h.said.map((r) => r.cacheKey)).toEqual(['offline_notice']);
    expect(trip.isActive()).toBe(false);
    expect(h.deps.store.getState().mode).toBe('IDLE');
    trip.dispose();
  });

  it('abort tears the session down, and a route that finishes installing afterwards is stopped again', async () => {
    let finish: () => void = () => undefined;
    const h = harness({ startImpl: () => new Promise((r) => { finish = () => r({}); }) });
    const trip = wireTrip(h.deps);
    h.deps.bus.emit({ type: 'ITEM_REQUESTED', item: 'eggs', source: 'keyboard' });
    h.fireTarget(resolved);
    await flush();
    expect(h.sessions[0].start).toHaveBeenCalled();
    h.deps.store.getState().abort();
    expect(h.sessions[0].dispose).toHaveBeenCalledTimes(1);
    expect(h.hooks.onTripEnd).toHaveBeenCalledTimes(1);
    expect(h.hooks.stopPickup).toHaveBeenCalledTimes(1);
    finish();
    await flush();
    expect(h.sessions[0].stop).toHaveBeenCalledTimes(1);
    expect(trip.isActive()).toBe(false);
    trip.dispose();
  });

  it('a stale ROUTE_READY after an abort cannot start a trip with no item', async () => {
    const h = harness();
    const trip = wireTrip(h.deps);
    h.deps.bus.emit({ type: 'ROUTE_READY', legCount: 2, destName: 'x', crossingCount: 0 });
    expect(h.deps.store.getState().mode).toBe('IDLE');
    expect(h.sessions).toHaveLength(0);
    trip.dispose();
  });

  it('a target resolved past the outdoor leg (a DebugPanel jump) starts no route', async () => {
    const h = harness();
    const trip = wireTrip(h.deps);
    const s = h.deps.store.getState();
    h.deps.bus.emit({ type: 'ITEM_REQUESTED', item: 'eggs', source: 'mock' });
    h.deps.bus.emit({ type: 'ROUTE_READY', legCount: 2, destName: 'x', crossingCount: 0 });
    h.deps.bus.emit({ type: 'STORE_ENTERED', reason: 'MANUAL', confidence: 1 });
    s.transitionEnded();
    expect(h.deps.store.getState().mode).toBe('INDOOR_NAV');
    h.fireTarget(resolved);
    await flush();
    expect(h.sessions).toHaveLength(0);
    trip.dispose();
  });

  it('announces the handoff once per accepted STORE_ENTERED: CONFIRM, entering_store, then looking_for_signs after four seconds', async () => {
    const h = harness();
    const trip = wireTrip(h.deps);
    // Illegal here (IDLE): nothing spoken.
    h.deps.bus.emit({ type: 'STORE_ENTERED', reason: 'FUSED', confidence: 0.8 });
    expect(h.said).toHaveLength(0);
    h.deps.bus.emit({ type: 'ITEM_REQUESTED', item: 'eggs', source: 'keyboard' });
    h.fireTarget(resolved);
    await flush();
    expect(h.deps.store.getState().mode).toBe('OUTDOOR_NAV');
    h.deps.bus.emit({ type: 'STORE_ENTERED', reason: 'FUSED', confidence: 0.8 });
    expect(h.deps.store.getState().mode).toBe('TRANSITION');
    expect(h.hooks.onTransition).toHaveBeenCalledTimes(1);
    expect(h.haptic).toEqual(['CONFIRM']);
    expect(h.said.map((r) => r.cacheKey)).toEqual(['entering_store']);
    await flush(4000);
    expect(h.said.map((r) => r.cacheKey)).toEqual(['entering_store', 'looking_for_signs']);
    trip.dispose();
  });

  it('an abort during the handoff cancels the second line', async () => {
    const h = harness();
    const trip = wireTrip(h.deps);
    h.deps.bus.emit({ type: 'ITEM_REQUESTED', item: 'eggs', source: 'keyboard' });
    h.fireTarget(resolved);
    await flush();
    h.deps.bus.emit({ type: 'STORE_ENTERED', reason: 'FUSED', confidence: 0.8 });
    h.deps.store.getState().abort();
    await flush(5000);
    expect(h.said.map((r) => r.cacheKey)).toEqual(['entering_store']);
    trip.dispose();
  });

  it('routes voice outcomes: rescan at the curb, runner answers while walking, reach at the item', async () => {
    const h = harness();
    const trip = wireTrip(h.deps);
    h.deps.bus.emit({ type: 'ITEM_REQUESTED', item: 'eggs', source: 'keyboard' });
    h.fireTarget(resolved);
    await flush();
    await trip.onVoiceOutcome({ output: { intent: 'repeat', item: null, reply: 'Repeating.' }, transcript: 'repeat that' });
    expect(h.sessions[0].answer).toHaveBeenCalledWith('repeat');
    expect(h.said.at(-1)?.text).toBe('Turn right in sixty feet.');
    await trip.onVoiceOutcome({ output: { intent: 'how_far', item: null, reply: 'Checking the distance.' }, transcript: 'how far' });
    expect(h.sessions[0].answer).toHaveBeenLastCalledWith('how_far');

    h.deps.bus.emit({ type: 'CROSSING_AHEAD', crossingId: 'c1', street: 'Forbes', signalized: true, pushButtonLikely: false, bearingDeg: 180, distanceM: 20 });
    h.deps.bus.emit({ type: 'CURB_REACHED', crossingId: 'c1' });
    expect(h.deps.store.getState().mode).toBe('AT_CURB');
    const before = (h.deps.outdoor.getState() as { rescanRequests: number }).rescanRequests;
    await trip.onVoiceOutcome({ output: { intent: 'repeat', item: null, reply: 'Repeating.' }, transcript: 'again' });
    expect((h.deps.outdoor.getState() as { rescanRequests: number }).rescanRequests).toBe(before + 1);
    expect(h.sessions[0].answer).toHaveBeenCalledTimes(2);

    // Indoors at the item: "reach out" starts the pick-up loop; any other unknown does not.
    h.deps.store.getState().abort();
    h.deps.bus.emit({ type: 'ITEM_REQUESTED', item: 'eggs', source: 'mock' });
    h.deps.bus.emit({ type: 'ROUTE_READY', legCount: 2, destName: 'x', crossingCount: 0 });
    h.deps.bus.emit({ type: 'STORE_ENTERED', reason: 'MANUAL', confidence: 1 });
    h.deps.store.getState().transitionEnded();
    h.deps.bus.emit({ type: 'TARGET_AISLE_REACHED', aisleId: 'a3', side: 'RIGHT' });
    expect(h.deps.store.getState().mode).toBe('AT_ITEM');
    await trip.onVoiceOutcome({ output: { intent: 'unknown', item: null, reply: 'Say the item again.' }, transcript: 'okay reach out' });
    expect(h.hooks.startPickup).toHaveBeenCalledTimes(1);
    await trip.onVoiceOutcome({ output: { intent: 'unknown', item: null, reply: 'Say the item again.' }, transcript: 'hello' });
    expect(h.hooks.startPickup).toHaveBeenCalledTimes(1);
    h.deps.bus.emit({ type: 'USER_ACTION', action: 'reach' });
    expect(h.hooks.startPickup).toHaveBeenCalledTimes(2);
    trip.nextFromItem();
    expect(h.deps.store.getState().mode).toBe('CHECKOUT_NAV');
    trip.dispose();
  });

  it('manual signal and curb facades survive session boundaries', async () => {
    const h = harness();
    const trip = wireTrip(h.deps);
    trip.curbReached(); // no session: no-op
    trip.setManualSignal('WALK');
    expect(h.hooks.onManualSignal).toHaveBeenCalledWith('WALK');
    expect(trip.getManualSignal()).toBe('WALK');
    h.deps.bus.emit({ type: 'ITEM_REQUESTED', item: 'eggs', source: 'keyboard' });
    h.fireTarget(resolved);
    await flush();
    expect(h.sessions[0].setManualSignal).toHaveBeenCalledWith('WALK');
    trip.setManualSignal(null);
    expect(h.sessions[0].setManualSignal).toHaveBeenLastCalledWith(null);
    trip.curbReached();
    expect(h.sessions[0].curbReached).toHaveBeenCalledTimes(1);
    expect(trip.getDebugState().crossing).toEqual({ state: 'ARMED' });
    trip.dispose();
  });

  it('DONE ends the session and fires onTripEnd; dispose is idempotent', async () => {
    const h = harness();
    const trip = wireTrip(h.deps);
    h.deps.bus.emit({ type: 'ITEM_REQUESTED', item: 'eggs', source: 'keyboard' });
    h.fireTarget(resolved);
    await flush();
    const s = h.deps.store.getState();
    h.deps.bus.emit({ type: 'STORE_ENTERED', reason: 'FUSED', confidence: 1 });
    s.transitionEnded();
    h.deps.bus.emit({ type: 'TARGET_AISLE_REACHED', aisleId: 'a3', side: 'RIGHT' });
    s.nextFromItem();
    h.deps.bus.emit({ type: 'CHECKOUT_REACHED' });
    expect(h.deps.store.getState().mode).toBe('DONE');
    expect(h.sessions[0].dispose).toHaveBeenCalledTimes(1);
    expect(h.hooks.onTripEnd).toHaveBeenCalledTimes(1);
    trip.dispose();
    trip.dispose();
    expect(h.hooks.onTripEnd).toHaveBeenCalledTimes(2);
  });

  it('REACH_RE matches the stretch-beat phrasings only', () => {
    expect(REACH_RE.test('reach out')).toBe(true);
    expect(REACH_RE.test('can I pick it up')).toBe(true);
    expect(REACH_RE.test('grab it')).toBe(true);
    expect(REACH_RE.test('where is the checkout')).toBe(false);
    expect(REACH_RE.test('preach')).toBe(false);
  });
});
