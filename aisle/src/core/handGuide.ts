/**
 * HandGuide — "hold out your hand" (round 6c).
 *
 * The last step of a home task is a reach: the fridge is open, the eggs are
 * somewhere in it, and the person needs their hand steered. The store's pickup
 * loop (src/indoor/itemPickup.ts) does this at a shelf with store wording; this
 * is the same idea for anywhere: ask Tier 1 `hand_guidance` about every two
 * seconds with the target item, and speak the one word that moves the hand —
 * "Higher.", "Lower.", "Left.", "Right.", "Reach forward." — until `touching`
 * ("Grab it.") closes the step. Not seen twice → "Tilt the camera down."; not
 * seen five times → "I do not see it. Move your hand slowly."; twelve steps
 * without touching → give up with a live line ("I could not find the eggs.").
 *
 * Every word is a cached phrase, so the loop stays fast and consistent; the
 * model's own `speech` is muted (`silent: true`).
 */
import type { HandHint, HapticService, SpeechService } from './contracts';
import type { AppEventBus } from './bus';
import type { ConversationLog } from './conversation';
import { PHRASES, type PhraseKey } from './phrases';
import type { SemanticVision } from '../perception/semanticVision';

export const HAND_INTERVAL_MS = 2000;
export const HAND_MAX_STEPS = 12;
export const HAND_NOT_SEEN_CAMERA_DOWN = 2;
export const HAND_NOT_SEEN_MOVE_SLOWLY = 5;

const HINT_PHRASE: Readonly<Record<Exclude<HandHint, 'not_seen' | 'touching'>, PhraseKey>> = {
  left: 'left', right: 'right', higher: 'higher', lower: 'lower', forward: 'reach_forward',
};

export interface HandGuideDeps {
  vision: Pick<SemanticVision, 'ask'>;
  speech: Pick<SpeechService, 'say'>;
  haptics: Pick<HapticService, 'play'>;
  bus?: Pick<AppEventBus, 'emit'>;
  conversation?: Pick<ConversationLog, 'pushAisle'>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  maxSteps?: number;
}

export interface HandGuideResult {
  done: 'touching' | 'gave_up' | 'stopped';
  steps: number;
}

export interface HandGuide {
  /** Speaks "Hold out your hand." and runs the loop for `item` until touching / give up / stop. */
  start(item: string): Promise<HandGuideResult>;
  stop(): void;
  isRunning(): boolean;
}

/** "eggs in my fridge" → "eggs": the thing, not the place. */
export function itemOfGoal(goal: string): string {
  const g = goal.trim().replace(/[.!?]+$/, '');
  const m = g.match(/^(?:the |my |some |a |an )?(.+?)(?:\s+(?:in|on|at|inside|from|near|by|next to)\s+.*)?$/i);
  return (m?.[1] ?? g).trim();
}

export function createHandGuide(deps: HandGuideDeps): HandGuide {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const interval = deps.intervalMs ?? HAND_INTERVAL_MS;
  const maxSteps = deps.maxSteps ?? HAND_MAX_STEPS;
  let running = false;
  let cancelled = false;

  const sayKey = (key: PhraseKey, cooldownMs: number): void => {
    deps.speech.say({ text: PHRASES[key], cacheKey: key, priority: 'NAV', dedupeKey: `hand-${key}`, cooldownMs });
    deps.conversation?.pushAisle(PHRASES[key], 'prompt');
  };

  return {
    async start(item) {
      if (running) return { done: 'stopped', steps: 0 };
      running = true;
      cancelled = false;
      let steps = 0;
      let notSeen = 0;
      let cameraAsked = false;
      let result: HandGuideResult | null = null;
      sayKey('hold_out_hand', 10_000);
      try {
        while (!cancelled && result === null) {
          const t0 = now();
          let hint: HandHint = 'not_seen';
          try {
            const out = await deps.vision.ask('hand_guidance', { targetItem: item, image: 640, force: true, silent: true });
            if (out.status === 'applied' && out.response) hint = out.response.hand.hint;
          } catch {
            hint = 'not_seen';
          }
          if (cancelled) break;
          steps += 1;
          deps.bus?.emit({ type: 'ITEM_HAND_GUIDANCE', hint, step: steps });
          if (hint === 'touching') {
            deps.haptics.play('CONFIRM');
            sayKey('grab_it', 0);
            result = { done: 'touching', steps };
            break;
          }
          if (hint === 'not_seen') {
            notSeen += 1;
            if (notSeen === HAND_NOT_SEEN_CAMERA_DOWN && !cameraAsked) {
              cameraAsked = true;
              deps.bus?.emit({ type: 'CAMERA_REQUEST', direction: 'down' });
              deps.speech.say({ text: 'Tilt the camera down.', priority: 'INFO', dedupeKey: 'hand-camera-down', cooldownMs: 8000 });
            } else if (notSeen >= HAND_NOT_SEEN_MOVE_SLOWLY && notSeen % HAND_NOT_SEEN_MOVE_SLOWLY === 0) {
              sayKey('move_hand_slowly', 4000);
            }
          } else {
            notSeen = 0;
            sayKey(HINT_PHRASE[hint], 1500);
          }
          if (steps >= maxSteps) {
            const text = `I could not find the ${item}. Try another spot.`;
            deps.speech.say({ text, priority: 'NAV', dedupeKey: 'hand-gave-up', cooldownMs: 10_000 });
            deps.conversation?.pushAisle(text, 'prompt');
            result = { done: 'gave_up', steps };
            break;
          }
          const elapsed = now() - t0;
          if (elapsed < interval) await sleep(interval - elapsed);
        }
      } finally {
        running = false;
      }
      return result ?? { done: 'stopped', steps };
    },
    stop() {
      cancelled = true;
    },
    isRunning: () => running,
  };
}
