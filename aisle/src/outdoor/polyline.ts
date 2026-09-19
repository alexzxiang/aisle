/**
 * Google encoded-polyline codec (03 Task 1).
 *
 * The Routes API returns `polyline.encodedPolyline` for the route and for every
 * step; no bearing field exists anywhere, so the decoded points are the only
 * source of `startBearingDeg` / `endBearingDeg`.
 *
 * Precision 5 (1e-5 degrees), the default for `computeRoutes`.
 */
import type { LatLng } from './geo';

export function decodePolyline(encoded: string, precision = 5): LatLng[] {
  const factor = 10 ** precision;
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      if (Number.isNaN(byte)) return points;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      if (Number.isNaN(byte)) return points;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push({ lat: lat / factor, lng: lng / factor });
  }
  return points;
}

export function encodePolyline(points: readonly LatLng[], precision = 5): string {
  const factor = 10 ** precision;
  let out = '';
  let prevLat = 0;
  let prevLng = 0;
  for (const p of points) {
    const lat = Math.round(p.lat * factor);
    const lng = Math.round(p.lng * factor);
    out += encodeSigned(lat - prevLat);
    out += encodeSigned(lng - prevLng);
    prevLat = lat;
    prevLng = lng;
  }
  return out;
}

function encodeSigned(value: number): string {
  let v = value < 0 ? ~(value << 1) : value << 1;
  let out = '';
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  out += String.fromCharCode(v + 63);
  return out;
}
