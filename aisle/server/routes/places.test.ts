import { beforeEach, describe, expect, it } from 'vitest';
import { clearPlacesCache, nameMatches, normStreet, onStreetHint, placesQuery, searchPlaces, toPlaces } from './places';

const ORIGIN = { lat: 40.4443, lng: -79.9436 };
const elements: Array<{ type: string; id: number; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }> = [
  { type: 'node', id: 1, lat: 40.4450, lon: -79.9440, tags: { name: 'CVS Pharmacy', amenity: 'pharmacy' } },
  { type: 'way', id: 2, center: { lat: 40.4500, lon: -79.9500 }, tags: { brand: 'CVS', shop: 'chemist' } },
  { type: 'node', id: 3, lat: 40.4444, lon: -79.9437, tags: { amenity: 'bench' } },           // no name → dropped
  { type: 'node', id: 1, lat: 40.4450, lon: -79.9440, tags: { name: 'CVS Pharmacy' } },      // duplicate id → dropped
];

function fakeFetch(handler: (url: string, body: string) => Response) {
  const calls: Array<{ url: string; body: string }> = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = String(init?.body ?? '');
    calls.push({ url, body });
    return handler(url, body);
  }) as typeof fetch;
  return { fn, calls };
}

beforeEach(() => clearPlacesCache());

describe('places query', () => {
  it('fetches tagged POIs around the position without a regex (index-friendly) and matches names here', () => {
    const q = placesQuery(40.4443, -79.9436, 1500);
    expect(q).toContain('nwr["shop"](around:1500,40.444300,-79.943600);');
    expect(q).toContain('nwr["amenity"](around:1500,40.444300,-79.943600);');
    expect(q).not.toContain('~');
    expect(q).toContain('out center tags');
  });
  it('nameMatches: an apostrophe joins ("trader joes" finds "Trader Joe\'s")', () => {
    expect(nameMatches('trader joes', { name: "Trader Joe's" })).toBe(true);
    expect(nameMatches("trader joe's", { name: 'Trader Joes' })).toBe(true);
    expect(nameMatches('joes', { name: "Trader Joe's" })).toBe(true);
  });

  it('nameMatches: substring or all-words, over name/brand/operator, punctuation-insensitive', () => {
    expect(nameMatches('cvs', { name: 'CVS Pharmacy' })).toBe(true);
    expect(nameMatches('CVS pharmacy', { brand: 'CVS', name: 'CVS Pharmacy #1234' })).toBe(true);
    expect(nameMatches('giant eagle', { name: 'Giant Eagle Market District' })).toBe(true);
    expect(nameMatches('7-eleven', { name: '7 Eleven' })).toBe(true);
    expect(nameMatches('cvs', { name: 'Rite Aid' })).toBe(false);
    expect(nameMatches('cvs', undefined)).toBe(false);
  });
  it('ranks a name match above a brand/operator-only match at any distance', () => {
    const els: Array<{ type: string; id: number; lat?: number; lon?: number; tags?: Record<string, string> }> = [
      { type: 'node', id: 1, lat: 40.4450, lon: -79.9440, tags: { name: 'GetGo', operator: 'Giant Eagle', amenity: 'fuel' } },
      { type: 'node', id: 2, lat: 40.4600, lon: -79.9600, tags: { name: 'Giant Eagle', shop: 'supermarket' } },
    ];
    const p = toPlaces(els, ORIGIN, 5, 'giant eagle');
    expect(p.map((x) => x.name)).toEqual(['Giant Eagle', 'GetGo']);
    expect(p.map((x) => x.rank)).toEqual([0, 1]);
  });

  it('a street hint ("the CVS on Forbes") puts the match on that street first, whatever the distance', () => {
    const els: Array<{ type: string; id: number; lat?: number; lon?: number; tags?: Record<string, string> }> = [
      { type: 'node', id: 1, lat: 40.4450, lon: -79.9440, tags: { name: 'CVS Pharmacy', amenity: 'pharmacy', 'addr:street': 'Murray Avenue' } },
      { type: 'node', id: 2, lat: 40.4600, lon: -79.9600, tags: { name: 'CVS Pharmacy', amenity: 'pharmacy', 'addr:street': 'Forbes Avenue' } },
      { type: 'node', id: 3, lat: 40.4455, lon: -79.9445, tags: { name: 'CVS Pharmacy', amenity: 'pharmacy' } },
    ];
    expect(normStreet('Forbes Ave.')).toBe('forbes');
    expect(onStreetHint('forbes ave', els[1]!.tags)).toBe(true);
    expect(onStreetHint('forbes', els[0]!.tags)).toBe(false);
    expect(onStreetHint('forbes', els[2]!.tags)).toBe(false);
    const p = toPlaces(els, ORIGIN, 5, 'cvs', 'Forbes Ave');
    expect(p.map((x) => [x.id, x.onStreet, x.street])).toEqual([
      ['node/2', true, 'Forbes Avenue'],
      ['node/1', false, 'Murray Avenue'],
      ['node/3', false, null],
    ]);
    // No hint: nearest first.
    expect(toPlaces(els, ORIGIN, 5, 'cvs').map((x) => x.id)).toEqual(['node/1', 'node/3', 'node/2']);
  });
});

describe('toPlaces', () => {
  it('keeps named elements, dedupes, sorts by distance, and labels the kind', () => {
    const p = toPlaces(elements, ORIGIN, 5, 'cvs');
    expect(p.map((x) => x.id)).toEqual(['node/1', 'way/2']);
    expect(p[0]).toMatchObject({ name: 'CVS Pharmacy', kind: 'amenity=pharmacy' });
    expect(p[0]!.distanceM).toBeLessThan(p[1]!.distanceM);
    expect(p[1]).toMatchObject({ name: 'CVS', kind: 'shop=chemist' });
  });
});

describe('searchPlaces', () => {
  it('posts to the first mirror, caches, and falls back to the next mirror on failure', async () => {
    const { fn, calls } = fakeFetch((url) => url.includes('kumi') ? new Response(JSON.stringify({ elements }), { status: 200 }) : new Response('', { status: 504 }));
    const q = { q: 'cvs', lat: ORIGIN.lat, lng: ORIGIN.lng, radiusM: 1500, limit: 5 };
    const r1 = await searchPlaces(q, { fetchFn: fn, mirrors: ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'] });
    expect(r1.source).toBe('live');
    expect(r1.places).toHaveLength(2);
    expect(calls.map((c) => c.url)).toEqual(['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']);
    expect(decodeURIComponent(calls[0]!.body)).toContain('nwr["shop"](around:1500');
    const r2 = await searchPlaces(q, { fetchFn: fn, mirrors: ['https://overpass-api.de/api/interpreter'] });
    expect(r2.source).toBe('cache');
    expect(calls).toHaveLength(2);
  });
  it('reports an error with no places when every mirror fails', async () => {
    const { fn } = fakeFetch(() => new Response('', { status: 504 }));
    const r = await searchPlaces({ q: 'cvs', lat: ORIGIN.lat, lng: ORIGIN.lng, radiusM: 1500, limit: 5 }, { fetchFn: fn, mirrors: ['https://x/api'] });
    expect(r.places).toEqual([]);
    expect(r.error).toMatch(/overpass 504/);
  });
});
