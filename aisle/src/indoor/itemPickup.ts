/**
 * Item pick-up, the stretch loop (04 Task 9).
 *
 * Only after TARGET_AISLE_REACHED and only when asked (the user or the demo
 * script). Mode AT_ITEM → ITEM_PICKUP on the first ITEM_HAND_GUIDANCE (A's store
 * rule); profile ITEM_PICKUP.
 *
 *   1. "Face the shelf on your <side>." (pre-synthesized at store load), then
 *      cached `reach_out`.
 *   2. Loop ≤ 8 steps: `hand_guidance` with `targetItem` + `packageHint` →
 *      `hand.hint` → ITEM_HAND_GUIDANCE {hint, step} → one cached word.
 *      ~2 s per model call; the 4 s speech gap paces the loop.
 *   3. `touching` → CONFIRM, cached `touching`, done (→ CHECKOUT_NAV via the store).
 *   4. `not_seen` twice in a row → CAMERA_REQUEST {down} once, then continue.
 *   5. Step 8 without `touching` → `ask_staff`, done.
 *
 * `reducePickup` is the pure step function; `createItemPickup` runs it against
 * the SemanticVision client with an injectable clock and sleep.
 */
import type { AppEvent, CacheKey, HandHint, HapticPattern, Side, SpeechPriority } from '../core/contracts';
import { phraseText } from '../core/phrases';
import type { AskOutcome, SemanticVision } from '../perception/semanticVision';

export const PICKUP_MAX_STEPS = 8;
export const PICKUP_STEP_INTERVAL_MS = 4000;
export const NOT_SEEN_BEFORE_CAMERA_REQUEST = 2;

export interface PickupTarget {
  item: string;
  side: Side | null;
  packageHint?: string;
  shelf?: string;
}

export interface PickupState {
  step: number;                 // steps completed
  consecutiveNotSeen: number;
  cameraRequested: boolean;
  done: 'touching' | 'gave_up' | 'stopped' | null;
}

export type PickupAction =
  | { kind: 'say'; priority: SpeechPriority; cacheKey?: CacheKey; text?: string; dedupeKey?: string; cooldownMs?: number }
  | { kind: 'emit'; event: AppEvent }
  | { kind: 'haptic'; pattern: HapticPattern };

export const INITIAL_PICKUP_STATE: PickupState = Object.freeze({ step: 0, consecutiveNotSeen: 0, cameraRequested: false, done: null });

const HINT_KEY: Readonly<Record<Exclude<HandHint, 'not_seen' | 'touching'>, CacheKey>> = Object.freeze({
  left: 'left',
  right: 'right',
  higher: 'higher',
  lower: 'lower',
  forward: 'reach_forward',
});

/** Opening line, pre-synthesized at store load by storeResolver. */
export function faceShelfText(side: Side | null): string {
  return side ? `Face the shelf on your ${side.toLowerCase()}.` : 'Face the shelf.';
}

/** Every variable phrase the loop can speak, for pre-synthesis. */
export function pickupPrefetchTexts(side: Side | null): string[] {
  return [faceShelfText(side)];
}

/** One step of the loop. `hint` is null when the model gave nothing usable (confidence < 0.5, stale, error). */
export function reducePickup(state: PickupState, hint: HandHint | null): { state: PickupState; actions: PickupAction[] } {
  if (state.done) return { state, actions: [] };
  const step = state.step + 1;
  const actions: PickupAction[] = [];
  const effective: HandHint = hint ?? 'not_seen';

  actions.push({ kind: 'emit', event: { type: 'ITEM_HAND_GUIDANCE', hint: effective, step } });

  if (effective === 'touching') {
    actions.push({ kind: 'haptic', pattern: 'CONFIRM' });
    actions.push({ kind: 'say', priority: 'NAV', cacheKey: 'touching', text: phraseText('touching') });
    return { state: { ...state, step, consecutiveNotSeen: 0, done: 'touching' }, actions };
  }

  let consecutiveNotSeen = 0;
  let cameraRequested = state.cameraRequested;
  if (effective === 'not_seen') {
    consecutiveNotSeen = state.consecutiveNotSeen + 1;
    if (consecutiveNotSeen >= NOT_SEEN_BEFORE_CAMERA_REQUEST && !cameraRequested) {
      cameraRequested = true;
      actions.push({ kind: 'emit', event: { type: 'CAMERA_REQUEST', direction: 'down' } });
      actions.push({ kind: 'say', priority: 'INFO', text: 'Tilt the camera down.', dedupeKey: 'pickup-camera-down', cooldownMs: 8000 });
    }
  } else {
    actions.push({ kind: 'say', priority: 'NAV', cacheKey: HINT_KEY[effective], text: phraseText(HINT_KEY[effective]), dedupeKey: `hand-${effective}`, cooldownMs: 2000 });
  }

  if (step >= PICKUP_MAX_STEPS) {
    actions.push({ kind: 'say', priority: 'NAV', cacheKey: 'ask_staff', text: phraseText('ask_staff'), dedupeKey: 'ask_staff', cooldownMs: 30_000 });
    return { state: { step, consecutiveNotSeen, cameraRequested, done: 'gave_up' }, actions };
  }
  return { state: { step, consecutiveNotSeen, cameraRequested, done: null }, actions };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface ItemPickupOptions {
  vision: Pick<SemanticVision, 'ask'>;
  perform: (a: PickupAction) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  stepIntervalMs?: number;
}

export interface ItemPickup {
  /** Speaks the opener, then runs the loop to completion. Resolves with the final state. */
  start(target: PickupTarget): Promise<PickupState>;
  stop(): void;
  isRunning(): boolean;
  getState(): PickupState;
}

export function createItemPickup(opts: ItemPickupOptions): ItemPickup {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const interval = opts.stepIntervalMs ?? PICKUP_STEP_INTERVAL_MS;
  let state: PickupState = { ...INITIAL_PICKUP_STATE };
  let running = false;
  let cancelled = false;

  const hintFrom = (o: AskOutcome): HandHint | null => (o.status === 'applied' && o.response ? o.response.hand.hint : null);

  return {
    async start(target) {
      if (running) return state;
      running = true;
      cancelled = false;
      state = { ...INITIAL_PICKUP_STATE };

      opts.perform({ kind: 'say', priority: 'NAV', text: faceShelfText(target.side), dedupeKey: 'pickup-open', cooldownMs: 30_000 });
      opts.perform({ kind: 'say', priority: 'NAV', cacheKey: 'reach_out', text: phraseText('reach_out'), dedupeKey: 'reach_out', cooldownMs: 30_000 });

      const targetItem = target.packageHint ? `${target.item} (${target.packageHint})` : target.item;

      while (!cancelled && !state.done) {
        const t0 = now();
        const outcome = await opts.vision.ask('hand_guidance', { targetItem, image: 640, force: true, silent: true });
        if (cancelled) break;
        const r = reducePickup(state, hintFrom(outcome));
        state = r.state;
        for (const a of r.actions) opts.perform(a);
        if (state.done) break;
        const elapsed = now() - t0;
        if (elapsed < interval) await sleep(interval - elapsed);
      }
      if (cancelled && !state.done) state = { ...state, done: 'stopped' };
      running = false;
      return state;
    },
    stop() {
      cancelled = true;
    },
    isRunning: () => running,
    getState: () => ({ ...state }),
  };
}
