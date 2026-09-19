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

/** Variable indoor phrases this file speaks; storeResolver pre-synthesizes them at load. */
export const OBSTACLE_PREFETCH_TEXTS: readonly string[] = Object.values(HAZARD_TEXT);

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
    opts.speech.say({
      text: phraseText('obstacle_ahead'),
      priority: 'INFO',
      cacheKey: 'obstacle_ahead',
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
