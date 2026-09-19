import forbesFixture from '../../server/data/fixtures/computeRoutes-forbes-bouquet.json';
import mergeFixture from '../../server/data/fixtures/computeRoutes-merge-cases.json';
import { WALKING_BETA_WARNING } from './types';
import {
  collapseManeuver,
  computeRoutesBody,
  extractStreet,
  parseComputeRoutes,
  RAW_MANEUVERS,
  ROUTES_FIELD_MASK,
  type RawComputeRoutesResponse,
} from './routeParse';

describe('collapseManeuver', () => {
  it('collapses all 21 Google values onto the seven leg maneuvers', () => {
    const expected: Record<string, string> = {
      MANEUVER_UNSPECIFIED: 'STRAIGHT', DEPART: 'STRAIGHT', NAME_CHANGE: 'STRAIGHT', STRAIGHT: 'STRAIGHT',
      TURN_SLIGHT_LEFT: 'SLIGHT_LEFT', TURN_SLIGHT_RIGHT: 'SLIGHT_RIGHT',
      TURN_LEFT: 'TURN_LEFT', TURN_RIGHT: 'TURN_RIGHT',
      TURN_SHARP_LEFT: 'TURN_LEFT', TURN_SHARP_RIGHT: 'TURN_RIGHT',
      UTURN_LEFT: 'UTURN', UTURN_RIGHT: 'UTURN',
      RAMP_LEFT: 'TURN_LEFT', RAMP_RIGHT: 'TURN_RIGHT',
      FORK_LEFT: 'TURN_LEFT', FORK_RIGHT: 'TURN_RIGHT',
      MERGE: 'STRAIGHT', ROUNDABOUT_LEFT: 'TURN_LEFT', ROUNDABOUT_RIGHT: 'TURN_RIGHT',
      FERRY: 'STRAIGHT', FERRY_TRAIN: 'STRAIGHT',
    };
    expect(RAW_MANEUVERS).toHaveLength(21);
    for (const m of RAW_MANEUVERS) expect(collapseManeuver(m)).toBe(expected[m]);
    expect(collapseManeuver(undefined)).toBe('STRAIGHT');
  });
});

describe('extractStreet', () => {
  it('reads the street after onto/on and drops trailers', () => {
    expect(extractStreet('Turn right onto S Bouquet St\nDestination will be on the right')).toBe('S Bouquet St');
    expect(extractStreet('Head southwest on Forbes Ave toward S Bouquet St')).toBe('Forbes Ave');
    expect(extractStreet('Continue onto Forbes Avenue')).toBe('Forbes Avenue');
    expect(extractStreet('Walk north')).toBe('');
    expect(extractStreet(undefined)).toBe('');
  });
});

describe('parseComputeRoutes on the recorded Forbes / S Bouquet fixture', () => {
  const parsed = parseComputeRoutes(forbesFixture as RawComputeRoutesResponse);

  it('yields two legs: walk Forbes then turn right, last leg ARRIVE', () => {
    expect(parsed.legs).toHaveLength(2);
    expect(parsed.legs[0].maneuver).toBe('TURN_RIGHT');   // the action at the END of leg 0
    expect(parsed.legs[1].maneuver).toBe('ARRIVE');
    expect(parsed.legs[0].street).toBe('Forbes Ave');
    expect(parsed.legs[1].street).toBe('S Bouquet St');
    expect(parsed.legs[0].index).toBe(0);
    expect(parsed.legs[1].index).toBe(1);
  });

  it('computes bearings from the decoded polylines', () => {
    // Forbes runs SW toward S Bouquet (~226°); S Bouquet runs NW (~305°).
    expect(parsed.legs[0].startBearingDeg).toBeGreaterThan(215);
    expect(parsed.legs[0].startBearingDeg).toBeLessThan(260);
    expect(parsed.legs[1].startBearingDeg).toBeGreaterThan(295);
    expect(parsed.legs[1].startBearingDeg).toBeLessThan(320);
    expect(parsed.legs[0].polyline.length).toBeGreaterThanOrEqual(2);
    expect(parsed.legs[0].endLat).toBeCloseTo(40.4419581, 4);
    expect(parsed.legs[0].endLng).toBeCloseTo(-79.9564358, 4);
  });

  it('keeps distances and the walking-beta warning verbatim', () => {
    expect(parsed.legs[0].distanceM).toBe(183);
    expect(parsed.legs[1].distanceM).toBe(61);
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toBe(WALKING_BETA_WARNING);
    expect(parsed.attribution).toContain('Google Maps');
    expect(parsed.durationS).toBeGreaterThan(100);
    expect(parsed.routePolyline.length).toBeGreaterThan(5);
  });
});

describe('parseComputeRoutes merge and collapse cases', () => {
  const parsed = parseComputeRoutes(mergeFixture as RawComputeRoutesResponse);

  it('merges NAME_CHANGE into the leg under construction and collapses slight/uturn', () => {
    // DEPART, NAME_CHANGE, TURN_SLIGHT_LEFT, UTURN_RIGHT → 3 legs.
    expect(parsed.legs.map((l) => l.maneuver)).toEqual(['SLIGHT_LEFT', 'UTURN', 'ARRIVE']);
    // First leg = DEPART step + NAME_CHANGE step geometry concatenated.
    expect(parsed.legs[0].distanceM).toBeGreaterThan(90);
    expect(parsed.legs[0].polyline.length).toBeGreaterThanOrEqual(4);
  });

  it('supplies the walking-beta sentence when the response has no warnings', () => {
    expect(parsed.warnings).toEqual([WALKING_BETA_WARNING]);
  });
});

describe('request shape', () => {
  it('has the mandatory field mask and a WALK body', () => {
    expect(ROUTES_FIELD_MASK).toContain('routes.legs.steps.navigationInstruction');
    expect(ROUTES_FIELD_MASK).toContain('routes.warnings');
    const body = computeRoutesBody({ lat: 1, lng: 2 }, { lat: 3, lng: 4 });
    expect(body.travelMode).toBe('WALK');
    expect(body).toEqual(expect.objectContaining({ origin: { location: { latLng: { latitude: 1, longitude: 2 } } } }));
  });
  it('returns no legs for an empty response', () => {
    expect(parseComputeRoutes({}).legs).toEqual([]);
  });
});
