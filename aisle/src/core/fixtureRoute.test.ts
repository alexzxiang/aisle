import trackJson from '../../fixtures/track.json';
import { crossingLengthM } from '../crossing/crossingData';
import { RouteClientError } from '../outdoor/routeClient';
import { findForbiddenTerm, countWords } from './phrases';
import { FIXTURE_ATTRIBUTION, createFixtureRouteClient, maneuverBetween, routeFromTrack, type FixtureTrack } from './fixtureRoute';

const track = trackJson as unknown as FixtureTrack;

describe('maneuverBetween', () => {
  it('classifies bearing changes', () => {
    expect(maneuverBetween(0, 10)).toBe('STRAIGHT');
    expect(maneuverBetween(0, 40)).toBe('SLIGHT_RIGHT');
    expect(maneuverBetween(0, 320)).toBe('SLIGHT_LEFT');
    expect(maneuverBetween(0, 90)).toBe('TURN_RIGHT');
    expect(maneuverBetween(90, 0)).toBe('TURN_LEFT');
    expect(maneuverBetween(0, 175)).toBe('UTURN');
    expect(maneuverBetween(350, 20)).toBe('SLIGHT_RIGHT');
  });
});

describe('routeFromTrack (D fixture → B RouteResponse)', () => {
  it('turns the track meta into legs, one crossing at its along-track position and a templated script', () => {
    const route = routeFromTrack(track, { destName: 'Demo Grocery', now: 1 });
    expect(route).not.toBeNull();
    const r = route!;
    expect(r.destName).toBe('Demo Grocery');
    expect(r.legs).toHaveLength(4);
    expect(r.legs.map((l) => l.maneuver)).toEqual(['TURN_RIGHT', 'TURN_LEFT', 'SLIGHT_RIGHT', 'ARRIVE']);
    expect(r.legs[0].polyline).toHaveLength(2);
    expect(r.legs[3].endLat).toBeCloseTo(40.4443, 4);
    expect(r.attribution).toBe(FIXTURE_ATTRIBUTION);
    expect(r.warnings).toHaveLength(1);
    expect(r.planner.routeCompile.fallback).toBe(true);
    expect(r.fetchedAt).toBe(1);

    expect(r.crossings).toHaveLength(1);
    const c = r.crossings[0];
    expect(c.crossingId).toBe('crossing-forbes-01');
    // Centre of the crossing sits after leg 0 (90.35 m) + leg 1 (48 m) + half the crossing.
    const expected = 90.35 + 48 + crossingLengthM(c) / 2;
    expect(c.sAlongM).toBeGreaterThan(expected - 3);
    expect(c.sAlongM).toBeLessThan(expected + 3);
    expect(c.afterLeg).toBeGreaterThanOrEqual(1);

    expect(r.script.legs).toHaveLength(4);
    expect(r.script.crossingAnnouncements).toEqual([{ crossingId: 'crossing-forbes-01', text: 'Crossing ahead: Forbes. Signalized.' }]);
    for (const leg of r.script.legs) {
      for (const text of [leg.soon, leg.now, leg.confirm]) {
        expect(findForbiddenTerm(text)).toBeNull();
        expect(countWords(text)).toBeLessThanOrEqual(12);
        expect(/\d/.test(text)).toBe(false);
      }
    }
    expect(r.script.legs[0].now).toBe('Turn right now.');
  });

  it('returns null without legs and the client throws B\'s shape error', async () => {
    expect(routeFromTrack({})).toBeNull();
    expect(routeFromTrack({ meta: { legs: [] } })).toBeNull();
    await expect(createFixtureRouteClient({}).fetchRoute({ origin: { lat: 0, lng: 0 }, dest: { lat: 0, lng: 0 }, storeId: 's' })).rejects.toBeInstanceOf(RouteClientError);
    const ok = await createFixtureRouteClient(track, { destName: 'X', now: () => 5 }).fetchRoute({ origin: { lat: 0, lng: 0 }, dest: { lat: 0, lng: 0 }, storeId: 's' });
    expect(ok.destName).toBe('X');
    expect(ok.fetchedAt).toBe(5);
  });

  it('a track without a crossing yields no crossings', () => {
    const noCrossing: FixtureTrack = { meta: { legs: track.meta!.legs } };
    expect(routeFromTrack(noCrossing)!.crossings).toEqual([]);
  });
});
