/**
 * Small geodesy helpers shared by the TransitionDetector and D's mocks.
 * Pure functions, metres and degrees. Accurate to well under a metre over the
 * few hundred metres a walk spans. (B keeps its own copy in src/outdoor/ by
 * ownership rule; these are deliberately tiny so drift between them is harmless.)
 */

export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_M = 6371008.8;
const DEG = Math.PI / 180;

export function normalizeDeg(deg: number): number {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

/** Signed smallest difference a − b in degrees, in (−180, 180]. */
export function signedDeltaDeg(a: number, b: number): number {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Great-circle distance in metres (haversine). */
export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLng = (b.lng - a.lng) * DEG;
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const h = s1 * s1 + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * s2 * s2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b, degrees clockwise from true north, 0..360. */
export function bearingDeg(a: LatLng, b: LatLng): number {
  const p1 = a.lat * DEG;
  const p2 = b.lat * DEG;
  const dl = (b.lng - a.lng) * DEG;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return normalizeDeg(Math.atan2(y, x) / DEG);
}

/** Local planar offset of p from origin in metres: x east, y north. */
export function toLocalM(origin: LatLng, p: LatLng): { x: number; y: number } {
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos(origin.lat * DEG);
  return { x: (p.lng - origin.lng) * mPerDegLng, y: (p.lat - origin.lat) * mPerDegLat };
}

/**
 * Signed cross-track distance of `p` from the polyline, metres.
 * Positive = right of the line's direction of travel, negative = left.
 * Uses the nearest segment (by perpendicular/endpoint distance).
 */
export function crossTrackM(p: LatLng, line: LatLng[]): number {
  if (line.length === 0) return 0;
  if (line.length === 1) return haversineM(p, line[0]!);
  let best = Number.POSITIVE_INFINITY;
  let bestSigned = 0;
  for (let i = 0; i < line.length - 1; i += 1) {
    const a = line[i]!;
    const b = line[i + 1]!;
    const A = { x: 0, y: 0 };
    const B = toLocalM(a, b);
    const P = toLocalM(a, p);
    const abx = B.x - A.x;
    const aby = B.y - A.y;
    const len2 = abx * abx + aby * aby;
    if (len2 === 0) continue;
    let u = (P.x * abx + P.y * aby) / len2;
    u = Math.max(0, Math.min(1, u));
    const cx = A.x + abx * u;
    const cy = A.y + aby * u;
    const dx = P.x - cx;
    const dy = P.y - cy;
    const d = Math.hypot(dx, dy);
    if (d < best) {
      best = d;
      // cross product sign: (B−A) × (P−A); negative = right of travel direction
      const cross = abx * P.y - aby * P.x;
      bestSigned = cross < 0 ? d : -d;
    }
  }
  return Number.isFinite(best) ? bestSigned : 0;
}
