/**
 * HandGuide — "hold out your hand" (round 6c, rebuilt in round 7 on the phone's own hand).
 *
 * The last step of a home task is a reach: the fridge is open, the eggs are somewhere
 * in it, and the person needs their hand steered. Round 7 (TEAM-PLAN v2, Stream A)
 * makes the steering geometric:
 *
 *   hand  ← Vision hand pose on-device, ~10 fps (`onHandPose`: index fingertip, wrist)
 *   target ← the detector's box for a class it knows (a cup, a bottle) at 15 fps,
 *            else Claude's `target.box` from `hand_guidance` every ~2 s (eggs, milk)
 *   word  ← `handWord(hand, target)`: Left / Right / Higher / Lower / Reach forward,
 *            and "Grab it." once the fingertip has sat inside the target twice
 *
 * One word per `wordIntervalMs` at most, and only when it changes (a repeat after
 * `repeatMs` if it still applies). Without an on-device hand (older build, hand out
 * of frame) the loop falls back to Claude's `hand.hint` words as before. Without a
 * target in view: "I see your hand, not the eggs. Tilt the camera down." Twelve
 * seconds without a target → give up with a live line; the step stays open.
 *
 * Every fixed word is a cached phrase; the model's own `speech` stays muted.
 */
import type { HandHint, HandPoseEvent, HapticService, PerceptionService, SpeechService, Detection } from './contracts';
import type { AppEventBus } from './bus';
import type { ConversationLog } from './conversation';
import { PHRASES, type PhraseKey } from './phrases';
import { MISSION_PHRASES } from './preparedGuidance';
import { classForWords } from './sceneMemory';
import { handWord, type HandWord, type TargetBox } from './guide';
import type { SemanticVision } from '../perception/semanticVision';

export const HAND_INTERVAL_MS = 2000;       // Claude cadence (target box / fallback hints)
export const HAND_TICK_MS = 350;            // the loop's own clock
export const HAND_WORD_INTERVAL_MS = 700;   // never two words closer than this
export const HAND_REPEAT_MS = 2500;         // the same word again if still true
export const HAND_FRESH_MS = 1000;          // a hand pose older than this is no hand
export const TARGET_FRESH_MS = 1500;        // a detector box older than this is stale
export const MODEL_TARGET_FRESH_MS = 3500;  // a Claude box lives a little longer
export const HAND_MAX_STEPS = 12;           // Claude readings without a touch → give up
export const HAND_GIVE_UP_MS = 30_000;      // …or this long without a target at all
export const HAND_NOT_SEEN_CAMERA_DOWN = 2;
export const HAND_NOT_SEEN_MOVE_SLOWLY = 5;

const HINT_PHRASE: Readonly<Record<Exclude<HandHint, 'not_seen' | 'touching'>, PhraseKey>> = {
  left: 'left', right: 'right', higher: 'higher', lower: 'lower', forward: 'reach_forward',
};
const WORD_PHRASE: Readonly<Record<Exclude<HandWord, null | 'grab'>, PhraseKey>> = {
  left: 'left', right: 'right', higher: 'higher', lower: 'lower', forward: 'reach_forward',
};

export interface HandGuideDeps {
  vision: Pick<SemanticVision, 'ask'>;
  speech: Pick<SpeechService, 'say'>;
  haptics: Pick<HapticService, 'play'>;
  /** The phone's own hand and the detector's boxes (round 7). Optional: without it the Claude words steer. */
  perception?: Partial<Pick<PerceptionService, 'onHandPose' | 'onDetections'>>;
  bus?: Pick<AppEventBus, 'emit'>;
  conversation?: Pick<ConversationLog, 'pushAisle'>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  wordIntervalMs?: number;
  maxSteps?: number;
}

export interface HandGuideResult {
  done: 'touching' | 'gave_up' | 'stopped';
  steps: number;
  /** Words spoken from the on-device hand (0 when Claude's hints did all the work). */
  handWords: number;
}

export interface HandGuide {
  /** Speaks "Hold out your hand." and runs the loop for `item` until touching / give up / stop. */
  start(item: string, context?: { goal: string; target: TargetBox | null }): Promise<HandGuideResult>;
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
  const wordInterval = deps.wordIntervalMs ?? HAND_WORD_INTERVAL_MS;
  const maxSteps = deps.maxSteps ?? HAND_MAX_STEPS;
  let running = false;
  let cancelled = false;
  let generation = 0;

  const sayKey = (key: PhraseKey, cooldownMs: number): void => {
    deps.speech.say({ text: PHRASES[key], cacheKey: key, priority: 'NAV', dedupeKey: `hand-${key}`, cooldownMs });
    deps.conversation?.pushAisle(PHRASES[key], 'prompt');
  };
  const sayLive = (text: string, dedupeKey: string, cooldownMs: number): void => {
    deps.speech.say({ text, priority: 'NAV', dedupeKey, cooldownMs });
    deps.conversation?.pushAisle(text, 'prompt');
  };

