/**
 * GET /api/places?q=cvs&lat=&lng=&radiusM=1500&limit=5  (round 4: "take me to CVS")
 *
 * Nearby place search by name/brand from OpenStreetMap through Overpass (the same mirrors,
 * User-Agent and timeout as the crossings join — no key, no Google). Returns the closest
 * matches with a coordinate the app uses as the trip's entrance (radius 35 m). Cached ten
 * minutes per (query, rounded position). Nothing here is safety-relevant: it only says where
 * a place is, never how to get there.
 */
import { Router } from 'express';
import { z } from 'zod';
import { haversineM } from '../../src/outdoor/geo';
import { OVERPASS_MIRRORS, OVERPASS_USER_AGENT } from './crossings';

export const PLACES_TIMEOUT_MS = 20_000;
export const PLACES_CACHE_MS = 10 * 60 * 1000;
export const PLACES_DEFAULT_RADIUS_M = 2000;
export const PLACES_MAX_RADIUS_M = 5000;

export const QuerySchema = z.object({
  q: z.string().trim().min(1).max(60),
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radiusM: z.coerce.number().min(100).max(PLACES_MAX_RADIUS_M).default(PLACES_DEFAULT_RADIUS_M),
  limit: z.coerce.number().int().min(1).max(10).default(5),
  /** "the CVS on Forbes": a street the match should sit on (addr:street), ranked first. */
  street: z.string().trim().max(60).optional(),
});
export type PlacesQuery = z.infer<typeof QuerySchema>;

export interface Place {
  id: string;            // "node/123" | "way/456"
  name: string;
  lat: number;
  lng: number;
  distanceM: number;
  kind: string | null;   // shop=chemist, amenity=pharmacy, …
  rank: 0 | 1;           // 0 = name match, 1 = brand/operator match only
  street: string | null; // addr:street when tagged
  onStreet: boolean;     // the street hint matched
}

