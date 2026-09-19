/**
 * `GET /api/route?originLat=&originLng=&destLat=&destLng=&storeId=` (03 Tasks 1, 2, 7).
 *
 * Once per route, on the proxy:
 *   1. Google Routes `computeRoutes` WALK with the mandatory field mask → `RouteLeg[]`
 *      (bearings from the decoded polylines; DEPART/NAME_CHANGE merged; ARRIVE synthesized).
 *   2. Overpass for `highway=crossing` / `footway=crossing` / road ways in the padded
 *      route bbox (cached; mirrors; recorded fixture as the last resort), joined with
 *      the bundled WPRDC signalized-intersection list → `crossings[]` with
 *      `signalized | null`, `pushButtonLikely`, `bearingDeg`, near/far curb, `roadSide`.
 *   3. Nemotron `crossingAnnounce` for ambiguous clusters and `routeCompile` for the
 *      ≤ 12-word leg script, in-process through `plan.ts`, each behind its deadline
 *      and template, so the phone receives everything the walk needs fully formed.
 *
 * Cached in memory (30 min, origin/destination rounded to 1e-4°) and on disk
 * under `server/routes/cache/` so a Google or Overpass hiccup at the venue costs
 * nothing. Google data says where a crossing is; no walk cue derives from it.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { CrossingAnnounceInput, RouteCompileInput, RouteCompileOutput } from '../../src/core/contracts';
import { joinCrossings, withRoadSides, type AmbiguousCluster, type OverpassElement, type WprdcSignal } from '../../src/crossing/crossingData';
import { bboxOf, haversineM, type LatLng } from '../../src/outdoor/geo';
import { COMPUTE_ROUTES_URL, ROUTES_FIELD_MASK, computeRoutesBody, parseComputeRoutes, type RawComputeRoutesResponse } from '../../src/outdoor/routeParse';
import type { RouteCrossing, RouteLeg, RouteResponse } from '../../src/outdoor/types';
import { loadConfig, type ProxyConfig } from '../config';
import { requestLog, type RequestLog } from '../lib/log';
import { fetchOverpass, loadWprdc, type OverpassFetchDeps, type OverpassSource } from './crossings';
import { runPlannerJob, type PlanDeps } from './plan';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CACHE_DIR = path.join(HERE, 'cache');
export const ROUTE_FIXTURE_FILE = path.resolve(HERE, '..', 'data', 'fixtures', 'computeRoutes-forbes-bouquet.json');
const STORES_DIR = path.resolve(HERE, '..', '..', 'fixtures', 'stores');

export const ROUTE_CACHE_MS = 30 * 60 * 1000;
export const ROUTE_BBOX_PAD_M = 60;
export const GOOGLE_TIMEOUT_MS = 10_000;
/** A recorded route stands in for Google only when both ends are this close to it. */
export const FIXTURE_MATCH_M = 150;

export type GoogleSource = 'live' | 'fixture';

export interface RouteSources {
  google: GoogleSource;
  overpass: OverpassSource;
  wprdcRows: number;
  cache: 'memory' | 'disk' | 'none';
}

export type RouteResponseWithSources = RouteResponse & { sources: RouteSources };

export interface RouteDeps {
  config?: ProxyConfig;
  fetchFn?: typeof fetch;
  log?: RequestLog;
  now?: () => number;
  overpass?: OverpassFetchDeps;
  wprdc?: () => Promise<WprdcSignal[]>;
  plan?: PlanDeps;
  /** Where the disk cache lives; null disables it (tests). */
  cacheDir?: string | null;
  /** Recorded Google response used when no key is configured (tests, venue backup). */
  routeFixture?: () => Promise<RawComputeRoutesResponse | null>;
  storesDir?: string;
}

export const QuerySchema = z.object({
  originLat: z.coerce.number().min(-90).max(90),
  originLng: z.coerce.number().min(-180).max(180),
  destLat: z.coerce.number().min(-90).max(90),
  destLng: z.coerce.number().min(-180).max(180),
  storeId: z.string().regex(/^[\w-]{1,64}$/).default('demo-store-01'),
});

