/**
 * Leg advancement (03 Task 3) and bearing math — pure functions.
 *
 * `stepLegProgress` is a reducer: feed it each GeoFix and it tells you whether
 * the current leg advanced, the route arrived, or the user looks off route.
 * Never more than one leg per fix. GPS accuracy gates whether a fix counts.
 */
import type { GeoFix } from '../core/contracts';
import { alongTrackUnclampedM, haversineM, polylineLengthM, projectOntoPolyline, type LatLng } from './geo';
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
export const STALL_PROGRESS_M = 3;

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
 * Off-route: three consecutive counting fixes > 25 m cross-track from both the
 * current and next leg with along-track progress stalled.
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

  // Off-route detection: far from this leg and the next, and not making progress.
  const nextLeg = legs[prev.legIndex + 1];
  const farFromNext = nextLeg ? (projectOntoPolyline(here, nextLeg.polyline)?.distM ?? Infinity) > OFF_ROUTE_CROSS_TRACK_M : true;
  const stalled = prev.lastAlongM !== null && alongM - prev.lastAlongM < STALL_PROGRESS_M;
  const far = crossTrackM > OFF_ROUTE_CROSS_TRACK_M && farFromNext;
  const offRouteCount = far && stalled ? prev.offRouteCount + 1 : far ? Math.max(1, prev.offRouteCount) : 0;
  next = { ...next, offRouteCount };
  if (offRouteCount >= OFF_ROUTE_FIXES) {
    events.push('OFF_ROUTE');
    next = { ...next, offRouteCount: 0 };
  }
  return { state: next, events, counted: true, distToEndM, alongM, crossTrackM, remainingM };
}

/** Bearing the user should face on a leg: its start bearing until the last 30 m, then the end bearing. */
export function referenceBearingFor(leg: RouteLeg, remainingM: number): number {
  return remainingM <= 30 ? leg.endBearingDeg : leg.startBearingDeg;
}
