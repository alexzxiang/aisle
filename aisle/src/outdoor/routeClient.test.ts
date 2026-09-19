import { RouteClientError, createRouteClient, parseRouteResponse, routeUrl } from './routeClient';
import { GOOGLE_ATTRIBUTION, WALKING_BETA_WARNING } from './types';

const A = { lat: 40.4428803, lng: -79.9546937 };
const B = { lat: 40.4419581, lng: -79.9564358 };

const good = {
  destName: 'Demo Grocery',
  legs: [
    { index: 0, instruction: 'Head southwest on Forbes Ave', maneuver: 'TURN_RIGHT', distanceM: 183, polyline: [A, B], startBearingDeg: 235, endBearingDeg: 238, endLat: B.lat, endLng: B.lng, roadSide: 'LEFT', street: 'Forbes Ave' },
    { index: 1, instruction: 'Turn right onto S Bouquet St', maneuver: 'ARRIVE', distanceM: 61, polyline: [B, A], startBearingDeg: 330, endBearingDeg: 330, endLat: A.lat, endLng: A.lng, roadSide: 'NONE' },
  ],
  crossings: [
    { crossingId: '9', street: 'Forbes Ave', signalized: true, pushButtonLikely: false, bearingDeg: 330, nearCurb: B, farCurb: A, roadSide: 'RIGHT', afterLeg: 0, sAlongM: 180 },
    { crossingId: '3', street: '', signalized: null, pushButtonLikely: true, bearingDeg: 30, nearCurb: A, farCurb: B, roadSide: 'LEFT', afterLeg: 0, sAlongM: 50 },
  ],
  warnings: [WALKING_BETA_WARNING],
  attribution: GOOGLE_ATTRIBUTION,
  script: { legs: [{ index: 0, soon: 'Turn right in sixty feet.', now: 'Turn right now.', confirm: 'Continue on South Bouquet Street, two hundred feet.' }], crossingAnnouncements: [] },
  planner: { routeCompile: { fallback: false, latencyMs: 900 }, crossingAnnounce: { fallback: true, latencyMs: 0 } },
  fetchedAt: 123,
};

describe('parseRouteResponse', () => {
  it('normalizes a good response and sorts crossings along-track', () => {
    const r = parseRouteResponse(good, 1);
    expect(r.legs).toHaveLength(2);
    expect(r.legs[1].maneuver).toBe('ARRIVE');
    expect(r.crossings.map((c) => c.crossingId)).toEqual(['3', '9']);
    expect(r.crossings[0].signalized).toBeNull();
    expect(r.planner.routeCompile.fallback).toBe(false);
    expect(r.fetchedAt).toBe(123);
  });

  it('fills defaults: warning, attribution, script, planner flags', () => {
    const r = parseRouteResponse({ legs: good.legs }, 7);
    expect(r.warnings).toEqual([WALKING_BETA_WARNING]);
    expect(r.attribution).toBe(GOOGLE_ATTRIBUTION);
    expect(r.script).toEqual({ legs: [], crossingAnnouncements: [] });
    expect(r.planner.routeCompile.fallback).toBe(true);
    expect(r.destName).toBe('the store');
    expect(r.fetchedAt).toBe(7);
  });

  it('drops malformed legs and crossings, throws when nothing usable remains', () => {
    const r = parseRouteResponse({ legs: [good.legs[0], { index: 1, maneuver: 'FLY' }], crossings: [{ crossingId: 'x' }] });
    expect(r.legs).toHaveLength(1);
    expect(r.crossings).toHaveLength(0);
    expect(() => parseRouteResponse({ legs: [] })).toThrow(RouteClientError);
    expect(() => parseRouteResponse('nope')).toThrow(RouteClientError);
  });
});

describe('createRouteClient', () => {
  it('GETs /api/route with the five query params and parses the body', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => good } as Response;
    }) as unknown as typeof fetch;
    const client = createRouteClient({ baseUrl: 'http://proxy:8787/', fetchImpl });
    const r = await client.fetchRoute({ origin: A, dest: B, storeId: 'demo-store-01' });
    expect(calls[0]).toBe(routeUrl('http://proxy:8787', { origin: A, dest: B, storeId: 'demo-store-01' }));
    expect(calls[0]).toContain('/api/route?originLat=40.4428803&originLng=-79.9546937&destLat=40.4419581&destLng=-79.9564358&storeId=demo-store-01');
    expect(r.destName).toBe('Demo Grocery');
  });

  it('maps HTTP and network failures to typed errors', async () => {
    const http = createRouteClient({ baseUrl: 'http://p', fetchImpl: (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch });
    await expect(http.fetchRoute({ origin: A, dest: B, storeId: 's' })).rejects.toMatchObject({ kind: 'http', status: 503 });
    const net = createRouteClient({ baseUrl: 'http://p', fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch });
    await expect(net.fetchRoute({ origin: A, dest: B, storeId: 's' })).rejects.toMatchObject({ kind: 'network' });
  });
});
