/**
 * Aisle centring → COURSE (04 Task 6).
 *
 * The single-frame VLM `alignmentOffset` is gone; centring comes from the
 * perception module. This file holds the pure math (pose → lateral offset
 * against a bearing line, sign box → offset, source precedence, smoothing,
 * heading error) plus `createAisleCentering`, which owns the two side effects:
 * re-anchoring `perception.setCourseReference` at the fused heading and
 * running the shared COURSE ramp through A's `sensors.courseErrorFor`
 * (`roadSide: 'NONE'`). A's SensorService already fuses the module's lateral
 * offset into `crossTrackM`; we supply the anchor, we do not run a second ramp.
 *
 * Frame conventions (ARKit `gravityAndHeading`): +x east, −z north, y up.
 * Bearing b (deg, 0 = north, clockwise): forward = (sin b, −cos b) in (x, z);
 * right   = (cos b,  sin b). Offset = (p − anchor) · right, + = right of line.
 */
import type {
  CompassAccuracy,
  CourseError,
  HapticService,
  PerceptionService,
  Pose,
  SensorService,
  TrackingState,
} from '../core/contracts';
import type { LateralOffsetEvent, LateralOffsetSource } from '../../modules/perception';

// ---------------------------------------------------------------------------
// Pure math
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;

export interface PlanarPoint { x: number; z: number }

/** Signed perpendicular offset (m) of `p` from the line through `anchor` along `bearingDeg`. */
export function lateralOffsetFromPose(anchor: PlanarPoint, p: PlanarPoint, bearingDeg: number): number {
  const b = bearingDeg * DEG;
  const rx = Math.cos(b);
  const rz = Math.sin(b);
  return (p.x - anchor.x) * rx + (p.z - anchor.z) * rz;
}

/** Distance travelled along the line (m); negative = behind the anchor. */
export function alongTrackFromPose(anchor: PlanarPoint, p: PlanarPoint, bearingDeg: number): number {
  const b = bearingDeg * DEG;
  const fx = Math.sin(b);
  const fz = -Math.cos(b);
  return (p.x - anchor.x) * fx + (p.z - anchor.z) * fz;
}

/** Portrait iPhone back camera, horizontal field of view (deg), approximate. */
export const DEFAULT_HFOV_DEG = 60;
/** Reading distance the sign-box offset assumes when nothing better is known (04 Task 11: 3–6 m). */
export const DEFAULT_SIGN_DISTANCE_M = 4;

/**
 * Lateral offset implied by a hanging sign's box: a sign centred in the frame
 * means the user walks under it; a sign left of centre means the user is right
 * of the aisle's centre line (+). Small-angle: offset ≈ d · tan(θ).
 */
export function offsetFromSignBox(
  box: readonly [number, number, number, number],
  distanceM = DEFAULT_SIGN_DISTANCE_M,
  hfovDeg = DEFAULT_HFOV_DEG,
): number {
  const cx = box[0] + box[2] / 2;
  const frac = 0.5 - cx;                         // sign left of centre → positive
  const theta = frac * hfovDeg * DEG;
  return distanceM * Math.tan(theta);
}

