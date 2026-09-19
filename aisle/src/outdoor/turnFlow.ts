/**
 * Turn flow (03 Task 5): spoken, then felt. A pure reducer.
 *
 *   ≤ 20 m before the maneuver   → say `soon`
 *   at the maneuver point         → say `now` → TURN → re-target COURSE to the next leg
 *   heading enters the dead zone  → (A's service plays the one CONFIRM) → say next `confirm`
 *
 * STRAIGHT maneuvers get no `now` and no TURN: the reference simply updates
 * and the next `confirm` is spoken at once. There is no hot/cold ramp anywhere.
 *
 * The reducer knows nothing about services: it returns actions the LegRunner
 * executes synchronously, in order.
 */
import type { CompassAccuracy, RouteCompileOutput, SpeechRequest } from '../core/contracts';
import { SOON_TRIGGER_M, legConfirmRequest, legNowRequest, legSoonRequest, routeWarningRequest } from './guidance';
import { angularError } from './legs';
import type { RouteLeg } from './types';

export const ALIGN_TIMEOUT_MS = 8000;
export const ALIGN_STABLE_MS = 1000;
export const DEAD_ZONE_ACC3_DEG = 12;
export const DEAD_ZONE_ACC2_DEG = 18;

export type TurnPhase = 'WALKING' | 'ALIGNING';

export interface TurnFlowState {
  legIndex: number;
  phase: TurnPhase;
  soonSaid: boolean;
  /** When TURN fired; after eight seconds ask for help without confirming alignment. */
  turnedAt: number | null;
  confirmSaid: boolean;
  alignedSince: number | null;
  lastHeadingAt: number | null;
  alignmentHelpSaid: boolean;
}

export type TurnAction =
  | { kind: 'SAY'; req: SpeechRequest }
  | { kind: 'TURN' }
  | { kind: 'RETARGET'; legIndex: number };

export type TurnEvent =
  | { type: 'ROUTE_READY'; warning: string | null }
  | { type: 'PROGRESS'; remainingM: number }
  | { type: 'ADVANCED'; toLegIndex: number; now: number }
  | { type: 'HEADING'; headingDeg: number; accuracy: CompassAccuracy; now: number }
  | { type: 'TICK'; now: number }
  | { type: 'REPLANNED' };

export function initialTurnFlow(legIndex = 0): TurnFlowState {
  return { legIndex, phase: 'WALKING', soonSaid: false, turnedAt: null, confirmSaid: false, alignedSince: null, lastHeadingAt: null, alignmentHelpSaid: false };
}

export function isTurnManeuver(leg: RouteLeg | undefined): boolean {
  return !!leg && leg.maneuver !== 'STRAIGHT' && leg.maneuver !== 'ARRIVE';
}

/** Dead zone for the compass tier; null when the compass is too poor to judge alignment. */
export function deadZoneFor(accuracy: CompassAccuracy): number | null {
  if (accuracy === 3) return DEAD_ZONE_ACC3_DEG;
  if (accuracy === 2) return DEAD_ZONE_ACC2_DEG;
  return null;
}

export function stepTurnFlow(
  state: TurnFlowState,
  event: TurnEvent,
  legs: readonly RouteLeg[],
  script: RouteCompileOutput | null | undefined,
): { state: TurnFlowState; actions: TurnAction[] } {
  const actions: TurnAction[] = [];
  const leg = legs[state.legIndex];

  switch (event.type) {
    case 'ROUTE_READY':
    case 'REPLANNED': {
      const next = initialTurnFlow(state.legIndex);
      if (event.type === 'ROUTE_READY' && event.warning) actions.push({ kind: 'SAY', req: routeWarningRequest(event.warning) });
      actions.push({ kind: 'RETARGET', legIndex: state.legIndex });
      if (leg) {
        const confirm = legConfirmRequest(leg, script);
        if (confirm) actions.push({ kind: 'SAY', req: confirm });
      }
      return { state: { ...next, confirmSaid: true }, actions };
    }

    case 'PROGRESS': {
      if (!leg || state.soonSaid || !isTurnManeuver(leg)) return { state, actions };
      if (event.remainingM > SOON_TRIGGER_M) return { state, actions };
      const soon = legSoonRequest(leg, script);
      if (soon) actions.push({ kind: 'SAY', req: soon });
      return { state: { ...state, soonSaid: true }, actions };
    }

    case 'ADVANCED': {
      const from = leg;
      const to = legs[event.toLegIndex];
      const turning = isTurnManeuver(from);
      if (from && turning) {
        const now = legNowRequest(from, script);
        if (now) actions.push({ kind: 'SAY', req: now });
        actions.push({ kind: 'TURN' });
      }
      actions.push({ kind: 'RETARGET', legIndex: event.toLegIndex });
      if (!to) return { state: initialTurnFlow(event.toLegIndex), actions };
      if (!turning) {
        const confirm = legConfirmRequest(to, script);
        if (confirm) actions.push({ kind: 'SAY', req: confirm });
        return { state: { ...initialTurnFlow(event.toLegIndex), confirmSaid: true }, actions };
      }
      return { state: { ...initialTurnFlow(event.toLegIndex), phase: 'ALIGNING', turnedAt: event.now }, actions };
    }

    case 'HEADING': {
      if (state.phase !== 'ALIGNING' || !leg) return { state, actions };
      const zone = deadZoneFor(event.accuracy);
      const aligned = zone !== null && Number.isFinite(event.headingDeg)
        && Math.abs(angularError(event.headingDeg, leg.startBearingDeg)) <= zone;
      const continuous = state.lastHeadingAt !== null && event.now > state.lastHeadingAt && event.now - state.lastHeadingAt <= 2000;
      const alignedSince = aligned ? (continuous ? state.alignedSince ?? event.now : event.now) : null;
      if (alignedSince !== null && event.now - alignedSince >= ALIGN_STABLE_MS) {
        return finishAlignment({ ...state, alignedSince }, leg, script, actions);
      }
      return alignmentHelp({ ...state, alignedSince, lastHeadingAt: event.now }, event.now, actions);
    }

    case 'TICK': {
      if (state.phase !== 'ALIGNING' || !leg) return { state, actions };
      return alignmentHelp(state, event.now, actions);
    }

    default:
      return { state, actions };
  }
}

function finishAlignment(
  state: TurnFlowState,
  leg: RouteLeg,
  script: RouteCompileOutput | null | undefined,
  actions: TurnAction[],
): { state: TurnFlowState; actions: TurnAction[] } {
  const confirm = legConfirmRequest(leg, script);
  if (confirm && !state.confirmSaid) actions.push({ kind: 'SAY', req: confirm });
  return { state: { ...state, phase: 'WALKING', turnedAt: null, confirmSaid: true }, actions };
}

/** A timeout asks for a stable heading; it cannot prove a turn completed. */
function alignmentHelp(state: TurnFlowState, now: number, actions: TurnAction[]): { state: TurnFlowState; actions: TurnAction[] } {
  if (!state.alignmentHelpSaid && state.turnedAt !== null && now - state.turnedAt >= ALIGN_TIMEOUT_MS) {
    actions.push({ kind: 'SAY', req: { text: 'Pause. Hold the phone steady to check your direction.', priority: 'NAV', dedupeKey: `alignment-${state.legIndex}`, cooldownMs: 8000 } });
    return { state: { ...state, alignmentHelpSaid: true }, actions };
  }
  return { state, actions };
}