export type RouteQuery = z.infer<typeof QuerySchema>;

/** Overpass budget inside a route request: every mirror at once, first answer wins, ≤ 5 s in all. */
export const ROUTE_OVERPASS_BUDGET_MS = 5000;

export function cacheKeyFor(q: Pick<RouteQuery, 'originLat' | 'originLng' | 'destLat' | 'destLng'>): string {
  const r = (v: number): string => v.toFixed(4);
  return `${r(q.originLat)}_${r(q.originLng)}__${r(q.destLat)}_${r(q.destLng)}`;
}

const memory = new Map<string, { at: number; value: RouteResponseWithSources }>();

export function clearRouteCache(): void {
  memory.clear();
}

async function readDisk(dir: string | null, key: string): Promise<RouteResponseWithSources | null> {
  if (!dir) return null;
  try {
    return JSON.parse(await fs.readFile(path.join(dir, `${key}.json`), 'utf8')) as RouteResponseWithSources;
  } catch {
    return null;
  }
}

async function writeDisk(dir: string | null, key: string, value: RouteResponseWithSources): Promise<void> {
  if (!dir) return;
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${key}.json`), JSON.stringify(value), 'utf8');
  } catch {
    // The disk cache is a convenience; never fail a route over it.
  }
}

export async function loadRouteFixture(file: string = ROUTE_FIXTURE_FILE): Promise<RawComputeRoutesResponse | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as RawComputeRoutesResponse;
  } catch {
    return null;
  }
}

/** Does a recorded response start and end near these points? */
export function fixtureMatches(raw: RawComputeRoutesResponse, origin: LatLng, dest: LatLng, maxM = FIXTURE_MATCH_M): boolean {
  const steps = raw.routes?.[0]?.legs?.flatMap((l) => l.steps ?? []) ?? [];
  const first = steps[0]?.startLocation?.latLng;
  const last = steps[steps.length - 1]?.endLocation?.latLng;
  if (!first || !last) return false;
  return haversineM(origin, { lat: first.latitude, lng: first.longitude }) <= maxM
    && haversineM(dest, { lat: last.latitude, lng: last.longitude }) <= maxM;
}

export class RouteError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'RouteError';
  }
}

async function fetchGoogle(origin: LatLng, dest: LatLng, deps: RouteDeps, config: ProxyConfig): Promise<{ raw: RawComputeRoutesResponse; source: GoogleSource }> {
  const fetchFn = deps.fetchFn ?? fetch;
  if (config.googleMapsApiKey) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GOOGLE_TIMEOUT_MS);
    try {
      const res = await fetchFn(COMPUTE_ROUTES_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': config.googleMapsApiKey,
          'X-Goog-FieldMask': ROUTES_FIELD_MASK,
        },
        body: JSON.stringify(computeRoutesBody(origin, dest)),
        signal: controller.signal,
      });
      if (!res.ok) throw new RouteError(`computeRoutes ${res.status}`, 502);
      const raw = (await res.json()) as RawComputeRoutesResponse;
      if (!raw.routes?.length) throw new RouteError('computeRoutes returned no route', 404);
      return { raw, source: 'live' };
    } catch (e) {
      if (e instanceof RouteError) throw e;
      throw new RouteError(`computeRoutes failed: ${(e as Error)?.message ?? String(e)}`, 502);
    } finally {
      clearTimeout(timer);
    }
  }
  const fixture = await (deps.routeFixture ?? loadRouteFixture)();
  if (fixture && fixtureMatches(fixture, origin, dest)) return { raw: fixture, source: 'fixture' };
  throw new RouteError('GOOGLE_MAPS_API_KEY is not set and no recorded route matches this origin/destination', 503);
}

async function storeDisplayName(storeId: string, dir: string): Promise<string | null> {
  try {
    const json = JSON.parse(await fs.readFile(path.join(dir, `${storeId}.json`), 'utf8')) as { displayName?: unknown };
    return typeof json.displayName === 'string' ? json.displayName : null;
  } catch {
    return null;
  }
}

/** `RouteCompileInput` from the legs and crossings (afterStep = afterLeg). */
export function routeCompileInputFor(legs: readonly RouteLeg[], crossings: readonly RouteCrossing[]): RouteCompileInput {
  return {
    steps: legs.map((l) => ({ index: l.index, instruction: l.instruction, maneuver: l.maneuver, distanceM: l.distanceM, startBearingDeg: l.startBearingDeg })),
    crossings: crossings.map((c) => ({ crossingId: c.crossingId, afterStep: c.afterLeg, street: c.street, signalized: c.signalized, pushButtonLikely: c.pushButtonLikely, bearingDeg: c.bearingDeg })),
  };
}

/** Apply a `crossingAnnounce` judgment to its crossing (facts only; the text is templated from them). */
export function applyAnnounce(c: RouteCrossing, out: { signalized: boolean | null; pushButtonLikely: boolean }): RouteCrossing {
  return { ...c, signalized: out.signalized, pushButtonLikely: out.pushButtonLikely };
}

/**
 * Build the full response for one origin/destination. Exported so tests and the
 * fixture recorder run it without HTTP.
 */
export async function buildRoute(q: RouteQuery, deps: RouteDeps = {}): Promise<RouteResponseWithSources> {
  const now = deps.now ?? Date.now;
  const config = deps.config ?? loadConfig();
  const origin: LatLng = { lat: q.originLat, lng: q.originLng };
  const dest: LatLng = { lat: q.destLat, lng: q.destLng };
  const key = cacheKeyFor(q);
  const cacheDir = deps.cacheDir === undefined ? CACHE_DIR : deps.cacheDir;

  const hit = memory.get(key);
  if (hit && now() - hit.at <= ROUTE_CACHE_MS) return { ...hit.value, sources: { ...hit.value.sources, cache: 'memory' } };

  let google: { raw: RawComputeRoutesResponse; source: GoogleSource };
  try {
    google = await fetchGoogle(origin, dest, deps, config);
  } catch (e) {
    const disk = await readDisk(cacheDir, key);
    if (disk) {
      memory.set(key, { at: now(), value: disk });
      return { ...disk, sources: { ...disk.sources, cache: 'disk' } };
    }
    // Google failed (API disabled, 403, 5xx, network, timeout) and nothing is cached: a
    // recorded route that starts and ends near this query stands in, honestly labelled —
    // the demo must survive a Google outage. Otherwise the error propagates (never a guess).
    const fixture = await (deps.routeFixture ?? loadRouteFixture)();
    if (fixture && fixtureMatches(fixture, origin, dest)) {
      google = { raw: fixture, source: 'fixture' };
    } else {
      throw e;
    }
  }

  const parsed = parseComputeRoutes(google.raw);
  if (parsed.legs.length === 0) throw new RouteError('route has no steps', 404);

  const allPoints = parsed.legs.flatMap((l) => l.polyline);
  const bbox = bboxOf(allPoints.length > 0 ? allPoints : [origin, dest], ROUTE_BBOX_PAD_M);
  // Overpass gets a short budget on the route path (round 6c): the phone times a route out at
  // 15 s and says "Offline", and two mirrors at 25 s each took 17–39 s in the field. A route
  // with fewer announced crossings beats no route; the standalone crossings fetch keeps its
  // full timeout and the bbox cache means the next call is instant.
  const [overpass, wprdc] = await Promise.all([
    fetchOverpass(bbox, { fetchFn: deps.fetchFn, now, timeoutMs: ROUTE_OVERPASS_BUDGET_MS, parallel: true, ...(deps.overpass ?? {}) }),
    (deps.wprdc ?? loadWprdc)(),
  ]);
  const elements: OverpassElement[] = overpass.elements;
  const legs = withRoadSides(parsed.legs, elements);
  const join = joinCrossings({ legs, elements, wprdc });
  let crossings = join.crossings;

  // Nemotron judges only the ambiguous clusters; unambiguous ones use the template.
  const planDeps: PlanDeps = { config, ...(deps.plan ?? {}) };
  let announceFallback = false;
  let announceLatency = 0;
  const announceText = new Map<string, string>();
  // The two route-time planner jobs are independent: the compile script names crossings by id
  // and the announcement text is patched in afterwards. Run them together (round 6c: they
  // used to run one after the other, up to twelve seconds on a slow Nemotron night).
  const announcing = join.ambiguous.length > 0
    ? Promise.all(join.ambiguous.map(async (a: AmbiguousCluster) => {
        const input: CrossingAnnounceInput = { candidates: a.candidates, street: a.street };
        const r = await runPlannerJob('crossingAnnounce', input, planDeps);
        return { a, r };
      }))
    : Promise.resolve([] as Array<{ a: AmbiguousCluster; r: Awaited<ReturnType<typeof runPlannerJob<'crossingAnnounce'>>> }>);
  const compiling = runPlannerJob('routeCompile', routeCompileInputFor(legs, crossings), planDeps);
  const [results, compile] = await Promise.all([announcing, compiling]);
  for (const { a, r } of results) {
    announceFallback = announceFallback || r.fallback;
    announceLatency = Math.max(announceLatency, r.latencyMs);
    crossings = crossings.map((c) => (c.crossingId === a.crossingId ? applyAnnounce(c, r.output) : c));
    announceText.set(a.crossingId, r.output.text);
  }
  const script: RouteCompileOutput = {
    legs: compile.output.legs,
    crossingAnnouncements: compile.output.crossingAnnouncements.map((x) => ({ crossingId: x.crossingId, text: announceText.get(x.crossingId) ?? x.text })),
  };

  const destName = (await storeDisplayName(q.storeId, deps.storesDir ?? STORES_DIR)) ?? 'the store';
  const value: RouteResponseWithSources = {
    destName,
    legs,
    crossings,
    warnings: parsed.warnings,
    attribution: parsed.attribution,
    script,
    planner: {
      routeCompile: { fallback: compile.fallback, latencyMs: compile.latencyMs },
      crossingAnnounce: { fallback: announceFallback, latencyMs: announceLatency },
    },
    fetchedAt: now(),
    sources: { google: google.source, overpass: overpass.source, wprdcRows: wprdc.length, cache: 'none' },
  };
  memory.set(key, { at: now(), value });
  await writeDisk(cacheDir, key, value);
  return value;
}

export function createRouteRouter(deps: RouteDeps = {}): Router {
  const router = Router();
  // D's app mounts this router at '/api/route' (so the path is '/'); a bare app.use(router) also works.
  router.get(['/', '/api/route'], async (req: Request, res: Response) => {
    const t0 = (deps.now ?? Date.now)();
    const log = deps.log ?? requestLog;
    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'expected originLat, originLng, destLat, destLng (numbers) and storeId' });
      return;
    }
    try {
      const value = await buildRoute(parsed.data, deps);
      log.write({ route: 'route', key: parsed.data.storeId, totalMs: (deps.now ?? Date.now)() - t0, fallback: value.planner.routeCompile.fallback, status: 200, extra: { sources: value.sources, legs: value.legs.length, crossings: value.crossings.length } });
      res.json(value);
    } catch (e) {
      const status = e instanceof RouteError ? e.status : 500;
      const message = (e as Error)?.message ?? 'route failed';
      log.write({ route: 'route', key: parsed.data.storeId, totalMs: (deps.now ?? Date.now)() - t0, status, error: message });
      res.status(status).json({ error: message });
    }
  });
  return router;
}

const router = createRouteRouter();
export default router;