/** Signed heading error, −180..180, + = pointed right of the bearing. */
export function headingErrorDeg(headingDeg: number, bearingDeg: number): number {
  let d = ((headingDeg - bearingDeg) % 360 + 540) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

export interface OffsetSamples {
  pose?: number | null;
  shelf?: number | null;
  ocr_box?: number | null;
}

/**
 * Precedence (04 Task 6): `pose` while tracking is NORMAL; else `shelf`;
 * `ocr_box` only while a sign is in view; otherwise 0 and heading alone drives.
 */
export function selectOffset(samples: OffsetSamples, tracking: TrackingState, signInView: boolean): { offsetM: number; source: LateralOffsetSource } {
  if (tracking === 'NORMAL' && typeof samples.pose === 'number') return { offsetM: samples.pose, source: 'pose' };
  if (typeof samples.shelf === 'number') return { offsetM: samples.shelf, source: 'shelf' };
  if (signInView && typeof samples.ocr_box === 'number') return { offsetM: samples.ocr_box, source: 'ocr_box' };
  return { offsetM: 0, source: 'none' };
}

/** Exponential smoothing with a 1 s time constant (01 §7: "5 Hz smoothed over 1 s"). */
export function createSmoother(tauMs = 1000) {
  let value: number | null = null;
  let lastT: number | null = null;
  return {
    push(x: number, t: number): number {
      if (value === null || lastT === null) {
        value = x;
        lastT = t;
        return x;
      }
      const dt = Math.max(0, t - lastT);
      const a = 1 - Math.exp(-dt / tauMs);
      value += a * (x - value);
      lastT = t;
      return value;
    },
    value: () => value,
    reset() {
      value = null;
      lastT = null;
    },
  };
}

/**
 * A pure CourseError feed for tests and for a SensorService that has no
 * perception attached: heading error from the fused heading vs the anchored
 * bearing, cross-track from the selected lateral offset. `compassAccuracy` is
 * 3 while a heading is known (ARKit yaw is steadier than the compass) else 0,
 * which A's ramp treats as "no course buzz".
 */
export interface CenteringFeed {
  setReference(bearingDeg: number, anchor?: PlanarPoint | null): void;
  clearReference(): void;
  updatePose(p: Pose): void;
  updateLateral(e: LateralOffsetEvent, t?: number): void;
  updateTracking(s: TrackingState): void;
  updateHeading(deg: number | null): void;
  setSignInView(v: boolean): void;
  getError(): CourseError;
  getReference(): { bearingDeg: number; anchor: PlanarPoint | null } | null;
}

export function createCenteringFeed(opts: { now?: () => number } = {}): CenteringFeed {
  const now = opts.now ?? Date.now;
  let ref: { bearingDeg: number; anchor: PlanarPoint | null } | null = null;
  let pose: Pose | null = null;
  let tracking: TrackingState = 'NOT_AVAILABLE';
  let heading: number | null = null;
  let signInView = false;
  const samples: OffsetSamples = {};
  const smooth = createSmoother();

  const poseOffset = (): number | null => {
    if (!ref || !ref.anchor || !pose || tracking !== 'NORMAL') return null;
    return lateralOffsetFromPose(ref.anchor, { x: pose.x, z: pose.z }, ref.bearingDeg);
  };

  return {
    setReference(bearingDeg, anchor) {
      ref = { bearingDeg, anchor: anchor ?? (pose ? { x: pose.x, z: pose.z } : null) };
      smooth.reset();
    },
    clearReference() {
      ref = null;
      smooth.reset();
    },
    updatePose(p) {
      pose = p;
      tracking = p.trackingState;
      if (ref && !ref.anchor) ref.anchor = { x: p.x, z: p.z };
    },
    updateLateral(e, t = now()) {
      if (e.source === 'none') return;
      if (e.source === 'curb') return; // outdoor-only source; not an aisle signal
      samples[e.source] = smooth.push(e.offsetM, t);
    },
    updateTracking(s) {
      tracking = s;
    },
    updateHeading(deg) {
      heading = deg;
    },
    setSignInView(v) {
      signInView = v;
    },
    getError() {
      const accuracy: CompassAccuracy = heading === null || !ref ? 0 : 3;
      const hErr = heading === null || !ref ? 0 : headingErrorDeg(heading, ref.bearingDeg);
      const local = poseOffset();
      const sel = selectOffset({ ...samples, pose: local ?? samples.pose ?? null }, tracking, signInView);
      return { headingErrorDeg: hErr, crossTrackM: sel.offsetM, roadSide: 'NONE', compassAccuracy: accuracy };
    },
    getReference: () => ref,
  };
}

// ---------------------------------------------------------------------------
// Side effects: anchor the module, run the shared ramp
// ---------------------------------------------------------------------------

export interface AisleCenteringOptions {
  perception: Pick<PerceptionService, 'setCourseReference'>;
  haptics: Pick<HapticService, 'startCourse' | 'stopCourse'>;
  sensors: Pick<SensorService, 'courseErrorFor' | 'getFusedHeadingDeg'>;
}

export interface AisleCentering {
  /** Anchor the drift line at the current fused heading (or the given bearing) and start COURSE. */
  anchor(bearingDeg?: number | null): number | null;
  /** Re-anchor at the current heading (cross-aisle turn). No-op when not running. */
  reanchor(): number | null;
  stop(): void;
  isRunning(): boolean;
  getBearing(): number | null;
}

export function createAisleCentering(opts: AisleCenteringOptions): AisleCentering {
  let running = false;
  let bearing: number | null = null;

  const norm = (b: number): number => {
    if (b >= 0 && b < 360) return b;              // avoid float drift on the common case
    const v = ((b % 360) + 360) % 360;
    return v === 360 ? 0 : v;
  };

  const start = (b: number): void => {
    bearing = b;
    opts.perception.setCourseReference({ bearingDeg: b });
    opts.haptics.startCourse(opts.sensors.courseErrorFor({ bearingDeg: b, roadSide: 'NONE' }));
    running = true;
  };

  return {
    anchor(bearingDeg) {
      const b = typeof bearingDeg === 'number' ? bearingDeg : opts.sensors.getFusedHeadingDeg();
      if (b === null) return null;
      start(norm(b));
      return bearing;
    },
    reanchor() {
      if (!running) return null;
      const b = opts.sensors.getFusedHeadingDeg();
      if (b === null) return bearing;
      start(norm(b));
      return bearing;
    },
    stop() {
      if (!running) return;
      running = false;
      bearing = null;
      opts.haptics.stopCourse();
      opts.perception.setCourseReference(null);
    },
    isRunning: () => running,
    getBearing: () => bearing,
  };
}
