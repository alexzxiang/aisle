/**
 * Leg advancement (03 Task 3) and bearing math — pure functions.
 *
 * `stepLegProgress` is a reducer: feed it each GeoFix and it tells you whether
 * the current leg advanced, the route arrived, or the user looks off route.
 * Never more than one leg per fix. GPS accuracy gates whether a fix counts.
 */
import type { GeoFix } from '../core/contracts';
import { alongTrackUnclampedM, bearingAtAlong, haversineM, polylineLengthM, projectOntoPolyline, type LatLng } from './geo';
import type { RouteLeg } from './types';

/**
 * Signed −180..180; + = target is to the right of current. Wraps across 0/360.
 * 03 Task 3 gives `((target − current + 540) % 360) − 180`; the inner modulo
 * below makes the same formula correct for inputs outside 0..360 too (JS `%`
 * keeps the sign of the dividend).
 */
export function angularError(current: number, target: number): number {
  if (!Number.isFinite(current) || !Number.isFinite(target)) return 0;
  const delta = ((target - current) % 360 + 540) % 360;
  return delta - 180;
}

/** True when |angularError| ≤ tolerance. */
export function isWithinDeg(current: number, target: number, toleranceDeg: number): boolean {
  return Math.abs(angularError(current, target)) <= toleranceDeg;
}

export const ADVANCE_RADIUS_GOOD_M = 15;
export const ADVANCE_RADIUS_FAIR_M = 25;
export const ACCURACY_GOOD_M = 20;
export const ACCURACY_FAIR_M = 35;
export const OVERSHOOT_M = 10;
export const OFF_ROUTE_CROSS_TRACK_M = 25;
export const OFF_ROUTE_FIXES = 3;

/** Accuracy gate: the advancement radius for a fix, or null when it does not count. */
export function advanceRadiusFor(accuracyM: number): number | null {
  if (!Number.isFinite(accuracyM) || accuracyM < 0) return null;
  if (accuracyM <= ACCURACY_GOOD_M) return ADVANCE_RADIUS_GOOD_M;
  if (accuracyM <= ACCURACY_FAIR_M) return ADVANCE_RADIUS_FAIR_M;
  return null;
}

/** Current GPS evidence only; poor fixes must not drive curb or turn decisions. */
export function usableOutdoorFix(fix: GeoFix, now: number, maxAccuracyM = ACCURACY_FAIR_M): boolean {
  return Number.isFinite(fix.lat) && Math.abs(fix.lat) <= 90
    && Number.isFinite(fix.lng) && Math.abs(fix.lng) <= 180
    && Number.isFinite(fix.accuracyM) && fix.accuracyM >= 0 && fix.accuracyM <= maxAccuracyM
    && Number.isFinite(fix.timestamp) && now - fix.timestamp >= 0 && now - fix.timestamp <= 5000;
}

export interface LegProgressState {
  legIndex: number;
  insideCount: number;      // consecutive counting fixes inside the end radius
  overshootCount: number;   // consecutive counting fixes past the end along-track
  offRouteCount: number;    // consecutive counting fixes far from current + next leg
  lastAlongM: number | null;
  arrived: boolean;
}

export function initialLegProgress(legIndex = 0): LegProgressState {
  return { legIndex, insideCount: 0, overshootCount: 0, offRouteCount: 0, lastAlongM: null, arrived: false };
}

export type LegProgressEvent = 'ADVANCED' | 'ARRIVED' | 'OFF_ROUTE';

export interface LegProgressStep {
  state: LegProgressState;
  events: LegProgressEvent[];
  counted: boolean;          // did this fix pass the accuracy gate
  distToEndM: number;
  alongM: number;            // along-track on the current leg (unclamped)
  crossTrackM: number;       // unsigned perpendicular distance to the current leg
  remainingM: number;        // metres left on the current leg (≥ 0)
}

function legEnd(leg: RouteLeg): LatLng {
  return { lat: leg.endLat, lng: leg.endLng };
}

/**
 * Advance rule (03 Task 3): two consecutive counting fixes inside the radius of the
 * leg end, or two consecutive counting fixes more than 10 m past the end along-track.
 * Off-route: three consecutive counting fixes separated from both the current
 * and next leg by more than 25 m and the accuracy-aware uncertainty margin.
 */
