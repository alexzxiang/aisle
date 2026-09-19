/**
 * Pure mode → profile and reflex decisions for the PerceptionService (04 Task 1).
 *
 * Nothing here touches a service: `PerceptionService.ts` calls these and does the
 * side effects. Keeping the decisions pure is what lets the reflex rules be unit
 * tested against 01 §3's mode policy without a native module.
 */
import type {
  AppMode,
  CacheKey,
  DepthSummary,
  Direction,
  DistanceClass,
  ModeProfile,
} from '../core/contracts';

/**
 * 01 §7: AT_CURB uses the APPROACH_CROSSING profile; TRANSITION uses OUTDOOR_NAV;
 * AT_ITEM / CHECKOUT_NAV use INDOOR_NAV. ONBOARDING and DONE need no camera, so
 * they pause the session (09 §3 "session paused").
 *
 * IDLE runs the AWARE schedule (round 6c: detector 8 fps, depth 4, OCR 1, scene 2)
 * since the awareness loop (situate.ts): the app looks at the room from the
 * moment it opens, so it can say where it thinks the user is and ask, at rates
 * a phone can hold all day. The obstacle reflex is off in IDLE
 * (`obstacleReflexFor`): a phone held at rest must not shout "Obstacle ahead".
 */
export const PROFILE_FOR_MODE: Readonly<Record<AppMode, ModeProfile>> = Object.freeze({
  IDLE: 'AWARE',
  ONBOARDING: 'IDLE',
  OUTDOOR_NAV: 'OUTDOOR_NAV',
  APPROACH_CROSSING: 'APPROACH_CROSSING',
  AT_CURB: 'APPROACH_CROSSING',
  CROSSING: 'CROSSING',
  TRANSITION: 'OUTDOOR_NAV',
  INDOOR_NAV: 'INDOOR_NAV',
  AT_ITEM: 'INDOOR_NAV',
  ITEM_PICKUP: 'ITEM_PICKUP',
  CHECKOUT_NAV: 'INDOOR_NAV',
  DONE: 'IDLE',
  GUIDED_TASK: 'INDOOR_NAV',   // guided steps anywhere: detector + depth + OCR, no signal model
});

export function profileForMode(mode: AppMode): ModeProfile {
  return PROFILE_FOR_MODE[mode];
}

/** Profiles in which 01 §3 permits an obstacle phrase (04 Task 1 / Task 7). */
export const INDOOR_PROFILES: ReadonlySet<ModeProfile> = new Set<ModeProfile>(['INDOOR_NAV', 'ITEM_PICKUP', 'AWARE']);
/** Profiles in which the vehicle pipeline runs (09 §5.2). */
export const VEHICLE_PROFILES: ReadonlySet<ModeProfile> = new Set<ModeProfile>(['OUTDOOR_NAV', 'APPROACH_CROSSING', 'CROSSING']);

export function isIndoorProfile(p: ModeProfile): boolean {
  return INDOOR_PROFILES.has(p);
}

/** 04 Task 1: the vehicle reflex speaks exactly one of these cached phrases. */
export const VEHICLE_CACHE_KEY: Readonly<Record<Direction, CacheKey>> = Object.freeze({
  LEFT: 'vehicle_left',
  CENTER: 'vehicle_ahead',
  RIGHT: 'vehicle_right',
});

export function vehicleCacheKey(direction: Direction): CacheKey {
  return VEHICLE_CACHE_KEY[direction];
}

/** Mirrors the module's 4 s per-track cooldown (01 §7); carried on the speech request too. */
export const VEHICLE_SPEECH_COOLDOWN_MS = 4000;

export type ObstacleReflex = 'STOP_ONLY' | 'STOP_AND_SPEAK' | 'NONE';

/**
 * 04 Task 1: NEAR + positive closing rate → STOP. The phrase is added only where
 * 01 §3's mode policy would not drop it (the indoor profiles). Everything that is
 * not NEAR-and-closing is INFO territory, handled by `src/indoor/obstacles.ts`.
 *
 * `closingRate` comes from the last `onDepth` summary because the obstacle event
 * itself carries no rate; with no depth summary yet nothing is "closing".
 */
/** Modes where a NEAR obstacle means nothing: the user is not walking under guidance. */
const OBSTACLE_QUIET_MODES: ReadonlySet<AppMode> = new Set<AppMode>(['IDLE', 'ONBOARDING', 'DONE']);

export function obstacleReflexFor(
  profile: ModeProfile,
  e: { distanceClass: DistanceClass },
  lastDepth: Pick<DepthSummary, 'closingRate'> | null,
  mode?: AppMode,
): ObstacleReflex {
  if (profile === 'IDLE') return 'NONE';
  if (mode !== undefined && OBSTACLE_QUIET_MODES.has(mode)) return 'NONE';
  if (e.distanceClass !== 'NEAR') return 'NONE';
  if (!lastDepth || !(lastDepth.closingRate > 0)) return 'NONE';
  if (mode === 'GUIDED_TASK' && lastDepth.closingRate <= 0.05) return 'NONE';
  return isIndoorProfile(profile) ? 'STOP_AND_SPEAK' : 'STOP_ONLY';
}
