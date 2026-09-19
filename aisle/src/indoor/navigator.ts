/**
 * Indoor navigator (04 Task 4, Task 10): ordered-aisle logic, no SLAM.
 *
 * The store is an ordered list of aisles; the camera answers "which sign am I
 * looking at"; navigation is comparing the current aisle's `order` to the
 * target's. This module is a pure state machine: reads and clock ticks go in,
 * a list of `NavAction`s comes out, and `indoorController.ts` performs them.
 * Every edge case in 04 Task 4 has a test in `navigator.test.ts`.
 *
 * State:
 *   currentOrder   null until the first confident read
 *   direction      travel direction, set from the first *two* reads, never assumed;
 *                  flipped by a pair of reads going the other way
 *   target         from storeResolver (null → announce aisles, never an arrival)
 *   lastReadAt / stepsAtLastRead   for the pedometer prior (Task 5)
 */
import type { AppEvent, CacheKey, HapticPattern, Side, SpeechPriority } from '../core/contracts';
import { phraseText } from '../core/phrases';
import { estimateOrder, nextSignDue, overshot, type TravelDirection } from './pedometerPrior';
import { PLAUSIBLE_ORDER_SPAN } from './ocrMatcher';
import { CHECKOUT_LANDMARK_ID } from './storeMap';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NavigatorTarget {
  aisleId: string;
  order: number;
  spokenLabel: string;
  /** Spoken item name (already words), or null when the aisle came from `disambiguate`. */
  item: string | null;
  /** null when the item was not in `itemIndex` (side unknown → say the aisle only). */
  sideWhenAscending: Side | null;
}

export type NavPhase = 'AISLE' | 'CHECKOUT';

export type NavAction =
  | {
      kind: 'say';
      priority: SpeechPriority;
      cacheKey?: CacheKey;
      text?: string;
      dedupeKey?: string;
      cooldownMs?: number;
    }
  | { kind: 'emit'; event: AppEvent }
  | { kind: 'haptic'; pattern: HapticPattern }
  /** Re-anchor `perception.setCourseReference` at the current heading (Task 6). */
  | { kind: 'anchorCourse' };

export interface NavigatorState {
  phase: NavPhase;
  currentOrder: number | null;
  currentAisleId: string | null;
  direction: TravelDirection | null;
  target: NavigatorTarget | null;
  checkoutOrder: number | null;
  lastReadAt: number | null;
  stepsAtLastRead: number;
  arrived: boolean;
  checkoutReached: boolean;
  estimatedOrder: number | null;
}

export interface IdentifiedSign {
  id: string;
  kind: 'aisle' | 'landmark';
  order: number;
  spokenLabel: string;
  confidence: number;
  source: 'ocr' | 'claude';
  label: string;
}

export interface NavigatorOptions {
  now?: () => number;
  /** Steps since app start (SensorService.subscribeSteps value); default 0. */
  getSteps?: () => number;
  aislePitchM?: number;
  checkoutOrder?: number | null;
}

export interface Navigator {
  setTarget(t: NavigatorTarget | null): void;
  setPhase(phase: NavPhase): void;
  onSignIdentified(sign: IdentifiedSign): NavAction[];
  /** Time-based prompts; call at ~1 Hz. */
  tick(): NavAction[];
  /** From obstacles.ts: the end-of-aisle wall is close; a cross-aisle turn is expected. */
  onWallAhead(): void;
  /** Matcher hook: |order − current| ≤ 2, or current unknown. */
  isPlausible(order: number): boolean;
  getState(): NavigatorState;
  reset(): void;
}

// ---------------------------------------------------------------------------
// Constants (04 Task 4)
// ---------------------------------------------------------------------------

export const SAME_SIGN_DEDUPE_MS = 10_000;
export const UNKNOWN_KEEP_GOING_MS = 15_000;
export const SILENCE_INFO_MS = 20_000;
export const SILENCE_CAMERA_MS = 40_000;
export const KEEP_GOING_COOLDOWN_MS = 8000;
export const ARRIVAL_DEDUPE_KEY = 'aisle-arrival';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function invertSide(side: Side): Side {
  return side === 'LEFT' ? 'RIGHT' : 'LEFT';
}

