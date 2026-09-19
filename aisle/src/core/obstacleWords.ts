/**
 * "Obstacle ahead." said nothing a blind person could act on (round 13, Stream A). The depth
 * grid knows *that* something is close ahead and which side is open; the detector very often
 * knows *what* it is and how far. Put together: "Chair ahead, two steps. Open on your right."
 *
 * Inputs are what the phone already has at the moment the obstacle reflex fires: the latest
 * detections (with the depth grid's nearness per box), the depth grid's bottom row, and the
 * lens's field of view. Nothing here decides *whether* to speak — the reflex does; this only
 * chooses the words, in twelve or fewer.
 */
import type { Detection, DetectionClass, Direction } from './contracts';
import { degreesFromBox, stepsFromBox, stepsWords } from './guide';
import { spokenName } from './sceneMemory';
import { fitWords } from './phrases';

export interface ObstacleContext {
  detections: readonly Detection[];
  depth: { center: number; left?: number; right?: number } | null;
  hfovDeg: number;
  direction: Direction;
}

/** Things that are never the obstacle: the user's own hand and the signal heads. */
const NOT_OBSTACLES = new Set<DetectionClass>(['hand', 'ped_walk', 'ped_hand', 'ped_countdown']);
/** A box counts as "in the way" when it sits in the lower middle of the frame. */
export const OBSTACLE_MIN_HEIGHT = 0.18;
export const OBSTACLE_MIN_BOTTOM = 0.55;
/** Depth-grid nearness at or under this on a side means that side is open. */
export const OPEN_SIDE_MAX = 0.45;

const cap = (s: string): string => (s.length ? s[0]!.toUpperCase() + s.slice(1) : s);

/** The detection most likely to be the thing in the way, or null. */
export function obstacleDetection(detections: readonly Detection[], direction: Direction): Detection | null {
  const xLo = direction === 'LEFT' ? 0 : direction === 'RIGHT' ? 0.45 : 0.2;
  const xHi = direction === 'LEFT' ? 0.55 : direction === 'RIGHT' ? 1 : 0.8;
  let best: Detection | null = null;
  let bestScore = -Infinity;
  for (const d of detections) {
    if (NOT_OBSTACLES.has(d.cls) || d.score < 0.5) continue;
    const [x, y, w, h] = d.box;
    const cx = x + w / 2;
    const bottom = y + h;
    if (h < OBSTACLE_MIN_HEIGHT || bottom < OBSTACLE_MIN_BOTTOM || cx < xLo || cx > xHi) continue;
    // Big, low and near wins; the depth grid's nearness at the box breaks ties.
    const score = w * h + bottom * 0.5 + (d.near ?? 0);
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/** Which side is more open, by the depth grid; null when neither is known to be open. */
export function openSide(depth: ObstacleContext['depth']): 'left' | 'right' | null {
  if (!depth) return null;
  const l = typeof depth.left === 'number' ? depth.left : null;
  const r = typeof depth.right === 'number' ? depth.right : null;
  if (l === null && r === null) return null;
  const leftOpen = l !== null && l <= OPEN_SIDE_MAX;
  const rightOpen = r !== null && r <= OPEN_SIDE_MAX;
  if (leftOpen && rightOpen) return (l ?? 1) <= (r ?? 1) ? 'left' : 'right';
  if (leftOpen) return 'left';
  if (rightOpen) return 'right';
  return null;
}

/**
 * The line for an obstacle reflex: what, where, how far, and the way round it.
 *   "Chair ahead, two steps. Open on your right."
 *   "Person close on your left. Open on your right."
 *   "Something close ahead. Open on your left." / "Something close ahead. Stop."
 */
export function describeObstacle(ctx: ObstacleContext): string {
  const d = obstacleDetection(ctx.detections, ctx.direction);
  const side = openSide(ctx.depth);
  const tail = side ? `Open on your ${side}.` : 'Stop.';
  if (!d) {
    const where = ctx.direction === 'LEFT' ? 'on your left' : ctx.direction === 'RIGHT' ? 'on your right' : 'ahead';
    return fitWords(`Something close ${where}. ${tail}`);
  }
  const rel = degreesFromBox(d.box, ctx.hfovDeg);
  const steps = stepsFromBox(d.cls, d.box, d.near, ctx.hfovDeg > 80);
  const where = Math.abs(rel) < 12 ? 'ahead' : rel < 0 ? 'on your left' : 'on your right';
  // The reflex fired because something is near: the depth grid's word beats the box estimate.
  const dist = steps <= 1 || (d.near ?? 0) >= 0.7 ? 'close' : stepsWords(steps);
  const name = cap(spokenName(d.cls));
  return fitWords(`${name} ${where}, ${dist}. ${tail}`);
}
