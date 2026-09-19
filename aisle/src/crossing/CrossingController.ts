/**
 * CrossingController (01 §10, 03 Task 6). One instance; signalized and
 * unsignalized crossings.
 *
 *   ARMED ─curbReached()─▶ ALIGNING ─aligned or 8 s─▶ READING   (signalized !== false)
 *                                                  └─▶ SCANNING  (signalized === false; or READING saw
 *                                                                 only UNKNOWN for 10 s at a null crossing)
 *   READING | SCANNING ─crossingStarted()─▶ CROSSING ─farCurbReached()─▶ DONE
 *   any ─abort()─▶ DONE
 *
 * The controller informs; it never decides. Google data never triggers a walk
 * cue: the only paths to a signal phrase are a `SIGNAL_STATE` event from the
 * perception module, a rung-2 Claude read (prefaced "Signal read is delayed"),
 * or a teammate's `setManualSignal`. Every haptic fires synchronously inside
 * its handler; nothing time-critical waits on the network.
 */
import type {
  AppMode,
  CacheKey,
  Crossing,
  CrossingController,
  Detection,
  Direction,
  EventBus,
  GeoFix,
  HapticService,
  PerceptionService,
  Pose,
  SensorService,
  SignalState,
  Side,
  SpeechRequest,
  SpeechService,
  VehiclesSeen,
  VisionRequest,
  VisionResponse,
} from '../core/contracts';
import { PHRASES } from '../core/phrases';
import { haversineM, type LatLng } from '../outdoor/geo';
import { SIGNAL_READ_DELAYED_TEXT } from '../outdoor/guidance';
import { angularError } from '../outdoor/legs';
import type { OutdoorStore, SignalSource } from '../outdoor/store';
import { crossingLengthM } from './crossingData';
import {
  crossingStarted as crossingStartedRule,
  decideSignalPhrase,
  farCurbReached as farCurbRule,
  fixNearFarCurb,
  initialSignalTrack,
  initialStillness,
  isStoppedAtCurb,
  noteFixMotion,
  noteStep,
  poseDisplacementAlongM,
  scanBearingFor,
  scanReportKeys,
  stillForMs,
  unknownTimedOut,
  walkedPast,
  worstVerdict,
  SCAN_HEADING_TOLERANCE_DEG,
  type ControllerState,
  type SignalTrack,
  type StillnessTrack,
} from './crossingLogic';

export interface VisionAsk {
  ask(req: VisionRequest): Promise<VisionResponse>;
}

export interface CrossingControllerDeps {
  haptics: HapticService;
  speech: SpeechService;
  sensors: SensorService;
  perception: PerceptionService;
  bus: EventBus;
  outdoor: OutdoorStore;
  /** C's SemanticVision client (or D's mock). Optional: rung 2 and the scan stills fail closed to `unclear`. */
  vision?: VisionAsk;
  getMode?: () => AppMode;
  /** LegRunner hook: re-target COURSE to the current leg after abort / far curb. */
  onReleased?: () => void;
  now?: () => number;
}

export const ALIGN_TIMEOUT_MS = 8000;
export const ALIGN_DEAD_ZONE_DEG = 12;
export const SCAN_WINDOW_MS = 2000;
export const SCAN_STILL_AT_MS = 1000;
export const SCAN_TURN_TIMEOUT_MS = 4000;
export const SCAN_HEADING_POLL_MS = 200;
export const LISTEN_PAUSE_MS = 2000;
export const VISION_FRESHNESS_CROSSING_MS = 3000;
export const CURB_CROP_INTERVAL_MS = 1000;
export const CURB_CROP_MAX_IN_FLIGHT = 3;
export const CURB_CROP_MIN_CONFIDENCE = 0.5;
export const SIGNAL_COOLDOWN_MS = 8000;

const SIGNAL_KEY_TEXT: Record<'walk_signal_on' | 'walk_already_on_wait' | 'dont_walk' | 'countdown' | 'cant_see_signal', string> = {
  walk_signal_on: PHRASES.walk_signal_on,
  walk_already_on_wait: PHRASES.walk_already_on_wait,
  dont_walk: PHRASES.dont_walk,
  countdown: PHRASES.countdown,
  cant_see_signal: PHRASES.cant_see_signal,
};

