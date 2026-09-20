/** Session exploration: coarse visited cells plus sparse 3D and semantic trip memory.
 * Live camera pans do not paint the old visibility cone: monocular nearness cannot
 * provide the metric occlusion limits needed to say what lies behind a shelf.
 * World yaw zero advances along negative z; positive yaw turns toward positive x.
 */
import type { Pose } from './contracts';
import { createTripMemory, type TripMemory } from './tripMemory';

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
  meters?: number;
  center: number;
  left?: number;
  right?: number;
}

/** A short segment, leaving a metre before the measured obstruction. */
export function explorationSteps(path: Openness): number {
  if (path.meters === undefined) return 3;
  if (!Number.isFinite(path.meters)) return 0;
  return Math.max(0, Math.min(3, Math.floor((path.meters - 1) / 0.7)));
}

export interface ExplorationMap {
  readonly trip: TripMemory;
  ingestPose(p: Pose): void;
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
  /**
   * Round 18: "the bananas are not on *this* table" — a mark at a world position, per item and
   * place. It outlives a pan, a walk away and a later mission for the same item, so the same
   * table met again from another side is known to be checked, while a different table across
   * the room is not.
   */
  markAbsent(item: string, place: string, p: Pick<Pose, 'x' | 'z'>): void;
  /** Is there an absent mark for this item and place within `radiusM` of `p`? */
  absentNear(item: string, place: string, p: Pick<Pose, 'x' | 'z'>, radiusM?: number): boolean;
  absentMarks(item: string): ReadonlyArray<{ place: string; x: number; z: number; at: number }>;
}

/** An absent mark this old no longer counts (someone may have moved the thing). */
export const ABSENT_TTL_MS = 30 * 60_000;
/** The same place instance: within this distance of a mark. */
export const ABSENT_RADIUS_M = 2.5;

/** The world position of a thing seen `steps` steps away at `relativeDeg` from the phone's yaw. */
export function projectFrom(p: Pick<Pose, 'x' | 'z' | 'yawDeg'>, relativeDeg: number, steps: number, stepM = 0.7): { x: number; z: number } {
  const rad = ((p.yawDeg + relativeDeg) * Math.PI) / 180;
  const d = Math.max(0.5, steps * stepM);
  return { x: p.x + Math.sin(rad) * d, z: p.z - Math.cos(rad) * d };
}

const key = (cx: number, cz: number): string => `${cx},${cz}`;
const cellOf = (p: Pick<Pose, 'x' | 'z'>): [number, number] => [Math.floor(p.x / CELL_M), Math.floor(p.z / CELL_M)];
export const wrap360 = (deg: number): number => ((deg % 360) + 360) % 360;

/** How far a look counts as having seen the ground, metres. */
export const VIEW_RANGE_M = 4.5;

export function createExplorationMap(now: () => number = Date.now): ExplorationMap {
  const trip = createTripMemory(now);
  let generation = 0;
  const visited = new Map<string, number>();
  const scanned = new Set<string>();
  const seen = new Map<string, number>();
  const absent: Array<{ item: string; place: string; x: number; z: number; at: number }> = [];
  const norm = (s: string): string => s.trim().toLowerCase();
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
    trip,
    ingestPose(p) {
      trip.ingest(p);
      if (trip.generation() !== generation) {
        generation = trip.generation();
        visited.clear(); scanned.clear(); seen.clear(); blocked.clear(); absent.length = 0;
      }
    },
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
    markAbsent(item, place, p) {
      const i = norm(item);
      const pl = norm(place);
      const t = now();
      // One mark per instance: refresh a mark within the radius rather than piling up.
      const same = absent.find((m) => m.item === i && m.place === pl && Math.hypot(m.x - p.x, m.z - p.z) <= ABSENT_RADIUS_M);
      if (same) { same.x = p.x; same.z = p.z; same.at = t; return; }
      absent.push({ item: i, place: pl, x: p.x, z: p.z, at: t });
      if (absent.length > 200) absent.shift();
    },
    absentNear(item, place, p, radiusM = ABSENT_RADIUS_M) {
      const i = norm(item);
      const pl = norm(place);
      const t = now();
      return absent.some((m) => m.item === i && m.place === pl && t - m.at <= ABSENT_TTL_MS && Math.hypot(m.x - p.x, m.z - p.z) <= radiusM);
    },
    absentMarks(item) {
      const i = norm(item);
      const t = now();
      return absent.filter((m) => m.item === i && t - m.at <= ABSENT_TTL_MS).map(({ place, x, z, at }) => ({ place, x, z, at }));
    },
  };
}
