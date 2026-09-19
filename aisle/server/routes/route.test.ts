import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findForbiddenTerm } from '../../src/core/phrases';
import type { OverpassResponse } from '../../src/crossing/crossingData';
import type { RawComputeRoutesResponse } from '../../src/outdoor/routeParse';
import { WALKING_BETA_WARNING } from '../../src/outdoor/types';
import { createRequestLog } from '../lib/log';
import { testConfig } from '../test/fakes';
import { clearOverpassCache, loadOverpassFixture, loadWprdc } from './crossings';
import { buildRoute, cacheKeyFor, clearRouteCache, createRouteRouter, fixtureMatches, routeCompileInputFor, type RouteDeps } from './route';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const GOOGLE_FIXTURE = path.resolve(HERE, '..', 'data', 'fixtures', 'computeRoutes-forbes-bouquet.json');

const ORIGIN = { lat: 40.4428803, lng: -79.9546937 };
const DEST = { lat: 40.4422747, lng: -79.9570206 };
const query = { originLat: ORIGIN.lat, originLng: ORIGIN.lng, destLat: DEST.lat, destLng: DEST.lng, storeId: 'demo-store-01' };

let google: RawComputeRoutesResponse;
let overpass: OverpassResponse;

/** fetch that serves the recorded Google and Overpass responses and counts calls. */
function fakeFetch(opts: { overpassFail?: boolean; googleStatus?: number } = {}) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, headers: (init?.headers as Record<string, string>) ?? {} });
    if (u.includes('routes.googleapis.com')) {
      const status = opts.googleStatus ?? 200;
      return { ok: status < 300, status, json: async () => google } as Response;
    }
    if (u.includes('overpass')) {
      if (opts.overpassFail) return { ok: false, status: 504, json: async () => ({}) } as Response;
      return { ok: true, status: 200, json: async () => overpass } as Response;
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function deps(over: Partial<RouteDeps> = {}, fetchOpts: Parameters<typeof fakeFetch>[0] = {}): RouteDeps & { calls: ReturnType<typeof fakeFetch>['calls'] } {
  const f = fakeFetch(fetchOpts);
  return {
    config: testConfig({ nvidiaApiKey: null, openRouterApiKey: null }),   // planner → templates, instantly
    fetchFn: f.fn,
    log: createRequestLog({ sink: () => {} }),
    cacheDir: null,
    plan: { log: createRequestLog({ sink: () => {} }) },
    overpass: { fetchFn: f.fn, mirrors: ['https://overpass.test/api/interpreter'] },
    calls: f.calls,
    ...over,
  };
}

beforeEach(async () => {
  clearRouteCache();
  clearOverpassCache();
  google = JSON.parse(await fs.readFile(GOOGLE_FIXTURE, 'utf8')) as RawComputeRoutesResponse;
  overpass = (await loadOverpassFixture())!;
});

describe('buildRoute on the recorded Forbes / Bouquet route', () => {
  it('normalizes legs with bearings, finds the signalized Forbes crossing, compiles the script', async () => {
    const d = deps();
    const r = await buildRoute(query, d);
    // Google call shape.
    const g = d.calls.find((c) => c.url.includes('routes.googleapis.com'))!;
    expect(g.headers['X-Goog-Api-Key']).toBe('test-google');
    expect(g.headers['X-Goog-FieldMask']).toContain('routes.legs.steps.navigationInstruction');
    // Legs: DEPART merged into the first leg, TURN_RIGHT at its end, ARRIVE synthesized.
    expect(r.legs.map((l) => l.maneuver)).toEqual(['TURN_RIGHT', 'ARRIVE']);
    expect(r.legs[0]!.startBearingDeg).toBeGreaterThan(200);
    expect(r.legs[0]!.startBearingDeg).toBeLessThan(260);
    // The recorded polyline runs on the Forbes Ave centreline, so no side is 'the roadway' — NONE is the honest value.
    expect(['LEFT', 'RIGHT', 'NONE']).toContain(r.legs[0]!.roadSide);
    expect(r.warnings).toEqual([WALKING_BETA_WARNING]);
    expect(r.attribution).toMatch(/Google Maps/);
    expect(r.sources).toMatchObject({ google: 'live', overpass: 'live', cache: 'none' });
    expect(r.sources.wprdcRows).toBeGreaterThan(700);
    // Crossings: at least one, sorted, the Forbes Ave crossing signalized (WPRDC "Fixed" + OSM tags).
    expect(r.crossings.length).toBeGreaterThan(0);
    const s = r.crossings.map((c) => c.sAlongM);
    expect([...s].sort((a, b) => a - b)).toEqual(s);
    const forbes = r.crossings.find((c) => /Forbes/.test(c.street));
    expect(forbes).toBeDefined();
    expect(forbes!.signalized).toBe(true);
    expect(forbes!.nearCurb).not.toEqual(forbes!.farCurb);
    // Script: one entry per leg, templates (no NIM key), announcement per crossing.
    expect(r.planner.routeCompile.fallback).toBe(true);
    expect(r.script.legs.map((l) => l.index)).toEqual([0, 1]);
    expect(r.script.legs[0]).toMatchObject({ soon: 'Turn right in sixty feet.', now: 'Turn right now.' });
    expect(r.script.legs[1]!.confirm).toMatch(/^Entrance ahead, /);
    expect(r.script.crossingAnnouncements.map((a) => a.crossingId)).toEqual(r.crossings.map((c) => c.crossingId));
    const forbesText = r.script.crossingAnnouncements.find((a) => a.crossingId === forbes!.crossingId)!.text;
    expect(forbesText.startsWith('Crossing ahead: Forbes Avenue. Signalized.')).toBe(true);
    // OSM tags button_operated=yes on that node; the announcement follows the data.
    expect(/Push button likely\.$/.test(forbesText)).toBe(forbes!.pushButtonLikely);
    for (const a of r.script.crossingAnnouncements) {
      expect(findForbiddenTerm(a.text)).toBeNull();
      expect(/\d/.test(a.text)).toBe(false);
      expect(a.text.split(/\s+/).length).toBeLessThanOrEqual(12);
    }
    for (const l of r.script.legs) for (const t of [l.soon, l.now, l.confirm]) expect(/\d/.test(t)).toBe(false);
  });

  it('serves the second identical request from memory without calling Google or Overpass again', async () => {
    const d = deps();
    await buildRoute(query, d);
    const n = d.calls.length;
    const again = await buildRoute(query, d);
    expect(d.calls.length).toBe(n);
    expect(again.sources.cache).toBe('memory');
    expect(cacheKeyFor(query)).toBe('40.4429_-79.9547__40.4423_-79.9570');
  });

  it('Overpass down → the recorded fixture for the Oakland bbox, honestly labelled', async () => {
    const d = deps({}, { overpassFail: true });
    const r = await buildRoute(query, d);
    expect(r.sources.overpass).toBe('fixture');
    expect(r.crossings.length).toBeGreaterThan(0);
  });

  it('Overpass down outside the fixture bbox → no crossings, not a guess', async () => {
    const d = deps({ overpass: { fetchFn: fakeFetch({ overpassFail: true }).fn, mirrors: ['https://overpass.test/x'], fixture: async () => null } });
    const r = await buildRoute(query, d);
    expect(r.sources.overpass).toBe('none');
    expect(r.crossings).toEqual([]);
    expect(r.legs.every((l) => l.roadSide === 'NONE')).toBe(true);
  });

  it('Google failing (403: API disabled) → the recorded route stands in when both ends match', async () => {
    const d = deps({}, { googleStatus: 403 });
    const r = await buildRoute(query, d);
    expect(r.sources.google).toBe('fixture');
    expect(d.calls.some((c) => c.url.includes('routes.googleapis.com'))).toBe(true); // Google was tried first
    expect(r.legs.length).toBeGreaterThan(0);
  });

  it('Google failing with no matching recorded route → 502, never a guess', async () => {
    const d = deps({ routeFixture: async () => null }, { googleStatus: 403 });
    await expect(buildRoute(query, d)).rejects.toMatchObject({ status: 502 });
  });

  it('no Google key: the recorded route stands in when both ends match, else 503', async () => {
    const d = deps({ config: testConfig({ googleMapsApiKey: null, nvidiaApiKey: null, openRouterApiKey: null }) });
    const r = await buildRoute(query, d);
    expect(r.sources.google).toBe('fixture');
    expect(d.calls.some((c) => c.url.includes('routes.googleapis.com'))).toBe(false);
    clearRouteCache();
    await expect(buildRoute({ ...query, originLat: 40.46, originLng: -79.93 }, d)).rejects.toMatchObject({ status: 503 });
    expect(fixtureMatches(google, ORIGIN, DEST)).toBe(true);
    expect(fixtureMatches(google, { lat: 40.46, lng: -79.93 }, DEST)).toBe(false);
  });

  it('a Google error falls back to the disk cache when one exists', async () => {
    const dir = path.join(HERE, 'cache', `test-${process.pid}`);
    try {
      const d = deps({ cacheDir: dir });
      await buildRoute(query, d);
      clearRouteCache();
      const d2 = deps({ cacheDir: dir }, { googleStatus: 500 });
      const r = await buildRoute(query, d2);
      expect(r.sources.cache).toBe('disk');
      expect(r.legs).toHaveLength(2);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('routeCompileInputFor maps afterLeg → afterStep and keeps the collapsed maneuvers', async () => {
    const r = await buildRoute(query, deps());
    const input = routeCompileInputFor(r.legs, r.crossings);
    expect(input.steps.map((s) => s.maneuver)).toEqual(['TURN_RIGHT', 'ARRIVE']);
    expect(input.crossings[0]!.afterStep).toBe(r.crossings[0]!.afterLeg);
  });

  it('the bundled WPRDC file has the documented columns and the Forbes/Bouquet signal', async () => {
    const rows = await loadWprdc();
    expect(rows.length).toBeGreaterThan(700);   // 783 rows in the dataset; a few lack coordinates
    expect(rows.some((s) => /Bouquet/.test(s.description) && /Forbes/.test(s.description))).toBe(true);
  });
});

describe('GET /api/route', () => {
  let server: Server | null = null;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  async function start(): Promise<string> {
    const app = express();
    app.use('/api/route', createRouteRouter(deps()));
    server = createServer(app);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const addr = server.address();
    return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  }

  it('answers under D\'s mount with the RouteResponse shape and rejects bad queries', async () => {
    const base = await start();
    const q = new URLSearchParams({ originLat: String(ORIGIN.lat), originLng: String(ORIGIN.lng), destLat: String(DEST.lat), destLng: String(DEST.lng), storeId: 'demo-store-01' });
    const res = await fetch(`${base}/api/route?${q}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { legs: unknown[]; crossings: unknown[]; warnings: string[]; script: { legs: unknown[] }; planner: { routeCompile: { fallback: boolean } }; fetchedAt: number };
    expect(body.legs).toHaveLength(2);
    expect(body.warnings[0]).toBe(WALKING_BETA_WARNING);
    expect(body.script.legs).toHaveLength(2);
    expect(typeof body.fetchedAt).toBe('number');
    const bad = await fetch(`${base}/api/route?originLat=abc`);
    expect(bad.status).toBe(400);
  });
});
