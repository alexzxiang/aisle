import type { AppMode, TransitionDetector } from '../core/contracts';
import { createEventBus } from '../core/bus';
import { createCrossingController } from '../crossing/CrossingController';
import { destinationPoint, interpolate, type LatLng } from './geo';
import { createLegRunner } from './LegRunner';
import { RouteClientError, type RouteClient } from './routeClient';
import { createOutdoorStore } from './store';
import { createFakeHaptics, createFakePerception, createFakeSensors, createFakeSpeech, fix } from './testing';
import type { RouteCrossing, RouteLeg, RouteResponse } from './types';
import { WALKING_BETA_WARNING } from './types';

const START: LatLng = { lat: 40.4428803, lng: -79.9546937 };

/** Leg 0 heads 240° for 180 m (turn right at the end), leg 1 heads 330° for 60 m, leg 2 arrives after 40 m. */
function buildRoute(): RouteResponse {
  const p0 = START;
  const p1 = destinationPoint(p0, 240, 180);
  const p2 = destinationPoint(p1, 330, 60);
  const p3 = destinationPoint(p2, 330, 40);
  const mk = (index: number, a: LatLng, b: LatLng, maneuver: RouteLeg['maneuver'], bearing: number, d: number, street: string): RouteLeg => ({
    index, instruction: `on ${street}`, maneuver, distanceM: d, polyline: [a, b], startBearingDeg: bearing, endBearingDeg: bearing, endLat: b.lat, endLng: b.lng, roadSide: 'RIGHT', street,
  });
  const legs = [mk(0, p0, p1, 'TURN_RIGHT', 240, 180, 'Forbes Ave'), mk(1, p1, p2, 'STRAIGHT', 330, 60, 'S Bouquet St'), mk(2, p2, p3, 'ARRIVE', 330, 40, 'S Bouquet St')];
  // A crossing across the leg-1 street, centred 30 m into leg 1 (sAlong = 210), 18 m long.
  const centre = destinationPoint(p1, 330, 30);
  const crossing: RouteCrossing = {
    crossingId: 'x1', street: 'S Bouquet St', signalized: true, pushButtonLikely: false, bearingDeg: 330,
    nearCurb: destinationPoint(centre, 150, 9), farCurb: destinationPoint(centre, 330, 9), roadSide: 'RIGHT', afterLeg: 1, sAlongM: 210,
  };
  return {
    destName: 'Demo Grocery', legs, crossings: [crossing], warnings: [WALKING_BETA_WARNING], attribution: 'Route data: Google Maps',
    script: { legs: [], crossingAnnouncements: [{ crossingId: 'x1', text: 'Crossing ahead: South Bouquet Street. Signalized.' }] },
    planner: { routeCompile: { fallback: true, latencyMs: 0 }, crossingAnnounce: { fallback: true, latencyMs: 0 } }, fetchedAt: 0,
  };
}

