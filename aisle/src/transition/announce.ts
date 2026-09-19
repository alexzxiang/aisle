/**
 * The handoff announcement (05 Part 3 "What happens on fire").
 *
 * The detector emits STORE_ENTERED and nothing else; A's store moves the mode to
 * TRANSITION. Then, scripted precisely:
 *
 *   haptics.play('CONFIRM');
 *   speech.say({ cacheKey: 'entering_store', priority: 'NAV', … });        // cached, 0 ms network
 *   // ≥ 4 s later, INFO — dropped by A's queue if anything else is queued, which is fine:
 *   speech.say({ cacheKey: 'looking_for_signs', priority: 'INFO', dedupeKey: 'looking_for_signs', … });
 *
 * The handoff should feel like the app noticed something, not like a menu changed.
 * Nobody narrates over it. Text comes from A's phrase table (src/core/phrases.ts) so the
 * spoken words and the cached mp3 cannot drift apart; both keys are cached, so nothing
 * falls to expo-speech in a different voice.
 *
 * `wireStoreEntryAnnouncement` subscribes a TransitionDetector's onEnter and runs the
 * script once per fire. Timers are injectable; the returned function cancels the
 * pending INFO line (call it on `* → IDLE`).
 */
import type { HapticService, SpeechService, TransitionDetector, TransitionSignal } from '../core/contracts';
import { phraseText } from '../core/phrases';

export const ENTERING_STORE_KEY = 'entering_store' as const;
export const LOOKING_FOR_SIGNS_KEY = 'looking_for_signs' as const;
export const SECOND_LINE_DELAY_MS = 4000;

export interface AnnounceDeps {
  haptics: Pick<HapticService, 'play'>;
  speech: Pick<SpeechService, 'say'>;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export interface AnnounceHandle {
  /** Cancel the pending second line (no-op after it played). */
  cancel(): void;
}

/** Run the two-beat script once. Pure apart from the injected side effects. */
export function announceStoreEntry(deps: AnnounceDeps): AnnounceHandle {
  const setT = deps.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearT = deps.clearTimeoutFn ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

  deps.haptics.play('CONFIRM');
  deps.speech.say({ text: phraseText(ENTERING_STORE_KEY), cacheKey: ENTERING_STORE_KEY, priority: 'NAV' });

  let handle: unknown = setT(() => {
    handle = null;
    deps.speech.say({
      text: phraseText(LOOKING_FOR_SIGNS_KEY),
      cacheKey: LOOKING_FOR_SIGNS_KEY,
      priority: 'INFO',
      dedupeKey: LOOKING_FOR_SIGNS_KEY,
    });
  }, SECOND_LINE_DELAY_MS);

  return {
    cancel() {
      if (handle !== null) {
        clearT(handle);
        handle = null;
      }
    },
  };
}

/** Subscribe the script to a detector. Returns an unsubscribe that also cancels a pending second line. */
export function wireStoreEntryAnnouncement(
  detector: Pick<TransitionDetector, 'onEnter'>,
  deps: AnnounceDeps,
  onFire?: (s: TransitionSignal) => void,
): () => void {
  let current: AnnounceHandle | null = null;
  const off = detector.onEnter((s) => {
    current?.cancel();
    current = announceStoreEntry(deps);
    onFire?.(s);
  });
  return () => {
    off();
    current?.cancel();
    current = null;
  };
}
