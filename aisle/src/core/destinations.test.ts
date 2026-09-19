import { mapForPlace, matchesStoreMap, resolveDestination } from './destinations';
import type { AisleStoreMap } from '../indoor/storeMap';

const map = { storeId: 'demo-store-01', displayName: 'Demo Grocery', entrance: { lat: 1, lng: 2, radiusM: 35, pinnedBy: 'x', pinnedAt: 'y' }, aisles: [], landmarks: [], itemIndex: {} } as unknown as AisleStoreMap;
const fix = { lat: 40.4443, lng: -79.9436, accuracyM: 8, timestamp: 0 } as unknown as import('./contracts').GeoFix;
const place = { id: 'node/1', name: 'CVS Pharmacy', lat: 40.45, lng: -79.94, distanceM: 1066, kind: 'amenity=pharmacy' };

function fetchWith(status: number, body: unknown): typeof fetch {
  return (async () => ({ ok: status < 300, status, json: async () => body })) as unknown as typeof fetch;
}

describe('destinations (round 4)', () => {
  it('matches the loaded store map by name in either direction', () => {
    expect(matchesStoreMap('demo grocery', map)).toBe(true);
    expect(matchesStoreMap('the Demo Grocery store', map)).toBe(true);
    expect(matchesStoreMap('CVS', map)).toBe(false);
    expect(matchesStoreMap('CVS', null)).toBe(false);
  });
  it('a place becomes a map with no aisles and the place as its entrance', () => {
    const m = mapForPlace(place, 0);
    expect(m.storeId).toBe('poi-node-1');
    expect(m.displayName).toBe('CVS Pharmacy');
    expect(m.entrance).toMatchObject({ lat: 40.45, lng: -79.94, radiusM: 35, pinnedBy: 'openstreetmap' });
    expect(m.aisles).toEqual([]);
    expect(Object.keys(m.itemIndex)).toHaveLength(0);
  });
  it('prefers the loaded map, else asks the proxy and takes the nearest place', async () => {
    expect(await resolveDestination('Demo Grocery', fix, { proxyUrl: 'http://p', loadedMap: map })).toMatchObject({ kind: 'store_map' });
    const calls: string[] = [];
    const f = (async (url: string) => { calls.push(String(url)); return { ok: true, status: 200, json: async () => ({ places: [place] }) }; }) as unknown as typeof fetch;
    const r = await resolveDestination('cvs', fix, { proxyUrl: 'http://p/', loadedMap: map, fetchImpl: f });
    expect(r.kind).toBe('place');
    expect(calls[0]).toMatch(/^http:\/\/p\/api\/places\?q=cvs&lat=40\.4443&lng=-79\.9436/);
    if (r.kind === 'place') expect(r.map.displayName).toBe('CVS Pharmacy');
  });
  it('reports no_fix, no_match and offline honestly', async () => {
    expect(await resolveDestination('cvs', null, { proxyUrl: 'http://p' })).toEqual({ kind: 'none', reason: 'no_fix' });
    expect(await resolveDestination('cvs', fix, { proxyUrl: 'http://p', fetchImpl: fetchWith(200, { places: [] }) })).toEqual({ kind: 'none', reason: 'no_match' });
    expect(await resolveDestination('cvs', fix, { proxyUrl: 'http://p', fetchImpl: fetchWith(502, {}) })).toEqual({ kind: 'none', reason: 'offline' });
    expect(await resolveDestination('cvs', fix, { proxyUrl: 'http://p', fetchImpl: (async () => { throw new Error('net'); }) as unknown as typeof fetch })).toEqual({ kind: 'none', reason: 'offline' });
  });
});