export function stepLegProgress(prev: LegProgressState, fix: GeoFix, legs: readonly RouteLeg[]): LegProgressStep {
  const leg = legs[prev.legIndex];
  const here: LatLng = { lat: fix.lat, lng: fix.lng };
  if (!leg || prev.arrived) {
    return { state: prev, events: [], counted: false, distToEndM: 0, alongM: 0, crossTrackM: 0, remainingM: 0 };
  }
  const line = leg.polyline.length >= 2 ? leg.polyline : [leg.polyline[0] ?? legEnd(leg), legEnd(leg)];
  const lengthM = polylineLengthM(line);
  const distToEndM = haversineM(here, legEnd(leg));
  const alongM = alongTrackUnclampedM(here, line);
  const proj = projectOntoPolyline(here, line);
  const crossTrackM = proj ? proj.distM : distToEndM;
  const remainingM = Math.max(0, lengthM - alongM);

  const radius = advanceRadiusFor(fix.accuracyM);
  if (radius === null) {
    return { state: { ...prev, insideCount: 0, overshootCount: 0, offRouteCount: 0 }, events: [], counted: false, distToEndM, alongM, crossTrackM, remainingM };
  }

  const inside = distToEndM <= radius;
  const overshoot = alongM > lengthM + OVERSHOOT_M && crossTrackM <= OFF_ROUTE_CROSS_TRACK_M;
  const insideCount = inside ? prev.insideCount + 1 : 0;
  const overshootCount = overshoot ? prev.overshootCount + 1 : 0;

  const events: LegProgressEvent[] = [];
  let next: LegProgressState = { ...prev, insideCount, overshootCount, lastAlongM: alongM };

  if (insideCount >= 2 || overshootCount >= 2) {
    const isLast = prev.legIndex >= legs.length - 1;
    if (isLast) {
      next = { ...next, arrived: true, insideCount: 0, overshootCount: 0, offRouteCount: 0 };
      events.push('ARRIVED');
    } else {
      next = { legIndex: prev.legIndex + 1, insideCount: 0, overshootCount: 0, offRouteCount: 0, lastAlongM: null, arrived: false };
      events.push('ADVANCED');
    }
    return { state: next, events, counted: true, distToEndM, alongM, crossTrackM, remainingM };
  }

  // Parallel travel is still off route. Require separation beyond GPS uncertainty.
  const offRouteThreshold = Math.max(OFF_ROUTE_CROSS_TRACK_M, fix.accuracyM * 1.5);
  const nextLeg = legs[prev.legIndex + 1];
  const farFromNext = nextLeg ? (projectOntoPolyline(here, nextLeg.polyline)?.distM ?? Infinity) > offRouteThreshold : true;
  const far = crossTrackM > offRouteThreshold && farFromNext;
  const offRouteCount = far ? prev.offRouteCount + 1 : 0;
  next = { ...next, offRouteCount };
  if (offRouteCount >= OFF_ROUTE_FIXES) {
    events.push('OFF_ROUTE');
    next = { ...next, offRouteCount: 0 };
  }
  return { state: next, events, counted: true, distToEndM, alongM, crossTrackM, remainingM };
}

/**
 * A gentle look-ahead so the reference leads the walker into a bend instead of trailing the
 * point they already stand on (~7 steps). Small enough never to cut a corner into the next leg.
 */
export const REFERENCE_LOOKAHEAD_M = 5;

/**
 * The bearing the user should face at `alongM` metres into the leg: the local tangent of the
 * leg's own polyline (with a small look-ahead), so the COURSE reference follows a curving
 * sidewalk rather than holding the stale start bearing for the whole leg. `bearingAtAlong`
 * clamps out-of-range distances to the first / last segment, so this is the start bearing at
 * the leg's head and the end bearing near the maneuver. A straight (two-point) leg returns its
 * one bearing throughout, so nothing changes there.
 */
export function referenceBearingAt(leg: RouteLeg, alongM: number, lookAheadM = REFERENCE_LOOKAHEAD_M): number {
  const line = leg.polyline;
  if (!line || line.length < 2) return leg.startBearingDeg;
  const bearing = bearingAtAlong(line, (Number.isFinite(alongM) ? alongM : 0) + lookAheadM);
  const normalized = ((bearing % 360) + 360) % 360;
  return normalized >= 360 - 1e-6 ? 0 : normalized;
}