function harness(opts: { fetchRoute?: RouteClient['fetchRoute'] } = {}) {
  const bus = createEventBus();
  const haptics = createFakeHaptics();
  const speech = createFakeSpeech();
  const sensors = createFakeSensors();
  const perception = createFakePerception();
  const outdoor = createOutdoorStore();
  let mode: AppMode = 'OUTDOOR_NAV';
  bus.on('CROSSING_AHEAD', () => { mode = 'APPROACH_CROSSING'; });
  bus.on('CURB_REACHED', () => { mode = 'AT_CURB'; });
  bus.on('CROSSING_STARTED', () => { mode = 'CROSSING'; });
  bus.on('FAR_CURB_REACHED', () => { mode = 'OUTDOOR_NAV'; });
  bus.on('CROSSING_ABORTED', () => { mode = 'OUTDOOR_NAV'; });
  // 01 §1: a re-plan's ROUTE_READY takes APPROACH_CROSSING → OUTDOOR_NAV ("crossing dropped").
  bus.on('ROUTE_READY', () => { if (mode === 'APPROACH_CROSSING') mode = 'OUTDOOR_NAV'; });
  let modeLocked = false; // when true, emulate a store that REJECTS STORE_ENTERED (01 §1)
  bus.on('STORE_ENTERED', () => { if (!modeLocked) mode = 'TRANSITION'; });
  const getMode = () => mode;
  const lockMode = (locked: boolean) => { modeLocked = locked; };
  const controller = createCrossingController({ haptics, speech, sensors, perception, bus, outdoor, getMode });
  const transitionCalls: unknown[] = [];
  const transition: TransitionDetector = {
    start: (d) => transitionCalls.push(['start', d]),
    stop: () => transitionCalls.push(['stop']),
    onEnter: () => () => {},
    forceEnter: () => {},
  };
  const fetched: unknown[] = [];
  const routeClient: RouteClient = {
    async fetchRoute(req) {
      fetched.push(req);
      return opts.fetchRoute ? opts.fetchRoute(req) : buildRoute();
    },
  };
  const events: string[] = [];
  bus.onAny((r) => events.push(r.event.type));
  const runner = createLegRunner({ haptics, speech, sensors, perception, bus, outdoor, routeClient, controller, transition, getMode, prefetchCapMs: 50 });
  return { bus, haptics, speech, sensors, perception, outdoor, controller, transition, transitionCalls, fetched, events, runner, getMode, lockMode };
}

const entrance = { lat: 40.4422747, lng: -79.9570206, radiusM: 35 };

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-19T15:00:00Z'));
});
afterEach(() => jest.useRealTimers());

