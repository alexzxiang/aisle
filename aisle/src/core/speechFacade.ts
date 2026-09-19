/**
 * Spoken forms for display strings (composition-root glue).
 *
 * Google's walking-routes warning is displayed verbatim (02 Task 10) and B
 * speaks it once at ROUTE_READY through `say()`. It is ~20 words, and A's
 * speech contract rejects anything over 12 in dev (01 §3: the long-phrase
 * allow-list has one member, `disclaimer`). Rather than widen the allow-list
 * unilaterally or silence B, the outdoor session speaks a ≤ 12-word form of
 * that one exact string; every other text passes through untouched.
 *
 * `prefetch` is mapped the same way so the pre-synthesized clip matches what
 * is later spoken.
 */
import type { SpeechRequest } from './contracts';
import type { AisleSpeechService } from './speech';
import { WALKING_BETA_WARNING } from '../outdoor/types';

export const SPOKEN_WALKING_BETA = 'Walking directions are in beta. Use caution.';

/** Exact display string → spoken form. Byte-for-byte keys only; no fuzzy matching. */
export const SPOKEN_FORMS: ReadonlyMap<string, string> = new Map([[WALKING_BETA_WARNING, SPOKEN_WALKING_BETA]]);

export function spokenFormOf(text: string): string {
  return SPOKEN_FORMS.get(text) ?? text;
}

/** The same service with `say` / `prefetch` text mapped through `spokenFormOf`. */
export function withSpokenForms(speech: AisleSpeechService): AisleSpeechService {
  return {
    say(req: SpeechRequest) {
      const text = spokenFormOf(req.text);
      speech.say(text === req.text ? req : { ...req, text });
    },
    playStream: (streamId, priority) => speech.playStream(streamId, priority),
    clearQueue: (priority) => speech.clearQueue(priority),
    isSpeaking: () => speech.isSpeaking(),
    setRate: (rate) => speech.setRate(rate),
    prefetch: (text) => speech.prefetch(spokenFormOf(text)),
    runtimeKeyFor: (text) => speech.runtimeKeyFor(spokenFormOf(text)),
    getStats: () => speech.getStats(),
    dispose: () => speech.dispose(),
  };
}
