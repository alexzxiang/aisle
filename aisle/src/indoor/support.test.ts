/** storeMap validation, pedometer prior and the obstacle INFO tier (04 Tasks 0, 5, 7). */
import type { DepthSummary, SpeechRequest } from '../core/contracts';
import { classifyObstacle, createObstacleReporter } from './obstacles';
import { estimateOrder, nextSignDue, overshot, plausibleWindow } from './pedometerPrior';
import { orderOf, signVocabulary, validateStoreMap } from './storeMap';
import { makeTestMap } from './testing';

describe('validateStoreMap (04 Task 0 step 1, 01 §6)', () => {
  it('accepts the test map and the demo fixture shape', () => {
    const v = validateStoreMap(makeTestMap());
    expect(v.ok).toBe(true);
  });
  it('rejects: missing pinnedBy, duplicate order, empty signText, dangling itemIndex, digit in spokenLabel', () => {
    const m = makeTestMap();
    const bad = {
      ...m,
      entrance: { ...m.entrance, pinnedBy: '' },
      aisles: [
        { ...m.aisles[0]!, order: 2 },
        { ...m.aisles[1]!, order: 2, signText: [] },
        { ...m.aisles[2]!, spokenLabel: 'Aisle 3' },
      ],
      itemIndex: { eggs: { aisleId: 'zzz', sideWhenAscending: 'RIGHT' } },
    };
    const v = validateStoreMap(bad);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.errors.join('\n')).toMatch(/pinnedBy/);
      expect(v.errors.join('\n')).toMatch(/order 2 duplicated/);
      expect(v.errors.join('\n')).toMatch(/signText/);
      expect(v.errors.join('\n')).toMatch(/itemIndex\['eggs'\]\.aisleId/);
      expect(v.errors.join('\n')).toMatch(/spokenLabel 'Aisle 3' contains a digit/);
    }
  });
  it('warns without a checkout landmark', () => {
    const v = validateStoreMap({ ...makeTestMap(), landmarks: [] });
    expect(v.ok && v.warnings.some((w) => w.includes('checkout'))).toBe(true);
  });
  it('orderOf and signVocabulary', () => {
    const m = makeTestMap();
    expect(orderOf(m, 'a3')).toBe(3);
    expect(orderOf(m, 'checkout')).toBe(99);
    expect(orderOf(m, 'nope')).toBeNull();
    expect(signVocabulary(m)).toEqual(expect.arrayContaining(['1', 'PRODUCE', 'CHECKOUT', 'LANES', 'WELCOME']));
  });
});

describe('pedometer prior (04 Task 5)', () => {
  it('estimates order from steps × 0.7 m / pitch in the direction of travel; null without a direction', () => {
    expect(estimateOrder({ currentOrder: 2, direction: 'ASC', stepsSinceRead: 10, aislePitchM: 3.5 })).toBeCloseTo(4, 6);
    expect(estimateOrder({ currentOrder: 6, direction: 'DESC', stepsSinceRead: 5, aislePitchM: 3.5 })).toBeCloseTo(5, 6);
    expect(estimateOrder({ currentOrder: 2, direction: null, stepsSinceRead: 50 })).toBeNull();
  });
  it('cadence and overshoot', () => {
    expect(nextSignDue(4, 3.5)).toBe(false);
    expect(nextSignDue(5, 3.5)).toBe(true);
    expect(overshot(4.2, 3, 'ASC')).toBe(true);
    expect(overshot(3.9, 3, 'ASC')).toBe(false);
    expect(overshot(1.5, 3, 'DESC')).toBe(true);
    expect(overshot(null, 3, 'ASC')).toBe(false);
  });
  it('plausibleWindow widens toward the estimate', () => {
    expect(plausibleWindow(null, null)).toBeNull();
    expect(plausibleWindow(2, null)).toEqual({ min: 0, max: 4 });
    expect(plausibleWindow(2, 5.5)).toEqual({ min: 0, max: 8 });
  });
});

describe('obstacles INFO tier (04 Task 7)', () => {
  const closing: DepthSummary = { centerBottomRel: 0.8, closingRate: 0.2, timestamp: 0 };
  const still: DepthSummary = { centerBottomRel: 0.8, closingRate: 0, timestamp: 0 };
  it('classifyObstacle: NEAR+closing is the reflex; MID closing or NEAR static is INFO; FAR / MID static nothing', () => {
    expect(classifyObstacle({ distanceClass: 'NEAR' }, closing)).toBe('REFLEX');
    expect(classifyObstacle({ distanceClass: 'NEAR' }, still)).toBe('INFO');
    expect(classifyObstacle({ distanceClass: 'MID' }, closing)).toBe('INFO');
    expect(classifyObstacle({ distanceClass: 'MID' }, still)).toBe('NONE');
    expect(classifyObstacle({ distanceClass: 'FAR' }, closing)).toBe('NONE');
  });
  it('speaks obstacle_ahead as INFO with an 8 s cooldown, hazards as two INFO words, never STOP', () => {
    type L<T> = (e: T) => void;
    const obs = new Set<L<{ distanceClass: 'NEAR' | 'MID' | 'FAR'; direction: 'LEFT' | 'CENTER' | 'RIGHT' }>>();
    const haz = new Set<L<{ kind: 'PERSON_AHEAD' | 'CART_AHEAD'; direction: 'LEFT' | 'CENTER' | 'RIGHT' }>>();
    const dep = new Set<L<DepthSummary>>();
    const said: SpeechRequest[] = [];
    const walls: string[] = [];
    let t = 0;
    createObstacleReporter({
      perception: {
        onObstacleAhead: (cb) => { obs.add(cb); return () => {}; },
        onHazard: (cb) => { haz.add(cb); return () => {}; },
        onDepth: (cb) => { dep.add(cb); return () => {}; },
      },
      speech: { say: (r) => { said.push(r); } },
      now: () => t,
      onWallAhead: (e) => walls.push(e.distanceClass),
    });
    dep.forEach((cb) => cb(closing));
    obs.forEach((cb) => cb({ distanceClass: 'MID', direction: 'CENTER' }));
    expect(said.map((s) => [s.cacheKey, s.priority])).toEqual([['obstacle_ahead', 'INFO']]);
    t = 3000;
    obs.forEach((cb) => cb({ distanceClass: 'MID', direction: 'CENTER' }));
    expect(said).toHaveLength(1);              // cooldown
    t = 9000;
    dep.forEach((cb) => cb(still));
    obs.forEach((cb) => cb({ distanceClass: 'NEAR', direction: 'LEFT' }));
    expect(said).toHaveLength(2);              // NEAR static → INFO
    obs.forEach((cb) => cb({ distanceClass: 'FAR', direction: 'CENTER' }));
    expect(said).toHaveLength(2);
    haz.forEach((cb) => cb({ kind: 'PERSON_AHEAD', direction: 'CENTER' }));
    expect(said[2]).toMatchObject({ text: 'Person ahead.', priority: 'INFO' });
    expect(said[2]!.cacheKey).toBeUndefined();
    expect(walls).toEqual(['MID', 'MID', 'NEAR']);
    // The reflex case is not spoken here (PerceptionService owns it) but still hints the wall.
    dep.forEach((cb) => cb(closing));
    t = 20_000;
    obs.forEach((cb) => cb({ distanceClass: 'NEAR', direction: 'CENTER' }));
    expect(said).toHaveLength(3);
    expect(walls).toHaveLength(4);
  });
});
