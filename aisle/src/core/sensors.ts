/**
 * SensorService (01 §4, 02 Task 6).
 *
 * Heading comes from `expo-location.watchHeadingAsync` (`trueHeading` plus the
 * 0–3 accuracy tier), never the raw magnetometer. Location is
 * `watchPositionAsync` at `BestForNavigation`. Steps come from the
 * `expo-sensors` Pedometer. Pose is re-emitted from Agent C's
 * PerceptionService when it is attached.
 *
 * Fusion (`HeadingFuser`, pure): ARKit `yawDeg` plus a correction
 * `offset = circularMean(trueHeading − yaw)` over the last 10 s of samples
 * taken while compass tier ≥ 2 and tracking NORMAL, minus `bodyOffsetDeg`.
 * Tracking not NORMAL → gated `trueHeading` alone. Compass below 2 with
 * tracking NORMAL → yaw + last offset for ≤ 30 s, then null. The fused sample
 * inherits the compass tier from the last offset refresh, so
 * `CourseError.compassAccuracy` stays honest.
 *
 * Body offset sign convention (shared with C's `setBodyOffsetDeg`):
 *   bodyOffsetDeg = phoneHeading − travelDirection, so
 *   bodyHeading   = phoneHeading − bodyOffsetDeg.
 *
 * `courseErrorFor(target)` is the producer for `HapticService.startCourse`:
 * heading error from the fused heading; cross-track from, in order of trust,
 * C's lateral offset (`pose` | `curb`, < 1 s old), else dead reckoning
 * (Σ sin(headingError) × 0.7 m per step) against `line`, re-anchored by GPS
 * only when `accuracyM ≤ 10`. Only the perception-sourced value is handed to
 * the COURSE rule (`crossTrackM` is 0 otherwise); the GPS / dead-reckoning
 * estimate is kept in the debug state as `rawCrossTrackM`.
 *
 * The platform is behind `SensorSources` so the whole service is unit-tested
 * with scripted samples; `EXPO_PUBLIC_MOCK=1` swaps the entire service for
 * D's replayer at the composition root, never here.
 */
import type {
  CompassAccuracy, CourseError, GeoFix, HeadingSample, PerceptionService, Pose, SensorService, TrackingState,
} from './contracts';
import type { AppStore } from './store';
import { circularMeanOffsetDeg, circularStats, normalizeDeg, wrapDeg180, DEG_TO_RAD } from './angles';
import { projectOntoLine, type LatLng } from './geo';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const STRIDE_M = 0.7;
export const GPS_ANCHOR_MAX_ACCURACY_M = 10;
export const LATERAL_FRESH_MS = 1000;
export const POSE_FRESH_MS = 500;
export const OFFSET_WINDOW_MS = 10_000;
export const OFFSET_HOLD_MS = 30_000;
export const OFFSET_PAIR_MAX_SKEW_MS = 250;
export const MIN_COURSE_SPEED_MPS = 0.5;
export const CALIBRATION_WINDOW_MS = 5000;
export const CALIBRATION_MAX_SPREAD_DEG = 15;
export const CALIBRATION_MIN_SAMPLES = 3;
export const RECAL_DISAGREE_DEG = 10;
export const RECAL_DISAGREE_MS = 10_000;
export const STEP_RING_SIZE = 600;

// ---------------------------------------------------------------------------
// Pure: heading fusion
// ---------------------------------------------------------------------------

export interface FusedHeading {
  deg: number;
  accuracy: CompassAccuracy;
  source: 'fused' | 'compass' | 'pose_hold';
}

export class HeadingFuser {
  private heading: HeadingSample | null = null;
  private pose: Pose | null = null;
  private tracking: TrackingState = 'NOT_AVAILABLE';
  private offsets: Array<{ ts: number; offsetDeg: number; accuracy: CompassAccuracy }> = [];
  private lastOffset: { deg: number; ts: number; accuracy: CompassAccuracy } | null = null;
  private bodyOffsetDeg = 0;

