import demoStore from '../../fixtures/stores/demo-store-01.json';
import type { GeoFix, SpeechRequest } from './contracts';
import { createEventBus } from './bus';
import { bindStoreToBus, createAppStore } from './store';
import { validateStoreMap, type AisleStoreMap } from '../indoor/storeMap';
import type { ResolveOutcome, ResolvedTarget } from '../indoor/storeResolver';
import { RouteClientError } from '../outdoor/routeClient';
import { createOutdoorStore } from '../outdoor/store';
import { PHRASES } from './phrases';
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
  sessions: Array<{ start: jest.Mock; stop: jest.Mock; loadRoute: jest.Mock; answer: jest.Mock; setManualSignal: jest.Mock; curbReached: jest.Mock; dispose: jest.Mock }>;
  fireTarget(outcome: ResolveOutcome): void;
  pushFix(f?: GeoFix): void;
  hooks: { onTransition: jest.Mock; onTripEnd: jest.Mock; onManualSignal: jest.Mock; startPickup: jest.Mock; stopPickup: jest.Mock };
}

function harness(opts: { firstRun?: boolean; map?: AisleStoreMap | null; lastFix?: GeoFix | null; startImpl?: () => Promise<unknown>; loadRouteImpl?: () => Promise<void>; fixPromptMs?: number; conversation?: TripDeps['conversation']; fetchImpl?: typeof fetch; describe?: TripDeps['describe'] } = {}): Harness {
  const bus = createEventBus();
  const store = createAppStore({ bus, warn: () => undefined, initial: { firstRun: opts.firstRun ?? false } });
  bindStoreToBus(store, bus);
  const said: SpeechRequest[] = [];
  const haptic: string[] = [];
  const targetListeners = new Set<(t: ResolvedTarget | null, o: ResolveOutcome) => void>();
  const fixListeners = new Set<(f: GeoFix) => void>();
  let lastFix: GeoFix | null = opts.lastFix === undefined ? fix() : opts.lastFix;
  const loaded = opts.map === undefined ? loadMap() : opts.map;
  let map: AisleStoreMap | null = loaded;
  const sessions: Harness['sessions'] = [];
  const hooks = { onTransition: jest.fn(), onTripEnd: jest.fn(), onManualSignal: jest.fn(), startPickup: jest.fn(async () => undefined), stopPickup: jest.fn() };

  const createSession = (): TripSession => {
    const s = {
      start: jest.fn(opts.startImpl ?? (async () => {
        bus.emit({ type: 'ROUTE_READY', legCount: 2, destName: 'Demo Grocery', crossingCount: 1 });
        return {};
      })),
      stop: jest.fn(),
      loadRoute: jest.fn(opts.loadRouteImpl ?? (async () => undefined)),
      answer: jest.fn(async (q: string) => (q === 'repeat' ? 'Turn right in sixty feet.' : 'About two hundred feet.')),
      setManualSignal: jest.fn(),
      curbReached: jest.fn(),
      dispose: jest.fn(),
    };
    sessions.push(s);
    return {
      runner: { start: s.start as never, stop: s.stop, answer: s.answer as never, loadRoute: s.loadRoute as never, getDebugState: () => ({ running: true }) as never },
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
      useMap: jest.fn((m: AisleStoreMap) => { map = m; }),
      restoreMap: jest.fn(() => { map = loaded; }),
    },
    outdoor: createOutdoorStore(),
    createSession,
    indoor: { startPickup: hooks.startPickup, stopPickup: hooks.stopPickup },
    onTransition: hooks.onTransition,
    onTripEnd: hooks.onTripEnd,
    onManualSignal: hooks.onManualSignal,
    fixTimeoutMs: 1000,
    ...(opts.fixPromptMs !== undefined ? { fixPromptMs: opts.fixPromptMs } : {}),
    ...(opts.conversation ? { conversation: opts.conversation } : {}),
    ...(opts.fetchImpl ? { proxyUrl: 'http://proxy.test', fetchImpl: opts.fetchImpl } : {}),
    ...(opts.describe ? { describe: opts.describe } : {}),
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

  it('a server-side route failure (proxy 502: Google disabled) degrades to a direct heading: says no_route_data and loads a one-leg route', async () => {
    const h = harness({ startImpl: async () => { throw new RouteClientError('route: http 502', 'http', 502); } });
    const trip = wireTrip(h.deps);
    h.deps.bus.emit({ type: 'ITEM_REQUESTED', item: 'eggs', source: 'keyboard' });
    h.fireTarget(resolved);
    await flush();
    expect(h.said.map((r) => r.cacheKey)).toEqual(['no_route_data']);
    expect(h.sessions[0].loadRoute).toHaveBeenCalledTimes(1);
    const [route, req] = (h.sessions[0].loadRoute as jest.Mock).mock.calls[0] as [{ legs: unknown[]; attribution: string; crossings: unknown[] }, { destName: string }];
    expect(route.legs).toHaveLength(1);
    expect(route.crossings).toEqual([]);
    expect(route.attribution).toMatch(/no route data/i);
    expect(req.destName).toBeTruthy();
    expect(trip.isActive()).toBe(true);
    const degraded = h.deps.bus.history().filter((r) => r.event.type === 'ERROR').map((r) => (r.event as { scope: string }).scope);
    expect(degraded).toEqual(['route-degraded']);
    trip.dispose();
  });

  it('when even the direct route cannot be installed, says route_unavailable and ends the session', async () => {
    const h = harness({
      startImpl: async () => { throw new RouteClientError('route: http 502', 'http', 502); },
      loadRouteImpl: async () => { throw new Error('install failed'); },
    });
    const trip = wireTrip(h.deps);
    h.deps.bus.emit({ type: 'ITEM_REQUESTED', item: 'eggs', source: 'keyboard' });
    h.fireTarget(resolved);
    await flush();
    expect(h.said.map((r) => r.cacheKey)).toEqual(['no_route_data', 'route_unavailable']);
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

  // --- round 3: proactive prompts when information is missing --------------------------

  it('no GPS fix five seconds into the trip → "I need your location. Step outside.", spoken and logged; a fix in time cancels it', async () => {
    const logged: string[] = [];
    const conversation = { pushAisle: (text: string, source?: string) => { logged.push(`${source}:${text}`); } };
    const h = harness({ lastFix: null, fixPromptMs: 400, conversation });
    const trip = wireTrip(h.deps);
    h.deps.bus.emit({ type: 'ITEM_REQUESTED', item: 'eggs', source: 'keyboard' });
    h.fireTarget(resolved);
    await flush(399);
    expect(h.said).toEqual([]);
    await flush(1);
    expect(h.said).toEqual([expect.objectContaining({ text: PHRASES.need_location, cacheKey: 'need_location', priority: 'NAV' })]);
    expect(logged).toEqual([`prompt:${PHRASES.need_location}`]);
    await flush(600);                                    // the 1 s fix timeout: still the one prompt, then the error
    expect(h.said).toHaveLength(1);
    expect(h.deps.bus.history().filter((r) => r.event.type === 'ERROR').map((r) => (r.event as { scope: string }).scope)).toEqual(['location']);
    trip.dispose();

    const h2 = harness({ lastFix: null, fixPromptMs: 400, conversation });
    const trip2 = wireTrip(h2.deps);
    h2.deps.bus.emit({ type: 'ITEM_REQUESTED', item: 'eggs', source: 'keyboard' });
    h2.fireTarget(resolved);
    await flush(200);
    h2.pushFix(fix(1, 2));
    await flush(2000);
    expect(h2.said).toEqual([]);                          // the fix arrived first: no prompt
    expect(h2.sessions[0].start).toHaveBeenCalled();
    trip2.dispose();

    // The default prompt time sits inside the default fix timeout.
    const h3 = harness({ lastFix: null, fixPromptMs: 5000 });   // prompt after the 1 s timeout: never fires
    const trip3 = wireTrip(h3.deps);
    h3.deps.bus.emit({ type: 'ITEM_REQUESTED', item: 'eggs', source: 'keyboard' });
    h3.fireTarget(resolved);
    await flush(6000);
    expect(h3.said).toEqual([]);
    trip3.dispose();
  });

  it('no store map → "I cannot find a store nearby.", on a resolver map_error and when the map never loads', async () => {
    const logged: string[] = [];
    const conversation = { pushAisle: (text: string, source?: string) => { logged.push(`${source}:${text}`); } };
    const h = harness({ map: null, conversation });
    const trip = wireTrip(h.deps);
    h.deps.bus.emit({ type: 'ITEM_REQUESTED', item: 'eggs', source: 'keyboard' });
    h.fireTarget({ kind: 'map_error', errors: ['no file'] });
    await flush();
    expect(h.said).toEqual([expect.objectContaining({ text: PHRASES.no_store_nearby, cacheKey: 'no_store_nearby' })]);
    expect(logged).toEqual([`prompt:${PHRASES.no_store_nearby}`]);
    expect(h.sessions).toHaveLength(0);

    h.fireTarget({ kind: 'unresolved' });                 // beginTrip with no map
    await flush();
    expect(h.said).toHaveLength(2);
    expect(h.deps.bus.history().filter((r) => r.event.type === 'ERROR').map((r) => (r.event as { scope: string }).scope)).toEqual(['store-map']);
    expect(trip.isActive()).toBe(false);
    trip.dispose();
  });

  // --- round 4: "take me to CVS" — a spoken place becomes a destination-only trip -------

  const placesOk = (places: unknown[]): typeof fetch => jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ places }) })) as unknown as typeof fetch;
  const cvs = { id: 'node/1', name: 'CVS Pharmacy', lat: 40.4460, lng: -79.9440, distanceM: 120, kind: 'pharmacy' };

  it('a place: looks first, says planning_route, then starts the route to the OSM entrance and swaps the map in', async () => {
    const order: string[] = [];
    const describe = jest.fn(async () => { order.push('describe'); return 'A hallway.'; });
    const fetchImpl = placesOk([cvs]);
    const h = harness({ fetchImpl, describe });
    const trip = wireTrip(h.deps);
    h.deps.bus.emit({ type: 'DESTINATION_REQUESTED', name: 'CVS', source: 'keyboard' });
    expect(h.deps.store.getState().targetItem).toBe('CVS');
    expect(h.deps.store.getState().destinationOnly).toBe(true);
    expect(h.said.map((r) => r.cacheKey)).toEqual(['let_me_see']);
    await flush();
    expect(describe).toHaveBeenCalledTimes(1);
    expect(h.said.map((r) => r.cacheKey)).toEqual(['let_me_see', 'planning_route']);
    const url = String((fetchImpl as jest.Mock).mock.calls[0][0]);
    expect(url).toMatch(/^http:\/\/proxy\.test\/api\/places\?/);
    expect(url).toContain('q=CVS');
    expect(url).toContain('radiusM=2500');
    expect(h.deps.resolver.useMap).toHaveBeenCalledWith(expect.objectContaining({ storeId: 'poi-node-1', displayName: 'CVS Pharmacy', aisles: [] }));
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0].start).toHaveBeenCalledWith(expect.objectContaining({
      storeId: 'poi-node-1',
      entrance: { lat: 40.446, lng: -79.944, radiusM: 35 },
      destName: 'CVS Pharmacy',
    }));
    expect(h.deps.store.getState().mode).toBe('OUTDOOR_NAV');
    expect(h.deps.store.getState().destinationOnly).toBe(true);
    trip.dispose();
  });

  it('arriving at a place: the store-entry handoff ends the trip at the door with "You have arrived." and restores the map', async () => {
    const h = harness({ fetchImpl: placesOk([cvs]) });
    const trip = wireTrip(h.deps);
    h.deps.bus.emit({ type: 'DESTINATION_REQUESTED', name: 'CVS', source: 'voice' });
    await flush();
    expect(h.deps.store.getState().mode).toBe('OUTDOOR_NAV');
    h.deps.bus.emit({ type: 'STORE_ENTERED', reason: 'FUSED', confidence: 0.9 });
    expect(h.deps.store.getState().mode).toBe('TRANSITION');
    h.deps.store.getState().transitionEnded();
    expect(h.deps.store.getState().mode).toBe('DONE');
    expect(h.said.map((r) => r.cacheKey)).toEqual(['let_me_see', 'planning_route', 'entering_store', 'arrived_destination']);
    expect(h.sessions[0].dispose).toHaveBeenCalledTimes(1);
    expect(h.deps.resolver.restoreMap).toHaveBeenCalled();
    expect(h.hooks.onTripEnd).toHaveBeenCalledTimes(1);
    trip.dispose();
  });

  it('the loaded store map wins by name and keeps the full aisle flow (destinationOnly cleared, no places call)', async () => {
    const fetchImpl = placesOk([cvs]);
    const h = harness({ fetchImpl });
    const trip = wireTrip(h.deps);
    h.deps.bus.emit({ type: 'DESTINATION_REQUESTED', name: 'demo grocery', source: 'keyboard' });
    await flush();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(h.deps.resolver.useMap).not.toHaveBeenCalled();
    expect(h.deps.store.getState().destinationOnly).toBe(false);
    expect(h.sessions[0].start).toHaveBeenCalledWith(expect.objectContaining({ storeId: 'demo-store-01' }));
    h.deps.bus.emit({ type: 'STORE_ENTERED', reason: 'FUSED', confidence: 0.9 });
    h.deps.store.getState().transitionEnded();
    expect(h.deps.store.getState().mode).toBe('INDOOR_NAV');
    trip.dispose();
  });

  it('no match → "I could not find that place nearby." and back to IDLE; no fix → need_location', async () => {
    const h = harness({ fetchImpl: placesOk([]) });
    const trip = wireTrip(h.deps);
    h.deps.bus.emit({ type: 'DESTINATION_REQUESTED', name: 'Narnia', source: 'keyboard' });
    await flush();
    expect(h.said.map((r) => r.cacheKey)).toEqual(['let_me_see', 'planning_route', 'no_place_found']);
    expect(h.said[2]).toEqual(expect.objectContaining({ text: PHRASES.no_place_found, priority: 'NAV' }));
    expect(h.sessions).toHaveLength(0);
    expect(h.deps.store.getState().mode).toBe('IDLE');
    expect(h.deps.store.getState().targetItem).toBeNull();
    trip.dispose();

    const fetchImpl = placesOk([cvs]);
    const h2 = harness({ fetchImpl, lastFix: null });
    const trip2 = wireTrip(h2.deps);
    h2.deps.bus.emit({ type: 'DESTINATION_REQUESTED', name: 'CVS', source: 'keyboard' });
    await flush();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(h2.said.map((r) => r.cacheKey)).toEqual(['let_me_see', 'planning_route', 'need_location']);
    expect(h2.deps.store.getState().mode).toBe('IDLE');
    trip2.dispose();
  });

  it('the proxy down (network error or 5xx) → no_place_found, and a failed look does not block the route', async () => {
    const h = harness({
      fetchImpl: jest.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch,
      describe: jest.fn(async () => { throw new Error('vision down'); }),
    });
    const trip = wireTrip(h.deps);
    h.deps.bus.emit({ type: 'DESTINATION_REQUESTED', name: 'CVS', source: 'keyboard' });
    await flush();
    expect(h.said.map((r) => r.cacheKey)).toEqual(['let_me_see', 'planning_route', 'no_place_found']);
    expect(h.deps.store.getState().mode).toBe('IDLE');
    trip.dispose();
  });

  it('a second request while the first is still resolving supersedes it (one route, the later name); mid-trip requests are ignored', async () => {
    const releases: Array<(places: unknown[]) => void> = [];
    const fetchImpl = jest.fn(
      () => new Promise((resolve) => { releases.push((places) => resolve({ ok: true, status: 200, json: async () => ({ places }) })); }),
    ) as unknown as typeof fetch;
    const h = harness({ fetchImpl });
    const trip = wireTrip(h.deps);
    h.deps.bus.emit({ type: 'DESTINATION_REQUESTED', name: 'CVS', source: 'keyboard' });
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    h.deps.bus.emit({ type: 'DESTINATION_REQUESTED', name: 'Walgreens', source: 'keyboard' });
    await flush();
    expect(h.deps.store.getState().targetItem).toBe('Walgreens');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // The stale first lookup resolves: nothing starts from it.
    releases[0]([cvs]);
    await flush();
    expect(h.sessions).toHaveLength(0);
    releases[1]([{ ...cvs, id: 'node/2', name: 'Walgreens' }]);
    await flush();
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0].start).toHaveBeenCalledWith(expect.objectContaining({ storeId: 'poi-node-2', destName: 'Walgreens' }));
    expect(h.deps.store.getState().mode).toBe('OUTDOOR_NAV');
    // Mid-trip: the store keeps its target and the trip does not double-start.
    h.deps.bus.emit({ type: 'DESTINATION_REQUESTED', name: 'CVS', source: 'keyboard' });
    await flush();
    expect(h.deps.store.getState().targetItem).toBe('Walgreens');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(h.sessions).toHaveLength(1);
    trip.dispose();
  });

  it('REACH_RE matches the stretch-beat phrasings only', () => {
    expect(REACH_RE.test('reach out')).toBe(true);
    expect(REACH_RE.test('can I pick it up')).toBe(true);
    expect(REACH_RE.test('grab it')).toBe(true);
    expect(REACH_RE.test('where is the checkout')).toBe(false);
    expect(REACH_RE.test('preach')).toBe(false);
  });
});