describe('LegRunner', () => {
  it('start: fetches the route, emits ROUTE_READY once, speaks the warning then leg 0 confirm, targets COURSE', async () => {
    const h = harness();
    const p = h.runner.start({ storeId: 'demo-store-01', entrance, destName: 'Demo Grocery', origin: START });
    await jest.advanceTimersByTimeAsync(100);
    await p;
    expect(h.fetched).toHaveLength(1);
    expect(h.events.filter((e) => e === 'ROUTE_READY')).toHaveLength(1);
    expect(h.bus.history().find((r) => r.event.type === 'ROUTE_READY')?.event).toMatchObject({ legCount: 3, crossingCount: 1, destName: 'Demo Grocery' });
    expect(h.speech.texts()[0]).toBe(WALKING_BETA_WARNING);
    expect(h.speech.texts()[1]).toBe('Continue on Forbes Avenue, about six hundred feet.');
    expect(h.haptics.courseActive).toBe(true);
    expect(h.perception.calls).toContainEqual({ method: 'setCourseReference', args: [{ bearingDeg: 240 }] });
    expect(h.outdoor.getState().legs).toHaveLength(3);
    expect(h.transitionCalls).toHaveLength(0);
  });

  it('walks leg 0: soon at 20 m, then the turn at the end (now, TURN, retarget), confirm once aligned', async () => {
    const h = harness();
    await h.runner.loadRoute(buildRoute(), { storeId: 's', entrance, destName: 'd', origin: START });
    const route = h.runner.getRoute()!;
    const end0 = { lat: route.legs[0].endLat, lng: route.legs[0].endLng };
    const along = (m: number) => destinationPoint(START, 240, m);
    for (const m of [30, 60, 90, 120, 150]) {
      const p = along(m);
      h.sensors.emitFix(fix(p.lat, p.lng));
    }
    expect(h.speech.keys()).not.toContain('turn_right_soon');
    const near = along(162);
    h.sensors.emitFix(fix(near.lat, near.lng));
    expect(h.speech.keys()).toContain('turn_right_soon');
    expect(h.outdoor.getState().beaconTarget).toEqual(end0);
    // Two fixes inside 15 m of the leg end → advance.
    h.sensors.emitFix(fix(end0.lat, end0.lng));
    expect(h.events).not.toContain('OUTDOOR_LEG_ADVANCED');
    h.sensors.emitFix(fix(end0.lat, end0.lng));
    expect(h.events).toContain('OUTDOOR_LEG_ADVANCED');
    expect(h.speech.keys()).toContain('turn_right_now');
    expect(h.haptics.played).toContain('TURN');
    expect(h.perception.calls.slice(-1)).toEqual([{ method: 'setCourseReference', args: [{ bearingDeg: 330 }] }]);
    expect(h.runner.getDebugState().turnPhase).toBe('ALIGNING');
    h.sensors.emitHeading({ trueHeadingDeg: 335, accuracy: 3, timestamp: Date.now() });
    expect(h.speech.texts().slice(-1)).toEqual(['Continue on South Bouquet Street, about two hundred feet.']);
    expect(h.runner.getDebugState().legIndex).toBe(1);
  });

  it('arms the crossing at ≤ 25 m to the near curb and hands fixes to the controller', async () => {
    const h = harness();
    await h.runner.loadRoute(buildRoute(), { storeId: 's', entrance, destName: 'd', origin: START });
    const route = h.runner.getRoute()!;
    const end0 = { lat: route.legs[0].endLat, lng: route.legs[0].endLng };
    // Near curb sits at sAlong 201: 150 m along leg 0 is 51 m away — not yet.
    const far = destinationPoint(START, 240, 150);
    h.sensors.emitFix(fix(far.lat, far.lng));
    expect(h.events).not.toContain('CROSSING_AHEAD');
    // At the leg end (sAlong 180) the near curb is 21 m away → armed as the leg advances.
    h.sensors.emitFix(fix(end0.lat, end0.lng));
    h.sensors.emitFix(fix(end0.lat, end0.lng));
    expect(h.runner.getDebugState().legIndex).toBe(1);
    expect(h.events).toContain('CROSSING_AHEAD');
    const ahead = h.bus.history().find((r) => r.event.type === 'CROSSING_AHEAD')!.event as { distanceM: number; crossingId: string; signalized: boolean | null };
    expect(ahead.crossingId).toBe('x1');
    expect(ahead.signalized).toBe(true);
    expect(ahead.distanceM).toBeLessThanOrEqual(25);
    expect(h.controller.getState()).toBe('ARMED');
    expect(h.getMode()).toBe('APPROACH_CROSSING');
    // Stopping at the curb reaches it through the controller.
    const curb = route.crossings[0].nearCurb;
    h.sensors.emitFix(fix(curb.lat, curb.lng, { speedMps: 0.1 }));
    jest.advanceTimersByTime(2100);
    h.sensors.emitFix(fix(curb.lat, curb.lng, { speedMps: 0.1 }));
    expect(h.events).toContain('CURB_REACHED');
    expect(h.getMode()).toBe('AT_CURB');
    // Abort releases the crossing and re-targets COURSE to the leg.
    const before = h.haptics.courseTargets.length;
    h.controller.abort('user');
    expect(h.haptics.courseTargets.length).toBe(before + 1);
    expect(h.runner.getDebugState().armedCrossingId).toBeNull();
  });

  it('starts the TransitionDetector when the ARRIVE leg becomes current, says nothing at arrival, and tears down on STORE_ENTERED', async () => {
    const h = harness();
    await h.runner.loadRoute(buildRoute(), { storeId: 's', entrance, destName: 'd', origin: START });
    const route = h.runner.getRoute()!;
    const end1 = { lat: route.legs[1].endLat, lng: route.legs[1].endLng };
    const end0 = { lat: route.legs[0].endLat, lng: route.legs[0].endLng };
    h.sensors.emitFix(fix(end0.lat, end0.lng));
    h.sensors.emitFix(fix(end0.lat, end0.lng));
    // Through the crossing quickly: it arms; keep walking without stopping so it is walked past.
    const mid = interpolate(end0, end1, 0.5);
    h.sensors.emitFix(fix(mid.lat, mid.lng));
    h.sensors.emitFix(fix(end1.lat, end1.lng));
    h.sensors.emitFix(fix(end1.lat, end1.lng));
    expect(h.runner.getDebugState().legIndex).toBe(2);
    expect(h.transitionCalls[0]).toEqual(['start', { lat: entrance.lat, lng: entrance.lng, radiusM: 35 }]);
    const spokenBefore = h.speech.said.length;
    const end2 = { lat: route.legs[2].endLat, lng: route.legs[2].endLng };
    h.sensors.emitFix(fix(end2.lat, end2.lng));
    h.sensors.emitFix(fix(end2.lat, end2.lng));
    expect(h.speech.said.length).toBe(spokenBefore); // nothing of ours at arrival
    expect(h.outdoor.getState().beaconTarget).toEqual({ lat: entrance.lat, lng: entrance.lng });
    h.bus.emit({ type: 'STORE_ENTERED', reason: 'FUSED', confidence: 0.8 });
    expect(h.haptics.courseActive).toBe(false);
    expect(h.perception.calls.slice(-1)).toEqual([{ method: 'setCourseReference', args: [null] }]);
    expect(h.outdoor.getState().beaconTarget).toBeNull();
    expect(h.runner.getDebugState().running).toBe(false);
    const count = h.speech.said.length;
    h.sensors.emitFix(fix(end2.lat, end2.lng));
    expect(h.speech.said.length).toBe(count);
  });

  it('answer: repeat is the last phrase; how_far and where_am_i template from the route', async () => {
    const h = harness();
    await h.runner.loadRoute(buildRoute(), { storeId: 's', entrance, destName: 'd', origin: START });
    expect(await h.runner.answer('repeat')).toBe('Continue on Forbes Avenue, about six hundred feet.');
    const p = destinationPoint(START, 240, 120);
    h.sensors.emitFix(fix(p.lat, p.lng));
    expect(await h.runner.answer('how_far')).toBe('About two hundred feet to the turn.');
    expect(await h.runner.answer('where_am_i')).toBe('On Forbes Avenue, about two hundred feet from South Bouquet Street.');
  });

  /** Three stationary fixes 40 m off leg 0 (and far from leg 1): the off-route rule. */
  function wanderOff(h: ReturnType<typeof harness>, alongM = 60, legBearing = 240) {
    const onLeg = destinationPoint(START, legBearing, alongM);
    const off = destinationPoint(onLeg, legBearing + 90, 40);
    for (let i = 0; i < 3; i += 1) h.sensors.emitFix(fix(off.lat, off.lng, { speedMps: 0.2 }));
    return off;
  }

  it('re-plans on the off-route rule: says Re-routing, fetches from the current fix, emits ROUTE_READY again', async () => {
    const h = harness();
    await h.runner.loadRoute(buildRoute(), { storeId: 's', entrance, destName: 'd', origin: START });
    expect(h.fetched).toHaveLength(0);
    const off = wanderOff(h);
    await jest.advanceTimersByTimeAsync(200);
    expect(h.fetched).toHaveLength(1);
    expect(h.fetched[0]).toMatchObject({ origin: { lat: off.lat, lng: off.lng }, dest: entrance, storeId: 's' });
    expect(h.speech.texts()).toContain('Re-routing.');
    expect(h.events.filter((e) => e === 'ROUTE_READY')).toHaveLength(2);
    expect(h.runner.getDebugState().replans).toBe(1);
    expect(h.outdoor.getState().replans).toBe(1);
    expect(h.runner.getDebugState().legIndex).toBe(0);
    expect(h.outdoor.getState().offline).toBe(false);
  });

  it('a re-plan whose new route drops the armed crossing aborts the controller with reason replan', async () => {
    const h = harness({ fetchRoute: async () => ({ ...buildRoute(), crossings: [] }) });
    await h.runner.loadRoute(buildRoute(), { storeId: 's', entrance, destName: 'd', origin: START });
    const route = h.runner.getRoute()!;
    const end0 = { lat: route.legs[0].endLat, lng: route.legs[0].endLng };
    h.sensors.emitFix(fix(end0.lat, end0.lng));
    h.sensors.emitFix(fix(end0.lat, end0.lng));
    expect(h.controller.getState()).toBe('ARMED');
    expect(h.getMode()).toBe('APPROACH_CROSSING');
    // Wander 40 m off leg 1, 10 m into it (short of the crossing line, so not "walked past").
    const onLeg = destinationPoint(end0, 330, 10);
    const off = destinationPoint(onLeg, 60, 40);
    for (let i = 0; i < 3; i += 1) h.sensors.emitFix(fix(off.lat, off.lng, { speedMps: 0.2 }));
    await jest.advanceTimersByTimeAsync(200);
    const aborted = h.bus.history().find((r) => r.event.type === 'CROSSING_ABORTED')?.event as { reason?: string } | undefined;
    expect(aborted?.reason).toBe('replan');
    expect(h.getMode()).toBe('OUTDOOR_NAV');
    expect(h.runner.getDebugState().armedCrossingId).toBeNull();
    expect(h.runner.getRoute()!.crossings).toHaveLength(0);
  });

  it('a re-plan whose new route keeps the armed crossing re-emits CROSSING_AHEAD so the store returns to APPROACH_CROSSING', async () => {
    const h = harness();
    await h.runner.loadRoute(buildRoute(), { storeId: 's', entrance, destName: 'd', origin: START });
    const route = h.runner.getRoute()!;
    const end0 = { lat: route.legs[0].endLat, lng: route.legs[0].endLng };
    h.sensors.emitFix(fix(end0.lat, end0.lng));
    h.sensors.emitFix(fix(end0.lat, end0.lng));
    expect(h.controller.getState()).toBe('ARMED');
    expect(h.getMode()).toBe('APPROACH_CROSSING');
    const onLeg = destinationPoint(end0, 330, 10);
    const off = destinationPoint(onLeg, 60, 40);
    for (let i = 0; i < 3; i += 1) h.sensors.emitFix(fix(off.lat, off.lng, { speedMps: 0.2 }));
    await jest.advanceTimersByTimeAsync(200);
    expect(h.events.filter((e) => e === 'ROUTE_READY')).toHaveLength(2);
    expect(h.events).not.toContain('CROSSING_ABORTED');
    const aheads = h.bus.history().filter((r) => r.event.type === 'CROSSING_AHEAD').map((r) => r.event as { crossingId: string; distanceM: number });
    expect(aheads).toHaveLength(2);
    expect(aheads[1].crossingId).toBe('x1');
    expect(aheads[1].distanceM).toBeGreaterThanOrEqual(0);
    expect(h.getMode()).toBe('APPROACH_CROSSING');
    expect(h.controller.getState()).toBe('ARMED');
    expect(h.runner.getDebugState().armedCrossingId).toBe('x1');
    // The announcement is not spoken a second time.
    expect(h.speech.said.filter((r) => /Crossing ahead/.test(r.text))).toHaveLength(1);
    // The crossing still completes normally from here.
    const curb = route.crossings[0].nearCurb;
    h.sensors.emitFix(fix(curb.lat, curb.lng, { speedMps: 0.1 }));
    jest.advanceTimersByTime(2100);
    h.sensors.emitFix(fix(curb.lat, curb.lng, { speedMps: 0.1 }));
    expect(h.getMode()).toBe('AT_CURB');
  });

  it('a re-plan that cannot reach the proxy keeps the old route and says offline_notice once', async () => {
    const h = harness({ fetchRoute: async () => { throw new RouteClientError('route: timeout', 'timeout'); } });
    await h.runner.loadRoute(buildRoute(), { storeId: 's', entrance, destName: 'd', origin: START });
    wanderOff(h);
    await jest.advanceTimersByTimeAsync(200);
    expect(h.fetched).toHaveLength(1);
    expect(h.speech.keys()).toContain('offline_notice');
    expect(h.outdoor.getState().offline).toBe(true);
    expect(h.runner.getRoute()!.legs).toHaveLength(3);
    expect(h.events.filter((e) => e === 'ROUTE_READY')).toHaveLength(1);
    // A second off-route run tries again; the notice carries a dedupeKey so A drops the repeat.
    wanderOff(h, 90);
    await jest.advanceTimersByTimeAsync(200);
    expect(h.fetched).toHaveLength(2);
    expect(h.speech.said.filter((r) => r.cacheKey === 'offline_notice').every((r) => r.dedupeKey === 'offline')).toBe(true);
  });
});

