import overpass from '../../server/data/fixtures/overpass-oakland-forbes-bouquet.json';
import routeFixture from '../../server/data/fixtures/computeRoutes-forbes-bouquet.json';
import wprdc from '../../server/data/wprdc-signals.json';
import { destinationPoint, haversineM } from '../outdoor/geo';
import { angularError } from '../outdoor/legs';
import { parseComputeRoutes, type RawComputeRoutesResponse } from '../outdoor/routeParse';
import type { RouteLeg } from '../outdoor/types';
import {
  buildRouteLine,
  clusterCrossingNodes,
  crossingLengthM,
  crossingNodes,
  joinCrossings,
  nearestWprdc,
  operationTypeSuggestsButton,
  overpassQuery,
  parseWprdcRecords,
  projectOntoRoute,
  roadSideForLeg,
  roadWays,
  tagSaysSignalized,
  tagSaysUnsignalized,
  toCrossing,
  withRoadSides,
  type OverpassElement,
  type OverpassResponse,
} from './crossingData';

const elements = (overpass as unknown as OverpassResponse).elements ?? [];
const signals = parseWprdcRecords((wprdc as { rows: Array<Record<string, unknown>> }).rows);

describe('WPRDC parsing', () => {
  it('parses the bundled dataset and skips rows without coordinates', () => {
    expect(signals.length).toBeGreaterThan(700);
    expect(signals.every((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng))).toBe(true);
  });
  it('finds the Bouquet St - Forbes Ave signal (Fixed) at the intersection', () => {
    const hit = nearestWprdc({ lat: 40.4419581, lng: -79.9564358 }, signals);
    expect(hit).not.toBeNull();
    expect(hit!.description).toMatch(/Bouquet/);
    expect(hit!.operationType).toBe('Fixed');
    expect(operationTypeSuggestsButton(hit!.operationType)).toBe(false);
  });
  it('reads push-button hints from the operation type', () => {
    expect(operationTypeSuggestsButton('Fully Actuated')).toBe(true);
    expect(operationTypeSuggestsButton('Fixed / Ped Actuated')).toBe(true);
    expect(operationTypeSuggestsButton('Actuated/PED')).toBe(true);
    expect(operationTypeSuggestsButton('Fixed')).toBe(false);
    expect(operationTypeSuggestsButton(null)).toBe(false);
  });
});

describe('tag reading', () => {
  it('signalized / unsignalized / unknown', () => {
    expect(tagSaysSignalized({ crossing: 'traffic_signals' })).toBe(true);
    expect(tagSaysSignalized({ 'crossing:signals': 'yes' })).toBe(true);
    expect(tagSaysSignalized({ crossing: 'marked' })).toBe(false);
    expect(tagSaysUnsignalized({ crossing: 'marked' })).toBe(true);
    expect(tagSaysUnsignalized({ crossing: 'uncontrolled', 'crossing:signals': 'no' })).toBe(true);
    expect(tagSaysUnsignalized({ crossing: 'marked', 'crossing:signals': 'yes' })).toBe(false);
    expect(tagSaysUnsignalized({})).toBe(false);
    expect(tagSaysUnsignalized(undefined)).toBe(false);
  });
});

