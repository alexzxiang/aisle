import { createTripMemory } from './tripMemory';
import type { Pose } from './contracts';
import type { SearchObservation } from './searchObservation';

const observation = (patch: Partial<SearchObservation> = {}): SearchObservation => ({
  inspection: { target: 'bananas', assessed: true, confidence: 0.95 }, sign: null, items: [], view: 'overview', quality: 'usable', confidence: 0.9, barrier: 'none', landmarks: [], ...patch,
});
function rig() {
  let t = 100000;
  const map = createTripMemory(() => t);
  let p: Pose = { x: 0, y: 1.4, z: 0, yawDeg: 0, timestamp: t, trackingState: 'NORMAL', worldSessionId: 'one' };
  function pose(patch: Partial<Pose> = {}) { t += 100; p = { ...p, ...patch, timestamp: t }; map.ingest(p); return p; }
  pose(); pose(); pose();
  return { map, pose, observe: (patch: Partial<SearchObservation> = {}, item = 'bananas') => { for (let i = 0; i < 8; i++) pose({ pitchDeg: patch.view === 'upper' ? 15 : patch.view === 'lower' ? -15 : 0 }); map.observe(observation(patch), item, t); }, now: () => t };
}

test('remembers dairy across item missions and routes around a corner using walked edges', () => {
  const h = rig();
  h.observe({ sign: 'DAIRY', items: ['milk', 'yogurt'] }); h.observe({ sign: 'DAIRY', items: ['milk', 'yogurt'] });
  for (let x = 0.1; x <= 3; x += 0.1) h.pose({ x });
  for (let z = 0.1; z <= 3; z += 0.1) h.pose({ z });
  const route = h.map.route('milk', 'dairy');
  expect(route?.destination.sign).toBe('DAIRY');
  expect(route?.waypoint.x).toBeGreaterThan(2); // walk back along this corridor, not across the diagonal
  expect(route?.metres).toBeGreaterThan(4);
});

test('only usable open shelf bands qualify; no whole aisle or neighboring shelf elimination', () => {
  const h = rig();
  h.observe({ view: 'upper' }); h.observe({ view: 'upper' }); h.observe({ view: 'middle' }); h.observe({ view: 'middle' });
  h.observe({ view: 'lower', quality: 'occluded' });
  expect(h.map.checkedNear('bananas', { x: 0, y: 1.4, z: 0 })).toBe(false);
  h.observe({ view: 'lower', barrier: 'closed_fridge' });
  expect(h.map.checkedNear('bananas', { x: 0, y: 1.4, z: 0 })).toBe(false);
  h.observe({ view: 'lower' }); h.observe({ view: 'lower' });
  expect(h.map.checkedNear('bananas', { x: 0, y: 1.4, z: 0 })).toBe(true);
  expect(h.map.checkedNear('milk', { x: 0, y: 1.4, z: 0 })).toBe(false);
  expect(h.map.checkedNear('bananas', { x: 3, y: 1.4, z: 0 })).toBe(false);
  h.observe({ view: 'lower', item: { box: [0.1, 0.1, 0.2, 0.2], confidence: 0.9 } });
  expect(h.map.checkedNear('bananas', { x: 0, y: 1.4, z: 0 })).toBe(false);
});

test('late cloud results attach to capture pose, never the new camera position', () => {
  const h = rig(); const captured = h.now();
  for (let x = 0.1; x < 4; x += 0.1) h.pose({ x });
  h.map.observe(observation({ items: ['milk', 'yogurt'] }), 'bananas', captured);
  const dairy = h.map.snapshot().places.find(p => p.section === 'dairy');
  expect(dairy?.x).toBe(0);
});

test('tracking loss freezes routes; native reset preserves semantics but disconnects old geometry', () => {
  const h = rig();
  h.observe({ sign: 'DAIRY', items: ['milk', 'yogurt'] }); h.observe({ sign: 'DAIRY', items: ['milk', 'yogurt'] });
  const old = h.map.snapshot().places.find(p => p.sign === 'DAIRY')!;
  h.pose({ trackingState: 'LIMITED' });
  expect(h.map.ready()).toBe(false); expect(h.map.route('milk', 'dairy')).toBeNull();
  h.pose({ trackingState: 'NORMAL', worldSessionId: 'two', x: 20 }); h.pose(); h.pose();
  expect(h.map.ready()).toBe(true); expect(h.map.route('milk', 'dairy')).toBeNull();
  h.observe({ sign: 'DAIRY', items: ['milk', 'yogurt'] }); h.observe({ sign: 'DAIRY', items: ['milk', 'yogurt'] });
  expect(h.map.snapshot().places.find(p => p.epoch === 'two' && p.sign === 'DAIRY')?.relocalizedFrom).toBe(old.id);
  expect(h.map.snapshot().edges).toEqual([]);
});

test('a NORMAL pose teleport creates a disconnected frame and does not keep resetting it', () => {
  const h = rig(); h.pose({ x: 20 });
  expect(h.map.ready()).toBe(false); const gen = h.map.generation();
  h.pose(); h.pose();
  expect(h.map.ready()).toBe(true); expect(h.map.generation()).toBe(gen);
  expect(h.map.snapshot().edges).toHaveLength(0);
});

test('sparse 3D points retain height, reject invalid geometry and reset with coordinate origin', () => {
  const h = rig(); h.pose({ mappingPoints: [{ x: 1, y: 1, z: 1 }, { x: 1, y: 2, z: 1 }, { x: NaN, y: 0, z: 0 }] });
  expect(h.map.snapshot().points).toHaveLength(2);
  h.pose({ worldSessionId: 'two', mappingPoints: [] }); h.pose(); h.pose();
  expect(h.map.snapshot().points).toHaveLength(0);
});

