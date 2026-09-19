import type { RouteCompileOutput } from '../core/contracts';
import { destinationPoint } from './geo';
import { ALIGN_TIMEOUT_MS, deadZoneFor, initialTurnFlow, stepTurnFlow, type TurnAction } from './turnFlow';
import type { RouteLeg } from './types';

const A = { lat: 40.4428803, lng: -79.9546937 };

function leg(index: number, maneuver: RouteLeg['maneuver'], bearing: number, lengthM: number, street = 'Forbes Ave'): RouteLeg {
  const end = destinationPoint(A, bearing, lengthM);
  return { index, instruction: `Head on ${street}`, maneuver, distanceM: lengthM, polyline: [A, end], startBearingDeg: bearing, endBearingDeg: bearing, endLat: end.lat, endLng: end.lng, roadSide: 'RIGHT', street };
}

const legs: RouteLeg[] = [leg(0, 'TURN_RIGHT', 240, 180, 'Forbes Ave'), leg(1, 'STRAIGHT', 330, 60, 'S Bouquet St'), leg(2, 'ARRIVE', 330, 40, 'S Bouquet St')];
const script: RouteCompileOutput = {
  legs: [
    { index: 0, soon: 'Turn right in sixty feet.', now: 'Turn right now.', confirm: 'Continue on Forbes Avenue, about six hundred feet.' },
    { index: 1, soon: '', now: '', confirm: 'Continue on South Bouquet Street, two hundred feet.' },
    { index: 2, soon: '', now: '', confirm: 'Entrance ahead, about one hundred thirty feet.' },
  ],
  crossingAnnouncements: [],
};

const kinds = (actions: TurnAction[]): string[] => actions.map((a) => (a.kind === 'SAY' ? `SAY:${a.req.cacheKey ?? a.req.text}` : a.kind === 'RETARGET' ? `RETARGET:${a.legIndex}` : 'TURN'));

describe('turn flow', () => {
  it('route ready: warning, COURSE reference, leg 0 confirm', () => {
    const r = stepTurnFlow(initialTurnFlow(0), { type: 'ROUTE_READY', warning: 'Walking directions are in beta. Use caution – This route may be missing sidewalks or pedestrian paths.' }, legs, script);
    expect(kinds(r.actions)).toEqual([
      'SAY:Walking directions are in beta. Use caution – This route may be missing sidewalks or pedestrian paths.',
      'RETARGET:0',
      'SAY:Continue on Forbes Avenue, about six hundred feet.',
    ]);
    expect(r.actions[0]).toMatchObject({ req: { dedupeKey: 'route-warning', priority: 'INFO' } });
    expect(r.state.confirmSaid).toBe(true);
  });

  it('soon fires once at ≤ 20 m, by cache key when the text is canonical', () => {
    let s = initialTurnFlow(0);
    let r = stepTurnFlow(s, { type: 'PROGRESS', remainingM: 35 }, legs, script);
    expect(r.actions).toEqual([]);
    r = stepTurnFlow(r.state, { type: 'PROGRESS', remainingM: 19 }, legs, script);
    expect(kinds(r.actions)).toEqual(['SAY:turn_right_soon']);
    expect(r.actions[0]).toMatchObject({ req: { dedupeKey: 'leg-0-soon', cooldownMs: 15000 } });
    s = r.state;
    r = stepTurnFlow(s, { type: 'PROGRESS', remainingM: 10 }, legs, script);
    expect(r.actions).toEqual([]);
  });

  it('at the maneuver point: now → TURN → RETARGET, then confirm only once aligned', () => {
    let r = stepTurnFlow(initialTurnFlow(0), { type: 'ADVANCED', toLegIndex: 1, now: 1000 }, legs, script);
    expect(kinds(r.actions)).toEqual(['SAY:turn_right_now', 'TURN', 'RETARGET:1']);
    expect(r.state.phase).toBe('ALIGNING');
    // Off by 40°: still aligning, nothing said.
    r = stepTurnFlow(r.state, { type: 'HEADING', headingDeg: 290, accuracy: 3, now: 2000 }, legs, script);
    expect(r.actions).toEqual([]);
    // Inside the 12° dead zone: the next leg's confirm.
    r = stepTurnFlow(r.state, { type: 'HEADING', headingDeg: 322, accuracy: 3, now: 3000 }, legs, script);
    expect(kinds(r.actions)).toEqual(['SAY:Continue on South Bouquet Street, two hundred feet.']);
    expect(r.state.phase).toBe('WALKING');
    // Never twice.
    r = stepTurnFlow(r.state, { type: 'HEADING', headingDeg: 330, accuracy: 3, now: 4000 }, legs, script);
    expect(r.actions).toEqual([]);
  });

  it('a poor compass never confirms on heading; the 8 s timeout does', () => {
    let r = stepTurnFlow(initialTurnFlow(0), { type: 'ADVANCED', toLegIndex: 1, now: 0 }, legs, script);
    r = stepTurnFlow(r.state, { type: 'HEADING', headingDeg: 330, accuracy: 1, now: 500 }, legs, script);
    expect(r.actions).toEqual([]);
    r = stepTurnFlow(r.state, { type: 'TICK', now: ALIGN_TIMEOUT_MS - 1 }, legs, script);
    expect(r.actions).toEqual([]);
    r = stepTurnFlow(r.state, { type: 'TICK', now: ALIGN_TIMEOUT_MS }, legs, script);
    expect(kinds(r.actions)).toEqual(['SAY:Continue on South Bouquet Street, two hundred feet.']);
  });

  it('a STRAIGHT maneuver gets no now, no TURN, and an immediate confirm', () => {
    const r = stepTurnFlow(initialTurnFlow(1), { type: 'ADVANCED', toLegIndex: 2, now: 0 }, legs, script);
    expect(kinds(r.actions)).toEqual(['RETARGET:2', 'SAY:Entrance ahead, about one hundred thirty feet.']);
    expect(r.state.phase).toBe('WALKING');
  });

  it('falls back to the template when the script is missing', () => {
    const r = stepTurnFlow(initialTurnFlow(0), { type: 'ADVANCED', toLegIndex: 1, now: 0 }, legs, null);
    expect(kinds(r.actions)).toEqual(['SAY:turn_right_now', 'TURN', 'RETARGET:1']);
  });

  it('dead zones follow the compass tier', () => {
    expect(deadZoneFor(3)).toBe(12);
    expect(deadZoneFor(2)).toBe(18);
    expect(deadZoneFor(1)).toBeNull();
    expect(deadZoneFor(0)).toBeNull();
  });
});
