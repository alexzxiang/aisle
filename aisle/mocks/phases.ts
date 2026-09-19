/**
 * Jump-to-mode for the DebugPanel (05 Part 1 "Playback controls", 01 §1).
 *
 * A's store owns the mode, so a jump never calls setMode(): it emits the events that
 * legally lead to the target from IDLE, in order. Because the legal graph has one
 * entry per mode, the jump first returns the store to IDLE (the `* → IDLE` abort
 * edge, via the bridge), re-issues ITEM_REQUESTED so the task fields survive, and
 * then walks the path. `firstRun` must be false for IDLE → OUTDOOR_NAV on ROUTE_READY
 * (01 §1); the bridge clears it.
 */
import type { AppEvent, AppMode, EventBus } from '../src/core/contracts';
import type { ReplayPhase } from './track';

export interface JumpContext {
  item: string;
  destName: string;
  crossingId: string;
  street: string;
  bearingDeg: number;
  targetAisleId: string;
  targetSide: 'LEFT' | 'RIGHT';
}

export const DEFAULT_JUMP_CONTEXT: JumpContext = {
  item: 'eggs',
  destName: 'Demo Grocery',
  crossingId: 'crossing-forbes-01',
  street: 'Forbes',
  bearingDeg: 180,
  targetAisleId: 'a3',
  targetSide: 'RIGHT',
};

/** The legal event chain from IDLE (after ITEM_REQUESTED) to each phase. Pure. */
export function eventsForPhase(phase: ReplayPhase, ctx: JumpContext = DEFAULT_JUMP_CONTEXT): AppEvent[] {
  const routeReady: AppEvent = { type: 'ROUTE_READY', legCount: 4, destName: ctx.destName, crossingCount: 1 };
  const crossingAhead: AppEvent = {
    type: 'CROSSING_AHEAD', crossingId: ctx.crossingId, street: ctx.street, signalized: true,
    pushButtonLikely: false, bearingDeg: ctx.bearingDeg, distanceM: 25,
  };
  const curb: AppEvent = { type: 'CURB_REACHED', crossingId: ctx.crossingId };
  const started: AppEvent = { type: 'CROSSING_STARTED', crossingId: ctx.crossingId };
  const entered: AppEvent = { type: 'STORE_ENTERED', reason: 'MANUAL', confidence: 1 };
  const aisle: AppEvent = { type: 'TARGET_AISLE_REACHED', aisleId: ctx.targetAisleId, side: ctx.targetSide };
  const hand1: AppEvent = { type: 'ITEM_HAND_GUIDANCE', hint: 'higher', step: 1 };
  const handDone: AppEvent = { type: 'ITEM_HAND_GUIDANCE', hint: 'touching', step: 2 };
  switch (phase) {
    case 'OUTDOOR_NAV': return [routeReady];
    case 'APPROACH_CROSSING': return [routeReady, crossingAhead];
    case 'AT_CURB': return [routeReady, crossingAhead, curb];
    case 'CROSSING': return [routeReady, crossingAhead, curb, started];
    case 'TRANSITION': return [routeReady, entered];
    case 'INDOOR_NAV': return [routeReady, entered];          // + bridge.transitionEnded()
    case 'AT_ITEM': return [routeReady, entered, aisle];
    case 'ITEM_PICKUP': return [routeReady, entered, aisle, hand1];
    case 'CHECKOUT_NAV': return [routeReady, entered, aisle, handDone];
    default: return [];
  }
}

/** Phases that pass through TRANSITION and need the 3 s cap short-circuited. */
export const PHASES_PAST_TRANSITION: ReadonlySet<ReplayPhase> = new Set(['INDOOR_NAV', 'AT_ITEM', 'ITEM_PICKUP', 'CHECKOUT_NAV']);

/** The narrow slice of A's store the jump needs. `bridgeAppStore` adapts the real one. */
export interface MockStoreBridge {
  getMode(): AppMode;
  abort(): void;
  setFirstRun(v: boolean): void;
  transitionEnded(): void;
}

export interface JumpDeps {
  bus: Pick<EventBus, 'emit'>;
  store?: MockStoreBridge;
  ctx?: JumpContext;
}

/** Emit the chain. Returns the events emitted (for tests / the DebugPanel log). */
export function emitJumpEvents(phase: ReplayPhase, deps: JumpDeps): AppEvent[] {
  const ctx = deps.ctx ?? DEFAULT_JUMP_CONTEXT;
  const out: AppEvent[] = [];
  const emit = (e: AppEvent): void => {
    out.push(e);
    deps.bus.emit(e);
  };
  if (deps.store) {
    if (deps.store.getMode() !== 'IDLE') deps.store.abort();
    deps.store.setFirstRun(false);
  }
  emit({ type: 'ITEM_REQUESTED', item: ctx.item, source: 'mock' });
  for (const e of eventsForPhase(phase, ctx)) {
    emit(e);
    if (e.type === 'STORE_ENTERED' && PHASES_PAST_TRANSITION.has(phase)) deps.store?.transitionEnded();
  }
  return out;
}
