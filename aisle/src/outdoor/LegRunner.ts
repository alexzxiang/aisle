/**
 * LegRunner (03 Tasks 3, 4, 5, 8): the outdoor orchestrator.
 *
 * - loads a route (proxy) and pre-synthesizes every variable phrase before
 *   `ROUTE_READY`;
 * - per GPS fix: leg advancement (accuracy gate, two-fix rule), the turn flow,
 *   the COURSE reference, the beacon target, crossing arming at ≤ 25 m;
 * - re-plans on the off-route rule;
 * - hands the final leg to Agent D's TransitionDetector and tears itself down
 *   on `STORE_ENTERED` — two modules reacting to location after the door is a
 *   guaranteed double-speech.
 *
 * It never computes heading and never sets mode: it emits events.
 */
import type {
  AppMode,
  EventBus,
  GeoFix,
  HapticService,
  PerceptionService,
  SensorService,
  SpeechRequest,
  SpeechService,
  TransitionDetector,
} from '../core/contracts';
import type { AisleCrossingController } from '../crossing/CrossingController';
import { buildRouteLine, crossingLengthM, projectOntoRoute, toCrossing, type RouteLine } from '../crossing/crossingData';
import { initialBearingDeg, polylineLengthM, projectOntoPolyline, type LatLng } from './geo';
import { initialCorrection, stepCorrection } from './courseCorrection';
import { CROSSING_AHEAD_M, crossingAheadRequests, offlineNoticeRequest, prefetchPhrases, prefetchPortOf, replanRequest, variablePhrases } from './guidance';
import { DIRECT_ROUTE_ATTRIBUTION, directRoute } from './directRoute';
import { angularError, initialLegProgress, referenceBearingAt, stepLegProgress, usableOutdoorFix, type LegProgressState } from './legs';
import type { PlannerClient } from './planner';
import { templateAnswer } from './plannerJobs';
import { RouteClientError, type RouteClient, type RouteRequest } from './routeClient';
import { beaconTargetFor, type OutdoorStore } from './store';
import { initialTurnFlow, stepTurnFlow, type TurnAction, type TurnFlowState } from './turnFlow';
import type { RouteResponse } from './types';

export interface StoreEntrance extends LatLng {
  radiusM: number;
}

export interface LegRunnerDeps {
  haptics: HapticService;
  speech: SpeechService;
  sensors: SensorService;
  perception: PerceptionService;
  bus: EventBus;
  outdoor: OutdoorStore;
  routeClient: RouteClient;
  controller: AisleCrossingController;
  planner?: PlannerClient;
  transition?: TransitionDetector;
  getMode: () => AppMode;
  now?: () => number;
  /** Cap on pre-synthesis before ROUTE_READY (default 10 s). */
  prefetchCapMs?: number;
}

export interface StartRequest {
  storeId: string;
  entrance: StoreEntrance;
  destName: string;
  /** Defaults to the last GPS fix. */
  origin?: LatLng;
}

export interface LegRunnerDebugState {
  running: boolean;
  legIndex: number;
  legCount: number;
  remainingM: number | null;
  nextCrossingM: number | null;
  armedCrossingId: string | null;
  turnPhase: TurnFlowState['phase'];
  replans: number;
  lastPhrase: string | null;
  prefetch: { requested: number; ok: number; failed: string[] } | null;
  transitionStarted: boolean;
}

export interface LegRunner {
  /** Fetch the route, pre-synthesize, emit ROUTE_READY and start guiding. */
  start(req: StartRequest): Promise<RouteResponse>;
  /** Start from an already-fetched response (mock replay, tests). */
  loadRoute(route: RouteResponse, req: StartRequest): Promise<void>;
  /** Push a fix by hand (tests / replay). Normal operation subscribes to SensorService. */
  onFix(fix: GeoFix): void;
  /** "repeat / how far / where am I" replies for A's voice flow. */
  answer(question: 'repeat' | 'how_far' | 'where_am_i'): Promise<string>;
  getRoute(): RouteResponse | null;
  getDebugState(): LegRunnerDebugState;
  stop(): void;
}