export interface CrossingDebugState {
  state: ControllerState;
  crossing: Crossing | null;
  signalSource: SignalSource;
  lastSignal: { state: SignalState; fresh: boolean } | null;
  manualSignal: SignalState | null;
  ladderRung: 1 | 2 | 3 | 4;
  scanVerdicts: { left: VehiclesSeen | null; right: VehiclesSeen | null };
  scanRuns: number;
  curbCropInFlight: number;
  curbCropSeqApplied: number;
  utterances: number;
  timers: { unknownSinceMs: number | null; alignedAt: number | null; curbAt: number | null };
}

export interface AisleCrossingController extends CrossingController {
  abort(reason?: 'user' | 'walked_past' | 'replan'): void;
  getState(): ControllerState;
  getDebugState(): CrossingDebugState;
  /** LegRunner feeds every location fix here (curb detection, walked-past, far curb). */
  observeFix(fix: GeoFix): void;
  dispose(): void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function createCrossingController(deps: CrossingControllerDeps): AisleCrossingController {
  const now = deps.now ?? Date.now;
  const { haptics, speech, sensors, perception, bus, outdoor } = deps;

  let state: ControllerState = 'IDLE';
  let crossing: Crossing | null = null;
  let signalTrack: SignalTrack = initialSignalTrack(0);
  let lastSignal: { state: SignalState; fresh: boolean } | null = null;
  let manualSignal: SignalState | null = null;
  let signalSource: SignalSource = 'none';
  let ladderRung: 1 | 2 | 3 | 4 = 1;
  let utterances = 0;
  let scanRuns = 0;
  let scanVerdicts: { left: VehiclesSeen | null; right: VehiclesSeen | null } = { left: null, right: null };
  let scanInProgress = false;
  let scanGeneration = 0;
  let curbAt: number | null = null;
  let alignedAt: number | null = null;
  let stillness: StillnessTrack = initialStillness(0);
  let posesAtCurb: Pose | null = null;
  let lastPose: Pose | null = null;
  let goodFixesNearFar = 0;
  let lastDetections: Detection[] = [];
  let seq = 0;
  let curbCropInFlight = 0;
  let curbCropSeqApplied = 0;
  let curbCropTimer: ReturnType<typeof setInterval> | null = null;
  let delayedPrefaceSaid = false;
  let alignTimer: ReturnType<typeof setTimeout> | null = null;
  let unknownTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const unsubs: Array<() => void> = [];
  const armedUnsubs: Array<() => void> = [];

  // --- helpers ------------------------------------------------------------

  const say = (req: SpeechRequest): void => {
    utterances += 1;
    outdoor.getState().countUtterance();
    speech.say(req);
  };

  const sayKey = (key: CacheKey, opts: { priority?: SpeechRequest['priority']; cooldownMs?: number; interrupt?: boolean; dedupeKey?: string } = {}): void => {
    const req: SpeechRequest = {
      text: PHRASES[key],
      cacheKey: key,
      priority: opts.priority ?? 'NAV',
      dedupeKey: opts.dedupeKey ?? key,
      cooldownMs: opts.cooldownMs ?? SIGNAL_COOLDOWN_MS,
    };
    if (opts.interrupt) req.interrupt = true;
    say(req);
  };

  const setState = (next: ControllerState): void => {
    state = next;
    outdoor.getState().setCrossingDebug({ crossingState: next, signalSource, scanVerdicts });
  };

  const setSource = (s: SignalSource): void => {
    signalSource = s;
    outdoor.getState().setCrossingDebug({ signalSource: s });
  };

  const clearTimers = (): void => {
    if (alignTimer) clearTimeout(alignTimer);
    if (unknownTimer) clearTimeout(unknownTimer);
    alignTimer = null;
    unknownTimer = null;
    stopCurbCrop();
  };

  const releaseArmed = (): void => {
    for (const u of armedUnsubs.splice(0)) u();
  };

  const headingDeg = (): number | null => {
    const fused = sensors.getFusedHeadingDeg();
    if (fused !== null) return fused;
    return sensors.getHeading()?.trueHeadingDeg ?? null;
  };

  const modeNow = (): AppMode => deps.getMode?.() ?? 'AT_CURB';

  // --- rung 2: Sonnet curb crop ---------------------------------------------

  const stopCurbCrop = (): void => {
    if (curbCropTimer) clearInterval(curbCropTimer);
    curbCropTimer = null;
  };

  const startCurbCrop = (): void => {
    if (!deps.vision || curbCropTimer || !crossing) {
      if (!deps.vision) ladderRung = 3;
      return;
    }
    ladderRung = 2;
    setSource('claude');
    curbCropTimer = setInterval(() => {
      void curbCropOnce();
    }, CURB_CROP_INTERVAL_MS);
  };

  const curbCropOnce = async (): Promise<void> => {
    if (!deps.vision || !crossing || curbCropInFlight >= CURB_CROP_MAX_IN_FLIGHT || state !== 'READING') return;
    curbCropInFlight += 1;
    const mySeq = ++seq;
    const sentAt = now();
    try {
      const snap = await perception.snapshotJPEG(1024);
      const req: VisionRequest = {
        seq: mySeq,
        question: 'curb_crop',
        mode: modeNow(),
        image: { base64: snap.base64, width: snap.width, height: snap.height },
        facts: { detections: lastDetections, ocr: [], headingDeg: headingDeg() ?? undefined, signalState: lastSignal?.state ?? 'UNKNOWN' },
      };
      const res = await deps.vision.ask(req);
      if (now() - sentAt > VISION_FRESHNESS_CROSSING_MS) return;           // stale: dropped, never spoken
      if (mySeq < curbCropSeqApplied || state !== 'READING' || ladderRung !== 2) return;
      curbCropSeqApplied = mySeq;
      const confident = res.confidence >= CURB_CROP_MIN_CONFIDENCE && res.signal.confidence >= CURB_CROP_MIN_CONFIDENCE;
      const st: SignalState = confident ? res.signal.state : 'UNKNOWN';
      if (st === 'UNKNOWN') return;
      if (!delayedPrefaceSaid) {
        delayedPrefaceSaid = true;
        say({ text: SIGNAL_READ_DELAYED_TEXT, cacheKey: 'signal_read_delayed', priority: 'NAV', dedupeKey: 'signal-delayed', cooldownMs: 60_000 });
      }
      // A cloud read never claims a fresh onset: WALK from rung 2 is "already on".
      applySignal({ state: st, fresh: false }, 'claude');
    } catch {
      // fail closed: silence
    } finally {
      curbCropInFlight -= 1;
    }
  };

  // --- signal --------------------------------------------------------------

  const armUnknownTimer = (): void => {
    if (unknownTimer) clearTimeout(unknownTimer);
    unknownTimer = setTimeout(() => {
      unknownTimer = null;
      if (state !== 'READING' || !crossing) return;
      if (unknownTimedOut(signalTrack, now())) applySignal({ state: 'UNKNOWN', fresh: false }, signalSource === 'none' ? 'live' : signalSource);
    }, 10_050);
  };

  const applySignal = (e: { state: SignalState; fresh: boolean }, source: SignalSource): void => {
    if (state !== 'READING' || !crossing) return;
    lastSignal = e;
    const decision = decideSignalPhrase(signalTrack, e, now());
    signalTrack = decision.track;
    if (e.state !== 'UNKNOWN') {
      setSource(source);
      if (source === 'live' && ladderRung === 2) {
        // The live stream is back: rung 2 stops the moment it returns a state.
        stopCurbCrop();
        ladderRung = 1;
      }
    }
    if (decision.key) sayKey(decision.key, { cooldownMs: SIGNAL_COOLDOWN_MS });
    if (decision.enterLadder) {
      if (crossing.signalized === null) {
        // Nothing to read: the crossing behaves as unsignalized from here.
        void startUnsignalizedScan();
      } else {
        startCurbCrop();
      }
    } else if (e.state === 'UNKNOWN') {
      armUnknownTimer();
    }
  };

  // --- alignment -------------------------------------------------------------

  const finishAlignment = (): void => {
    if (state !== 'ALIGNING' || !crossing) return;
    if (alignTimer) clearTimeout(alignTimer);
    alignTimer = null;
    alignedAt = now();
    if (crossing.signalized === false) {
      setState('SCANNING');
      void startUnsignalizedScan();
      return;
    }
    setState('READING');
    signalTrack = initialSignalTrack(now());
    if (manualSignal) applySignal({ state: manualSignal, fresh: true }, 'manual');
    else armUnknownTimer();
  };

  const onHeadingWhileAligning = (): void => {
    if (state !== 'ALIGNING' || !crossing) return;
    const h = headingDeg();
    const acc = sensors.getHeading()?.accuracy ?? 0;
    if (h === null || acc < 2) return;
    const zone = acc === 3 ? ALIGN_DEAD_ZONE_DEG : 18;
    if (Math.abs(angularError(h, crossing.bearingDeg)) <= zone) finishAlignment();
  };

  // --- motion (crossing start / far curb) -----------------------------------

  const stepsSinceCurb = (): number => (curbAt === null ? 0 : sensors.getStepsSince(curbAt));

  const displacementM = (): number | null => {
    if (!crossing || !posesAtCurb || !lastPose || lastPose.trackingState === 'NOT_AVAILABLE') return null;
    return poseDisplacementAlongM(posesAtCurb, lastPose, crossing.bearingDeg);
  };

  const checkMotion = (): void => {
    if (!crossing) return;
    if (state === 'READING' || state === 'SCANNING') {
      if (crossingStartedRule({ stepsSinceCurb: stepsSinceCurb(), displacementM: displacementM() })) crossingStarted();
      return;
    }
    if (state === 'CROSSING') {
      const lengthM = crossingLengthM(crossing);
      if (farCurbRule({ lengthM, displacementM: displacementM(), goodFixesNearFar, stepsSinceCurb: stepsSinceCurb() })) farCurbReached();
    }
  };

  // --- public API ------------------------------------------------------------

  const arm: CrossingController['arm'] = (c) => {
    if (disposed) return;
    if (state !== 'IDLE' && state !== 'DONE') abortInternal('replan', false);
    crossing = c;
    manualSignal = manualSignal ?? null;
    ladderRung = 1;
    delayedPrefaceSaid = false;
    scanVerdicts = { left: null, right: null };
    goodFixesNearFar = 0;
    curbAt = null;
    alignedAt = null;
    posesAtCurb = null;
    stillness = initialStillness(now());
    signalTrack = initialSignalTrack(now());
    lastSignal = null;
    setSource('none');
    setState('ARMED');
    perception.setCrossingBearing(c.bearingDeg);

    armedUnsubs.push(bus.on('SIGNAL_STATE', (e) => {
      if (manualSignal !== null) return;
      applySignal({ state: e.state, fresh: e.fresh }, 'live');
    }));
    armedUnsubs.push(sensors.subscribeHeading(() => onHeadingWhileAligning()));
    armedUnsubs.push(sensors.subscribeSteps(() => {
      stillness = noteStep(stillness, now());
      checkMotion();
    }));
    armedUnsubs.push(sensors.subscribePose((p) => {
      lastPose = p;
      if (state === 'CROSSING' || state === 'READING' || state === 'SCANNING') checkMotion();
    }));
    armedUnsubs.push(perception.onDetections((d) => {
      lastDetections = d;
    }));
    let lastRescan = outdoor.getState().rescanRequests;
    armedUnsubs.push(outdoor.subscribe((s) => {
      if (s.rescanRequests !== lastRescan) {
        lastRescan = s.rescanRequests;
        if (state === 'SCANNING' || (state === 'READING' && crossing?.signalized === null)) void startUnsignalizedScan();
      }
    }));
  };

  const observeFix = (fix: GeoFix): void => {
    if (!crossing || state === 'IDLE' || state === 'DONE') return;
    const here: LatLng = { lat: fix.lat, lng: fix.lng };
    const t = now();
    stillness = noteFixMotion(stillness, fix, t);
    if (state === 'ARMED') {
      if (walkedPast(here, crossing.nearCurb, crossing.farCurb)) {
        abortInternal('walked_past', true);
        return;
      }
      const distToNearCurbM = haversineM(here, crossing.nearCurb);
      if (isStoppedAtCurb({ distToNearCurbM, stillForMs: stillForMs(stillness, t) })) curbReached();
      return;
    }
    if (state === 'CROSSING') {
      goodFixesNearFar = fixNearFarCurb(fix, crossing.farCurb) ? goodFixesNearFar + 1 : 0;
      checkMotion();
    }
  };

  const curbReached: CrossingController['curbReached'] = () => {
    if (!crossing || state !== 'ARMED') return;
    curbAt = now();
    posesAtCurb = lastPose;
    bus.emit({ type: 'CURB_REACHED', crossingId: crossing.crossingId });
    setState('ALIGNING');
    // Alignment to the crossing bearing, no line; silence means aligned; A's
    // service plays the one CONFIRM on the first re-entry.
    haptics.play('TURN');
    haptics.stopCourse();
    haptics.startCourse(sensors.courseErrorFor({ bearingDeg: crossing.bearingDeg, roadSide: 'NONE' }));
    outdoor.getState().setBeaconTarget(null);
    alignTimer = setTimeout(finishAlignment, ALIGN_TIMEOUT_MS);
    onHeadingWhileAligning();
  };

  const signalUpdate: CrossingController['signalUpdate'] = (e) => {
    if (manualSignal !== null) return;
    applySignal(e, 'live');
  };

  const setManualSignal: CrossingController['setManualSignal'] = (s) => {
    manualSignal = s;
    if (s === null) {
      if (state === 'READING') {
        setSource('live');
        signalTrack = initialSignalTrack(now());
        armUnknownTimer();
      }
      return;
    }
    ladderRung = 4;
    stopCurbCrop();
    if (state === 'READING') applySignal({ state: s, fresh: true }, 'manual');
  };

  // --- unsignalized scan -------------------------------------------------------

  const waitForHeading = async (target: number, generation: number): Promise<void> => {
    const deadline = now() + SCAN_TURN_TIMEOUT_MS;
    while (now() < deadline && generation === scanGeneration) {
      const h = headingDeg();
      if (h !== null && Math.abs(angularError(h, target)) <= SCAN_HEADING_TOLERANCE_DEG) return;
      await sleep(SCAN_HEADING_POLL_MS);
    }
  };

  const scanWindow = async (side: Side, generation: number): Promise<VehiclesSeen> => {
    if (!crossing) return 'unclear';
    let approaching = false;
    const unsub = bus.on('VEHICLE_APPROACHING', () => {
      approaching = true;
    });
    let claudeVerdict: VehiclesSeen | null = null;
    let claudePromise: Promise<void> | null = null;
    const question = side === 'LEFT' ? 'scan_left' : 'scan_right';
    try {
      await sleep(SCAN_STILL_AT_MS);
      if (generation !== scanGeneration) return 'unclear';
      if (deps.vision) {
        const vision = deps.vision;
        const mySeq = ++seq;
        const sentAt = now();
        claudePromise = (async () => {
          try {
            const snap = await perception.snapshotJPEG(512);
            const res = await Promise.race([
              vision.ask({
                seq: mySeq,
                question,
                mode: modeNow(),
                image: { base64: snap.base64, width: snap.width, height: snap.height },
                facts: { detections: lastDetections, ocr: [], headingDeg: headingDeg() ?? undefined },
              }),
              sleep(VISION_FRESHNESS_CROSSING_MS).then(() => null),
            ]);
            if (res === null || now() - sentAt > VISION_FRESHNESS_CROSSING_MS || res.confidence < 0.5 || res.scan.confidence < 0.5) {
              claudeVerdict = 'unclear';
            } else {
              claudeVerdict = res.scan.vehiclesSeen;
            }
          } catch {
            claudeVerdict = 'unclear';
          }
        })();
      }
      await sleep(SCAN_WINDOW_MS - SCAN_STILL_AT_MS);
    } finally {
      unsub();
    }
    if (generation !== scanGeneration) return 'unclear';
    const detector: VehiclesSeen = approaching ? 'approaching' : 'none';
    bus.emit({ type: 'SCAN_RESULT', side, vehiclesSeen: detector, source: 'detector' });
    if (claudePromise) {
      await claudePromise;
      const v: VehiclesSeen = claudeVerdict ?? 'unclear';
      bus.emit({ type: 'SCAN_RESULT', side, vehiclesSeen: v, source: 'claude' });
      return worstVerdict(detector, v);
    }
    return detector;
  };

  const startUnsignalizedScan: CrossingController['startUnsignalizedScan'] = async () => {
    if (!crossing || (state !== 'SCANNING' && state !== 'READING')) return;
    if (scanInProgress) return;
    scanInProgress = true;
    const generation = ++scanGeneration;
    scanRuns += 1;
    if (state === 'READING') {
      stopCurbCrop();
      setState('SCANNING');
    }
    try {
      sayKey('no_signal_point_left', { cooldownMs: 1000, dedupeKey: `scan-left-${scanRuns}` });
      await waitForHeading(scanBearingFor(crossing.bearingDeg, 'LEFT'), generation);
      if (generation !== scanGeneration || state !== 'SCANNING') return;
      const left = await scanWindow('LEFT', generation);
      if (generation !== scanGeneration || state !== 'SCANNING') return;
      scanVerdicts = { left, right: null };
      sayKey('now_right', { cooldownMs: 1000, dedupeKey: `scan-right-${scanRuns}` });
      await waitForHeading(scanBearingFor(crossing.bearingDeg, 'RIGHT'), generation);
      if (generation !== scanGeneration || state !== 'SCANNING') return;
      const right = await scanWindow('RIGHT', generation);
      if (generation !== scanGeneration || state !== 'SCANNING') return;
      scanVerdicts = { left, right };
      outdoor.getState().setCrossingDebug({ scanVerdicts: { left, right } });
      // Listening pause: nothing plays.
      await sleep(LISTEN_PAUSE_MS);
      if (generation !== scanGeneration || state !== 'SCANNING') return;
      const keys = scanReportKeys(left, right);
      keys.forEach((k, i) => sayKey(k, { priority: 'CRITICAL', interrupt: false, cooldownMs: 1000, dedupeKey: `scan-report-${scanRuns}-${i}` }));
    } finally {
      if (generation === scanGeneration) scanInProgress = false;
    }
  };

  // --- crossing ------------------------------------------------------------------

  const crossingStarted: CrossingController['crossingStarted'] = () => {
    if (!crossing || (state !== 'READING' && state !== 'SCANNING')) return;
    scanGeneration += 1;
    scanInProgress = false;
    stopCurbCrop();
    if (unknownTimer) clearTimeout(unknownTimer);
    unknownTimer = null;
    setState('CROSSING');
    bus.emit({ type: 'CROSSING_STARTED', crossingId: crossing.crossingId });
    perception.setCourseReference({ bearingDeg: crossing.bearingDeg });
    haptics.stopCourse();
    haptics.startCourse(sensors.courseErrorFor({ bearingDeg: crossing.bearingDeg, line: [crossing.nearCurb, crossing.farCurb], roadSide: 'NONE' }));
    outdoor.getState().setBeaconTarget({ lat: crossing.farCurb.lat, lng: crossing.farCurb.lng });
    goodFixesNearFar = 0;
  };

  const farCurbReached: CrossingController['farCurbReached'] = () => {
    if (!crossing || state !== 'CROSSING') return;
    const id = crossing.crossingId;
    haptics.play('CONFIRM');
    sayKey('far_curb', { cooldownMs: 30_000 });
    outdoor.getState().setBeaconTarget(null);
    perception.setCrossingBearing(null);
    perception.setCourseReference(null);
    clearTimers();
    releaseArmed();
    setState('DONE');
    bus.emit({ type: 'FAR_CURB_REACHED', crossingId: id });
    deps.onReleased?.();
  };

  const abortInternal = (reason: 'user' | 'walked_past' | 'replan', emit: boolean): void => {
    const id = crossing?.crossingId ?? null;
    const wasActive = state !== 'IDLE' && state !== 'DONE';
    scanGeneration += 1;
    scanInProgress = false;
    clearTimers();
    releaseArmed();
    perception.setCrossingBearing(null);
    outdoor.getState().setBeaconTarget(null);
    setSource('none');
    setState('DONE');
    if (emit && wasActive && id !== null) bus.emit({ type: 'CROSSING_ABORTED', crossingId: id, reason });
    deps.onReleased?.();
  };

  const abort = (reason: 'user' | 'walked_past' | 'replan' = 'user'): void => {
    abortInternal(reason, true);
  };

  const getDebugState = (): CrossingDebugState => ({
    state,
    crossing,
    signalSource,
    lastSignal,
    manualSignal,
    ladderRung,
    scanVerdicts,
    scanRuns,
    curbCropInFlight,
    curbCropSeqApplied,
    utterances,
    timers: { unknownSinceMs: signalTrack.unknownSince === null ? null : now() - signalTrack.unknownSince, alignedAt, curbAt },
  });

  const dispose = (): void => {
    disposed = true;
    scanGeneration += 1;
    clearTimers();
    releaseArmed();
    for (const u of unsubs.splice(0)) u();
    state = 'IDLE';
  };

  return {
    arm,
    curbReached,
    signalUpdate,
    startUnsignalizedScan,
    crossingStarted,
    farCurbReached,
    setManualSignal,
    abort,
    getState: () => state,
    getDebugState,
    observeFix,
    dispose,
  };
}

/** Direction → phrase key, for DebugPanel labels. */
export const VEHICLE_DIRECTION_KEY: Readonly<Record<Direction, CacheKey>> = { LEFT: 'vehicle_left', RIGHT: 'vehicle_right', CENTER: 'vehicle_ahead' };

export { SIGNAL_KEY_TEXT };
