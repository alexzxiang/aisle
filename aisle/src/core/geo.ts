/**
 * Minimal geodesy for the SensorService (pure). `src/outdoor/geo.ts` is Agent
 * B's richer version for routing; core keeps its own small copy so nothing in
 * `src/core/` depends on a feature track. Same conventions: metres on a local
 * equirectangular plane (fine over a leg), bearings clockwise from true north,
 * signed cross-track where + = right of the line's direction.
 */
import { normalizeDeg, DEG_TO_RAD, RAD_TO_DEG } from './angles';

export interface LatLng {
  lat: number;
  lng: number;
}

export const EARTH_RADIUS_M = 6371008.8;

/** Great-circle distance in metres (haversine). */
export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = (b.lat - a.lat) * DEG_TO_RAD;
  const dLng = (b.lng - a.lng) * DEG_TO_RAD;
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const h = s1 * s1 + Math.cos(a.lat * DEG_TO_RAD) * Math.cos(b.lat * DEG_TO_RAD) * s2 * s2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial great-circle bearing from a to b, degrees 0..360. */
export function bearingDeg(a: LatLng, b: LatLng): number {
  const p1 = a.lat * DEG_TO_RAD;
  const p2 = b.lat * DEG_TO_RAD;
  const dl = (b.lng - a.lng) * DEG_TO_RAD;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return normalizeDeg(Math.atan2(y, x) * RAD_TO_DEG);
}

/** Local east/north metres of `p` relative to `origin`. */
export function toLocalXY(p: LatLng, origin: LatLng): { x: number; y: number } {
  const x = (p.lng - origin.lng) * DEG_TO_RAD * Math.cos(origin.lat * DEG_TO_RAD) * EARTH_RADIUS_M;
  const y = (p.lat - origin.lat) * DEG_TO_RAD * EARTH_RADIUS_M;
  return { x, y };
}

export interface LineProjection {
  /** Signed cross-track in metres, + = right of the line direction. */
  crossTrackM: number;
  /** Unsigned perpendicular distance in metres. */
  distM: number;
  /** Index of the nearest segment (0-based). */
  segIndex: number;
  /** Bearing of that segment, 0..360. */
  segBearingDeg: number;
}

/**
 * Signed cross-track of `p` against a polyline. Returns null for fewer than
 * two points (no line to be beside). Used for the GPS re-anchor of the COURSE
 * dead-reckoning and for the crossing line at the curb.
 */
export function projectOntoLine(p: LatLng, line: readonly LatLng[]): LineProjection | null {
  if (line.length < 2) return null;
  let best: LineProjection | null = null;
  for (let i = 1; i < line.length; i += 1) {
    const a = line[i - 1];
    const b = line[i];
    const B = toLocalXY(b, a);
    const P = toLocalXY(p, a);
    const len2 = B.x * B.x + B.y * B.y;
    let crossTrackM: number;
    let distM: number;
    if (len2 === 0) {
      distM = Math.hypot(P.x, P.y);
      crossTrackM = 0;
    } else {
      const len = Math.sqrt(len2);
      const tRaw = (P.x * B.x + P.y * B.y) / len2;
      const t = Math.max(0, Math.min(1, tRaw));
      const qx = t * B.x;
      const qy = t * B.y;
      distM = Math.hypot(P.x - qx, P.y - qy);
      // z of direction × (P − A): positive = left of direction; we want + = right.
      const crossZ = B.x * P.y - B.y * P.x;
      crossTrackM = -crossZ / len;
    }
    if (best === null || distM < best.distM) {
      best = { crossTrackM, distM, segIndex: i - 1, segBearingDeg: bearingDeg(a, b) };
    }
  }
  return best;
}