  setBodyOffsetDeg(deg: number): void {
    this.bodyOffsetDeg = Number.isFinite(deg) ? wrapDeg180(deg) : 0;
  }

  getBodyOffsetDeg(): number {
    return this.bodyOffsetDeg;
  }

  pushHeading(h: HeadingSample): void {
    this.heading = h;
    this.maybePair(h.timestamp);
  }

  pushPose(p: Pose): void {
    this.pose = p;
    this.tracking = p.trackingState;
    this.maybePair(p.timestamp);
  }

  setTracking(t: TrackingState): void {
    this.tracking = t;
  }

  private maybePair(now: number): void {
    const h = this.heading;
    const p = this.pose;
    if (!h || !p) return;
    if (h.accuracy < 2 || p.trackingState !== 'NORMAL') return;
    if (Math.abs(h.timestamp - p.timestamp) > OFFSET_PAIR_MAX_SKEW_MS) return;
    this.offsets.push({ ts: now, offsetDeg: wrapDeg180(h.trueHeadingDeg - p.yawDeg), accuracy: h.accuracy });
    const cutoff = now - OFFSET_WINDOW_MS;
    while (this.offsets.length > 0 && this.offsets[0].ts < cutoff) this.offsets.shift();
    const mean = circularMeanOffsetDeg(this.offsets.map((o) => o.offsetDeg));
    if (mean !== null) {
      // The fused sample inherits the *worst* tier in the window: honest, not optimistic.
      let acc: CompassAccuracy = 3;
      for (const o of this.offsets) if (o.accuracy < acc) acc = o.accuracy;
      this.lastOffset = { deg: mean, ts: now, accuracy: acc };
    }
  }

  /** Raw compass sample (phone frame). */
  getHeading(): HeadingSample | null {
    return this.heading;
  }

  getPose(): Pose | null {
    return this.pose;
  }

