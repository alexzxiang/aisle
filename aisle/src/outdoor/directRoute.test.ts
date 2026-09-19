import { DIRECT_ROUTE_ATTRIBUTION, DIRECT_ROUTE_WARNING, directRoute } from './directRoute';

describe('directRoute (no route data)', () => {
  const origin = { lat: 40.445378, lng: -79.945016 };
  const entrance = { lat: 40.4443, lng: -79.9436 };

  it('is one ARRIVE leg on the great-circle bearing to the entrance with an honest warning', () => {
    const r = directRoute(origin, entrance, 'Demo Grocery', 1234);
    expect(r.legs).toHaveLength(1);
    const leg = r.legs[0]!;
    expect(leg.maneuver).toBe('ARRIVE');
    expect(leg.endLat).toBe(entrance.lat);
    expect(leg.endLng).toBe(entrance.lng);
    expect(leg.distanceM).toBeGreaterThan(100);
    expect(leg.distanceM).toBeLessThan(250);
    expect(leg.startBearingDeg).toBeGreaterThan(90);   // roughly east-south-east
    expect(leg.startBearingDeg).toBeLessThan(180);
    expect(leg.roadSide).toBe('NONE');
    expect(r.crossings).toEqual([]);
    expect(r.warnings).toEqual([DIRECT_ROUTE_WARNING]);
    expect(r.attribution).toBe(DIRECT_ROUTE_ATTRIBUTION);
    expect(r.planner.routeCompile.fallback).toBe(true);
    expect(r.fetchedAt).toBe(1234);
  });
});
