/**
 * Angular helpers (pure, no side effects).
 *
 * Everything in Aisle that points somewhere — heading error, the beacon's
 * relative bearing, the compass/ARKit fusion offset, the body offset from the
 * "walk straight for five seconds" routine — needs the same three operations:
 * wrap to −180..180, normalize to 0..360, and average a set of angles without
 * the 359°/1° discontinuity. They live here so there is one implementation and
 * one test file, and so nothing in the hot path allocates.
 *
 * Convention throughout the app: degrees clockwise from true north, 0..360 for
 * absolute bearings; signed −180..180 for errors, where + means "the user is
 * pointed to the right of the target".
 */

export const DEG_TO_RAD = Math.PI / 180;
export const RAD_TO_DEG = 180 / Math.PI;

/** 0..360, always positive. NaN/±Infinity → 0 (a bad sensor sample is not a crash). */
export function normalizeDeg(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

/** −180..180 (inclusive of −180, exclusive of 180 only at the wrap point). */
export function wrapDeg180(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  let d = (deg + 180) % 360;
  if (d < 0) d += 360;
  return d - 180;
}

/**
 * Signed difference `from → to`, −180..180.
 * Positive means `to` is clockwise (to the right) of `from`.
 */
export function angleDiffDeg(from: number, to: number): number {
  return wrapDeg180(to - from);
}

/** Unsigned separation, 0..180. */
export function angleAbsDiffDeg(a: number, b: number): number {
  return Math.abs(angleDiffDeg(a, b));
}

/**
 * Heading error for the COURSE rule: how far the user's heading is from the
 * target bearing, signed. + = user is pointed right of the target, so the
 * correction is "turn left".
 */
export function headingErrorDeg(headingDeg: number, targetBearingDeg: number): number {
  return wrapDeg180(headingDeg - targetBearingDeg);
}

export interface CircularStats {
  /** Mean direction, 0..360. `null` when the samples cancel out (no direction). */
  meanDeg: number | null;
  /** Circular spread in degrees: 0 = identical, 180 = uniformly opposed. */
  spreadDeg: number;
  /** Resultant length 0..1 (1 = perfectly agreeing). */
  r: number;
  count: number;
}

/**
 * Circular mean and spread. Used for the ARKit↔compass fusion offset and for
 * `calibrateBodyOffset` (`ok` when the spread is under 15°).
 *
 * `spreadDeg` is the circular standard deviation in degrees,
 * `sqrt(-2 ln r)` in radians, which is the usual O&M-friendly "how tight was
 * that walk" number: it stays small while samples agree and blows up when they
 * do not, and it is finite (capped at 180) when they fully cancel.
 */
export function circularStats(degs: readonly number[]): CircularStats {
  let sx = 0;
  let sy = 0;
  let count = 0;
  for (const d of degs) {
    if (!Number.isFinite(d)) continue;
    const r = d * DEG_TO_RAD;
    sx += Math.cos(r);
    sy += Math.sin(r);
    count += 1;
  }
  if (count === 0) return { meanDeg: null, spreadDeg: 180, r: 0, count: 0 };
  const cx = sx / count;
  const cy = sy / count;
  const r = Math.min(1, Math.hypot(cx, cy));
  if (r < 1e-9) return { meanDeg: null, spreadDeg: 180, r: 0, count };
  const meanDeg = normalizeDeg(Math.atan2(cy, cx) * RAD_TO_DEG);
  const spreadDeg = Math.min(180, Math.sqrt(-2 * Math.log(r)) * RAD_TO_DEG);
  return { meanDeg, spreadDeg, r, count };
}

/** Convenience: circular mean only, `null` when undefined. */
export function circularMeanDeg(degs: readonly number[]): number | null {
  return circularStats(degs).meanDeg;
}

/**
 * Circular mean of signed offsets (e.g. `trueHeading − yaw`), returned wrapped
 * to −180..180 because an offset of 350° is really −10°.
 */
export function circularMeanOffsetDeg(degs: readonly number[]): number | null {
  const mean = circularStats(degs).meanDeg;
  return mean === null ? null : wrapDeg180(mean);
}

/** Exponential smoothing that respects the wrap-around. */
export function smoothAngleDeg(previousDeg: number | null, sampleDeg: number, alpha: number): number {
  if (previousDeg === null) return normalizeDeg(sampleDeg);
  const a = Math.min(1, Math.max(0, alpha));
  return normalizeDeg(previousDeg + a * angleDiffDeg(previousDeg, sampleDeg));
}

/** `true` when `bearingDeg` is inside ±`halfWindowDeg` of `referenceDeg`. */
export function isWithinDeg(bearingDeg: number, referenceDeg: number, halfWindowDeg: number): boolean {
  return angleAbsDiffDeg(bearingDeg, referenceDeg) <= halfWindowDeg;
}

/** Clamp helper used by the pulse and pan laws. */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Constant-power stereo pan for the direction beacon (02 Task 5).
 *
 * `expo-audio` has no pan property, so the beacon is two looping players —
 * a hard-left clip and a hard-right clip — whose volumes follow the
 * sine/cosine law, keeping `left² + right² === 1` so the loudness does not dip
 * as the sound crosses the centre.
 *
 * `relativeBearingDeg` is the target relative to where the user faces
 * (0 = dead ahead, + = to the right). Behind the user the pan saturates at the
 * hard side: the beacon encodes direction, and "behind you on the right" still
 * means turn right.
 */
export function constantPowerPan(relativeBearingDeg: number): { left: number; right: number } {
  const rel = wrapDeg180(relativeBearingDeg);
  // −1 (hard left) .. +1 (hard right), saturating beyond ±90°.
  const x = clamp(rel / 90, -1, 1);
  const theta = ((x + 1) / 2) * (Math.PI / 2); // 0 → hard left, π/2 → hard right
  return { left: Math.cos(theta), right: Math.sin(theta) };
}