  return {
    async start(item, context) {
      if (running) return { done: 'stopped', steps: 0, handWords: 0 };
      running = true;
      cancelled = false;
      const gen = ++generation;
      // An appliance box is never a handle box.
      const cls = /\bhandle\b/i.test(item) ? null : classForWords(item);
      const startedAt = now();
      let steps = 0;
      let handWords = 0;
      let notSeen = 0;
      let cameraAsked = false;
      let lastAskAt = -Infinity;
      let asking = false;
      let lastWord: HandWord = null;
      let lastWordAt = -Infinity;
      let insideFor = 0;
      let lastTargetSeenAt = startedAt;
      let hand: HandPoseEvent | null = null;
      let handAt = -Infinity;
      type Seen = { box: Detection['box']; at: number };
      const boxes: { detector: Seen | null; model: Seen | null } = { detector: null, model: context?.target ?? null };
      let result: HandGuideResult | null = null;

      const unsubs: Array<() => void> = [];
      if (deps.perception?.onHandPose) {
        unsubs.push(deps.perception.onHandPose((e) => { hand = e; handAt = now(); }));
      }
      if (deps.perception?.onDetections && cls) {
        unsubs.push(deps.perception.onDetections((list) => {
          const best = list.filter((d) => d.cls === cls).sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3])[0];
          if (best) boxes.detector = { box: best.box, at: now() };
        }));
      }

      const speakWord = (w: Exclude<HandWord, null>, t: number): void => {
        if (w === 'grab') {
          deps.haptics.play('CONFIRM');
          sayLive(MISSION_PHRASES.mission_hand_aligned, 'hand-aligned', 0);
          return;
        }
        sayKey(WORD_PHRASE[w], 0);
        deps.bus?.emit({ type: 'ITEM_HAND_GUIDANCE', hint: w, step: steps });
        lastWord = w;
        lastWordAt = t;
        handWords += 1;
      };

      sayKey('hold_out_hand', 10_000);
      try {
        while (!cancelled && result === null) {
          const t = now();

          // Claude, every `interval`: a target box for things the detector cannot name, and the fallback hints.
          if (!asking && t - lastAskAt >= interval) {
            asking = true;
            lastAskAt = t;
            void deps.vision.ask('hand_guidance', { targetItem: item, userText: `Goal: ${context?.goal ?? item}. Current stage: guide the hand to ${item}. ${/handle/i.test(item) ? 'Locate the actual door handle, not the appliance. The door may still be closed.' : 'Locate the requested food or its carton, not another item.'} Do not change the goal.`, image: 768, force: true, silent: true })
              .then((out) => {
                if (cancelled || generation !== gen || !running || !(out.status === 'applied' && out.response)) return;
                const r = out.response;
                steps += 1;
                if (r.target.box && r.target.confidence >= 0.7) boxes.model = { box: r.target.box, at: t };
                const freshHand = hand !== null && now() - handAt <= HAND_FRESH_MS;
                if (!freshHand) {
                  // No on-device hand: Claude's word steers, as in round 6c.
                  const hint = r.target.box && r.target.confidence >= 0.7 && now() - t <= MODEL_TARGET_FRESH_MS ? r.hand.hint : 'not_seen';
                  deps.bus?.emit({ type: 'ITEM_HAND_GUIDANCE', hint, step: steps });
                  if (hint === 'touching') {
                    deps.haptics.play('CONFIRM');
                    sayLive(MISSION_PHRASES.mission_hand_aligned, 'hand-aligned', 0);
                    result = { done: 'touching', steps, handWords };
                  } else if (hint === 'not_seen') {
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
                  if (result === null && steps >= maxSteps) result = { done: 'gave_up', steps, handWords };
                }
              })
              .catch(() => undefined)
              .then(() => { asking = false; });
          }

          // The phone's own hand against the freshest target box.
          const freshHand = hand !== null && t - handAt <= HAND_FRESH_MS ? hand : null;
          const d = boxes.detector;
          const m = boxes.model;
          const target = d && t - d.at <= TARGET_FRESH_MS ? d.box : m && t - m.at <= MODEL_TARGET_FRESH_MS ? m.box : null;
          if (target) lastTargetSeenAt = t;
          if (freshHand && target && t - lastWordAt >= wordInterval) {
            const w = handWord(freshHand, target, insideFor);
            insideFor = w === 'forward' || w === 'grab' ? insideFor + 1 : 0;
            if (w === 'grab') {
              speakWord('grab', t);
              result = { done: 'touching', steps, handWords };
            } else if (w !== null && (w !== lastWord || t - lastWordAt >= HAND_REPEAT_MS)) {
              speakWord(w, t);
            }
          } else if (freshHand && !target && t - lastWordAt >= HAND_REPEAT_MS * 2) {
            lastWordAt = t;
            sayLive(MISSION_PHRASES.mission_target_missing, 'hand-no-target', 4000);
          }

          if (result === null && t - lastTargetSeenAt >= HAND_GIVE_UP_MS) {
            sayLive(MISSION_PHRASES.mission_retry, 'hand-gave-up', 10_000);
            result = { done: 'gave_up', steps, handWords };
          }
          if (result !== null) break;
          await sleep(HAND_TICK_MS);
        }
      } finally {
        for (const u of unsubs.splice(0)) u();
        running = false;
      }
      return result ?? { done: 'stopped', steps, handWords };
    },
    stop() {
      cancelled = true;
      generation += 1;
    },
    isRunning: () => running,
  };
}
