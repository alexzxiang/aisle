/**
 * Pure decisions behind the CrossingController (03 Task 6): the signal phrase
 * table with the fresh-vs-stale onset rule, the scan verdict matrix and its
 * exact phrase sequences, and the curb / crossing-started / far-curb detectors.
 *
 * Every phrase here is a 01 §3 cache key. The controller informs; it never
 * decides a crossing, and nothing in this file can produce a walk cue from map
 * data — only a `SIGNAL_STATE` event (or a teammate's manual override) does.
 */
import type { CacheKey, GeoFix, Pose, SignalState, Side, VehiclesSeen } from '../core/contracts';
import { haversineM, projectOntoSegment, type LatLng } from '../outdoor/geo';

export type ControllerState = 'IDLE' | 'ARMED' | 'ALIGNING' | 'READING' | 'SCANNING' | 'CROSSING' | 'DONE';

// ---------------------------------------------------------------------------
// Signal phrases
// ---------------------------------------------------------------------------

export const UNKNOWN_TIMEOUT_MS = 10_000;

export interface SignalTrack {
  /** Last state applied (UNKNOWN included) — a phrase fires on change only. */
  lastState: SignalState | null;
  /** Start of the current UNKNOWN run (or arming time), null while a state is known. */
  unknownSince: number | null;
  cantSeeSaid: boolean;
}

export function initialSignalTrack(armedAt: number): SignalTrack {
  return { lastState: null, unknownSince: armedAt, cantSeeSaid: false };
}

export interface SignalDecision {
  track: SignalTrack;
  /** The phrase to speak now, or null for silence. */
  key: CacheKey | null;
  /** True the moment `cant_see_signal` fires: the caller enters the fallback ladder. */
  enterLadder: boolean;
}

/**
 * The phrase table (03 Task 6 READING). WALK is spoken only on `fresh: true`;
 * a stale WALK says `walk_already_on_wait` and never `walk_signal_on`.
 * `UNKNOWN` is silence — unless it has lasted 10 s, once, `cant_see_signal`.
 */
export function decideSignalPhrase(track: SignalTrack, e: { state: SignalState; fresh: boolean }, now: number): SignalDecision {
  if (e.state === 'UNKNOWN') {
    const since = track.unknownSince ?? now;
    const next: SignalTrack = { ...track, lastState: 'UNKNOWN', unknownSince: since };
    if (!track.cantSeeSaid && now - since >= UNKNOWN_TIMEOUT_MS) {
      return { track: { ...next, cantSeeSaid: true }, key: 'cant_see_signal', enterLadder: true };
    }
    return { track: next, key: null, enterLadder: false };
  }
  const changed = track.lastState !== e.state;
  const next: SignalTrack = { lastState: e.state, unknownSince: null, cantSeeSaid: false };
  if (!changed) return { track: next, key: null, enterLadder: false };
  switch (e.state) {
    case 'WALK':
      return { track: next, key: e.fresh ? 'walk_signal_on' : 'walk_already_on_wait', enterLadder: false };
    case 'DONT_WALK':
      return { track: next, key: 'dont_walk', enterLadder: false };
    case 'COUNTDOWN':
      return { track: next, key: 'countdown', enterLadder: false };
    default:
      return { track: next, key: null, enterLadder: false };
  }
}