/** The side to speak: `sideWhenAscending`, inverted when travelling DESC; null when unknown. */
export function sideFor(target: NavigatorTarget, direction: TravelDirection | null): Side | null {
  if (target.sideWhenAscending === null || direction === null) return null;
  return direction === 'ASC' ? target.sideWhenAscending : invertSide(target.sideWhenAscending);
}

/** `"Aisle three. Eggs on your right."` — the one arrival template (01 §6). */
export function arrivalText(target: NavigatorTarget, side: Side | null): string {
  const label = target.spokenLabel.replace(/\.+$/, '');
  if (!side || !target.item) return `${label}.`;
  const item = target.item.trim();
  const cased = item.charAt(0).toUpperCase() + item.slice(1);
  return `${label}. ${cased} on your ${side.toLowerCase()}.`;
}

/** Is the target behind a user travelling `direction` from `currentOrder`? */
export function targetBehind(currentOrder: number, targetOrder: number, direction: TravelDirection | null): boolean {
  if (direction === null) return false;
  return direction === 'ASC' ? currentOrder > targetOrder : currentOrder < targetOrder;
}

/** A `say` action for a cached phrase; the text is A's canonical wording for the key. */
export function cachedSay(cacheKey: CacheKey, priority: SpeechPriority, dedupeKey: string, cooldownMs: number): NavAction {
  return { kind: 'say', priority, cacheKey, text: phraseText(cacheKey), dedupeKey, cooldownMs };
}

// ---------------------------------------------------------------------------
// Navigator
// ---------------------------------------------------------------------------

