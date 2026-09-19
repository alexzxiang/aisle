/**
 * fixtures/track.json shape (05 Part 1 plus D's `meta` and `phases` extensions).
 */
import type { AppMode, CompassAccuracy, Crossing } from '../src/core/contracts';

export interface TrackSample {
  t: number;                     // seconds from track start
  lat: number;
  lng: number;
  accuracyM: number;
  courseDeg: number | null;
  speedMps: number | null;
  heading: { trueHeadingDeg: number; accuracy: CompassAccuracy };
  steps: number;                 // cumulative since track start
}

/** Modes a DebugPanel jump can target (01 §1 minus IDLE/ONBOARDING/DONE, which are not seek targets). */
export type ReplayPhase =
  | 'OUTDOOR_NAV' | 'APPROACH_CROSSING' | 'AT_CURB' | 'CROSSING' | 'TRANSITION'
  | 'INDOOR_NAV' | 'AT_ITEM' | 'ITEM_PICKUP' | 'CHECKOUT_NAV';

export const REPLAY_PHASES: readonly ReplayPhase[] = [
  'OUTDOOR_NAV', 'APPROACH_CROSSING', 'AT_CURB', 'CROSSING', 'TRANSITION',
  'INDOOR_NAV', 'AT_ITEM', 'ITEM_PICKUP', 'CHECKOUT_NAV',
];

export function isReplayPhase(m: AppMode | string): m is ReplayPhase {
  return (REPLAY_PHASES as readonly string[]).includes(m);
}

export interface PhaseSpec {
  t: number;              // track second to seek to
  pack: string;           // perception pack to arm
  packOffsetMs: number;   // offset into that pack
}

export interface TrackMeta {
  synthetic?: boolean;
  entrance: { lat: number; lng: number; radiusM: number };
  door: { t: number };
  /** The accuracy step after the door (iOS holds 5–10 m, then snaps to ~65 m). */
  accuracySnap?: { t: number; accuracyM: number };
  /** One urban-canyon fix that must not advance a leg. */
  canyonJump?: { t: number; accuracyM: number; offLineM: number };
  /** Compass tier-2 stretch (dead zone 18°). */
  compassAccuracy2?: { fromT: number; toT: number };
  curb?: { arriveT: number; dwellS: number; alignedFromT: number };
  crossing: Crossing;
  legs?: Array<{ index: number; from: { lat: number; lng: number }; to: { lat: number; lng: number }; bearingDeg: number; distanceM: number; roadSide: 'LEFT' | 'RIGHT' | 'NONE' }>;
  [k: string]: unknown;
}

export interface TrackFixture {
  hz: number;
  meta?: TrackMeta;
  phases?: Partial<Record<ReplayPhase, PhaseSpec>>;
  samples: TrackSample[];
}

/** Runtime guard for a JSON import (Metro gives `any`-ish shapes; keep the check cheap). */
export function asTrackFixture(x: unknown): TrackFixture {
  const o = x as TrackFixture;
  if (!o || !Array.isArray(o.samples) || typeof o.hz !== 'number') {
    throw new Error('[mock] track fixture missing hz/samples');
  }
  return o;
}

export function trackDurationS(track: TrackFixture): number {
  const last = track.samples[track.samples.length - 1];
  return last ? last.t : 0;
}

/** Index of the last sample with t ≤ seconds (−1 when before the first). */
export function sampleIndexAt(track: TrackFixture, seconds: number): number {
  const s = track.samples;
  let lo = 0;
  let hi = s.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (s[mid]!.t <= seconds) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}