/** Has UNKNOWN lasted long enough to speak `cant_see_signal` with no new event? (timer path) */
export function unknownTimedOut(track: SignalTrack, now: number): boolean {
  return !track.cantSeeSaid && track.unknownSince !== null && now - track.unknownSince >= UNKNOWN_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
// Scan verdicts
// ---------------------------------------------------------------------------

const VERDICT_RANK: Record<VehiclesSeen, number> = { none: 0, distant: 0, approaching: 3, unclear: 2 };

/** `approaching` > `unclear` > `distant` = `none`. */
export function worstVerdict(a: VehiclesSeen | null, b: VehiclesSeen | null): VehiclesSeen {
  if (a === null && b === null) return 'unclear';
  if (a === null) return b as VehiclesSeen;
  if (b === null) return a;
  return VERDICT_RANK[b] > VERDICT_RANK[a] ? b : a;
}

function sideLine(side: Side, v: VehiclesSeen): CacheKey {
  if (v === 'approaching') return side === 'LEFT' ? 'vehicle_approaching_left' : 'vehicle_approaching_right';
  if (v === 'unclear') return side === 'LEFT' ? 'cant_see_well_left' : 'cant_see_well_right';
  return side === 'LEFT' ? 'no_vehicles_left' : 'no_vehicles_right';
}

/**
 * The report (03 Task 6 step 5). States what was perceived; never grants permission.
 * - both none/distant → left line, right line, `listen_then_cross`
 * - any approaching   → that side first, then the other side's line; no `listen_then_cross`
 * - any unclear       → that side first, then the other side's line; no `listen_then_cross`
 */
export function scanReportKeys(left: VehiclesSeen, right: VehiclesSeen): CacheKey[] {
  const l = VERDICT_RANK[left];
  const r = VERDICT_RANK[right];
  if (l === 0 && r === 0) return ['no_vehicles_left', 'no_vehicles_right', 'listen_then_cross'];
  // Worse side first; ties keep left first.
  const first: Side = r > l ? 'RIGHT' : 'LEFT';
  const second: Side = first === 'LEFT' ? 'RIGHT' : 'LEFT';
  const verdictOf = (s: Side): VehiclesSeen => (s === 'LEFT' ? left : right);
  return [sideLine(first, verdictOf(first)), sideLine(second, verdictOf(second))];
}

// ---------------------------------------------------------------------------
// Curb, crossing start, far curb
// ---------------------------------------------------------------------------

export const CURB_RADIUS_M = 12;
export const CURB_STOP_SPEED_MPS = 0.3;
export const CURB_STILL_MS = 2000;
export const WALKED_PAST_M = 10;
export const START_STEPS = 4;
export const START_DISPLACEMENT_M = 1.5;
export const FAR_CURB_GPS_RADIUS_M = 8;
export const FAR_CURB_GPS_ACCURACY_M = 15;
export const STRIDE_M = 0.7;
export const SCAN_HEADING_TOLERANCE_DEG = 30;
/** The no-pose step rule is suppressed while the user faces further than this off the crossing bearing. */
export const START_HEADING_OFF_MAX_DEG = 45;

export interface StillnessTrack {
  /** When the user was last seen moving (speed ≥ 0.3 m/s or a step). */
  lastMovingAt: number;
  /** First still observation after the last movement; null while moving. */
  stillSince: number | null;
}

export function initialStillness(now: number): StillnessTrack {
  return { lastMovingAt: now, stillSince: null };
}

/** A fix updates the stillness track: a null speed counts as "not moving". */
export function noteFixMotion(track: StillnessTrack, fix: Pick<GeoFix, 'speedMps'>, now: number): StillnessTrack {
  if (fix.speedMps !== null && fix.speedMps >= CURB_STOP_SPEED_MPS) return { lastMovingAt: now, stillSince: null };
  return { lastMovingAt: track.lastMovingAt, stillSince: track.stillSince ?? now };
}

export function noteStep(_track: StillnessTrack, now: number): StillnessTrack {
  return { lastMovingAt: now, stillSince: null };
}

/** Milliseconds of observed stillness (0 while moving or before any still observation). */
export function stillForMs(track: StillnessTrack, now: number): number {
  return track.stillSince === null ? 0 : Math.max(0, now - track.stillSince);
}

/**
 * The cane finds the curb; we detect the stop: within 12 m of the near curb
 * and still (no speed / no step) for 2 s.
 */
export function isStoppedAtCurb(input: { distToNearCurbM: number; stillForMs: number }): boolean {
  return input.distToNearCurbM <= CURB_RADIUS_M && input.stillForMs >= CURB_STILL_MS;
}

/** Along-track position on the crossing line (0 at the near curb), unclamped. */
export function alongCrossingM(p: LatLng, nearCurb: LatLng, farCurb: LatLng): number {
  return projectOntoSegment(p, nearCurb, farCurb).alongRawM;
}

/** Walked straight past: more than 10 m beyond the far curb with no stop. */
export function walkedPast(p: LatLng, nearCurb: LatLng, farCurb: LatLng): boolean {
  const len = haversineM(nearCurb, farCurb);
  return alongCrossingM(p, nearCurb, farCurb) > len + WALKED_PAST_M;
}

/**
 * ARKit displacement along a bearing. World frame is `gravityAndHeading`:
 * x = east, y = up, z = south (−z = north).
 */
export function poseDisplacementAlongM(from: Pick<Pose, 'x' | 'z'>, to: Pick<Pose, 'x' | 'z'>, bearingDeg: number): number {
  const east = to.x - from.x;
  const north = -(to.z - from.z);
  const θ = (bearingDeg * Math.PI) / 180;
  return east * Math.sin(θ) + north * Math.cos(θ);
}

export interface CrossingStartInput {
  /** Steps since the curb — or since the last suppression window closed (the caller re-bases). */
  stepsSinceCurb: number;
  /** ARKit displacement along the crossing bearing; null unless pose tracking is NORMAL. */
  displacementM: number | null;
  /** A left/right scan window is open: turning in place registers pedometer shuffles. */
  scanInProgress?: boolean;
  /** |heading − crossing bearing| in degrees; null / undefined when no heading is available. */
  headingOffDeg?: number | null;
}

/**
 * The user decided to step off. With pose tracking NORMAL the only evidence is
 * > 1.5 m of displacement *along the bearing* — direction-aware, so a turn in
 * place or a step back from the curb never counts. Without a pose, ≥ 4 steps is
 * the fallback, and it is suppressed while a scan window is open and while the
 * user faces more than 45° off the crossing bearing (walking away, scanning).
 */
export function crossingStarted(input: CrossingStartInput): boolean {
  if (input.displacementM !== null) return input.displacementM > START_DISPLACEMENT_M;
  if (input.scanInProgress) return false;
  if (input.headingOffDeg !== null && input.headingOffDeg !== undefined && Math.abs(input.headingOffDeg) > START_HEADING_OFF_MAX_DEG) return false;
  return input.stepsSinceCurb >= START_STEPS;
}

export interface FarCurbInput {
  lengthM: number;
  displacementM: number | null;
  /** Consecutive counting fixes within 8 m of the far curb with accuracy ≤ 15 m. */
  goodFixesNearFar: number;
  stepsSinceCurb: number;
}

/**
 * Far curb: pose displacement ≥ length − 1 m, or two good fixes within 8 m of
 * the far curb, or steps × 0.7 m ≥ length + 2 m as the last resort.
 */
export function farCurbReached(input: FarCurbInput): boolean {
  if (input.displacementM !== null && input.displacementM >= input.lengthM - 1) return true;
  if (input.goodFixesNearFar >= 2) return true;
  return input.stepsSinceCurb * STRIDE_M >= input.lengthM + 2;
}

/** Does a fix count toward the far-curb GPS rule? */
export function fixNearFarCurb(fix: GeoFix, farCurb: LatLng): boolean {
  return fix.accuracyM <= FAR_CURB_GPS_ACCURACY_M && haversineM({ lat: fix.lat, lng: fix.lng }, farCurb) <= FAR_CURB_GPS_RADIUS_M;
}

/** Bearing the camera must face for a scan side: left = bearing − 90, right = bearing + 90. */
export function scanBearingFor(bearingDeg: number, side: Side): number {
  const b = side === 'LEFT' ? bearingDeg - 90 : bearingDeg + 90;
  return ((b % 360) + 360) % 360;
}
