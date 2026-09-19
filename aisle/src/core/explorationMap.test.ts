import { CELL_M, createExplorationMap } from './explorationMap';

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
