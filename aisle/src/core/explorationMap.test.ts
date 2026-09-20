import { CELL_M, createExplorationMap } from './explorationMap';
import type { Pose } from './contracts';

it('preserves visited geometry across brief continuous tracking loss, but discards it after a reset or gap', () => {
  let t = 1000;
  const m = createExplorationMap(() => t);
  let p: Pose = { x: 0, y: 1, z: 0, yawDeg: 0, timestamp: t, trackingState: 'NORMAL', worldSessionId: 'one' };
  const feed = (patch: Partial<Pose> = {}) => { t += 100; p = { ...p, ...patch, timestamp: t }; m.ingestPose(p); };
  feed(); feed(); feed(); m.visit(p); m.markBlocked(p, 0);
  feed({ trackingState: 'LIMITED' });
  expect(m.trip.ready()).toBe(false);
  feed({ trackingState: 'NORMAL' }); feed(); feed();
  expect(m.trip.ready()).toBe(true);
  expect(m.visitedCells()).toBe(1);
  expect(m.bestHeading(p, 0, null)?.turn).not.toBe('ahead');
  feed({ trackingState: 'LIMITED' }); t += 3000;
  feed({ trackingState: 'NORMAL' }); feed(); feed();
  expect(m.visitedCells()).toBe(0);
  m.visit(p); feed({ worldSessionId: 'two' });
  expect(m.visitedCells()).toBe(0);
});

describe('exploration map (round 12): go where we have not been', () => {
  it('prefers unvisited ground ahead, then a turn; the depth grid vetoes a blocked way; visited ground is skipped', () => {
    const m = createExplorationMap();
    const here = { x: 0, z: 0 };
    m.visit(here);
    // Facing north (yaw 0): everything ahead is unvisited.
    expect(m.bestHeading(here, 0, null)).toMatchObject({ turn: 'ahead', yawDeg: 0, unvisited: 4 });
    // Ahead blocked by the depth grid → a turn.
    const turned = m.bestHeading(here, 0, { center: 0.9, left: 0.2, right: 0.6 });
    expect(turned?.turn).toMatch(/left/);
    // Walk north through four cells: north is now visited, so the best way is elsewhere.
    for (let i = 1; i <= 4; i += 1) m.visit({ x: 0, z: -CELL_M * i });
    const next = m.bestHeading(here, 0, null);
    expect(next?.turn).not.toBe('ahead');
    expect(next?.unvisited).toBe(4);
    // A blocked heading is remembered per cell.
    m.markBlocked(here, 90);
    const noEast = m.bestHeading(here, 0, null);
    expect(noEast?.turn).not.toBe('right');
    expect(m.visitedCells()).toBe(5);
    m.markScanned(here);
    expect(m.scannedHere(here)).toBe(true);
    expect(m.scannedCells()).toBe(1);
  });

  it('returns null when every direction is visited or blocked', () => {
    const m = createExplorationMap();
    for (let x = -6; x <= 6; x += 1) for (let z = -6; z <= 6; z += 1) m.visit({ x: x * CELL_M, z: z * CELL_M });
    expect(m.bestHeading({ x: 0, z: 0 }, 0, null)).toBeNull();
  });
});

describe('looking counts as coverage (round 17)', () => {
  it('a full turn at one spot paints the ring around it; the best heading is then where no view reached', () => {
    const m = createExplorationMap();
    const here = { x: 0, z: 0 };
    m.visit(here);
    for (let yaw = 0; yaw < 360; yaw += 30) m.markViewed(here, yaw, 56);
    expect(m.viewedCells()).toBeGreaterThan(20);
    expect(m.viewed({ x: 0, z: -3 })).toBe(true);
    // Nothing within four and a half metres is unknown any more; the lookahead (six metres) still has unknown cells at the far end.
    const next = m.bestHeading(here, 0, null);
    expect(next).not.toBeNull();
    expect(next!.unvisited).toBeLessThanOrEqual(2);
    // Looking north only leaves the other headings unknown.
    const n = createExplorationMap();
    n.visit(here);
    n.markViewed(here, 0, 56);
    expect(n.bestHeading(here, 0, null)?.turn).not.toBe('ahead');
  });
});