const WALKING_MODES: ReadonlySet<AppMode> = new Set<AppMode>(['OUTDOOR_NAV', 'APPROACH_CROSSING']);
const TICK_MS = 1000;
const REPLAN_REPLY_WAIT_MS = 1500;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function createLegRunner(deps: LegRunnerDeps): LegRunner {
  const now = deps.now ?? Date.now;
  const { haptics, speech, sensors, perception, bus, outdoor, controller } = deps;

  let route: RouteResponse | null = null;
  let request: StartRequest | null = null;
  let line: RouteLine | null = null;
  let progress: LegProgressState = initialLegProgress(0);
  let legAlongM = 0;   // along-track on the current leg; drives the tangent-following COURSE reference
  let turn: TurnFlowState = initialTurnFlow(0);
  let remainingM: number | null = null;
  let nextCrossingM: number | null = null;
  let armedCrossingId: string | null = null;
  const passedCrossings = new Set<string>();
  let replans = 0;
  let replanning = false;
  let lastPhrase: string | null = null;
  let prefetchReport: LegRunnerDebugState['prefetch'] = null;
  let transitionStarted = false;
  let running = false;
  let correction = initialCorrection();
  let courseBearing: number | null = null;
  let routeRevision = 0;
  let installing = false;
  let tick: ReturnType<typeof setInterval> | null = null;
  const unsubs: Array<() => void> = [];

  // --- speech / haptics --------------------------------------------------------

  const say = (req: SpeechRequest): void => {
    lastPhrase = req.text;
    outdoor.getState().countUtterance();
    const routeSpecific = req.dedupeKey?.startsWith('leg-') || req.dedupeKey?.startsWith('alignment-');
    speech.say({ ...req, dedupeKey: routeSpecific ? `route-${routeRevision}-${req.dedupeKey}` : req.dedupeKey });
  };

  const retargetCourse = (legIndex: number, bearing?: number): void => {
    const leg = route?.legs[legIndex];
    if (!leg) return;
    legAlongM = 0;   // a fresh leg starts at its head (start bearing) until the next fix advances it
    courseBearing = bearing ?? leg.startBearingDeg;
    haptics.stopCourse();
    // The bearing getter follows the current tangent without restarting COURSE at every bend.
    haptics.startCourse(sensors.courseErrorFor({ bearingDeg: () => referenceBearingAt(leg, legAlongM), line: leg.polyline, roadSide: leg.roadSide }));
    perception.setCourseReference({ bearingDeg: courseBearing });
  };

  const runActions = (actions: TurnAction[]): void => {
    for (const a of actions) {
      if (a.kind === 'SAY') say(a.req);
      else if (a.kind === 'TURN') haptics.play('TURN');
      else retargetCourse(a.legIndex);
    }
  };

  const applyTurn = (event: Parameters<typeof stepTurnFlow>[1]): void => {
    if (!route) return;
    if (event.type === 'ADVANCED') speech.clearQueue('NAV');
    const r = stepTurnFlow(turn, event, route.legs, route.script);
    turn = r.state;
    runActions(r.actions);
  };

  // --- handoff (Task 8) ------------------------------------------------------------

  const maybeStartTransition = (): void => {
    if (transitionStarted || !route || !request) return;
    const leg = route.legs[progress.legIndex];
    if (!leg || leg.maneuver !== 'ARRIVE') return;
    transitionStarted = true;
    deps.transition?.start({ lat: request.entrance.lat, lng: request.entrance.lng, radiusM: request.entrance.radiusM });
  };

  // --- crossings ---------------------------------------------------------------------

  const updateCrossings = (routeAlongM: number): void => {
    if (!route) return;
    nextCrossingM = null;
    for (const c of route.crossings) {
      if (passedCrossings.has(c.crossingId)) continue;
      const half = crossingLengthM(c) / 2;
      const toNearCurbM = c.sAlongM - half - routeAlongM;
      if (routeAlongM > c.sAlongM + half + 10 && armedCrossingId !== c.crossingId) {
        passedCrossings.add(c.crossingId);
        continue;
      }
      if (nextCrossingM === null) nextCrossingM = Math.max(0, toNearCurbM);
      if (armedCrossingId === null && toNearCurbM <= CROSSING_AHEAD_M && WALKING_MODES.has(deps.getMode())) {
        armedCrossingId = c.crossingId;
        bus.emit({
          type: 'CROSSING_AHEAD',
          crossingId: c.crossingId,
          street: c.street,
          signalized: c.signalized,
          pushButtonLikely: c.pushButtonLikely,
          bearingDeg: c.bearingDeg,
          distanceM: Math.max(0, toNearCurbM),
        });
        controller.arm(toCrossing(c));
        // 03 Task 3: the compiled "Crossing ahead: <street>. Signalized." (+ "Push button
        // likely.") is spoken exactly once per crossing, dedupe-keyed per crossingId.
        for (const req of crossingAheadRequests(c, route?.script)) say(req);
      }
      break;
    }
  };

  /**
   * 01 §1: ROUTE_READY takes APPROACH_CROSSING → OUTDOOR_NAV ("crossing dropped"). When the
   * re-planned route still carries the armed crossing, re-emit CROSSING_AHEAD so the store
   * returns to APPROACH_CROSSING and CURB_REACHED / CROSSING_STARTED stay legal edges. Not
   * spoken again: the announcement is dedupe-keyed per crossing.
   */
  const reannounceArmedCrossing = (fix: GeoFix): void => {
    if (!route || !line || armedCrossingId === null) return;
    if (controller.getState() !== 'ARMED' || !WALKING_MODES.has(deps.getMode())) return;
    const c = route.crossings.find((x) => x.crossingId === armedCrossingId);
    if (!c) return;
    const routeAlongM = projectOntoRoute({ lat: fix.lat, lng: fix.lng }, line)?.sAlongM ?? 0;
    const toNearCurbM = c.sAlongM - crossingLengthM(c) / 2 - routeAlongM;
    bus.emit({
      type: 'CROSSING_AHEAD',
      crossingId: c.crossingId,
      street: c.street,
      signalized: c.signalized,
      pushButtonLikely: c.pushButtonLikely,
      bearingDeg: c.bearingDeg,
      distanceM: Math.max(0, toNearCurbM),
    });
  };

  const onCrossingReleased = (crossingId: string): void => {
    if (armedCrossingId === crossingId) {
      passedCrossings.add(crossingId);
      armedCrossingId = null;
    }
    retargetCourse(progress.legIndex);
  };

  // --- fixes ---------------------------------------------------------------------------

  const onFix = (fix: GeoFix): void => {
    if (!running || !route || !line || installing || replanning) return;
    if (!usableOutdoorFix(fix, now())) {
      correction = initialCorrection();
      progress = { ...progress, insideCount: 0, overshootCount: 0, offRouteCount: 0 };
      outdoor.getState().setProgress({ lastFixCounted: false });
      return;
    }
    controller.observeFix(fix);

    const step = stepLegProgress(progress, fix, route.legs);
    const before = progress.legIndex;
    progress = step.state;
    const activeLeg = route.legs[progress.legIndex];
    const activeProjection = activeLeg ? projectOntoPolyline(fix, activeLeg.polyline) : null;
    remainingM = before === progress.legIndex ? step.remainingM
      : activeProjection ? Math.max(0, polylineLengthM(activeLeg.polyline) - activeProjection.alongM) : activeLeg?.distanceM ?? 0;
    legAlongM = activeProjection?.alongM ?? 0;

    const here: LatLng = { lat: fix.lat, lng: fix.lng };
    const routeProj = projectOntoRoute(here, line);
    const routeAlongM = routeProj?.sAlongM ?? 0;
    const mode = deps.getMode();
    const walking = WALKING_MODES.has(mode);

    for (const ev of step.events) {
      if (ev === 'ADVANCED') {
        const leg = route.legs[progress.legIndex];
        bus.emit({ type: 'OUTDOOR_LEG_ADVANCED', index: progress.legIndex, instruction: leg?.instruction ?? '' });
        if (walking) applyTurn({ type: 'ADVANCED', toLegIndex: progress.legIndex, now: now() });
        else {
          turn = { ...initialTurnFlow(progress.legIndex), confirmSaid: true };
          if (mode !== 'CROSSING' && mode !== 'AT_CURB') retargetCourse(progress.legIndex);
        }
        maybeStartTransition();
      } else if (ev === 'OFF_ROUTE' && walking) {
        void replan(fix);
      }
      // ARRIVED: no utterance of ours (Task 8) — Agent D's STORE_ENTERED is the handoff.
    }
    const offRoute = step.crossTrackM > Math.max(25, fix.accuracyM * 1.5)
      && (projectOntoPolyline(fix, route.legs[before + 1]?.polyline ?? [])?.distM ?? Infinity) > Math.max(25, fix.accuracyM * 1.5);
    if (walking && (offRoute || replanning)) {
      correction = initialCorrection();
      haptics.stopCourse();
      courseBearing = null;
      perception.setCourseReference(null);
      outdoor.getState().setBeaconTarget(null);
      outdoor.getState().setProgress({ lastFixCounted: step.counted });
      return;
    }
    if (before === progress.legIndex && walking) applyTurn({ type: 'PROGRESS', remainingM });

    if (walking && turn.phase === 'WALKING' && activeProjection && activeLeg) {
      const a = activeLeg.polyline[activeProjection.segIndex];
      const b = activeLeg.polyline[activeProjection.segIndex + 1];
      const bearing = a && b ? initialBearingDeg(a, b) : activeLeg.startBearingDeg;
      if (courseBearing === null || Math.abs(angularError(courseBearing, bearing)) > 5) {
        // Keep native pose drift aligned with the local tangent; the haptic COURSE source
        // already follows it through the getter, so it does not restart on every bend.
        courseBearing = bearing;
        perception.setCourseReference({ bearingDeg: bearing });
      }
      const heading = sensors.getHeading();
      const fused = sensors.getFusedHeadingDeg();
      // Near a maneuver, its dedicated turn flow owns the instructions.
      if (heading && heading.accuracy >= 2 && fused !== null && now() >= heading.timestamp
        && now() - heading.timestamp <= 2000 && remainingM > 25
        && fix.accuracyM <= 20 && activeProjection.distM <= Math.max(12, fix.accuracyM)) {
        const result = stepCorrection(correction, fused, bearing, fix.timestamp);
        correction = result.state;
        if (result.request) say(result.request);
      } else correction = initialCorrection();
    } else correction = initialCorrection();

    updateCrossings(routeAlongM);

    if (mode !== 'CROSSING' && mode !== 'AT_CURB') {
      const leg = route.legs[progress.legIndex];
      outdoor.getState().setBeaconTarget(beaconTargetFor(leg, remainingM, request ? { lat: request.entrance.lat, lng: request.entrance.lng } : null));
    }
    outdoor.getState().setProgress({
      legIndex: progress.legIndex,
      nextManeuverM: remainingM,
      nextCrossingM,
      lastFixCounted: step.counted,
    });
  };

  // --- re-plan (Task 3) -------------------------------------------------------------------

  const replan = async (fix: GeoFix): Promise<void> => {
    if (replanning || !request || !route) return;
    const revision = routeRevision;
    replanning = true;
    speech.clearQueue('NAV');
    say({ text: 'Pause. You are off the route. Recalculating directions.', priority: 'NAV', dedupeKey: 'off-route', cooldownMs: 15000 });
    replans += 1;
    outdoor.getState().bumpReplans();
    // A degraded straight-line route has nothing to fetch: "off route" only means the line
    // moved. Rebuild it from here — no proxy call, so no false "Offline" while Google Routes
    // is disabled (round 6c: this was the "Offline. Signal reading …" heard at home).
    if (route.attribution === DIRECT_ROUTE_ATTRIBUTION) {
      try {
        await installRoute(directRoute({ lat: fix.lat, lng: fix.lng }, request.entrance, request.destName, now()), request, 'REPLANNED');
      } finally {
        replanning = false;
      }
      return;
    }
    try {
      const reply = await Promise.race([
        deps.planner ? deps.planner.run('answer', { question: 'replan', context: { mode: deps.getMode() } }).then((r) => r.output.reply) : Promise.resolve(templateAnswer({ question: 'replan', context: {} }).reply),
        sleep(REPLAN_REPLY_WAIT_MS).then(() => templateAnswer({ question: 'replan', context: {} }).reply),
      ]);
      if (!running || revision !== routeRevision) return;
      say(replanRequest(reply));
      const fresh = await deps.routeClient.fetchRoute({ origin: { lat: fix.lat, lng: fix.lng }, dest: request.entrance, storeId: request.storeId });
      if (!running || revision !== routeRevision) return;
      outdoor.getState().setOffline(false);
      const armedStillThere = armedCrossingId !== null && fresh.crossings.some((c) => c.crossingId === armedCrossingId);
      if (armedCrossingId !== null && !armedStillThere) {
        controller.abort('replan');
        armedCrossingId = null;
      }
      await installRoute(fresh, request, 'REPLANNED');
      if (armedStillThere) reannounceArmedCrossing(fix);
    } catch (e) {
      if (!running || revision !== routeRevision) return;
      // Keep the old route (cached audio keeps playing); the next off-route run tries again.
      // A network / timeout failure is the one connectivity signal B owns: say `offline_notice` once.
      if (e instanceof RouteClientError && (e.kind === 'network' || e.kind === 'timeout')) {
        outdoor.getState().setOffline(true);
        say(offlineNoticeRequest());
      }
    } finally {
      replanning = false;
    }
  };

  // --- route install -------------------------------------------------------------------------

  const installRoute = async (r: RouteResponse, req: StartRequest, how: 'ROUTE_READY' | 'REPLANNED'): Promise<void> => {
    routeRevision += 1;
    const revision = routeRevision;
    installing = true;
    correction = initialCorrection();
    speech.clearQueue('NAV');
    route = r;
    request = req;
    line = buildRouteLine(r.legs);
    progress = initialLegProgress(0);
    turn = initialTurnFlow(0);
    passedCrossings.clear();
    transitionStarted = false;
    remainingM = r.legs[0]?.distanceM ?? null;

    const port = prefetchPortOf(speech);
    const texts = variablePhrases({ legs: r.legs, crossings: r.crossings, warnings: r.warnings, script: r.script });
    const cap = deps.prefetchCapMs ?? 10_000;
    const report = await Promise.race([
      prefetchPhrases(texts, port),
      sleep(cap).then(() => ({ requested: texts.length, ok: 0, failed: ['<timeout>'], elapsedMs: cap })),
    ]);
    if (!running || revision !== routeRevision) return;
    installing = false;
    speech.clearQueue('NAV');
    prefetchReport = { requested: report.requested, ok: report.ok, failed: report.failed };

    outdoor.getState().setRoute({ legs: r.legs, crossings: r.crossings, destName: r.destName, warnings: r.warnings, attribution: r.attribution, planner: r.planner });
    bus.emit({ type: 'ROUTE_READY', legCount: r.legs.length, destName: r.destName, crossingCount: r.crossings.length });
    if (how === 'ROUTE_READY') applyTurn({ type: 'ROUTE_READY', warning: r.warnings[0] ?? null });
    else applyTurn({ type: 'REPLANNED' });
    maybeStartTransition();
  };

  const subscribe = (): void => {
    if (running) return;
    running = true;
    unsubs.push(sensors.subscribeLocation(onFix));
    unsubs.push(sensors.subscribeHeading((h) => {
      const heading = sensors.getFusedHeadingDeg();
      if (!installing && !replanning && WALKING_MODES.has(deps.getMode()) && heading !== null && now() >= h.timestamp && now() - h.timestamp <= 2000) {
        applyTurn({ type: 'HEADING', headingDeg: heading, accuracy: h.accuracy, now: now() });
      }
    }));
    unsubs.push(bus.on('FAR_CURB_REACHED', (e) => onCrossingReleased(e.crossingId)));
    unsubs.push(bus.on('CROSSING_ABORTED', (e) => onCrossingReleased(e.crossingId)));
    // Tear down only when A's store ACCEPTED the handoff (mode reached TRANSITION). A raw
    // STORE_ENTERED fired while AT_CURB / CROSSING is rejected by the store (01 §1) and must
    // not strand the user by disposing the crossing controller mid-crossing. Re-check on the
    // next tick because the store applies the edge synchronously inside the same dispatch.
    unsubs.push(bus.on('STORE_ENTERED', () => {
      const check = (): void => {
        const m = deps.getMode();
        if (m === 'TRANSITION' || m === 'INDOOR_NAV') stop();
      };
      check();
      if (running) setTimeout(check, 0);
    }));
    tick = setInterval(() => {
      if (!installing && !replanning && WALKING_MODES.has(deps.getMode())) applyTurn({ type: 'TICK', now: now() });
    }, TICK_MS);
  };

  const stop = (): void => {
    if (!running && route === null) return;
    running = false;
    routeRevision += 1;
    installing = false;
    // Deliberately no clearQueue('NAV') here. The other clears drop stale route
    // instructions while a route is live; this one is teardown, and the runner
    // stops itself on STORE_ENTERED — the same instant trip.ts enqueues the
    // handoff announcement. Clearing here swallowed "Entering the store.",
    // which 00-PROJECT-BRIEF lists under "Never cut". Abort already cancels a
    // pending announcement through trip.ts.
    if (tick) clearInterval(tick);
    tick = null;
    for (const u of unsubs.splice(0)) u();
    haptics.stopCourse();
    perception.setCourseReference(null);
    outdoor.getState().setBeaconTarget(null);
    controller.dispose();
    deps.transition?.stop();
    route = null;
    line = null;
    armedCrossingId = null;
  };

  const answer: LegRunner['answer'] = async (question) => {
    const leg = route?.legs[progress.legIndex];
    const nextLeg = route?.legs[progress.legIndex + 1];
    const context: Record<string, unknown> = {
      lastPhrase,
      metersToManeuver: remainingM,
      metersToCrossing: nextCrossingM,
      nextManeuver: leg?.maneuver ?? null,
      street: leg?.street ?? '',
      nextStreet: nextLeg?.street ?? '',
      mode: deps.getMode(),
    };
    const template = templateAnswer({ question, context }).reply;
    if (question === 'repeat' || !deps.planner) return template;
    const reply = await Promise.race([
      deps.planner.run('answer', { question, context }).then((r) => r.output.reply),
      sleep(REPLAN_REPLY_WAIT_MS).then(() => template),
    ]);
    return reply;
  };

  return {
    async start(req) {
      const origin = req.origin ?? (() => {
        const fix = sensors.getLastFix();
        return fix ? { lat: fix.lat, lng: fix.lng } : null;
      })();
      if (!origin) throw new Error('LegRunner.start: no origin and no GPS fix yet');
      const routeReq: RouteRequest = { origin, dest: { lat: req.entrance.lat, lng: req.entrance.lng }, storeId: req.storeId };
      const r = await deps.routeClient.fetchRoute(routeReq);
      await this.loadRoute(r, req);
      return r;
    },
    async loadRoute(r, req) {
      subscribe();
      await installRoute(r, req, 'ROUTE_READY');
    },
    onFix,
    answer,
    getRoute: () => route,
    getDebugState: () => ({
      running,
      legIndex: progress.legIndex,
      legCount: route?.legs.length ?? 0,
      remainingM,
      nextCrossingM,
      armedCrossingId,
      turnPhase: turn.phase,
      replans,
      lastPhrase,
      prefetch: prefetchReport,
      transitionStarted,
    }),
    stop,
  };
}
