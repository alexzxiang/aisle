import type { GeoFix } from '../core/contracts';
import { destinationPoint } from './geo';
import {
  ADVANCE_RADIUS_FAIR_M,
  ADVANCE_RADIUS_GOOD_M,
  advanceRadiusFor,
  angularError,
  initialLegProgress,
  isWithinDeg,
  referenceBearingFor,
  stepLegProgress,
  type LegProgressState,
} from './legs';
import type { RouteLeg } from './types';

describe('angularError', () => {
  it('is signed with + meaning target to the right', () => {
    expect(angularError(0, 10)).toBe(10);
    expect(angularError(10, 0)).toBe(-10);
    expect(angularError(90, 90)).toBe(0);
  });
  it('wraps across 0/360', () => {
    expect(angularError(350, 10)).toBe(20);
    expect(angularError(10, 350)).toBe(-20);
    expect(angularError(359, 1)).toBe(2);
    expect(angularError(1, 359)).toBe(-2);
    expect(angularError(0, 180)).toBe(-180);
    expect(angularError(180, 0)).toBe(-180);
    expect(angularError(0, 179)).toBe(179);
    expect(angularError(0, 181)).toBe(-179);
    expect(angularError(720, 90)).toBe(90);
    expect(angularError(-90, 0)).toBe(90);
  });
  it('isWithinDeg uses the wrapped error', () => {
    expect(isWithinDeg(358, 3, 12)).toBe(true);
    expect(isWithinDeg(340, 3, 12)).toBe(false);
  });
});

describe('advanceRadiusFor (accuracy gate)', () => {
  it('maps accuracy to a radius or null', () => {
    expect(advanceRadiusFor(5)).toBe(ADVANCE_RADIUS_GOOD_M);
    expect(advanceRadiusFor(20)).toBe(ADVANCE_RADIUS_GOOD_M);
    expect(advanceRadiusFor(21)).toBe(ADVANCE_RADIUS_FAIR_M);
    expect(advanceRadiusFor(35)).toBe(ADVANCE_RADIUS_FAIR_M);
    expect(advanceRadiusFor(36)).toBeNull();
    expect(advanceRadiusFor(NaN)).toBeNull();
  });
});

// A two-leg synthetic route: 100 m north, then 100 m east.
const O = { lat: 40.4419581, lng: -79.9564358 };
const B = destinationPoint(O, 0, 100);
const C = destinationPoint(B, 90, 100);

function leg(index: number, a: { lat: number; lng: number }, b: { lat: number; lng: number }, maneuver: RouteLeg['maneuver']): RouteLeg {
  return {
    index,
    instruction: '',
    maneuver,
    distanceM: 100,
    polyline: [a, b],
    startBearingDeg: index === 0 ? 0 : 90,
    endBearingDeg: index === 0 ? 0 : 90,
    endLat: b.lat,
    endLng: b.lng,
    roadSide: 'NONE',
  };
}
const legs: RouteLeg[] = [leg(0, O, B, 'TURN_RIGHT'), leg(1, B, C, 'ARRIVE')];

function fix(p: { lat: number; lng: number }, accuracyM = 8, t = 0): GeoFix {
  return { lat: p.lat, lng: p.lng, accuracyM, courseDeg: null, speedMps: 1.2, timestamp: t };
}

function run(fixes: GeoFix[], start: LegProgressState = initialLegProgress()) {
  const events: string[] = [];
  let state = start;
  for (const f of fixes) {
    const r = stepLegProgress(state, f, legs);
    state = r.state;
    events.push(...r.events);
  }
  return { state, events };
}