describe('reviewer must-fixes (seams with the store)', () => {
  it('arming a crossing speaks the compiled announcement exactly once', async () => {
    const h = harness();
    const p = h.runner.start({ storeId: 'demo-store-01', entrance, destName: 'Demo Grocery', origin: START });
    await jest.advanceTimersByTimeAsync(100);
    await p;
    const route = h.runner.getRoute()!;
    const end0 = { lat: route.legs[0].endLat, lng: route.legs[0].endLng };
    h.sensors.emitFix(fix(end0.lat, end0.lng));
    h.sensors.emitFix(fix(end0.lat, end0.lng));
    expect(h.events).toContain('CROSSING_AHEAD');
    const announcements = h.speech.said.filter((r) => /Crossing ahead: South Bouquet Street\. Signalized\./.test(r.text));
    expect(announcements).toHaveLength(1);
    expect(announcements[0].dedupeKey).toBe('xing-x1-ahead');
    // A second fix in range must not repeat it.
    h.sensors.emitFix(fix(end0.lat, end0.lng));
    expect(h.speech.said.filter((r) => /Crossing ahead/.test(r.text))).toHaveLength(1);
  });

  it('a STORE_ENTERED the store rejects (mode stays AT_CURB) does not tear the runner down; an accepted one does', async () => {
    const h = harness();
    const p = h.runner.start({ storeId: 'demo-store-01', entrance, destName: 'Demo Grocery', origin: START });
    await jest.advanceTimersByTimeAsync(100);
    await p;
    const route = h.runner.getRoute()!;
    const end0 = { lat: route.legs[0].endLat, lng: route.legs[0].endLng };
    h.sensors.emitFix(fix(end0.lat, end0.lng));
    h.sensors.emitFix(fix(end0.lat, end0.lng));
    const curb = route.crossings[0].nearCurb;
    h.sensors.emitFix(fix(curb.lat, curb.lng, { speedMps: 0.1 }));
    jest.advanceTimersByTime(2100);
    h.sensors.emitFix(fix(curb.lat, curb.lng, { speedMps: 0.1 }));
    expect(h.getMode()).toBe('AT_CURB');
    expect(h.controller.getState()).not.toBe('IDLE');
    // Rejected handoff: the mode machine keeps AT_CURB → the runner and controller stay alive.
    h.lockMode(true);
    h.bus.emit({ type: 'STORE_ENTERED', reason: 'FUSED', confidence: 0.7 });
    jest.advanceTimersByTime(1);
    expect(h.runner.getDebugState().running).toBe(true);
    expect(h.runner.getDebugState().armedCrossingId).toBe('x1');
    // Accepted handoff: the store reaches TRANSITION → the runner tears down.
    h.lockMode(false);
    h.bus.emit({ type: 'STORE_ENTERED', reason: 'MANUAL', confidence: 1 });
    jest.advanceTimersByTime(1);
    expect(h.runner.getDebugState().running).toBe(false);
  });
});
