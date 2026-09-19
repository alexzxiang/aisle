/**
 * Degraded route: one straight leg from the current fix to the store entrance, used when
 * the proxy has no route data (Google disabled / 5xx / bad shape) so the trip still starts
 * — the course buzz keeps the user on the entrance bearing, the transition detector arms on
 * the ARRIVE leg, and the indoor flow is reachable. Honest by construction: no crossings
 * (nothing is announced that is not known), a visible warning, no planner script.
 */
import type { RouteLeg, RouteResponse } from './types';
import type { LatLng } from './geo';
import { haversineM, initialBearingDeg } from './geo';

export const DIRECT_ROUTE_ATTRIBUTION = 'Direct heading (no route data)';
export const DIRECT_ROUTE_WARNING = 'No route data: heading straight to the entrance. Crossings are not announced. Follow your cane.';

export function directRoute(origin: LatLng, entrance: LatLng, destName: string, now: number = Date.now()): RouteResponse {
  const distanceM = Math.round(haversineM(origin, entrance));
  const bearing = initialBearingDeg(origin, entrance);
  const leg: RouteLeg = {
    index: 0,
    instruction: `Head toward ${destName}`,
    maneuver: 'ARRIVE',
    distanceM,
    polyline: [origin, entrance],
    startBearingDeg: bearing,
    endBearingDeg: bearing,
    endLat: entrance.lat,
    endLng: entrance.lng,
    roadSide: 'NONE',
  };
  return {
    destName,
    legs: [leg],
    crossings: [],
    warnings: [DIRECT_ROUTE_WARNING],
    attribution: DIRECT_ROUTE_ATTRIBUTION,
    script: { legs: [], crossingAnnouncements: [] },
    planner: { routeCompile: { fallback: true, latencyMs: 0 }, crossingAnnounce: { fallback: true, latencyMs: 0 } },
    fetchedAt: now,
  };
}