describe('join on the real Forbes / S Bouquet route', () => {
  const parsed = parseComputeRoutes(routeFixture as RawComputeRoutesResponse);
  const legs = withRoadSides(parsed.legs, elements);
  const result = joinCrossings({ legs, elements, wprdc: signals });

  it('finds Forbes Avenue (signalized, OSM button_operated=yes) then the Euler Way alley (unmarked)', () => {
    expect(result.crossings).toHaveLength(2);
    const c = result.crossings[0];
    expect(c.street).toBe('Forbes Avenue');
    expect(c.signalized).toBe(true);
    // WPRDC says "Fixed", but OSM tags button_operated=yes (and traffic_signals:sound=yes) on
    // every node of this intersection; the tag wins per 03 Task 2 rule 4.
    expect(c.pushButtonLikely).toBe(true);
    expect(c.afterLeg).toBe(0);
    expect(c.sAlongM).toBeGreaterThan(150);
    expect(c.sAlongM).toBeLessThan(200);
    expect(c.crossingId).toBe('6715675231');   // lowest OSM node id in the cluster
    const alley = result.crossings[1];
    expect(alley.street).toBe('Euler Way');
    expect(alley.signalized).toBe(false);      // crossing=unmarked, no WPRDC → the scan flow
    expect(alley.afterLeg).toBe(1);
    expect(alley.sAlongM).toBeGreaterThan(c.sAlongM);
  });

  it('drops the S Bouquet crosswalk nodes that sit on the route but run across it', () => {
    // Nodes 6715675233 (S Bouquet north crosswalk) and 7804459614 (Euler Way's second node) lie on
    // the centreline the pedestrian walks along; neither becomes a crossing of its own.
    expect(result.crossings.map((x) => x.crossingId)).not.toContain('6715675233');
  });

  it('crosses along the S Bouquet direction with the curbs on the crosswalk ends', () => {
    const c = result.crossings[0];
    // The pedestrian crosses Forbes heading NW (parallel to S Bouquet, ~305°).
    expect(Math.abs(angularError(c.bearingDeg, legs[1].startBearingDeg))).toBeLessThan(25);
    const len = crossingLengthM(c);
    expect(len).toBeGreaterThan(8);
    expect(len).toBeLessThan(25);
    // near curb is on the Posvar (south) side, far curb across Forbes.
    expect(c.nearCurb.lat).toBeLessThan(c.farCurb.lat);
    // The crossing sits within a few metres of the intersection.
    expect(haversineM(c.nearCurb, { lat: 40.4419581, lng: -79.9564358 })).toBeLessThan(20);
  });

  it('is unambiguous (all nodes tagged traffic_signals, street known) so no model call is needed', () => {
    expect(result.ambiguous).toHaveLength(0);
  });

  it('toCrossing strips the route bookkeeping', () => {
    const c = toCrossing(result.crossings[0]);
    expect(c).not.toHaveProperty('afterLeg');
    expect(c).not.toHaveProperty('sAlongM');
    expect(c.crossingId).toMatch(/^\d+$/);
  });

  it('assigns a roadSide to the Forbes leg', () => {
    expect(['LEFT', 'RIGHT', 'NONE']).toContain(legs[0].roadSide);
    // Walking SW along the Forbes centreline the nearest named road is Forbes itself (on the line) → NONE,
    // or a parallel road on one side; either way the value is a legal RoadSide.
    expect(roadSideForLeg(legs[1], roadWays(elements))).toBeDefined();
  });

  it('projects a point onto the whole route with leg attribution', () => {
    const line = buildRouteLine(legs);
    const p = projectOntoRoute(legs[1].polyline[1], line);
    expect(p).not.toBeNull();
    expect(p!.legIndex).toBe(1);
    expect(p!.distM).toBeLessThan(0.01);
  });

  it('clusters the intersection nodes within 15 m along-track', () => {
    const clusters = clusterCrossingNodes(crossingNodes(elements), buildRouteLine(legs));
    const atCorner = clusters.filter((c) => Math.abs(c.sAlongM - result.crossings[0].sAlongM) < 20);
    expect(atCorner.length).toBeGreaterThanOrEqual(1);
    expect(atCorner[0].nodes.length).toBeGreaterThanOrEqual(2);
  });
});