export function createNavigator(opts: NavigatorOptions = {}): Navigator {
  const now = opts.now ?? Date.now;
  const getSteps = opts.getSteps ?? (() => 0);

  let phase: NavPhase = 'AISLE';
  let currentOrder: number | null = null;
  let currentAisleId: string | null = null;
  let direction: TravelDirection | null = null;
  let target: NavigatorTarget | null = null;
  let checkoutOrder: number | null = opts.checkoutOrder ?? null;
  let lastReadAt: number | null = null;
  let stepsAtLastRead = 0;
  let arrived = false;
  let checkoutReached = false;

  const startedAt = now();
  let lastSeen = new Map<string, number>();
  let lastSignId: string | null = null;
  let lastKeepGoingAt = -Infinity;
  let lastUnknownPromptAt = -Infinity;
  let silenceInfoSaid = false;
  let silenceCameraSaid = false;
  let passedItSaidFor: string | null = null;   // direction key it was said under
  let overshootSaid = false;
  let wallAheadAt: number | null = null;

  const activeOrder = (): number | null => (phase === 'CHECKOUT' ? checkoutOrder : target ? target.order : null);

  const estimated = (): number | null => {
    if (currentOrder === null) return null;
    return estimateOrder({
      currentOrder,
      direction,
      stepsSinceRead: Math.max(0, getSteps() - stepsAtLastRead),
      aislePitchM: opts.aislePitchM,
    });
  };

  const keepGoing = (priority: SpeechPriority, t: number, dedupe = 'keep_going'): NavAction[] => {
    if (t - lastKeepGoingAt < KEEP_GOING_COOLDOWN_MS) return [];
    lastKeepGoingAt = t;
    return [cachedSay('keep_going', priority, dedupe, KEEP_GOING_COOLDOWN_MS)];
  };

  const passedIt = (): NavAction[] => {
    // Once per direction episode: a second sign in the same wrong direction stays silent
    // rather than nagging; the flip (or a new target) re-arms it.
    const key = direction ?? '?';
    if (passedItSaidFor === key) return [];
    passedItSaidFor = key;
    return [cachedSay('passed_it_turn_around', 'NAV', 'passed_it', KEEP_GOING_COOLDOWN_MS)];
  };

  const arrive = (t: NavigatorTarget): NavAction[] => {
    arrived = true;
    const side = sideFor(t, direction);
    const actions: NavAction[] = [
      { kind: 'emit', event: { type: 'TARGET_AISLE_REACHED', aisleId: t.aisleId, side: side ?? t.sideWhenAscending ?? 'RIGHT' } },
      { kind: 'haptic', pattern: 'CONFIRM' },
      { kind: 'say', priority: 'NAV', text: arrivalText(t, side), dedupeKey: ARRIVAL_DEDUPE_KEY, cooldownMs: 30_000 },
    ];
    return actions;
  };

  const reachCheckout = (): NavAction[] => {
    checkoutReached = true;
    return [
      { kind: 'emit', event: { type: 'CHECKOUT_REACHED' } },
      { kind: 'haptic', pattern: 'CONFIRM' },
      cachedSay('checkout_ahead', 'NAV', 'checkout_ahead', 30_000),
    ];
  };

  /** Guidance after the current order changed: arrival, passed-it or keep-going. */
  const guide = (t: number): NavAction[] => {
    const goal = activeOrder();
    if (currentOrder === null || goal === null) return [];
    if (phase === 'AISLE' && target) {
      if (currentOrder === target.order) return arrived ? [] : arrive(target);
    }
    if (targetBehind(currentOrder, goal, direction)) return passedIt();
    if (direction === null) return [];   // first read: no travel direction yet, do not send them anywhere
    return keepGoing('NAV', t);
  };

  return {
    setTarget(t) {
      target = t;
      arrived = false;
      passedItSaidFor = null;
      overshootSaid = false;
    },
    setPhase(p) {
      if (p === phase) return;
      phase = p;
      passedItSaidFor = null;
      overshootSaid = false;
      lastKeepGoingAt = -Infinity;
    },

    onSignIdentified(sign) {
      const t = now();
      const actions: NavAction[] = [];

      // Same sign re-read while standing still (no other sign in between): dedupe for 10 s,
      // do not advance the step prior. Coming back to an earlier sign after another one is a
      // genuine observation (a turn-around) and is never deduped.
      const seen = lastSeen.get(sign.id);
      if (sign.id === lastSignId && seen !== undefined && t - seen < SAME_SIGN_DEDUPE_MS) return [];
      lastSeen.set(sign.id, t);
      lastSignId = sign.id;

      // Announce to everyone (A's store, DebugPanel) — the event carries the display label.
      actions.push({
        kind: 'emit',
        event: { type: 'AISLE_IDENTIFIED', aisleId: sign.id, label: sign.label, confidence: sign.confidence, source: sign.source },
      });

      // Checkout landmark (Task 10): arrival is by sign, not by order comparison.
      if (sign.kind === 'landmark') {
        if (sign.id === CHECKOUT_LANDMARK_ID) {
          checkoutOrder = sign.order;
          if (phase === 'CHECKOUT' && !checkoutReached) actions.push(...reachCheckout());
        }
        // Landmarks carry a position but are not aisles: do not move currentOrder.
        lastReadAt = t;
        silenceInfoSaid = false;
        silenceCameraSaid = false;
        return actions;
      }

      const prevOrder = currentOrder;
      const prevDirection = direction;
      currentOrder = sign.order;
      currentAisleId = sign.id;
      lastReadAt = t;
      stepsAtLastRead = getSteps();
      silenceInfoSaid = false;
      silenceCameraSaid = false;
      overshootSaid = false;

      if (prevOrder !== null && sign.order !== prevOrder) {
        const observed: TravelDirection = sign.order > prevOrder ? 'ASC' : 'DESC';
        if (direction !== observed) {
          direction = observed;   // first pair sets it; a pair the other way flips it (and the side)
          passedItSaidFor = null;
        }
      }
      if (prevOrder !== null && sign.order !== prevOrder) actions.push({ kind: 'anchorCourse' });
      if (prevDirection !== direction && prevDirection !== null) actions.push({ kind: 'anchorCourse' });

      // No target: announce the aisle, never an arrival. Also when the direction is still
      // unknown after a first read away from the target: orient, do not command.
      const goal = activeOrder();
      if (goal === null || (direction === null && currentOrder !== goal)) {
        actions.push({ kind: 'say', priority: 'INFO', text: `${sign.spokenLabel.replace(/\.+$/, '')}.`, dedupeKey: `aisle-${sign.id}`, cooldownMs: SAME_SIGN_DEDUPE_MS });
        return actions;
      }

      actions.push(...guide(t));
      return actions;
    },

    tick() {
      const t = now();
      const actions: NavAction[] = [];
      if (arrived && phase === 'AISLE') return actions;
      if (checkoutReached) return actions;

      if (currentOrder === null || lastReadAt === null) {
        if (t - lastUnknownPromptAt >= UNKNOWN_KEEP_GOING_MS && t - startedAt >= UNKNOWN_KEEP_GOING_MS) {
          lastUnknownPromptAt = t;
          actions.push(cachedSay('keep_going', 'INFO', 'keep_going_unknown', UNKNOWN_KEEP_GOING_MS));
        }
        return actions;
      }

      const sinceRead = t - lastReadAt;

      // Pedometer prior (Task 5): cadence and early overshoot.
      const goal = activeOrder();
      const stepsSince = Math.max(0, getSteps() - stepsAtLastRead);
      const est = estimated();
      if (goal !== null && !overshootSaid && overshot(est, goal, direction)) {
        overshootSaid = true;
        actions.push(...passedIt());
        actions.push({ kind: 'emit', event: { type: 'CAMERA_REQUEST', direction: 'up' } });
        actions.push(cachedSay('tilt_camera_up', 'INFO', 'tilt_camera_up', SILENCE_INFO_MS));
        return actions;
      }
      if (goal !== null && direction !== null && nextSignDue(stepsSince, opts.aislePitchM) && sinceRead >= KEEP_GOING_COOLDOWN_MS) {
        // Cadence only encourages walking toward the target; behind it (by the last read or by
        // the prior's estimate), the once-only passed_it applies instead.
        const where = est ?? currentOrder;
        if (overshootSaid || targetBehind(where, goal, direction)) actions.push(...passedIt());
        else actions.push(...keepGoing('NAV', t, 'keep_going_cadence'));
      }

      // No read for 20 s → one INFO; a further 20 s → one CAMERA_REQUEST up.
      if (sinceRead >= SILENCE_CAMERA_MS && !silenceCameraSaid) {
        silenceCameraSaid = true;
        actions.push({ kind: 'emit', event: { type: 'CAMERA_REQUEST', direction: 'up' } });
        actions.push(cachedSay('tilt_camera_up', 'INFO', 'tilt_camera_up', SILENCE_INFO_MS));
      } else if (sinceRead >= SILENCE_INFO_MS && !silenceInfoSaid) {
        silenceInfoSaid = true;
        actions.push(cachedSay('keep_going', 'INFO', 'keep_going_silence', SILENCE_INFO_MS));
      }
      return actions;
    },

    onWallAhead() {
      wallAheadAt = now();
    },

    isPlausible(order) {
      if (currentOrder === null) return true;
      const est = estimated();
      const lo = est === null ? currentOrder : Math.min(currentOrder, est);
      const hi = est === null ? currentOrder : Math.max(currentOrder, est);
      // A wall ahead means a cross-aisle turn is coming; widen by one order for 30 s.
      const widen = wallAheadAt !== null && now() - wallAheadAt < 30_000 ? 1 : 0;
      return order >= lo - PLAUSIBLE_ORDER_SPAN - widen && order <= hi + PLAUSIBLE_ORDER_SPAN + widen;
    },

    getState() {
      return {
        phase,
        currentOrder,
        currentAisleId,
        direction,
        target,
        checkoutOrder,
        lastReadAt,
        stepsAtLastRead,
        arrived,
        checkoutReached,
        estimatedOrder: estimated(),
      };
    },

    reset() {
      phase = 'AISLE';
      currentOrder = null;
      currentAisleId = null;
      direction = null;
      lastReadAt = null;
      stepsAtLastRead = 0;
      arrived = false;
      checkoutReached = false;
      lastSeen = new Map();
      lastSignId = null;
      lastKeepGoingAt = -Infinity;
      lastUnknownPromptAt = -Infinity;
      silenceInfoSaid = false;
      silenceCameraSaid = false;
      passedItSaidFor = null;
      overshootSaid = false;
      wallAheadAt = null;
    },
  };
}
