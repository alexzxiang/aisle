/**
 * ExplorationMap — where the person has been, so the search can go where they have not
 * (round 12, Stream A).
 *
 * ARKit reports the phone's position in metres at 10 Hz (`Pose.x/z`, `yawDeg`). A coarse grid
 * (CELL_M) of visited cells, plus the cells where a scan was done and the headings that
 * turned out blocked, is enough to explore a room, a classroom or a store aisle by aisle
 * without Claude having to name a landmark first: the next heading is the one with the
 * most unvisited cells along it that the depth grid does not call blocked. Ahead is
 * preferred on ties (no turn), then a quarter turn, then around.
 *
 * Coordinates are ARKit's world frame (x east-ish, z south-ish after gravity-and-heading
 * alignment); yaw is the app's compass yaw (0 = north, + clockwise). A ray at yaw θ
 * advances (sin θ, −cos θ) in (x, z).
 */
import type { Pose } from './contracts';

export const CELL_M = 1.5;
/** How far ahead a heading is scored, in cells. */
export const LOOKAHEAD_CELLS = 4;
/** Depth-grid nearness at or above this in a direction means it is blocked. */
export const BLOCKED_NEAR = 0.7;

export interface HeadingChoice {
  yawDeg: number;
  /** Relative to the current facing. */
  turn: 'ahead' | 'left' | 'right' | 'around' | 'half_left' | 'half_right';
  /** Unvisited cells along the ray (0..LOOKAHEAD_CELLS). */
  unvisited: number;
}

export interface Openness {
  center: number;
  left?: number;
  right?: number;
}

export interface ExplorationMap {
  /** Feed every pose; visits are recorded per cell. */
  visit(p: Pick<Pose, 'x' | 'z'>): void;
  /**
   * Round 17: the camera looked this way — paint the view cone (yaw ± hfov/2, out to `rangeM`)
   * as seen. Panning at one spot then covers the whole ring around it, and "where else?" is
   * answered by the cells no view has touched: the doorway you never faced, the far corner.
   */
  markViewed(p: Pick<Pose, 'x' | 'z'>, yawDeg: number, hfovDeg: number, rangeM?: number): void;
  /** Cells any view has touched. */
  viewedCells(): number;
  /** Has this cell been looked at (from anywhere)? */
  viewed(p: Pick<Pose, 'x' | 'z'>): boolean;
  markScanned(p: Pick<Pose, 'x' | 'z'>): void;
  /** The way ahead at this cell and yaw turned out blocked (an obstacle, a wall, a shelf end). */
  markBlocked(p: Pick<Pose, 'x' | 'z'>, yawDeg: number): void;
  /** The most promising heading from here, or null when everything around is visited or blocked. */
  bestHeading(p: Pick<Pose, 'x' | 'z'>, yawDeg: number, openness: Openness | null): HeadingChoice | null;
  /** Was this cell scanned already? */
  scannedHere(p: Pick<Pose, 'x' | 'z'>): boolean;
  visitedCells(): number;
  scannedCells(): number;
  /** Straight-line distance from `from` to `to`, metres. */
  distance(from: Pick<Pose, 'x' | 'z'>, to: Pick<Pose, 'x' | 'z'>): number;
}

const key = (cx: number, cz: number): string => `${cx},${cz}`;
const cellOf = (p: Pick<Pose, 'x' | 'z'>): [number, number] => [Math.floor(p.x / CELL_M), Math.floor(p.z / CELL_M)];
export const wrap360 = (deg: number): number => ((deg % 360) + 360) % 360;

/** How far a look counts as having seen the ground, metres. */
export const VIEW_RANGE_M = 4.5;

