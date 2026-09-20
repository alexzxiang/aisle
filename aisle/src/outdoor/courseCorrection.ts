import type { SpeechRequest } from '../core/contracts';
import { angularError } from './legs';

export interface CorrectionState {
  direction: 'left' | 'right' | 'around' | null;
  since: number;
  lastAt: number;
  count: number;
  lastSpokenAt: number;
}

export function initialCorrection(): CorrectionState {
  return { direction: null, since: 0, lastAt: 0, count: 0, lastSpokenAt: -Infinity };
}

/** Orientation only: never directs a shortcut back across an unknown roadside. */
export function stepCorrection(state: CorrectionState, heading: number, bearing: number, at: number): { state: CorrectionState; request: SpeechRequest | null } {
  const error = angularError(heading, bearing);
  const direction = Math.abs(error) < 35 ? null : Math.abs(error) >= 140 ? 'around' : error > 0 ? 'right' : 'left';
  if (!direction || !Number.isFinite(heading) || !Number.isFinite(bearing)) {
    return { state: { ...initialCorrection(), lastSpokenAt: state.lastSpokenAt }, request: null };
  }
  if (at <= state.lastAt) return { state, request: null };
  const continuous = direction === state.direction && at - state.lastAt <= 5000;
  const next: CorrectionState = { ...state, direction, lastAt: at, since: continuous ? state.since : at, count: continuous ? state.count + 1 : 1 };
  if (next.count < 3 || at - next.since < 2000 || at - state.lastSpokenAt < 12000) return { state: next, request: null };
  return {
    state: { ...next, lastSpokenAt: at },
    request: { text: direction === 'around' ? 'Pause. Turn around to face the route.' : `Bear ${direction} to follow the route.`, priority: 'NAV', dedupeKey: 'route-course-correction', cooldownMs: 12000 },
  };
}