describe('stepLegProgress', () => {
  it('needs two consecutive counting fixes inside the end radius', () => {
    const near = destinationPoint(B, 180, 5);
    const one = run([fix(near)]);
    expect(one.events).toEqual([]);
    expect(one.state.legIndex).toBe(0);
    const two = run([fix(near), fix(near)]);
    expect(two.events).toEqual(['ADVANCED']);
    expect(two.state.legIndex).toBe(1);
  });

  it('never advances more than one leg per fix and does not double-advance', () => {
    const near = destinationPoint(B, 180, 5);
    const r = run([fix(near), fix(near), fix(near), fix(near)]);
    // Two more fixes near B are 100 m from C (leg 1 end), so no second advance.
    expect(r.events).toEqual(['ADVANCED']);
    expect(r.state.legIndex).toBe(1);
  });

  it('ignores fixes worse than 35 m and resets the streak on a miss', () => {
    const near = destinationPoint(B, 180, 5);
    const far = destinationPoint(O, 0, 30);
    expect(run([fix(near, 50), fix(near, 50), fix(near, 50)]).events).toEqual([]);
    expect(run([fix(near), fix(far), fix(near)]).events).toEqual([]);
    expect(run([fix(near), fix(near, 100), fix(near)]).events).toEqual([]);
    expect(run([fix(near, 50), fix(near), fix(near)]).events).toEqual(['ADVANCED']);
  });

  it('uses the 25 m radius only for fair accuracy', () => {
    const at20 = destinationPoint(B, 180, 20);
    expect(run([fix(at20, 8), fix(at20, 8)]).events).toEqual([]);          // good acc: 15 m radius
    expect(run([fix(at20, 30), fix(at20, 30)]).events).toEqual(['ADVANCED']); // fair acc: 25 m radius
  });

  it('advances on two consecutive along-track overshoots (inside corner cut)', () => {
    const past = destinationPoint(destinationPoint(B, 0, 18), 90, 12);  // 18 m past the end, 12 m right
    const r = run([fix(past), fix(past)]);
    expect(r.events).toEqual(['ADVANCED']);
  });

  it('arrives on the last leg instead of advancing', () => {
    const nearC = destinationPoint(C, 270, 4);
    const r = run([fix(nearC), fix(nearC)], initialLegProgress(1));
    expect(r.events).toEqual(['ARRIVED']);
    expect(r.state.arrived).toBe(true);
    // Further fixes do nothing.
    const again = stepLegProgress(r.state, fix(nearC), legs);
    expect(again.events).toEqual([]);
  });

  it('survives a jittered walk up leg 0 without skipping or double-advancing', () => {
    // Walk north 0→100 m in 4 m steps with ±6 m lateral jitter and 8–18 m accuracy.
    const fixes: GeoFix[] = [];
    let seed = 7;
    const rnd = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    for (let s = 0; s <= 100; s += 4) {
      const p = destinationPoint(destinationPoint(O, 0, s), rnd() > 0.5 ? 90 : 270, rnd() * 6);
      fixes.push(fix(p, 8 + rnd() * 10, s));
    }
    // Then east along leg 1.
    for (let s = 4; s <= 100; s += 4) {
      const p = destinationPoint(destinationPoint(B, 90, s), rnd() > 0.5 ? 0 : 180, rnd() * 6);
      fixes.push(fix(p, 8 + rnd() * 10, 100 + s));
    }
    const r = run(fixes);
    expect(r.events.filter((e) => e === 'ADVANCED')).toHaveLength(1);
    expect(r.events.filter((e) => e === 'ARRIVED')).toHaveLength(1);
    expect(r.events).not.toContain('OFF_ROUTE');
  });

  it('flags off-route after three stalled far fixes', () => {
    const away = destinationPoint(destinationPoint(O, 0, 40), 270, 40); // 40 m west of leg 0
    const r = run([fix(away), fix(away), fix(away), fix(away)]);
    expect(r.events).toContain('OFF_ROUTE');
  });

  it('detects parallel movement even when along-route progress continues', () => {
    const fixes = [20, 30, 40].map((m) => fix(destinationPoint(destinationPoint(O, 0, m), 270, 40)));
    expect(run(fixes).events).toContain('OFF_ROUTE');
  });

  it('does not interpret separation within GPS uncertainty as off-route', () => {
    const away = destinationPoint(destinationPoint(O, 0, 40), 270, 40);
    expect(run([fix(away, 35), fix(away, 35), fix(away, 35)]).events).not.toContain('OFF_ROUTE');
  });
});

describe('referenceBearingFor', () => {
  it('switches to the end bearing in the last 30 m', () => {
    const l: RouteLeg = { ...legs[0], startBearingDeg: 10, endBearingDeg: 80 };
    expect(referenceBearingFor(l, 60)).toBe(10);
    expect(referenceBearingFor(l, 30)).toBe(80);
  });
});
