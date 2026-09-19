/**
 * Pure model behind mocks/debug/MockControls.tsx (05 Part 5): the option tables,
 * the events the overrides inject, and the formatting of the transition trace. No
 * React here so every branch is a plain Jest test.
 */
import type { AppEvent, Side, SignalState, TransitionSignals, VehiclesSeen } from '../../src/core/contracts';
import type { ReplayPhase } from '../track';
import { REPLAY_PHASES } from '../track';

export interface SignalOption {
  label: string;
  state: SignalState | null;   // null = RELEASE OVERRIDE
  fresh: boolean;
}

/** Rung 4 of the fallback ladder (05 Part 5), in display order. */
export const SIGNAL_OPTIONS: readonly SignalOption[] = [
  { label: 'WALK (fresh)', state: 'WALK', fresh: true },
  { label: 'WALK (already on)', state: 'WALK', fresh: false },
  { label: 'DONT_WALK', state: 'DONT_WALK', fresh: false },
  { label: 'COUNTDOWN', state: 'COUNTDOWN', fresh: false },
  { label: 'UNKNOWN', state: 'UNKNOWN', fresh: false },
  { label: 'RELEASE OVERRIDE', state: null, fresh: false },
];

export const SCAN_SIDES: readonly Side[] = ['LEFT', 'RIGHT'];
export const SCAN_RESULTS: readonly VehiclesSeen[] = ['none', 'distant', 'approaching', 'unclear'];

/** The event B's CrossingController would have emitted for the Claude result (01 §5). */
export function scanResultEvent(side: Side, vehiclesSeen: VehiclesSeen): AppEvent {
  return { type: 'SCAN_RESULT', side, vehiclesSeen, source: 'claude' };
}

/** The SIGNAL_STATE event a manual override maps to when no controller is wired (mock-mode last resort). */
export function signalStateEvent(o: SignalOption): AppEvent | null {
  if (o.state === null) return null;
  return { type: 'SIGNAL_STATE', state: o.state, fresh: o.fresh, confidence: 1 };
}

/** Jump targets, in state-machine order, with short labels for 64 pt buttons. */
export const JUMP_TARGETS: ReadonlyArray<{ phase: ReplayPhase; label: string }> = REPLAY_PHASES.map((phase) => ({
  phase,
  label: phase.replace(/_/g, ' '),
}));

export const SKIP_TO_AISLE_PHASE: ReplayPhase = 'INDOOR_NAV';

export function formatSeconds(s: number): string {
  const whole = Math.max(0, Math.floor(s));
  const m = Math.floor(whole / 60);
  const sec = whole % 60;
  return `${m}:${sec < 10 ? '0' : ''}${sec}`;
}

/** "distance 0.3 · accuracy 0.3 · steps 0 · storefront 0 = 0.6" */
export function formatTransitionSignals(s: TransitionSignals | null | undefined, confidence?: number): string {
  if (!s) return 'transition: not started';
  const sum = confidence ?? Math.round((s.distanceMinThenRise + s.accuracyStepUp + s.stepsSinceMin + s.storefrontFrame + s.ambientLight) * 1000) / 1000;
  const parts = [
    `dist ${s.distanceMinThenRise}`,
    `acc ${s.accuracyStepUp}`,
    `steps ${s.stepsSinceMin}`,
    `store ${s.storefrontFrame}`,
  ];
  if (s.ambientLight) parts.push(`light ${s.ambientLight}`);
  return `${parts.join(' · ')} = ${sum}${sum >= 0.6 ? ' FIRE' : ''}`;
}

export function speedLabel(speed: number): string {
  return `${speed}×`;
}

export function networkLabel(online: boolean): string {
  return online ? 'NETWORK: ON' : 'NETWORK: OFF';
}

export function playLabel(playing: boolean): string {
  return playing ? 'PAUSE' : 'PLAY';
}
