/**
 * The user-facing string rules the screens and their tests apply (00
 * principle 7, 01 §3).
 *
 * - The forbidden list comes from `src/core/phrases.ts`, the A-side canon
 *   that SpeechService and `scripts/lint-phrases.ts` also use; this module
 *   only adds the multi-hit finder the tests want. Matching is on word
 *   boundaries, so identifiers like `clearQueue` or the word "going" are not
 *   hits; only text is.
 * - `assertUtterance` is the <= 12-word rule applied to anything the UI renders
 *   as an instruction, so a bad string is a test failure, not a demo surprise.
 */
import { FORBIDDEN_TERMS } from '../core/phrases';

/** 00 principle 7 / 01 section 3, plus the explicit "go now" spelling. */
export const FORBIDDEN_PHRASES: readonly string[] = [...FORBIDDEN_TERMS, 'go now'];

const WORD_BOUNDARY_SOURCE = FORBIDDEN_PHRASES.map(
  (p) => `\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}\\b`,
).join('|');

/** Fresh instance per call: a global regex carries `lastIndex` between uses. */
export function forbiddenRegex(): RegExp {
  return new RegExp(WORD_BOUNDARY_SOURCE, 'gi');
}

/** Every forbidden phrase found in `text`, lower-cased, in order of appearance. */
export function findForbidden(text: string): string[] {
  const out: string[] = [];
  const re = forbiddenRegex();
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    out.push(m[0].toLowerCase().replace(/\s+/g, ' '));
    m = re.exec(text);
  }
  return out;
}

export function hasForbidden(text: string): boolean {
  return forbiddenRegex().test(text);
}

export const MAX_UTTERANCE_WORDS = 12;

export function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

/** Throws with a useful message; used by tests and by the screens' dev checks. */
export function assertUtterance(text: string, where: string): void {
  const bad = findForbidden(text);
  if (bad.length > 0) {
    throw new Error(`[copy] ${where}: forbidden word(s) ${bad.join(', ')} in "${text}"`);
  }
  const n = wordCount(text);
  if (n > MAX_UTTERANCE_WORDS) {
    throw new Error(`[copy] ${where}: ${n} words (max ${MAX_UTTERANCE_WORDS}) in "${text}"`);
  }
}

// ---------------------------------------------------------------------------
// Fixed copy
// ---------------------------------------------------------------------------

/** Spoken on first launch and shown on HomeScreen (02 Task 10, verbatim). */
export const DISCLAIMER_TEXT =
  'Aisle is a prototype, not a safety device. Keep using your cane or guide dog. ' +
  'Aisle reads walk signals and warns about vehicles it can see; it cannot see everything ' +
  'and never decides when to cross.';

/** One sentence, shown once on HomeScreen (02 Task 10). */
export const PRIVACY_TEXT =
  'Street and store video stays on this phone. Only occasional still frames are sent to the cloud.';

/** Headphone guidance, shown in settings and spoken in onboarding. */
export const HEADPHONE_NOTE =
  'Use open-ear or bone-conduction headphones so you can still hear traffic. Keep the ring switch on.';

/** B supplies the real Google walking-routes beta string; this is the placeholder we display. */
export const WALKING_BETA_FALLBACK = 'Walking routes are in beta and can be wrong.';

/**
 * The first-launch card on Home: a blind user cannot discover the vocabulary
 * by looking, and a sighted teammate handing the phone over reads it aloud.
 * Each line is an utterance that hits a fast path (README, "What to say").
 * Shown until the conversation has a line in it.
 */
export const SAY_CARD_TITLE = 'Try saying';
export const SAY_CARD_EXAMPLES: readonly string[] = [
  'I need eggs',
  'Take me to the CVS on Forbes',
  'Find the eggs in my fridge',
  'What is around me',
];
export const SAY_CARD_NOTE = 'Hold the talk button, or type it below.';

// ---------------------------------------------------------------------------
// Typed input (the zero-risk keyboard path, 02 Task 7)
// ---------------------------------------------------------------------------

const TYPED_PREFIX_RE =
  /^(?:(?:i|we)\s*(?:'m|am|'re|are)?\s*(?:need|want|would like|looking for|need to (?:find|get|buy)|want to (?:find|get|buy))|find(?: me)?|get me|(?:take|bring) me to|looking for|where (?:is|are|'s)(?: the)?|show me)\s+/i;
const TYPED_FILLER_RE = /\b(?:please|some|the|a|an|uh|um)\b/gi;

/**
 * The typed or dictated request as an item name: lower case, request prefix
 * and filler removed, punctuation dropped. Deterministic and local, so the
 * keyboard path never waits on the planner. Returns null when nothing is left.
 */
export function normalizeTypedItem(text: string): string | null {
  let t = text.toLowerCase().replace(/[^\p{L}\p{N}\s'%-]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (t.length === 0) return null;
  const m = t.match(TYPED_PREFIX_RE);
  if (m) t = t.slice(m[0].length);
  t = t.replace(TYPED_FILLER_RE, ' ').replace(/\s+/g, ' ').trim();
  return t.length === 0 ? null : t;
}

/** "eggs" -> "Eggs. Planning the route." Null when the item cannot be spoken as is (digits). */
export function itemAcknowledgement(item: string): string | null {
  if (/\d/.test(item)) return null;
  const spoken = item.length === 0 ? item : item[0].toUpperCase() + item.slice(1);
  const text = `${spoken}. Planning the route.`;
  return wordCount(text) <= MAX_UTTERANCE_WORDS && !hasForbidden(text) ? text : null;
}
