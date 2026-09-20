import { usableOutdoorFix } from '../outdoor/legs';
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
import { pedSignalModelPresent } from '../perception/PerceptionService';
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
  START_HEADING_OFF_MAX_DEG,
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
/** Gap between the lines of the scan report: each line is re-checked against the state before it is queued. */
export const SCAN_REPORT_LINE_GAP_MS = 1500;
/** After the last report line is queued, stepping off within this window flushes the report (nothing of it plays in the roadway). */
export const SCAN_REPORT_FLUSH_WINDOW_MS = 3000;

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
  /** Until when a queued scan report may still be playing (0 = none). */
  let reportUntil = 0;
  let curbAt: number | null = null;
  /** Start of the step count for the no-pose start rule; re-based while the rule is suppressed. */
  let stepsFrom: number | null = null;
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
    const raw = sensors.getHeading();
    return raw && raw.accuracy >= 2 && now() >= raw.timestamp && now() - raw.timestamp <= 2000 ? raw.trueHeadingDeg : null;
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
    const facing = headingDeg();
    if (facing === null || (sensors.getHeading()?.accuracy ?? 0) < 2
      || Math.abs(angularError(facing, crossing.bearingDeg)) > 20) return;
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
      const currentFacing = headingDeg();
      if (!crossing || currentFacing === null || Math.abs(angularError(currentFacing, crossing.bearingDeg)) > 20) return;
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

  /** True unless the engine reports the pedestrian-signal model MISSING (null/unknown → trusted, e.g. mock). */
  const pedSignalReady = (): boolean | null => pedSignalModelPresent(perception.debugLog?.() ?? []);

  const applySignal = (e: { state: SignalState; fresh: boolean }, source: SignalSource): void => {
    if (state !== 'READING' || !crossing) return;
    // Safety: with no on-device pedestrian-signal model, a "live" read is unverifiable — never
    // let it claim WALK (or any state). It becomes UNKNOWN and the honest fallback ladder runs.
    if (source === 'live' && pedSignalReady() === false) e = { state: 'UNKNOWN', fresh: false };
    lastSignal = e;
    const decision = decideSignalPhrase(signalTrack, e, now());
    signalTrack = decision.track;
    if (e.state !== 'UNKNOWN') {
      setSource(source);
      if (unknownTimer) clearTimeout(unknownTimer);
      // Native heartbeats arrive every two seconds. Silence invalidates the old state.
      unknownTimer = source === 'manual' ? null : setTimeout(() => {
        unknownTimer = null;
        applySignal({ state: 'UNKNOWN', fresh: false }, source);
      }, 4500);
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
    if (manualSignal) {
      applySignal({ state: manualSignal, fresh: true }, 'manual');
    } else if (pedSignalReady() === false) {
      // No pedestrian-signal model in this build: say so at once and drop to the delayed cloud
      // read (or, for an unmapped crossing, the scan) — never wait on a live read that cannot come.
      sayKey('cant_see_signal', { cooldownMs: SIGNAL_COOLDOWN_MS });
      signalTrack = { ...signalTrack, cantSeeSaid: true };
      if (crossing.signalized === null) void startUnsignalizedScan();
      else startCurbCrop();
    } else {
      armUnknownTimer();
    }
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

  /** Steps that count toward the no-pose start rule: since the curb, or since the last suppressed step. */
  const stepsForStart = (): number => {
    if (curbAt === null) return 0;
    return sensors.getStepsSince(Math.max(curbAt, stepsFrom ?? curbAt));
  };

  const displacementM = (): number | null => {
    if (!crossing || !posesAtCurb || !lastPose || lastPose.trackingState === 'NOT_AVAILABLE') return null;
    return poseDisplacementAlongM(posesAtCurb, lastPose, crossing.bearingDeg);
  };

  const checkMotion = (): void => {
    if (!crossing) return;
    if (state === 'READING' || state === 'SCANNING') {
      const h = headingDeg();
      const headingOffDeg = h === null ? null : Math.abs(angularError(h, crossing.bearingDeg));
      // Pedometer shuffles during the left/right scan, or while turned away from the
      // crossing, never count: re-base the step count so they cannot fire later either.
      if (scanInProgress || (headingOffDeg !== null && headingOffDeg > START_HEADING_OFF_MAX_DEG)) stepsFrom = now();
      // Steps are the no-pose fallback only: with tracking NORMAL, displacement along the bearing decides.
      const displacement = lastPose?.trackingState === 'NORMAL' ? displacementM() : null;
      if (crossingStartedRule({ stepsSinceCurb: stepsForStart(), displacementM: displacement, scanInProgress, headingOffDeg })) crossingStarted();
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
    stepsFrom = null;
    reportUntil = 0;
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
      const reliable = Number.isFinite(e.confidence) && e.confidence >= 0.5;
      applySignal({ state: reliable ? e.state : 'UNKNOWN', fresh: reliable && e.fresh }, 'live');
    }));
    armedUnsubs.push(sensors.subscribeHeading(() => onHeadingWhileAligning()));
    armedUnsubs.push(sensors.subscribeSteps(() => {
      stillness = noteStep(stillness, now());
      checkMotion();
    }));
    armedUnsubs.push(sensors.subscribePose((p) => {
      lastPose = p;
      // No pose was available when the curb was reached: the first NORMAL pose at the curb is the origin.
      if (posesAtCurb === null && curbAt !== null && p.trackingState === 'NORMAL' && (state === 'ALIGNING' || state === 'READING' || state === 'SCANNING')) {
        posesAtCurb = p;
        return;
      }
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
    const t = now();
    if (!usableOutdoorFix(fix, t, 20)) {
      goodFixesNearFar = 0;
      stillness = initialStillness(t);
      return;
    }
    const here: LatLng = { lat: fix.lat, lng: fix.lng };
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
    stepsFrom = curbAt;
    posesAtCurb = lastPose?.trackingState === 'NORMAL' ? lastPose : null;
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

  const waitForHeading = async (target: number, generation: number): Promise<boolean> => {
    const deadline = now() + SCAN_TURN_TIMEOUT_MS;
    while (now() < deadline && generation === scanGeneration) {
      const h = headingDeg();
      if (h !== null && (sensors.getHeading()?.accuracy ?? 0) >= 2 && Math.abs(angularError(h, target)) <= SCAN_HEADING_TOLERANCE_DEG) return true;
      await sleep(SCAN_HEADING_POLL_MS);
    }
    return false;
  };

  const scanWindow = async (side: Side, generation: number): Promise<VehiclesSeen> => {
    if (!crossing) return 'unclear';
    let approaching = false;
    let detectorFrames = 0;
    const stopFrames = perception.onDetections(() => { detectorFrames += 1; });
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
            // The whole snapshot + ask chain races the freshness budget: a slow or hung
            // native snapshot closes the window with `unclear`, never stalls the scan.
            const res = await Promise.race([
              (async () => {
                const snap = await perception.snapshotJPEG(512);
                return vision.ask({
                  seq: mySeq,
                  question,
                  mode: modeNow(),
                  image: { base64: snap.base64, width: snap.width, height: snap.height },
                  facts: { detections: lastDetections, ocr: [], headingDeg: headingDeg() ?? undefined },
                });
              })(),
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
      stopFrames();
    }
    if (generation !== scanGeneration) return 'unclear';
    const detector: VehiclesSeen = approaching ? 'approaching' : detectorFrames >= 2 ? 'none' : 'unclear';
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
      const facingLeft = await waitForHeading(scanBearingFor(crossing.bearingDeg, 'LEFT'), generation);
      if (generation !== scanGeneration || state !== 'SCANNING') return;
      const left = facingLeft ? await scanWindow('LEFT', generation) : 'unclear';
      if (generation !== scanGeneration || state !== 'SCANNING') return;
      scanVerdicts = { left, right: null };
      sayKey('now_right', { cooldownMs: 1000, dedupeKey: `scan-right-${scanRuns}` });
      const facingRight = await waitForHeading(scanBearingFor(crossing.bearingDeg, 'RIGHT'), generation);
      if (generation !== scanGeneration || state !== 'SCANNING') return;
      const right = facingRight ? await scanWindow('RIGHT', generation) : 'unclear';
      if (generation !== scanGeneration || state !== 'SCANNING') return;
      scanVerdicts = { left, right };
      outdoor.getState().setCrossingDebug({ scanVerdicts: { left, right } });
      // Listening pause: nothing plays.
      await sleep(LISTEN_PAUSE_MS);
      if (generation !== scanGeneration || state !== 'SCANNING') return;
      // The report stays CRITICAL (NAV is newest-wins: three back-to-back NAV lines would
      // drop the middle one) but is paced, and every line is re-checked against the
      // state before it is queued; crossingStarted() flushes whatever is still queued.
      const keys = scanReportKeys(left, right);
      for (let i = 0; i < keys.length; i += 1) {
        if (i > 0) await sleep(SCAN_REPORT_LINE_GAP_MS);
        if (generation !== scanGeneration || state !== 'SCANNING') return;
        sayKey(keys[i], { priority: 'CRITICAL', interrupt: false, cooldownMs: 1000, dedupeKey: `scan-report-${scanRuns}-${i}` });
        reportUntil = now() + SCAN_REPORT_FLUSH_WINDOW_MS;
      }
    } finally {
      if (generation === scanGeneration) scanInProgress = false;
    }
  };

  // --- crossing ------------------------------------------------------------------

  const crossingStarted: CrossingController['crossingStarted'] = () => {
    if (!crossing || (state !== 'READING' && state !== 'SCANNING')) return;
    scanGeneration += 1;
    scanInProgress = false;
    // Nothing of the scan report ("Listen, then cross.") plays in the roadway: flush what is
    // still queued. Only while a report is in flight, so a vehicle alert is never collateral.
    if (now() < reportUntil) {
      speech.clearQueue('CRITICAL');
      reportUntil = 0;
    }
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
