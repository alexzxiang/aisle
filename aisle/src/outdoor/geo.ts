/**
 * Geodesy helpers for outdoor legs and crossings (pure, no side effects).
 *
 * Everything works in metres on a local equirectangular plane, which is
 * accurate to well under a metre over the few hundred metres a leg spans.
 * Bearings are degrees clockwise from true north, 0..360.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

export const EARTH_RADIUS_M = 6371008.8;
const DEG = Math.PI / 180;

export function normalizeDeg(deg: number): number {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
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

/** Initial great-circle bearing from a to b, degrees 0..360. */
export function initialBearingDeg(a: LatLng, b: LatLng): number {
  const φ1 = a.lat * DEG;
  const φ2 = b.lat * DEG;
  const Δλ = (b.lng - a.lng) * DEG;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return normalizeDeg(Math.atan2(y, x) / DEG);
}

/** Point `distM` metres from `a` along `bearingDeg`. */
export function destinationPoint(a: LatLng, bearingDeg: number, distM: number): LatLng {
  const δ = distM / EARTH_RADIUS_M;
  const θ = bearingDeg * DEG;
  const φ1 = a.lat * DEG;
  const λ1 = a.lng * DEG;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: φ2 / DEG, lng: normalizeLng(λ2 / DEG) };
}

function normalizeLng(lng: number): number {
  return ((lng + 540) % 360) - 180;
}

/** Local east/north metres of `p` relative to `origin`. */
export function toLocalXY(p: LatLng, origin: LatLng): { x: number; y: number } {
  const x = (p.lng - origin.lng) * DEG * Math.cos(origin.lat * DEG) * EARTH_RADIUS_M;
  const y = (p.lat - origin.lat) * DEG * EARTH_RADIUS_M;
  return { x, y };
}

export interface SegmentProjection {
  /** Parameter along the segment, clamped to 0..1. */
  t: number;
  /** Perpendicular distance in metres (unsigned). */
  distM: number;
  /** Signed cross-track: + = point is right of the segment direction. */
  crossTrackM: number;
  /** Metres from the segment start to the projected point (clamped). */
  alongM: number;
  /** Unclamped along-track (negative before the start, > length after the end). */
  alongRawM: number;
}

/** Project `p` onto the segment a→b on the local plane. */
export function projectOntoSegment(p: LatLng, a: LatLng, b: LatLng): SegmentProjection {
  const A = { x: 0, y: 0 };
  const B = toLocalXY(b, a);
  const P = toLocalXY(p, a);
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) {
    const d = Math.hypot(P.x, P.y);
    return { t: 0, distM: d, crossTrackM: 0, alongM: 0, alongRawM: 0 };
  }
  const len = Math.sqrt(len2);
  const tRaw = (P.x * dx + P.y * dy) / len2;
  const t = Math.max(0, Math.min(1, tRaw));
  const qx = A.x + t * dx;
  const qy = A.y + t * dy;
  const distM = Math.hypot(P.x - qx, P.y - qy);
  // cross product z of direction × (P - A): positive = left; we want + = right.
  const crossZ = dx * P.y - dy * P.x;
  const crossTrackM = -crossZ / len;
  return { t, distM, crossTrackM, alongM: t * len, alongRawM: tRaw * len };
}

export interface PolylineProjection {
  segIndex: number;
  crossTrackM: number;     // signed, + = right of the line
  distM: number;           // unsigned perpendicular distance
  alongM: number;          // metres from the polyline start (clamped inside)
  point: LatLng;           // the projected point
}

export function polylineLengthM(line: readonly LatLng[]): number {
  let total = 0;
  for (let i = 1; i < line.length; i += 1) total += haversineM(line[i - 1], line[i]);
  return total;
}

/** Nearest point on a polyline. Returns null for an empty line. */
export function projectOntoPolyline(p: LatLng, line: readonly LatLng[]): PolylineProjection | null {
  if (line.length === 0) return null;
  if (line.length === 1) {
    return { segIndex: 0, crossTrackM: 0, distM: haversineM(p, line[0]), alongM: 0, point: line[0] };
  }
  let best: PolylineProjection | null = null;
  let cumulative = 0;
  for (let i = 1; i < line.length; i += 1) {
    const a = line[i - 1];
    const b = line[i];
    const proj = projectOntoSegment(p, a, b);
    if (best === null || proj.distM < best.distM) {
      best = {
        segIndex: i - 1,
        crossTrackM: proj.crossTrackM,
        distM: proj.distM,
        alongM: cumulative + proj.alongM,
        point: interpolate(a, b, proj.t),
      };
    }
    cumulative += haversineM(a, b);
  }
  return best;
}

/**
 * Along-track metres of `p` measured on the polyline, *unclamped* at the final
 * segment so a fix past the end reads > length (the overshoot rule).
 */
export function alongTrackUnclampedM(p: LatLng, line: readonly LatLng[]): number {
  if (line.length < 2) return 0;
  const proj = projectOntoPolyline(p, line);
  if (!proj) return 0;
  if (proj.segIndex === line.length - 2) {
    const start = polylineLengthM(line.slice(0, line.length - 1));
    const seg = projectOntoSegment(p, line[line.length - 2], line[line.length - 1]);
    return start + seg.alongRawM;
  }
  return proj.alongM;
}

export function interpolate(a: LatLng, b: LatLng, t: number): LatLng {
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}

/** Point `sM` metres along the polyline (clamped to the ends). */
export function pointAtAlong(line: readonly LatLng[], sM: number): LatLng {
  if (line.length === 0) throw new Error('pointAtAlong: empty polyline');
  if (line.length === 1 || sM <= 0) return line[0];
  let cumulative = 0;
  for (let i = 1; i < line.length; i += 1) {
    const segLen = haversineM(line[i - 1], line[i]);
    if (cumulative + segLen >= sM) {
      const t = segLen === 0 ? 0 : (sM - cumulative) / segLen;
      return interpolate(line[i - 1], line[i], t);
    }
    cumulative += segLen;
  }
  return line[line.length - 1];
}

/** Bearing of the polyline at `sM` metres along it. */
export function bearingAtAlong(line: readonly LatLng[], sM: number): number {
  if (line.length < 2) return 0;
  let cumulative = 0;
  for (let i = 1; i < line.length; i += 1) {
    const segLen = haversineM(line[i - 1], line[i]);
    if (cumulative + segLen >= sM || i === line.length - 1) {
      return initialBearingDeg(line[i - 1], line[i]);
    }
    cumulative += segLen;
  }
  return initialBearingDeg(line[line.length - 2], line[line.length - 1]);
}

export interface BBox { s: number; w: number; n: number; e: number }

/** Bounding box of points, padded by `padM` metres on every side. */
export function bboxOf(points: readonly LatLng[], padM = 0): BBox {
  if (points.length === 0) throw new Error('bboxOf: no points');
  let s = Infinity;
  let n = -Infinity;
  let w = Infinity;
  let e = -Infinity;
  for (const p of points) {
    if (p.lat < s) s = p.lat;
    if (p.lat > n) n = p.lat;
    if (p.lng < w) w = p.lng;
    if (p.lng > e) e = p.lng;
  }
  const dLat = (padM / EARTH_RADIUS_M) / DEG;
  const midLat = (s + n) / 2;
  const dLng = dLat / Math.max(0.1, Math.cos(midLat * DEG));
  return { s: s - dLat, w: w - dLng, n: n + dLat, e: e + dLng };
}
