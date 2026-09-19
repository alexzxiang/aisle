/**
 * Server-side language rule (05 Part 2) — a safety control, not a style rule.
 *
 * Every `speech` string from Claude and every `text` on /api/tts is checked against
 * the forbidden list (01 §3: safe, clear, go, cross now, no cars, you can cross) and
 * the 12-word limit. A violation blanks `speech` (Claude) or returns 422 (/api/tts).
 * The speech lane also blanks any string containing a digit, mirroring the client's
 * sanitizeSpeech (src/perception/semanticVision.ts): a bare "3" is not normalised by
 * the voice and A's phrase table spells numbers out. The client lints too; the proxy
 * is the second lock.
 *
 * The one exemption: Google's mandatory walking-beta warning, allow-listed by the
 * SHA-256 of its exact bytes. It exempts that sentence from both rules on /api/tts and
 * display only — never a Claude `speech` string. The forbidden list and the sentence
 * are imported from the committed constants (A's `src/core/phrases.ts`, B's
 * `src/outdoor/types.ts`); there is deliberately no second copy here.
 */
import { createHash } from 'node:crypto';
import { MAX_UTTERANCE_WORDS, countWords, findForbiddenTerm, hasDigit } from '../../src/core/phrases';
import { digitsToWords } from '../../src/outdoor/plannerJobs';
import { WALKING_BETA_WARNING } from '../../src/outdoor/types';

export type { LanguageVerdict } from './log';
import type { LanguageVerdict } from './log';

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Exact-byte hash of the one allow-listed sentence. */
export const WALKING_BETA_WARNING_SHA256: string = sha256Hex(WALKING_BETA_WARNING);

/** Allow-list: hash → label. One member. Do not widen here (05 Part 2). */
export const TTS_ALLOWLIST: ReadonlyMap<string, string> = new Map([[WALKING_BETA_WARNING_SHA256, 'google_walking_beta']]);

export interface LanguageCheck {
  verdict: LanguageVerdict;
  /** Text to use downstream: the input on pass/allowlisted, '' on blanked. */
  text: string;
  reason?: 'forbidden' | 'too_long' | 'digit';
  term?: string | null;
  words: number;
}

export interface CheckOptions {
  /** 'speech' (Claude → blank) or 'tts' (→ 422). The allow-list applies to 'tts' only. */
  lane: 'speech' | 'tts';
  maxWords?: number;
}

/**
 * Pure. Returns the verdict and the text the caller may use.
 *  - speech lane: forbidden, a digit, or > 12 words → 'blanked', text ''.
 *  - tts lane: allow-listed hash → 'allowlisted' (skips both rules);
 *              forbidden or > 12 words → 'rejected_422'.
 */
export function checkLanguage(text: string, opts: CheckOptions): LanguageCheck {
  if (opts.lane === 'tts' && TTS_ALLOWLIST.has(sha256Hex(text))) {
    return { verdict: 'allowlisted', text, words: countWords(text) };
  }
  const max = opts.maxWords ?? MAX_UTTERANCE_WORDS;
  // Speech lane, round 6: repair before judging. Digits become words and a long
  // answer is cut to its first sentence(s) within the budget — a description that
  // ran to fourteen words used to be thrown away whole, which read as silence.
  const candidate = opts.lane === 'speech' ? capitalize(trimToBudget(digitsToWords(text), max)) : text;
  const words = countWords(candidate);
  const term = findForbiddenTerm(candidate);
  const fail = (reason: 'forbidden' | 'too_long' | 'digit'): LanguageCheck => ({
    verdict: opts.lane === 'speech' ? 'blanked' : 'rejected_422',
    text: '',
    reason,
    term,
    words,
  });
  if (term) return fail('forbidden');
  if (opts.lane === 'speech' && hasDigit(candidate)) return fail('digit');
  if (words > max) return fail('too_long');
  const repaired = candidate.toLowerCase() !== text.trim().toLowerCase();
  return { verdict: repaired ? 'repaired' : 'pass', text: candidate, words };
}

const capitalize = (s: string): string => (s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s);

/** Keep whole sentences while they fit; else the first `max` words with a full stop. */
export function trimToBudget(text: string, max: number): string {
  const t = text.trim();
  if (countWords(t) <= max) return t;
  const sentences = t.match(/[^.!?]+[.!?]?/g) ?? [t];
  let out = '';
  for (const s of sentences) {
    const next = `${out} ${s.trim()}`.trim();
    if (countWords(next) > max) break;
    out = next;
  }
  if (out.length > 0) return out;
  const cut = t.split(/\s+/).slice(0, max).join(' ').replace(/[,;:]$/, '');
  return /[.!?]$/.test(cut) ? cut : `${cut}.`;
}

/** Convenience for the vision path: the speech string Claude may say, or ''. */
export function sanitizeSpeech(speech: unknown): { speech: string; verdict: LanguageVerdict } {
  if (typeof speech !== 'string' || speech.trim() === '') return { speech: '', verdict: 'pass' };
  const c = checkLanguage(speech, { lane: 'speech' });
  return { speech: c.text, verdict: c.verdict };
}