test('remembers open portals as exploration candidates and records measured aisle traversals', () => {
  const h = rig();
  const landmarks: SearchObservation['landmarks'] = [{ name: 'open passage', boundary: 'open_passage', kind: 'doorway', section: 'unknown', confidence: 0.9, box: [0.4, 0.1, 0.2, 0.8] }];
  h.observe({ landmarks }); h.observe({ landmarks });
  h.map.arrive('first aisle end', 'aisle_end');
  for (let x = 0.1; x <= 6; x += 0.1) h.pose({ x });
  expect(h.map.route('bananas', 'produce')?.destination.x).toBe(0);
  h.map.arrive('second aisle end', 'aisle_end');
  expect(h.map.snapshot().aisles[0]?.walkedMetres).toBeGreaterThan(5);
  expect(h.map.snapshot().aisles[0]?.lengthKnown).toBe(false);
});

test('absence requires explicit inspection of the requested item and independent confident frames', () => {
  const h = rig();
  for (const view of ['upper', 'middle', 'lower'] as const) {
    h.observe({ view, inspection: undefined }); h.observe({ view, inspection: undefined });
  }
  expect(h.map.coverage('bananas').checked).toBe(false);
  for (const view of ['upper', 'middle', 'lower'] as const) {
    h.observe({ view, inspection: { target: 'milk', assessed: true, confidence: 1 } });
    h.observe({ view, confidence: 0.7 });
  }
  expect(h.map.coverage('bananas').checked).toBe(false);
});

test('changing shelf labels without changing the camera viewpoint cannot clear a location', () => {
  const h = rig();
  for (const view of ['upper', 'upper', 'middle', 'middle', 'lower', 'lower'] as const) {
    for (let i = 0; i < 8; i++) h.pose({ pitchDeg: 0 });
    h.map.observe(observation({ view }), 'bananas', h.now());
  }
  expect(h.map.coverage('bananas')).toMatchObject({ checked: false, missing: ['lower'] });
});

test('deferred routes are skipped without claiming absence and are retried after cooldown', () => {
  const h = rig();
  h.observe({ items: ['milk', 'yogurt'] });
  for (let x = 0.1; x <= 3; x += 0.1) h.pose({ x });
  const destination = h.map.route('milk', 'dairy')!.destination.id;
  h.map.defer('milk', destination, 2000);
  expect(h.map.route('milk', 'dairy')).toBeNull();
  expect(h.map.describe('milk')).toContain('partial coverage');
  for (let i = 0; i < 21; i++) h.pose();
  expect(h.map.route('milk', 'dairy')?.destination.id).toBe(destination);
  expect(h.map.route('milk', 'dairy', 'nonexistent')).toBeNull();
});

test('a stalled shelf cools down nearby walked viewpoints without excluding farther produce', () => {
  const h = rig();
  h.observe({ items: ['apples', 'oranges'] });
  for (let i = 1; i <= 60; i++) {
    h.pose({ x: i / 10 });
    if (i === 10 || i === 50) h.observe({ items: ['apples', 'oranges'] });
  }
  h.map.defer('bananas', h.map.snapshot().places[0]!.id);
  const route = h.map.route('bananas', 'produce');
  expect(route?.destination.x).toBeGreaterThan(3);
  expect(h.map.describe('bananas')).toContain('partial coverage');
  h.map.noteAisle('produce aisle', 'produce');
  h.map.noteAisleSearch('bananas', 'inconclusive');
  expect(h.map.aisleVisited('produce sign', 'bananas')).toBe(false);
});

test('a door-shaped object without open-floor evidence never becomes an exploration portal', () => {
  const h = rig();
  const doorway: SearchObservation['landmarks'][number] = { name: 'door', kind: 'doorway', section: 'unknown', box: [0.3, 0.1, 0.3, 0.8], confidence: 0.99 };
  h.observe({ landmarks: [doorway] }); h.observe({ landmarks: [{ ...doorway, boundary: 'closed_door' }] });
  expect(h.map.snapshot().portals).toHaveLength(0);
});

test('tracks grocery aisle visits and search outcome independently for each item', () => {
  const h = rig();
  h.map.noteAisle('Aisle four pasta', 'pantry');
  h.map.noteAisleSearch('spaghetti', 'inconclusive');
  expect(h.map.aisleVisited('Aisle four pasta', 'spaghetti')).toBe(true);
  expect(h.map.aisleVisited('Aisle six coffee', 'spaghetti')).toBe(false);
  expect(h.map.aisleVisited('Aisle four pasta', 'coffee')).toBe(false);
  h.map.noteAisleSearch('spaghetti', 'checked');
  expect(h.map.visitedAisles('spaghetti')).toEqual([expect.objectContaining({ result: 'checked', visits: 1 })]);
  h.map.leaveAisle();
});

test('keeps separate unmarked aisles and upgrades one when its sign becomes readable', () => {
  const h = rig();
  h.map.noteAisle('unmarked aisle', 'unknown');
  h.map.noteAisle('PRODUCE', 'produce');
  h.map.noteAisleSearch('bananas', 'inconclusive');
  h.map.leaveAisle();
  h.map.noteAisle('unmarked aisle', 'unknown');
  h.map.noteAisleSearch('bananas', 'inconclusive');
  expect(h.map.visitedAisles('bananas').map(a => a.label)).toEqual(['PRODUCE', 'unmarked aisle']);
});