describe('join on a synthetic route (tagged, untagged and WPRDC-only nodes)', () => {
  const O = { lat: 40.4500, lng: -79.9500 };
  const B = destinationPoint(O, 0, 300);
  const leg: RouteLeg = {
    index: 0, instruction: 'Head north on Test St', maneuver: 'ARRIVE', distanceM: 300,
    polyline: [O, B], startBearingDeg: 0, endBearingDeg: 0, endLat: B.lat, endLng: B.lng, roadSide: 'NONE', street: 'Test St',
  };
  const at = (s: number, offsetM = 0) => destinationPoint(destinationPoint(O, 0, s), 90, offsetM);
  const road = (id: number, name: string, s: number): OverpassElement => {
    const a = destinationPoint(at(s), 270, 40);
    const b = destinationPoint(at(s), 90, 40);
    return { type: 'way', id, tags: { highway: 'residential', name }, geometry: [{ lat: a.lat, lon: a.lng }, { lat: b.lat, lon: b.lng }] };
  };
  const node = (id: number, s: number, tags: Record<string, string>, offsetM = 0): OverpassElement => {
    const p = at(s, offsetM);
    return { type: 'node', id, lat: p.lat, lon: p.lng, tags: { highway: 'crossing', ...tags } };
  };
  const els: OverpassElement[] = [
    node(10, 50, { crossing: 'marked' }),                       // unsignalized, tagged
    node(20, 120, {}),                                          // untagged → null
    node(30, 200, { crossing: 'unmarked' }),                    // WPRDC-only signal nearby → conflict
    node(31, 206, { crossing: 'unmarked' }),                    // same cluster (6 m along)
    node(40, 260, { crossing: 'traffic_signals', button_operated: 'yes' }),
    node(50, 150, { crossing: 'traffic_signals' }, 30),         // 30 m off route → dropped
    road(100, 'First St', 50), road(101, 'Second St', 120), road(102, 'Third St', 203), road(103, 'Fourth St', 260),
  ];
  const wprdcOnly = [{ id: 'w1', description: 'Third St', operationType: 'Semi Actuated', lat: at(203).lat, lng: at(203).lng }];
  const result = joinCrossings({ legs: [leg], elements: els, wprdc: wprdcOnly });

  it('keeps on-route nodes, clusters within 15 m, drops far nodes, sorts by sAlongM', () => {
    expect(result.crossings.map((c) => c.crossingId)).toEqual(['10', '20', '30', '40']);
    expect(result.crossings.map((c) => Math.round(c.sAlongM))).toEqual([50, 120, 203, 260]);
  });

  it('resolves signalized per the rules', () => {
    const [a, b, c, d] = result.crossings;
    expect(a.signalized).toBe(false);
    expect(b.signalized).toBeNull();
    expect(c.signalized).toBe(true);        // WPRDC within 30 m
    expect(c.pushButtonLikely).toBe(true);  // Semi Actuated
    expect(d.signalized).toBe(true);
    expect(d.pushButtonLikely).toBe(true);  // button_operated=yes
  });

  it('names the crossed street from the perpendicular road and falls back to 6 m curbs', () => {
    const [a, , c] = result.crossings;
    expect(a.street).toBe('First St');
    expect(c.street).toBe('Third St');
    expect(crossingLengthM(a)).toBeCloseTo(12, 0);
    expect(Math.abs(angularError(a.bearingDeg, 0))).toBeLessThan(1);
  });

  it('flags the tag/WPRDC conflict for the crossingAnnounce job and nothing else', () => {
    expect(result.ambiguous.map((x) => x.crossingId)).toEqual(['30']);
    expect(result.ambiguous[0].candidates).toHaveLength(2);
    expect(result.ambiguous[0].candidates[0].wprdcOperationType).toBe('Semi Actuated');
  });

  it('marks a missing street as ambiguous', () => {
    const noRoads = joinCrossings({ legs: [leg], elements: els.filter((e) => e.type !== 'way') });
    expect(noRoads.crossings.every((c) => c.street === '')).toBe(true);
    expect(noRoads.ambiguous.length).toBe(noRoads.crossings.length);
  });

  it('roadSideForLeg reports the side of a parallel named road', () => {
    const right = destinationPoint(O, 90, 8);
    const rightEnd = destinationPoint(B, 90, 8);
    const parallel: OverpassElement = { type: 'way', id: 200, tags: { highway: 'residential', name: 'Test St' }, geometry: [{ lat: right.lat, lon: right.lng }, { lat: rightEnd.lat, lon: rightEnd.lng }] };
    expect(roadSideForLeg(leg, roadWays([parallel]))).toBe('RIGHT');
    const left = destinationPoint(O, 270, 8);
    const leftEnd = destinationPoint(B, 270, 8);
    const parallelL: OverpassElement = { type: 'way', id: 201, tags: { highway: 'residential', name: 'Test St' }, geometry: [{ lat: left.lat, lon: left.lng }, { lat: leftEnd.lat, lon: leftEnd.lng }] };
    expect(roadSideForLeg(leg, roadWays([parallelL]))).toBe('LEFT');
    expect(roadSideForLeg(leg, [])).toBe('NONE');
  });
});

describe('overpassQuery', () => {
  it('asks for crossing nodes, crossing footways and named road classes with a 25 s timeout', () => {
    const q = overpassQuery({ s: 40.44, w: -79.96, n: 40.45, e: -79.95 });
    expect(q).toContain('[out:json][timeout:25];');
    expect(q).toContain('node["highway"="crossing"]');
    expect(q).toContain('way["footway"="crossing"]');
    expect(q).toContain('out body geom;');
  });
});
