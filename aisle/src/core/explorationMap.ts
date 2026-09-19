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

export function createExplorationMap(): ExplorationMap {
  const visited = new Map<string, number>();
  const scanned = new Set<string>();
  /** cell → set of yaw sectors (30°) found blocked. */
  const blocked = new Map<string, Set<number>>();

  const sector = (yawDeg: number): number => Math.round(wrap360(yawDeg) / 30) % 12;
  const visitsAlong = (p: Pick<Pose, 'x' | 'z'>, yawDeg: number): number => {
    const rad = (yawDeg * Math.PI) / 180;
    let unvisited = 0;
    for (let i = 1; i <= LOOKAHEAD_CELLS; i += 1) {
      const x = p.x + Math.sin(rad) * CELL_M * i;
      const z = p.z - Math.cos(rad) * CELL_M * i;
      const [cx, cz] = cellOf({ x, z });
      if (!visited.has(key(cx, cz))) unvisited += 1;
    }
    return unvisited;
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