  /** Body-frame fused heading, or null when both sources are bad. */
  fused(now: number): FusedHeading | null {
    const h = this.heading;
    const p = this.pose;
    const poseFresh = p !== null && this.tracking === 'NORMAL' && now - p.timestamp <= POSE_FRESH_MS;
    const compassOk = h !== null && h.accuracy >= 2;

    if (poseFresh && p && this.lastOffset && (compassOk || now - this.lastOffset.ts <= OFFSET_HOLD_MS)) {
      return {
        deg: normalizeDeg(p.yawDeg + this.lastOffset.deg - this.bodyOffsetDeg),
        accuracy: compassOk && h ? (Math.min(h.accuracy, this.lastOffset.accuracy) as CompassAccuracy) : this.lastOffset.accuracy,
        source: compassOk ? 'fused' : 'pose_hold',
      };
    }
    if (compassOk && h) {
      return { deg: normalizeDeg(h.trueHeadingDeg - this.bodyOffsetDeg), accuracy: h.accuracy, source: 'compass' };
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pure: body offset from a straight walk
// ---------------------------------------------------------------------------

export interface BodyOffsetSample {
  trueHeadingDeg: number;
  courseDeg: number;
}

/** `bodyOffsetDeg = circularMean(trueHeading − course)`; ok when the spread is < 15° over ≥ 3 samples. */
export function bodyOffsetFrom(samples: readonly BodyOffsetSample[]): { offsetDeg: number; ok: boolean; spreadDeg: number; count: number } {
  const diffs = samples.map((s) => wrapDeg180(s.trueHeadingDeg - s.courseDeg));
  const stats = circularStats(diffs);
  const offsetDeg = stats.meanDeg === null ? 0 : wrapDeg180(stats.meanDeg);
  const ok = stats.count >= CALIBRATION_MIN_SAMPLES && stats.spreadDeg < CALIBRATION_MAX_SPREAD_DEG;
  return { offsetDeg: ok ? offsetDeg : offsetDeg, ok, spreadDeg: stats.spreadDeg, count: stats.count };
}

// ---------------------------------------------------------------------------
// Pure: step ring
// ---------------------------------------------------------------------------

export class StepRing {
  private samples: Array<{ ts: number; steps: number }> = [];

  constructor(private readonly capacity = STEP_RING_SIZE) {}

  push(ts: number, steps: number): void {
    this.samples.push({ ts, steps });
    if (this.samples.length > this.capacity) this.samples.splice(0, this.samples.length - this.capacity);
  }

  latest(): number {
    return this.samples.length ? this.samples[this.samples.length - 1].steps : 0;
  }

  /** Steps counted since `ts` (0 when nothing is known). */
  since(ts: number): number {
    if (this.samples.length === 0) return 0;
    let base = this.samples[0].steps;
    for (const s of this.samples) {
      if (s.ts <= ts) base = s.steps;
      else break;
    }
    if (this.samples[0].ts > ts) base = this.samples[0].steps;
    return Math.max(0, this.latest() - base);
  }
}

// ---------------------------------------------------------------------------
// Pure: cross-track estimator (perception lateral → GPS anchor → dead reckoning)
// ---------------------------------------------------------------------------

export interface LateralSample {
  offsetM: number;
  source: 'pose' | 'ocr_box' | 'shelf' | 'curb' | 'none';
  timestamp: number;
}

export class CrossTrackEstimator {
  private dr = 0;                     // dead-reckoned cross-track, + = right
  private lastSteps: number | null = null;
  private lastAnchorTs = -Infinity;
  private source: 'perception' | 'gps' | 'dr' | 'none' = 'none';

  constructor(private readonly line: readonly LatLng[] | undefined) {}

  /** Feed the latest cumulative step count with the heading error at that moment. */
  steps(count: number, headingErrorDeg: number): void {
    if (this.lastSteps === null) {
      this.lastSteps = count;
      return;
    }
    const n = count - this.lastSteps;
    this.lastSteps = count;
    if (n <= 0) return;
    this.dr += Math.sin(headingErrorDeg * DEG_TO_RAD) * STRIDE_M * n;
    if (this.source === 'none') this.source = 'dr';
  }

  /** GPS re-anchor only when the fix is tight enough and a line exists. */
  fix(f: GeoFix): void {
    if (!this.line || this.line.length < 2) return;
    if (f.accuracyM > GPS_ANCHOR_MAX_ACCURACY_M || f.timestamp <= this.lastAnchorTs) return;
    const proj = projectOntoLine({ lat: f.lat, lng: f.lng }, this.line);
    if (!proj) return;
    this.dr = proj.crossTrackM;
    this.lastAnchorTs = f.timestamp;
    this.source = 'gps';
  }

  estimate(now: number, lateral: LateralSample | null): { crossTrackM: number; source: 'perception' | 'gps' | 'dr' | 'none' } {
    if (lateral && (lateral.source === 'pose' || lateral.source === 'curb') && now - lateral.timestamp <= LATERAL_FRESH_MS) {
      return { crossTrackM: lateral.offsetM, source: 'perception' };
    }
    return { crossTrackM: this.dr, source: this.source };
  }
}

// ---------------------------------------------------------------------------
// Platform sources
// ---------------------------------------------------------------------------

export interface SensorSources {
  requestPermissions(): Promise<{ location: boolean; motion: boolean }>;
  watchHeading(cb: (h: HeadingSample) => void): Promise<() => void>;
  watchPosition(cb: (f: GeoFix) => void): Promise<() => void>;
  /** Cumulative steps since the watch started. */
  watchSteps(cb: (steps: number) => void): Promise<() => void>;
}

export function toCompassAccuracy(raw: number): CompassAccuracy {
  if (raw >= 3) return 3;
  if (raw >= 2) return 2;
  if (raw >= 1) return 1;
  return 0;
}

/** Default sources on expo-location + expo-sensors; required lazily so tests never load them. */
export function createExpoSensorSources(): SensorSources {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Location = require('expo-location') as typeof import('expo-location');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pedometer } = require('expo-sensors') as typeof import('expo-sensors');
  return {
    async requestPermissions() {
      let location = false;
      let motion = false;
      try {
        location = (await Location.requestForegroundPermissionsAsync()).granted;
      } catch {
        location = false;
      }
      try {
        motion = (await Pedometer.requestPermissionsAsync()).granted;
      } catch {
        motion = false;
      }
      return { location, motion };
    },
    async watchHeading(cb) {
      const sub = await Location.watchHeadingAsync((h) => {
        cb({ trueHeadingDeg: normalizeDeg(h.trueHeading), accuracy: toCompassAccuracy(h.accuracy), timestamp: Date.now() });
      });
      return () => sub.remove();
    },
    async watchPosition(cb) {
      const sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 0 },
        (loc) => {
          const speed = loc.coords.speed;
          const speedMps = speed !== null && speed >= 0 ? speed : null;
          const moving = speedMps !== null && speedMps >= MIN_COURSE_SPEED_MPS;
          const course = loc.coords.heading;
          cb({
            lat: loc.coords.latitude,
            lng: loc.coords.longitude,
            accuracyM: loc.coords.accuracy ?? 999,
            courseDeg: moving && course !== null && course >= 0 ? normalizeDeg(course) : null,
            speedMps,
            timestamp: loc.timestamp,
          });
        },
      );
      return () => sub.remove();
    },
    async watchSteps(cb) {
      const sub = Pedometer.watchStepCount((r) => cb(r.steps));
      return () => sub.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface AisleSensorService extends SensorService {
  /** Request permissions and start the watchers. Idempotent. */
  start(): Promise<void>;
  stop(): void;
  /** Wire Agent C's service (pose, tracking state, lateral offset). Idempotent. */
  attachPerception(p: PerceptionService): void;
  getFusedHeading(): FusedHeading | null;
  getPose(): Pose | null;
  getTrackingState(): TrackingState;
  getBodyOffsetDeg(): number;
  /** GPS course and fused heading disagreed > 10° for > 10 s while walking: re-run calibration. */
  needsRecalibration(): boolean;
  getDebugState(): {
    heading: HeadingSample | null; fused: FusedHeading | null; pose: Pose | null; tracking: TrackingState;
    fix: GeoFix | null; steps: number; bodyOffsetDeg: number; lateral: LateralSample | null;
    lastCourseError: (CourseError & { crossTrackSource: string; rawCrossTrackM: number }) | null; needsRecalibration: boolean;
  };
}

export interface SensorServiceOptions {
  sources?: SensorSources;
  store?: AppStore;
  perception?: PerceptionService;
  now?: () => number;
  calibrationWindowMs?: number;
}

type Listener<T> = (v: T) => void;

class Emitter<T> {
  private readonly set = new Set<Listener<T>>();
  add(cb: Listener<T>): () => void {
    this.set.add(cb);
    return () => {
      this.set.delete(cb);
    };
  }
  emit(v: T): void {
    for (const cb of Array.from(this.set)) {
      try {
        cb(v);
      } catch {
        // one bad subscriber never starves the others
      }
    }
  }
}

export function createSensorService(opts: SensorServiceOptions = {}): AisleSensorService {
  const sources = opts.sources ?? createExpoSensorSources();
  const now = opts.now ?? Date.now;
  const calibrationWindowMs = opts.calibrationWindowMs ?? CALIBRATION_WINDOW_MS;

  const fuser = new HeadingFuser();
  const steps = new StepRing();
  let lastFix: GeoFix | null = null;
  let lateral: LateralSample | null = null;
  let perception: PerceptionService | null = null;
  let perceptionUnsubs: Array<() => void> = [];
  let sourceUnsubs: Array<() => void> = [];
  let started = false;
  let starting: Promise<void> | null = null;
  let disagreeSince: number | null = null;
  let needsRecal = false;
  let lastCourseError: (CourseError & { crossTrackSource: string; rawCrossTrackM: number }) | null = null;
  const calibrationTaps = new Set<(fix: GeoFix, heading: HeadingSample | null) => void>();

  const headingE = new Emitter<HeadingSample>();
  const fixE = new Emitter<GeoFix>();
  const stepsE = new Emitter<number>();
  const poseE = new Emitter<Pose>();

  if (opts.store) fuser.setBodyOffsetDeg(opts.store.getState().bodyOffsetDeg);

  const onHeading = (h: HeadingSample): void => {
    fuser.pushHeading(h);
    opts.store?.getState().setHeading(h);
    headingE.emit(h);
  };

  const onFix = (f: GeoFix): void => {
    lastFix = f;
    opts.store?.getState().setLastFix(f);
    // Re-calibration watch: GPS course vs fused heading while walking.
    const fused = fuser.fused(now());
    if (f.courseDeg !== null && f.speedMps !== null && f.speedMps > MIN_COURSE_SPEED_MPS && fused) {
      const diff = Math.abs(wrapDeg180(fused.deg - f.courseDeg));
      if (diff > RECAL_DISAGREE_DEG) {
        if (disagreeSince === null) disagreeSince = f.timestamp;
        else if (f.timestamp - disagreeSince > RECAL_DISAGREE_MS) needsRecal = true;
      } else {
        disagreeSince = null;
      }
    } else {
      disagreeSince = null;
    }
    for (const tap of Array.from(calibrationTaps)) tap(f, fuser.getHeading());
    fixE.emit(f);
  };

  const onSteps = (count: number): void => {
    steps.push(now(), count);
    stepsE.emit(count);
  };

  const attachPerception = (p: PerceptionService): void => {
    if (perception === p) return;
    for (const u of perceptionUnsubs) u();
    perceptionUnsubs = [];
    perception = p;
    perceptionUnsubs.push(p.onPose((pose) => {
      fuser.pushPose(pose);
      poseE.emit(pose);
    }));
    perceptionUnsubs.push(p.onTrackingState((t) => fuser.setTracking(t)));
    perceptionUnsubs.push(p.onLateralOffset((e) => {
      lateral = { offsetM: e.offsetM, source: e.source, timestamp: now() };
    }));
    p.setBodyOffsetDeg(fuser.getBodyOffsetDeg());
  };
  if (opts.perception) attachPerception(opts.perception);

  const start = async (): Promise<void> => {
    if (started) return;
    if (starting) return starting;
    starting = (async () => {
      const perms = await sources.requestPermissions();
      const unsubs: Array<() => void> = [];
      if (perms.location) {
        try { unsubs.push(await sources.watchHeading(onHeading)); } catch { /* no compass: fused() stays null */ }
        try { unsubs.push(await sources.watchPosition(onFix)); } catch { /* no GPS: fixes stay null */ }
      }
      if (perms.motion) {
        try { unsubs.push(await sources.watchSteps(onSteps)); } catch { /* no pedometer: steps stay 0 */ }
      }
      sourceUnsubs = unsubs;
      started = true;
      starting = null;
    })();
    return starting;
  };

  const stop = (): void => {
    for (const u of sourceUnsubs) u();
    sourceUnsubs = [];
    started = false;
  };

  const applyBodyOffset = (deg: number): void => {
    fuser.setBodyOffsetDeg(deg);
    opts.store?.getState().setBodyOffsetDeg(deg);
    perception?.setBodyOffsetDeg(deg);
    needsRecal = false;
    disagreeSince = null;
  };

  const calibrateBodyOffset = (): Promise<{ offsetDeg: number; ok: boolean }> =>
    new Promise((resolve) => {
      const samples: BodyOffsetSample[] = [];
      const tap = (f: GeoFix, h: HeadingSample | null): void => {
        if (!h || h.accuracy < 2) return;
        if (f.courseDeg === null || f.speedMps === null || f.speedMps <= MIN_COURSE_SPEED_MPS) return;
        samples.push({ trueHeadingDeg: h.trueHeadingDeg, courseDeg: f.courseDeg });
      };
      calibrationTaps.add(tap);
      setTimeout(() => {
        calibrationTaps.delete(tap);
        const r = bodyOffsetFrom(samples);
        if (r.ok) applyBodyOffset(r.offsetDeg);
        resolve({ offsetDeg: r.offsetDeg, ok: r.ok });
      }, calibrationWindowMs);
    });

  const courseErrorFor: SensorService['courseErrorFor'] = (target) => {
    const bearing = normalizeDeg(target.bearingDeg);
    const est = new CrossTrackEstimator(target.line);
    let lastFixTs = -Infinity;
    perception?.setCourseReference({ bearingDeg: bearing });
    return (): CourseError => {
      const t = now();
      const fused = fuser.fused(t);
      const raw = fuser.getHeading();
      let headingErrorDeg = 0;
      let compassAccuracy: CompassAccuracy = 0;
      if (fused) {
        headingErrorDeg = wrapDeg180(fused.deg - bearing);
        compassAccuracy = fused.accuracy;
      } else if (raw) {
        headingErrorDeg = wrapDeg180(raw.trueHeadingDeg - fuser.getBodyOffsetDeg() - bearing);
        compassAccuracy = raw.accuracy; // 0 or 1 here → the COURSE rule suppresses the buzz
      }
      est.steps(steps.latest(), headingErrorDeg);
      if (lastFix && lastFix.timestamp > lastFixTs) {
        lastFixTs = lastFix.timestamp;
        est.fix(lastFix);
      }
      const ct = est.estimate(t, lateral);
      // Only the perception module's lateral offset ('pose' / 'curb', fresh) is
      // precise enough to feed the roadward buzz. A GPS anchor at ≤ 10 m or dead
      // reckoning routinely reads > 0.5 m off the line while the user is on it,
      // and a false roadward buzz is a safety failure (01 §2), so those sources
      // reach the COURSE rule as 0 m and are kept only for the DebugPanel.
      const trusted = ct.source === 'perception';
      const err: CourseError = { headingErrorDeg, crossTrackM: trusted ? ct.crossTrackM : 0, roadSide: target.roadSide, compassAccuracy };
      lastCourseError = { ...err, crossTrackSource: ct.source, rawCrossTrackM: ct.crossTrackM };
      return err;
    };
  };

  return {
    subscribeHeading: (cb) => headingE.add(cb),
    subscribeLocation: (cb) => fixE.add(cb),
    subscribeSteps: (cb) => stepsE.add(cb),
    subscribePose: (cb) => poseE.add(cb),
    getHeading: () => fuser.getHeading(),
    getFusedHeadingDeg: () => fuser.fused(now())?.deg ?? null,
    getLastFix: () => lastFix,
    getStepsSince: (ts) => steps.since(ts),
    calibrateBodyOffset,
    courseErrorFor,
    start,
    stop,
    attachPerception,
    getFusedHeading: () => fuser.fused(now()),
    getPose: () => fuser.getPose(),
    getTrackingState: () => fuser.getPose()?.trackingState ?? 'NOT_AVAILABLE',
    getBodyOffsetDeg: () => fuser.getBodyOffsetDeg(),
    needsRecalibration: () => needsRecal,
    getDebugState: () => ({
      heading: fuser.getHeading(),
      fused: fuser.fused(now()),
      pose: fuser.getPose(),
      tracking: fuser.getPose()?.trackingState ?? 'NOT_AVAILABLE',
      fix: lastFix,
      steps: steps.latest(),
      bodyOffsetDeg: fuser.getBodyOffsetDeg(),
      lateral,
      lastCourseError,
      needsRecalibration: needsRecal,
    }),
  };
}
