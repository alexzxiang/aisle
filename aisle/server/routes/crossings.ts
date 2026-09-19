/**
 * Crossing data sources for `/api/route` (03 Task 2): Overpass (OSM) with a
 * mirror list, a real User-Agent, a 25 s timeout and a per-bbox cache; the
 * bundled WPRDC signalized-intersection dataset; and a recorded Overpass
 * fixture for the Oakland demo bbox so a 504 at the venue costs nothing.
 * The join itself is pure and lives in `src/crossing/crossingData.ts`.
 *
 * Called once per route from the proxy — never per fix, never from the phone.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { overpassQuery, parseWprdcRecords, type OverpassElement, type OverpassResponse, type WprdcSignal } from '../../src/crossing/crossingData';
import type { BBox } from '../../src/outdoor/geo';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.resolve(HERE, '..', 'data');
export const WPRDC_FILE = path.join(DATA_DIR, 'wprdc-signals.json');
export const OVERPASS_FIXTURE_FILE = path.join(DATA_DIR, 'fixtures', 'overpass-oakland-forbes-bouquet.json');

export const OVERPASS_MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
export const OVERPASS_USER_AGENT = 'Aisle/0.1 (SteelHacks)';
export const OVERPASS_TIMEOUT_MS = 25_000;
export const OVERPASS_CACHE_MS = 30 * 60 * 1000;

export type OverpassSource = 'live' | 'cache' | 'fixture' | 'none';

export interface OverpassFetchResult {
  elements: OverpassElement[];
  source: OverpassSource;
  mirror: string | null;
  error?: string;
}

export interface OverpassFetchDeps {
  fetchFn?: typeof fetch;
  now?: () => number;
  mirrors?: string[];
  timeoutMs?: number;
  /** Recorded fixture used when every mirror fails and the bbox lies inside it. */
  fixture?: () => Promise<OverpassResponse | null>;
}

/** Cache key: bbox rounded to 1e-3° (~100 m), enough to reuse across nearby origins. */
export function bboxKey(b: BBox): string {
  const r = (v: number): string => v.toFixed(3);
  return `${r(b.s)},${r(b.w)},${r(b.n)},${r(b.e)}`;
}

const cache = new Map<string, { at: number; elements: OverpassElement[] }>();

export function clearOverpassCache(): void {
  cache.clear();
}

async function postOverpass(url: string, query: string, fetchFn: typeof fetch, timeoutMs: number): Promise<OverpassResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'User-Agent': OVERPASS_USER_AGENT, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`overpass ${res.status}`);
    return (await res.json()) as OverpassResponse;
  } finally {
    clearTimeout(timer);
  }
}

/** Bounding box of the elements in a recorded response (nodes + way geometry). */
export function elementsBBox(elements: readonly OverpassElement[]): BBox | null {
  let s = Infinity;
  let n = -Infinity;
  let w = Infinity;
  let e = -Infinity;
  const take = (lat: number, lon: number): void => {
    if (lat < s) s = lat;
    if (lat > n) n = lat;
    if (lon < w) w = lon;
    if (lon > e) e = lon;
  };
  for (const el of elements) {
    if (el.type === 'node' && typeof (el as { lat?: number }).lat === 'number') {
      take((el as { lat: number }).lat, (el as { lon: number }).lon);
    } else if (el.type === 'way') {
      for (const g of (el as { geometry?: Array<{ lat: number; lon: number }> }).geometry ?? []) take(g.lat, g.lon);
    }
  }
  return Number.isFinite(s) ? { s, w, n, e } : null;
}

export function bboxInside(inner: BBox, outer: BBox): boolean {
  return inner.s >= outer.s && inner.n <= outer.n && inner.w >= outer.w && inner.e <= outer.e;
}

export async function loadOverpassFixture(file: string = OVERPASS_FIXTURE_FILE): Promise<OverpassResponse | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as OverpassResponse;
  } catch {
    return null;
  }
}

/**
 * Crossing nodes, crossing footways and road ways in the bbox. Tries the
 * mirrors in order, then the recorded fixture when the bbox lies inside it,
 * then an empty set (the route still works — with no crossings, honestly).
 */
export async function fetchOverpass(bbox: BBox, deps: OverpassFetchDeps = {}): Promise<OverpassFetchResult> {
  const now = deps.now ?? Date.now;
  const fetchFn = deps.fetchFn ?? fetch;
  const mirrors = deps.mirrors ?? OVERPASS_MIRRORS;
  const timeoutMs = deps.timeoutMs ?? OVERPASS_TIMEOUT_MS;
  const key = bboxKey(bbox);
  const hit = cache.get(key);
  if (hit && now() - hit.at <= OVERPASS_CACHE_MS) return { elements: hit.elements, source: 'cache', mirror: null };

  const query = overpassQuery(bbox);
  const errors: string[] = [];
  for (const mirror of mirrors) {
    try {
      const res = await postOverpass(mirror, query, fetchFn, timeoutMs);
      const elements = (res.elements ?? []) as OverpassElement[];
      cache.set(key, { at: now(), elements });
      return { elements, source: 'live', mirror };
    } catch (e) {
      errors.push(`${mirror}: ${(e as Error)?.message ?? String(e)}`);
    }
  }
  const fixture = await (deps.fixture ?? loadOverpassFixture)();
  if (fixture) {
    const elements = (fixture.elements ?? []) as OverpassElement[];
    const fb = elementsBBox(elements);
    if (fb && bboxInside(bbox, fb)) {
      return { elements, source: 'fixture', mirror: null, error: errors.join('; ') };
    }
  }
  return { elements: [], source: 'none', mirror: null, error: errors.join('; ') };
}

// --- WPRDC ------------------------------------------------------------------------

let wprdcCache: WprdcSignal[] | null = null;

export interface WprdcFile {
  source: string;
  dataset: string;
  resourceId: string;
  license: string;
  fetchedAt: string;
  fields: string[];
  rowCount: number;
  rows: Array<Record<string, unknown>>;
}

/** The bundled City of Pittsburgh signalized-intersection list (CC BY, WPRDC). */
export async function loadWprdc(file: string = WPRDC_FILE): Promise<WprdcSignal[]> {
  if (wprdcCache && file === WPRDC_FILE) return wprdcCache;
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<WprdcFile>;
    const rows = parseWprdcRecords(parsed.rows ?? []);
    if (file === WPRDC_FILE) wprdcCache = rows;
    return rows;
  } catch {
    return [];
  }
}

export function resetWprdcCache(): void {
  wprdcCache = null;
}