export interface OverpassEl {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/** Normalise a name for matching: lowercase, ASCII letters/digits, single spaces. */
export function normName(s: string): string {
  // Apostrophes join ("Trader Joe's" → "trader joes", as people say it); other punctuation splits.
  return s.toLowerCase().replace(/[’'`]/g, '').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Overpass query: every tagged POI in the radius, matched by name on this side. Regex name
 * filters cannot use Overpass's index inside `around` and time out (measured 19–25 s for
 * 2 km near Oakland, Pittsburgh); the category fetch returns in ~2 s with ~1–3k elements.
 */
export function placesQuery(lat: number, lng: number, radiusM: number): string {
  const around = `(around:${Math.round(radiusM)},${lat.toFixed(6)},${lng.toFixed(6)})`;
  const keys = ['shop', 'amenity', 'healthcare', 'office', 'tourism', 'leisure'];
  return `[out:json][timeout:${Math.round(PLACES_TIMEOUT_MS / 1000)}];(` + keys.map((k) => `nwr["${k}"]${around};`).join('') + ');out center tags;';
}

/** Does this element's name/brand match the query? Whole query as a substring, or every query word present. */
export function nameMatches(q: string, tags: Record<string, string> | undefined): boolean {
  return matchRank(q, tags) !== null;
}

/** 0 = the place's own name matches, 1 = only brand/operator matches (a GetGo run by Giant Eagle), null = no match. */
export function matchRank(q: string, tags: Record<string, string> | undefined): 0 | 1 | null {
  if (!tags) return null;
  const nq = normName(q);
  if (nq.length === 0) return null;
  const words = nq.split(' ').filter((w) => w.length > 1);
  const hit = (hay: string): boolean => hay.length > 0 && (hay.includes(nq) || (words.length > 1 && words.every((w) => hay.includes(w))));
  if (hit(normName(`${tags.name ?? ''} ${tags['name:en'] ?? ''}`))) return 0;
  if (hit(normName(`${tags.brand ?? ''} ${tags.operator ?? ''}`))) return 1;
  return null;
}

const STREET_SUFFIX_RE = /\b(street|st|avenue|ave|road|rd|boulevard|blvd|way|drive|dr|lane|ln|place|pl)\b\.?/g;

/** "Forbes Ave" → "forbes": the street's proper name, so hints and tags compare loosely. */
export function normStreet(s: string): string {
  return normName(s).replace(STREET_SUFFIX_RE, '').replace(/\s+/g, ' ').trim();
}

export function onStreetHint(hint: string | undefined, tags: Record<string, string> | undefined): boolean {
  if (!hint) return false;
  const h = normStreet(hint);
  if (!h) return false;
  const tagged = tags?.['addr:street'];
  if (!tagged) return false;
  const s = normStreet(tagged);
  return s === h || s.includes(h) || h.includes(s);
}

export function toPlaces(elements: readonly OverpassEl[], origin: { lat: number; lng: number }, limit: number, q?: string, street?: string): Place[] {
  const seen = new Set<string>();
  const out: Place[] = [];
  for (const el of elements) {
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    const name = el.tags?.name ?? el.tags?.brand;
    if (typeof lat !== 'number' || typeof lng !== 'number' || !name) continue;
    const rank: 0 | 1 | null = q !== undefined ? matchRank(q, el.tags) : 0;
    if (rank === null) continue;
    const id = `${el.type}/${el.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const kind = el.tags?.shop ? `shop=${el.tags.shop}` : el.tags?.amenity ? `amenity=${el.tags.amenity}` : el.tags?.building ? `building=${el.tags.building}` : null;
    out.push({
      id, name, lat, lng, distanceM: Math.round(haversineM(origin, { lat, lng })), kind, rank,
      street: el.tags?.['addr:street'] ?? null,
      onStreet: onStreetHint(street, el.tags),
    });
  }
  // The named street first, then name matches over brand-only, then the nearest.
  out.sort((a, b) => Number(b.onStreet) - Number(a.onStreet) || a.rank - b.rank || a.distanceM - b.distanceM);
  return out.slice(0, limit);
}

export interface PlacesDeps {
  fetchFn?: typeof fetch;
  mirrors?: readonly string[];
  now?: () => number;
  timeoutMs?: number;
}

const cache = new Map<string, { at: number; elements: OverpassEl[] }>();
export function clearPlacesCache(): void {
  cache.clear();
}

export async function searchPlaces(q: PlacesQuery, deps: PlacesDeps = {}): Promise<{ places: Place[]; source: 'live' | 'cache'; error?: string }> {
  const now = deps.now ?? Date.now;
  const fetchFn = deps.fetchFn ?? fetch;
  const mirrors = deps.mirrors ?? OVERPASS_MIRRORS;
  const timeoutMs = deps.timeoutMs ?? PLACES_TIMEOUT_MS;
  const key = `${q.lat.toFixed(3)}|${q.lng.toFixed(3)}|${q.radiusM}`;
  const hit = cache.get(key);
  if (hit && now() - hit.at <= PLACES_CACHE_MS) return { places: toPlaces(hit.elements, { lat: q.lat, lng: q.lng }, q.limit, q.q, q.street), source: 'cache' };
  const query = placesQuery(q.lat, q.lng, q.radiusM);
  const errors: string[] = [];
  for (const mirror of mirrors) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn(mirror, {
        method: 'POST',
        headers: { 'User-Agent': OVERPASS_USER_AGENT, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`overpass ${res.status}`);
      const json = (await res.json()) as { elements?: OverpassEl[]; remark?: string };
      if (typeof json.remark === 'string' && /timed out/i.test(json.remark)) throw new Error(`overpass timeout: ${json.remark.slice(0, 80)}`);
      const elements = json.elements ?? [];
      cache.set(key, { at: now(), elements });
      return { places: toPlaces(elements, { lat: q.lat, lng: q.lng }, q.limit, q.q, q.street), source: 'live' };
    } catch (e) {
      errors.push(`${mirror}: ${(e as Error)?.message ?? String(e)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  return { places: [], source: 'live', error: errors.join('; ') };
}

export function createPlacesRouter(deps: PlacesDeps = {}): Router {
  const router = Router();
  router.get('/', async (req, res) => {
    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
      return;
    }
    const r = await searchPlaces(parsed.data, deps);
    if (r.places.length === 0 && r.error) {
      res.status(502).json({ error: `places lookup failed: ${r.error}`, places: [] });
      return;
    }
    res.json({ query: parsed.data.q, places: r.places, source: r.source });
  });
  return router;
}

const router = createPlacesRouter();
export default router;
