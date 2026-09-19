/**
 * Obstacles and hazards, INFO tier (04 Task 7).
 *
 * The time-critical half — NEAR + closing → STOP (+ `obstacle_ahead` CRITICAL in
 * the indoor profiles only) — lives in `PerceptionService.ts` so it never waits
 * on this file. This file handles what is left:
 *
 *   MID closing, or NEAR static → `obstacle_ahead` as INFO, cooldown 8 s, and a
 *                                  `wallAhead` hint to the navigator (the end-of-
 *                                  aisle wall shows up here first);
 *   HAZARD (person / cart)       → INFO only, two words, never STOP.
 *
 * Hazard honesty: depth is relative and uncalibrated; NEAR / MID / FAR are
 * per-phone thresholds. The phrase is always "Obstacle ahead" or "Person ahead",
 * never a distance, never a reassurance.
 */
import type { DepthSummary, Direction, DistanceClass, HazardKind, PerceptionService, SpeechService } from '../core/contracts';
import { phraseText } from '../core/phrases';

export const OBSTACLE_INFO_COOLDOWN_MS = 8000;
export const HAZARD_INFO_COOLDOWN_MS = 8000;

export type ObstacleClass = 'REFLEX' | 'INFO' | 'NONE';

/** Pure classification: REFLEX is owned by PerceptionService; INFO is ours; FAR is nothing. */
export function classifyObstacle(e: { distanceClass: DistanceClass }, lastDepth: Pick<DepthSummary, 'closingRate'> | null): ObstacleClass {
  const closing = !!lastDepth && lastDepth.closingRate > 0;
  if (e.distanceClass === 'NEAR') return closing ? 'REFLEX' : 'INFO';
  if (e.distanceClass === 'MID') return closing ? 'INFO' : 'NONE';
  return 'NONE';
}

export const HAZARD_TEXT: Readonly<Record<HazardKind, string>> = Object.freeze({
  PERSON_AHEAD: 'Person ahead.',
  CART_AHEAD: 'Cart ahead.',
});

/**
 * Which way to step. "Obstacle ahead." alone leaves the person stopped with nowhere to go, and
 * the depth grid's bottom-left / bottom-right cells were added in round 6b for exactly this.
 *
 * The wording stays comparative on purpose. Depth here is relative and uncalibrated, so the
 * grid can say one side has *more room* than the other; it cannot say a side is free, and the
 * phrase lint forbids "clear" for that reason. A side being less blocked is not permission to
 * walk into it, so the cane check stays the answer when neither side gives way.
 */
export const OBSTACLE_SPACE_LEFT = 'Obstacle ahead. More space on your left.';
export const OBSTACLE_SPACE_RIGHT = 'Obstacle ahead. More space on your right.';
export const OBSTACLE_BOTH_BLOCKED = 'Obstacle ahead. Stop and check with your cane.';

/** Relative depth at or above this reads as blocked — the same cut the proxy's `path:` fact uses. */
export const DEPTH_BLOCKED_REL = 0.66;
/** How much lower one side must be before it is worth naming; below this the grid is guessing. */
export const DEPTH_SIDE_MARGIN = 0.15;

/** `rel` is 0..1 with 1 nearest, so the *lower* side is the one with more room. */
export function obstacleText(depth: Pick<DepthSummary, 'leftBottomRel' | 'rightBottomRel'> | null): string {
  const left = depth?.leftBottomRel;
  const right = depth?.rightBottomRel;
  const plain = phraseText('obstacle_ahead');
  if (typeof left !== 'number' || typeof right !== 'number') return plain;
  if (left >= DEPTH_BLOCKED_REL && right >= DEPTH_BLOCKED_REL) return OBSTACLE_BOTH_BLOCKED;
  if (left <= right - DEPTH_SIDE_MARGIN && left < DEPTH_BLOCKED_REL) return OBSTACLE_SPACE_LEFT;
  if (right <= left - DEPTH_SIDE_MARGIN && right < DEPTH_BLOCKED_REL) return OBSTACLE_SPACE_RIGHT;
  return plain;
}

/** Variable indoor phrases this file speaks; storeResolver pre-synthesizes them at load. */
export const OBSTACLE_PREFETCH_TEXTS: readonly string[] = [
  ...Object.values(HAZARD_TEXT),
  OBSTACLE_SPACE_LEFT,
  OBSTACLE_SPACE_RIGHT,
  OBSTACLE_BOTH_BLOCKED,
];

export interface ObstacleReporterOptions {
  perception: Pick<PerceptionService, 'onObstacleAhead' | 'onHazard' | 'onDepth'>;
  speech: Pick<SpeechService, 'say'>;
  /** Only speak while the indoor leg runs (01 §3 permits `obstacle` indoors; A's policy drops it elsewhere anyway). */
  isActive?: () => boolean;
  onWallAhead?: (e: { distanceClass: DistanceClass; direction: Direction }) => void;
  now?: () => number;
}

export interface ObstacleReporter {
  dispose(): void;
  getLastDepth(): DepthSummary | null;
}

export function createObstacleReporter(opts: ObstacleReporterOptions): ObstacleReporter {
  const now = opts.now ?? Date.now;
  const active = opts.isActive ?? (() => true);
  let lastDepth: DepthSummary | null = null;
  let lastObstacleAt = -Infinity;
  let lastHazardAt = -Infinity;
  const unsubs: Array<() => void> = [];

  unsubs.push(opts.perception.onDepth((d) => {
    lastDepth = d;
  }));

  unsubs.push(opts.perception.onObstacleAhead((e) => {
    if (!active()) return;
    const cls = classifyObstacle(e, lastDepth);
    if (cls === 'NONE') return;
    if (cls === 'INFO' || cls === 'REFLEX') opts.onWallAhead?.(e);
    if (cls !== 'INFO') return;
    const t = now();
    if (t - lastObstacleAt < OBSTACLE_INFO_COOLDOWN_MS) return;
    lastObstacleAt = t;
    const text = obstacleText(lastDepth);
    opts.speech.say({
      text,
      priority: 'INFO',
      // The cached clip says "Obstacle ahead." and nothing else, so it may only be used for
      // exactly that line; sending it with a sidestep would speak over the direction.
      ...(text === phraseText('obstacle_ahead') ? { cacheKey: 'obstacle_ahead' as const } : {}),
      dedupeKey: 'obstacle-info',
      cooldownMs: OBSTACLE_INFO_COOLDOWN_MS,
    });
  }));

  unsubs.push(opts.perception.onHazard((e) => {
    if (!active()) return;
    const t = now();
    if (t - lastHazardAt < HAZARD_INFO_COOLDOWN_MS) return;
    lastHazardAt = t;
    opts.speech.say({
      text: HAZARD_TEXT[e.kind],
      priority: 'INFO',
      dedupeKey: `hazard-${e.kind}`,
      cooldownMs: HAZARD_INFO_COOLDOWN_MS,
    });
  }));

  return {
    dispose() {
      for (const u of unsubs.splice(0)) u();
    },
    getLastDepth: () => lastDepth,
  };
}
