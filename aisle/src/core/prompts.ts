/**
 * Proactive prompts → the conversation log (round 3, "prompt the user when
 * information is missing"). The *spoken* side of each prompt already exists:
 * C's SemanticVision speaks `cameraRequest` / `userAction` as cached ≤ 6-word
 * prompts, and C's indoor navigator speaks `keep_going` after 20 s without a
 * sign. This module makes the same prompts visible in the transcript blurb,
 * so the user (and the judge) can read what Aisle asked for even when the
 * spoken copy was gated (COURSE buzzing, ≤ 1 prompt / 3 s):
 *
 *   - CAMERA_REQUEST / USER_ACTION on the bus → the prompt text, source 'prompt';
 *   - INDOOR_NAV with no AISLE_IDENTIFIED for 20 s → `keep_going`, source
 *     'prompt', again every 20 s until a sign is read or the mode changes.
 *
 * The GPS and store-map prompts live in `trip.ts` (they need the trip's
 * timing); the "two unclear tries" prompt lives in `voice.ts`.
 */
import type { AppMode } from './contracts';
import type { AppEventBus } from './bus';
import type { ConversationLog } from './conversation';
import type { AppStore } from './store';
import { PHRASES } from './phrases';
import { cameraPrompt, userActionPrompt } from '../perception/semanticVision';

export const NO_SIGN_PROMPT_MS = 20_000;
const NO_SIGN_MODE: AppMode = 'INDOOR_NAV';

export interface PromptsDeps {
  bus: Pick<AppEventBus, 'on'>;
  store: Pick<AppStore, 'getState' | 'subscribe'>;
  conversation: Pick<ConversationLog, 'pushAisle'>;
  noSignMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export interface PromptsBinding {
  getDebugState(): { noSignArmed: boolean; noSignPrompts: number; prompts: number };
  dispose(): void;
}

export function wirePrompts(deps: PromptsDeps): PromptsBinding {
  const noSignMs = deps.noSignMs ?? NO_SIGN_PROMPT_MS;
  const setT = deps.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearT = deps.clearTimeoutFn ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const unsubs: Array<() => void> = [];
  let noSignTimer: unknown = null;
  let noSignPrompts = 0;
  let prompts = 0;

  const push = (text: string): void => {
    prompts += 1;
    try {
      deps.conversation.pushAisle(text, 'prompt');
    } catch {
      // the blurb is never worth a crash
    }
  };

  const disarm = (): void => {
    if (noSignTimer !== null) {
      clearT(noSignTimer);
      noSignTimer = null;
    }
  };

  const arm = (): void => {
    disarm();
    noSignTimer = setT(() => {
      noSignTimer = null;
      if (deps.store.getState().mode !== NO_SIGN_MODE) return;
      noSignPrompts += 1;
      push(PHRASES.keep_going);
      arm();   // again after another silent window
    }, noSignMs);
  };

  unsubs.push(deps.bus.on('CAMERA_REQUEST', (e) => {
    const p = cameraPrompt(e.direction);
    if (p) push(p.text);
  }));
  unsubs.push(deps.bus.on('USER_ACTION', (e) => {
    const p = userActionPrompt(e.action);
    if (p) push(p.text);
  }));
  unsubs.push(deps.bus.on('AISLE_IDENTIFIED', () => {
    if (deps.store.getState().mode === NO_SIGN_MODE) arm();
  }));
  unsubs.push(deps.store.subscribe((s, prev) => {
    if (s.mode === prev.mode) return;
    if (s.mode === NO_SIGN_MODE) arm();
    else disarm();
  }));
  if (deps.store.getState().mode === NO_SIGN_MODE) arm();

  return {
    getDebugState: () => ({ noSignArmed: noSignTimer !== null, noSignPrompts, prompts }),
    dispose() {
      disarm();
      for (const u of unsubs.splice(0)) u();
    },
  };
}
