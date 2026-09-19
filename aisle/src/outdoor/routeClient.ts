/**
 * `GET /api/route` client (03 Task 1). The proxy does the Google, Overpass,
 * WPRDC and Nemotron work once per route; the phone receives `crossings[]`
 * and the compiled script fully formed. Never called per fix — once at route
 * load and once per re-plan.
 *
 * `fetchImpl` is injectable so the composition root can hand the mock in; no
 * `if (mock)` branch lives here.
 */
import type { Crossing } from '../core/contracts';
import type { LatLng } from './geo';
import type { LegManeuver, RouteCrossing, RouteLeg, RouteResponse } from './types';
import { GOOGLE_ATTRIBUTION, LEG_MANEUVERS, WALKING_BETA_WARNING } from './types';

export interface RouteRequest {
  origin: LatLng;
  dest: LatLng;
  storeId: string;
}

export interface RouteClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

export interface RouteClient {
  fetchRoute(req: RouteRequest): Promise<RouteResponse>;
}

export class RouteClientError extends Error {
  constructor(message: string, public readonly kind: 'network' | 'timeout' | 'http' | 'shape', public readonly status?: number) {
    super(message);
    this.name = 'RouteClientError';
  }
}

export const ROUTE_TIMEOUT_MS = 15_000;

export function routeUrl(baseUrl: string, req: RouteRequest): string {
  const q = new URLSearchParams({
    originLat: String(req.origin.lat),
    originLng: String(req.origin.lng),
    destLat: String(req.dest.lat),
    destLng: String(req.dest.lng),
    storeId: req.storeId,
  });
  return `${baseUrl.replace(/\/+$/, '')}/api/route?${q.toString()}`;
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isLatLng(v: unknown): v is LatLng {
  return !!v && typeof v === 'object' && isNum((v as LatLng).lat) && isNum((v as LatLng).lng);
}

function isManeuver(v: unknown): v is LegManeuver {
  return typeof v === 'string' && (LEG_MANEUVERS as readonly string[]).includes(v);
}

function parseLeg(raw: unknown, index: number): RouteLeg | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const polyline = Array.isArray(r.polyline) ? r.polyline.filter(isLatLng) : [];
  if (!isManeuver(r.maneuver) || !isNum(r.distanceM) || !isNum(r.endLat) || !isNum(r.endLng)) return null;
  const roadSide = r.roadSide === 'LEFT' || r.roadSide === 'RIGHT' ? r.roadSide : 'NONE';
  const leg: RouteLeg = {
    index: isNum(r.index) ? r.index : index,
    instruction: typeof r.instruction === 'string' ? r.instruction : '',
    maneuver: r.maneuver,
    distanceM: r.distanceM,
    polyline: polyline.length > 0 ? polyline : [{ lat: r.endLat, lng: r.endLng }],
    startBearingDeg: isNum(r.startBearingDeg) ? r.startBearingDeg : 0,
    endBearingDeg: isNum(r.endBearingDeg) ? r.endBearingDeg : 0,
    endLat: r.endLat,
    endLng: r.endLng,
    roadSide,
  };
  if (typeof r.street === 'string') leg.street = r.street;
  return leg;
}

function parseCrossing(raw: unknown): RouteCrossing | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.crossingId !== 'string' || !isNum(r.bearingDeg) || !isLatLng(r.nearCurb) || !isLatLng(r.farCurb)) return null;
  const signalized: Crossing['signalized'] = typeof r.signalized === 'boolean' ? r.signalized : null;
  return {
    crossingId: r.crossingId,
    street: typeof r.street === 'string' ? r.street : '',
    signalized,
    pushButtonLikely: r.pushButtonLikely === true,
    bearingDeg: r.bearingDeg,
    nearCurb: { lat: r.nearCurb.lat, lng: r.nearCurb.lng },
    farCurb: { lat: r.farCurb.lat, lng: r.farCurb.lng },
    roadSide: r.roadSide === 'LEFT' ? 'LEFT' : 'RIGHT',
    afterLeg: isNum(r.afterLeg) ? r.afterLeg : 0,
    sAlongM: isNum(r.sAlongM) ? r.sAlongM : 0,
  };
}

/** Validate and normalize a proxy response; throws `RouteClientError('shape')` when unusable. */
export function parseRouteResponse(raw: unknown, now: number = Date.now()): RouteResponse {
  if (!raw || typeof raw !== 'object') throw new RouteClientError('route: response is not an object', 'shape');
  const r = raw as Record<string, unknown>;
  const legs = (Array.isArray(r.legs) ? r.legs : []).map(parseLeg).filter((l): l is RouteLeg => l !== null);
  if (legs.length === 0) throw new RouteClientError('route: no legs', 'shape');
  const crossings = (Array.isArray(r.crossings) ? r.crossings : []).map(parseCrossing).filter((c): c is RouteCrossing => c !== null);
  crossings.sort((a, b) => a.sAlongM - b.sAlongM);
  const warnings = (Array.isArray(r.warnings) ? r.warnings : []).filter((w): w is string => typeof w === 'string' && w.trim() !== '');
  const script = r.script && typeof r.script === 'object' ? (r.script as RouteResponse['script']) : { legs: [], crossingAnnouncements: [] };
  const planner = r.planner && typeof r.planner === 'object' ? (r.planner as RouteResponse['planner']) : {
    routeCompile: { fallback: true, latencyMs: 0 },
    crossingAnnounce: { fallback: true, latencyMs: 0 },
  };
  return {
    destName: typeof r.destName === 'string' ? r.destName : 'the store',
    legs,
    crossings,
    warnings: warnings.length > 0 ? warnings : [WALKING_BETA_WARNING],
    attribution: typeof r.attribution === 'string' ? r.attribution : GOOGLE_ATTRIBUTION,
    script: {
      legs: Array.isArray(script.legs) ? script.legs : [],
      crossingAnnouncements: Array.isArray(script.crossingAnnouncements) ? script.crossingAnnouncements : [],
    },
    planner: {
      routeCompile: { fallback: planner.routeCompile?.fallback !== false, latencyMs: isNum(planner.routeCompile?.latencyMs) ? planner.routeCompile.latencyMs : 0 },
      crossingAnnounce: { fallback: planner.crossingAnnounce?.fallback !== false, latencyMs: isNum(planner.crossingAnnounce?.latencyMs) ? planner.crossingAnnounce.latencyMs : 0 },
    },
    fetchedAt: isNum(r.fetchedAt) ? r.fetchedAt : now,
  };
}

export function createRouteClient(opts: RouteClientOptions): RouteClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? ROUTE_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  return {
    async fetchRoute(req) {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = setTimeout(() => controller?.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetchImpl(routeUrl(opts.baseUrl, req), {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: controller?.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        const aborted = (e as { name?: string })?.name === 'AbortError';
        throw new RouteClientError(aborted ? 'route: timeout' : `route: ${(e as Error)?.message ?? 'network error'}`, aborted ? 'timeout' : 'network');
      }
      clearTimeout(timer);
      if (!res.ok) throw new RouteClientError(`route: HTTP ${res.status}`, 'http', res.status);
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new RouteClientError('route: invalid JSON', 'shape');
      }
      return parseRouteResponse(body, now());
    },
  };
}
