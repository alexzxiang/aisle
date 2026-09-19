import { beforeEach, describe, expect, it } from 'vitest';
import { bboxInside, bboxKey, clearOverpassCache, elementsBBox, fetchOverpass, loadOverpassFixture, OVERPASS_USER_AGENT } from './crossings';

const BBOX = { s: 40.4415, w: -79.9585, n: 40.4435, e: -79.9525 };

function fetchSeq(responses: Array<{ ok: boolean; status?: number; body?: unknown; throws?: string }>) {
  const calls: Array<{ url: string; ua: string | undefined; body: string }> = [];
  let i = 0;
  const fn = (async (url: string, init?: RequestInit) => {
    const r = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    calls.push({ url, ua: (init?.headers as Record<string, string> | undefined)?.['User-Agent'], body: String(init?.body) });
    if (r.throws) throw new Error(r.throws);
    return { ok: r.ok, status: r.status ?? 200, json: async () => r.body ?? { elements: [] } } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

beforeEach(() => clearOverpassCache());

describe('fetchOverpass', () => {
  it('posts the query with a real User-Agent to the first mirror and caches by bbox', async () => {
    const f = fetchSeq([{ ok: true, body: { elements: [{ type: 'node', id: 1, lat: 40.442, lon: -79.955, tags: { highway: 'crossing' } }] } }]);
    const r = await fetchOverpass(BBOX, { fetchFn: f.fn, mirrors: ['https://a.test/', 'https://b.test/'] });
    expect(r.source).toBe('live');
    expect(r.mirror).toBe('https://a.test/');
    expect(f.calls[0]!.ua).toBe(OVERPASS_USER_AGENT);
    expect(decodeURIComponent(f.calls[0]!.body)).toContain('node["highway"="crossing"]');
    const again = await fetchOverpass(BBOX, { fetchFn: f.fn, mirrors: ['https://a.test/'] });
    expect(again.source).toBe('cache');
    expect(f.calls).toHaveLength(1);
    expect(bboxKey(BBOX)).toBe('40.441,-79.959,40.444,-79.953');   // toFixed(3) rounding of 40.4415
  });

  it('falls through the mirrors in order on 504 / connection errors', async () => {
    const f = fetchSeq([{ ok: false, status: 504 }, { ok: true, body: { elements: [] } }]);
    const r = await fetchOverpass(BBOX, { fetchFn: f.fn, mirrors: ['https://a.test/', 'https://b.test/'] });
    expect(r.source).toBe('live');
    expect(r.mirror).toBe('https://b.test/');
    expect(f.calls.map((c) => c.url)).toEqual(['https://a.test/', 'https://b.test/']);
  });

  it('uses the recorded fixture only when the bbox lies inside it', async () => {
    const f = fetchSeq([{ ok: false, throws: 'ECONNREFUSED' }]);
    const inside = await fetchOverpass(BBOX, { fetchFn: f.fn, mirrors: ['https://a.test/'] });
    expect(inside.source).toBe('fixture');
    expect(inside.elements.length).toBeGreaterThan(50);
    clearOverpassCache();
    const outside = await fetchOverpass({ s: 40.5, w: -80.1, n: 40.51, e: -80.09 }, { fetchFn: f.fn, mirrors: ['https://a.test/'] });
    expect(outside.source).toBe('none');
    expect(outside.elements).toEqual([]);
    const fx = (await loadOverpassFixture())!;
    const fb = elementsBBox(fx.elements ?? [])!;
    expect(bboxInside(BBOX, fb)).toBe(true);
  });
});