export function createExplorationMap(): ExplorationMap {
  const visited = new Map<string, number>();
  const scanned = new Set<string>();
  const seen = new Map<string, number>();
  /** cell → set of yaw sectors (30°) found blocked. */
  const blocked = new Map<string, Set<number>>();

  const sector = (yawDeg: number): number => Math.round(wrap360(yawDeg) / 30) % 12;
  /** Cells along a ray that no one has walked *or looked at* yet. */
  const visitsAlong = (p: Pick<Pose, 'x' | 'z'>, yawDeg: number): number => {
    const rad = (yawDeg * Math.PI) / 180;
    let unknown = 0;
    for (let i = 1; i <= LOOKAHEAD_CELLS; i += 1) {
      const x = p.x + Math.sin(rad) * CELL_M * i;
      const z = p.z - Math.cos(rad) * CELL_M * i;
      const [cx, cz] = cellOf({ x, z });
      const k = key(cx, cz);
      if (!visited.has(k) && !seen.has(k)) unknown += 1;
    }
    return unknown;
  };

  return {
    visit(p) {
      const [cx, cz] = cellOf(p);
      const k = key(cx, cz);
      visited.set(k, (visited.get(k) ?? 0) + 1);
    },
    markScanned(p) {
      const [cx, cz] = cellOf(p);
      scanned.add(key(cx, cz));
      visited.set(key(cx, cz), (visited.get(key(cx, cz)) ?? 0) + 1);
    },
    markViewed(p, yawDeg, hfovDeg, rangeM = VIEW_RANGE_M) {
      // Sample the cone on a half-cell lattice: cheap, and every cell in it gets painted.
      const half = hfovDeg / 2;
      for (let a = -half; a <= half; a += 10) {
        const rad = ((yawDeg + a) * Math.PI) / 180;
        for (let r = CELL_M * 0.5; r <= rangeM; r += CELL_M * 0.5) {
          const x = p.x + Math.sin(rad) * r;
          const z = p.z - Math.cos(rad) * r;
          const [cx, cz] = cellOf({ x, z });
          const k = key(cx, cz);
          seen.set(k, (seen.get(k) ?? 0) + 1);
        }
      }
    },
    viewedCells: () => seen.size,
    viewed(p) {
      const [cx, cz] = cellOf(p);
      return seen.has(key(cx, cz));
    },
    markBlocked(p, yawDeg) {
      const [cx, cz] = cellOf(p);
      const k = key(cx, cz);
      const set = blocked.get(k) ?? new Set<number>();
      set.add(sector(yawDeg));
      blocked.set(k, set);
    },
    scannedHere(p) {
      const [cx, cz] = cellOf(p);
      return scanned.has(key(cx, cz));
    },
    bestHeading(p, yawDeg, openness) {
      const [cx, cz] = cellOf(p);
      const blockedHere = blocked.get(key(cx, cz)) ?? new Set<number>();
      const candidates: Array<{ turn: HeadingChoice['turn']; rel: number; open: number | null }> = [
        { turn: 'ahead', rel: 0, open: openness?.center ?? null },
        { turn: 'half_left', rel: -45, open: openness?.left ?? null },
        { turn: 'half_right', rel: 45, open: openness?.right ?? null },
        { turn: 'left', rel: -90, open: openness?.left ?? null },
        { turn: 'right', rel: 90, open: openness?.right ?? null },
        { turn: 'around', rel: 180, open: null },
      ];
      let best: HeadingChoice | null = null;
      let bestScore = -Infinity;
      for (const c of candidates) {
        const yaw = wrap360(yawDeg + c.rel);
        if (blockedHere.has(sector(yaw))) continue;
        if (c.open !== null && c.open >= BLOCKED_NEAR) continue;
        const unvisited = visitsAlong(p, yaw);
        if (unvisited === 0) continue;
        // Unvisited cells first; then the smaller turn; open space as a small bonus.
        const score = unvisited * 10 - Math.abs(c.rel) / 90 + (c.open !== null ? (1 - c.open) : 0.3);
        if (score > bestScore) {
          bestScore = score;
          best = { yawDeg: yaw, turn: c.turn, unvisited };
        }
      }
      return best;
    },
    visitedCells: () => visited.size,
    scannedCells: () => scanned.size,
    distance: (a, b) => Math.hypot(a.x - b.x, a.z - b.z),
  };
}
