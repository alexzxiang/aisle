/**
 * Aisle identification from raw OCR reads (04 Task 3).
 *
 * The native module emits Vision's text unmodified (09 §5.5); everything textual
 * happens here, once, so a fixture replayed through the mock and a live frame
 * normalize identically:
 *
 *   1. normalize: uppercase, strip punctuation, collapse whitespace, tokenize;
 *      digit-confusion map (O→0, I/l→1, S→5, B→8, Z→2) on tokens that are
 *      otherwise numeric;
 *   2. reject price-tag text before matching ($, decimal point, FOR / EA / LB /
 *      OZ / SAVE, box too small for a hanging sign);
 *   3. fuzzy match against every aisle's and landmark's `signText`: numeric
 *      entries need an exact digit match; alphabetic entries match a token of
 *      ≥ 3 characters at Levenshtein ≤ 2 (≤ 1 when the entry has ≤ 4 letters);
 *      a read matching two different ids is a two-match, not a match;
 *   4. two signs in one frame → the read with the larger box;
 *   5. 2-of-3 vote over the last three processed reads inside a 3 s window;
 *   6. plausibility: a candidate > 2 orders from the navigator's current order is
 *      held until three reads in a row agree (`isPlausible` is injected);
 *   7. no-match / two-match are handed to Claude by the caller, ≤ 1 per 4 s.
 *
 * Everything but `createAisleMatcher` is a pure function.
 */
import type { OcrRead } from '../core/contracts';
import { type AisleStoreMap, orderOf } from './storeMap';

// ---------------------------------------------------------------------------
// 1. Normalization
// ---------------------------------------------------------------------------

/** Uppercase, punctuation → space, collapse whitespace. Idempotent. */
export function normalizeText(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function tokenize(normalized: string): string[] {
  return normalized.length === 0 ? [] : normalized.split(' ');
}

const CONFUSION: Readonly<Record<string, string>> = { O: '0', I: '1', L: '1', S: '5', B: '8', Z: '2' };
const CONFUSABLE_RE = /^[0-9OILSBZ]+$/;

/**
 * Apply the digit-confusion map only to tokens that are otherwise numeric: every
 * character is a digit or a confusable glyph, and the token either already holds
 * a digit or is a single glyph (a lone "I" or "l" on an aisle sign is a 1). A
 * token like "DA1RY" is left alone so the alphabetic matcher can fix it instead.
 */
export function fixDigitConfusions(token: string): string {
  if (!CONFUSABLE_RE.test(token)) return token;
  if (!/\d/.test(token) && token.length !== 1) return token;
  let out = '';
  for (const ch of token) out += CONFUSION[ch] ?? ch;
  return out;
}

export function isNumericToken(token: string): boolean {
  return /^\d+$/.test(token);
}

/** Normalized tokens with digit confusions fixed on the numeric-looking ones. */
export function normalizeTokens(raw: string): string[] {
  return tokenize(normalizeText(raw)).map(fixDigitConfusions);
}

// ---------------------------------------------------------------------------
// 2. Price-tag rejection
// ---------------------------------------------------------------------------

export const PRICE_WORDS: ReadonlySet<string> = new Set(['FOR', 'EA', 'LB', 'OZ', 'SAVE']);
/** Normalized box height below which a read is a shelf label, not a hanging sign (phase-0 measured). */
export const DEFAULT_MIN_SIGN_BOX_HEIGHT = 0.015;

export type RejectReason = 'price' | 'small_box' | 'empty';

export function priceTagReason(raw: string): 'price' | null {
  if (raw.includes('$')) return 'price';
  if (/\d\s*[.,]\s*\d/.test(raw)) return 'price';
  for (const tok of tokenize(normalizeText(raw))) {
    if (PRICE_WORDS.has(tok)) return 'price';
  }
  return null;
}

export function rejectReason(read: OcrRead, minBoxHeight = DEFAULT_MIN_SIGN_BOX_HEIGHT): RejectReason | null {
  if (normalizeText(read.text).length === 0) return 'empty';
  const price = priceTagReason(read.text);
  if (price) return price;
  if (read.box[3] < minBoxHeight) return 'small_box';
  return null;
}

// ---------------------------------------------------------------------------
// 3. Fuzzy matching
// ---------------------------------------------------------------------------

/** Levenshtein distance, small strings only. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length]!;
}

/** Distance an alphabetic map entry tolerates: ≤ 1 for short words (DELI, ICE), else ≤ 2. */
export function toleranceFor(entry: string): number {
  return entry.length <= 4 ? 1 : 2;
}

export const MIN_ALPHA_TOKEN_LEN = 3;

/**
 * Does one normalized map entry match any of the read's tokens? Numeric entries
 * need an exact numeric token ("3" is never "8"); alphabetic entries of ≥ 3
 * characters use the tolerance above against tokens of ≥ 3 characters; shorter
 * alphabetic entries need an exact token.
 */
export function entryMatchesTokens(entry: string, tokens: readonly string[]): boolean {
  const e = normalizeTokens(entry).join(' ');
  if (e.length === 0) return false;
  if (isNumericToken(e)) return tokens.some((t) => t === e);
  if (e.includes(' ')) {
    // Multi-word entry ("ICE CREAM"): match on the joined token string.
    const joined = tokens.join(' ');
    return joined.includes(e) || editDistance(joined, e) <= toleranceFor(e);
  }
  if (e.length < MIN_ALPHA_TOKEN_LEN) return tokens.some((t) => t === e);
  const tol = toleranceFor(e);
  return tokens.some((t) => t.length >= MIN_ALPHA_TOKEN_LEN && !isNumericToken(t) && editDistance(t, e) <= tol);
}

export type MatchKind = 'aisle' | 'landmark';

export interface MatchCandidate {
  id: string;
  kind: MatchKind;
  order: number;
  /** Which signText entries hit (numeric hits are worth more downstream). */
  hits: string[];
}

export type MatchResult =
  | { kind: 'match'; candidate: MatchCandidate; tokens: string[] }
  | { kind: 'two_match'; candidates: MatchCandidate[]; tokens: string[] }
  | { kind: 'none'; tokens: string[] }
  | { kind: 'rejected'; reason: RejectReason; tokens: string[] };

/** Match one read against the whole map. Pure. */
export function matchRead(read: OcrRead, map: AisleStoreMap, minBoxHeight = DEFAULT_MIN_SIGN_BOX_HEIGHT): MatchResult {
  const tokens = normalizeTokens(read.text);
  const reason = rejectReason(read, minBoxHeight);
  if (reason) return { kind: 'rejected', reason, tokens };

  const candidates: MatchCandidate[] = [];
  for (const a of map.aisles) {
    const hits = a.signText.filter((s) => entryMatchesTokens(s, tokens));
    if (hits.length > 0) candidates.push({ id: a.id, kind: 'aisle', order: a.order, hits });
  }
  for (const l of map.landmarks) {
    const hits = l.signText.filter((s) => entryMatchesTokens(s, tokens));
    if (hits.length > 0) candidates.push({ id: l.id, kind: 'landmark', order: l.afterAisleOrder, hits });
  }
  if (candidates.length === 0) return { kind: 'none', tokens };
  if (candidates.length === 1) return { kind: 'match', candidate: candidates[0]!, tokens };

  // A read whose numeric token names exactly one aisle and whose word also names that
  // same aisle is one match; a number for one aisle and a word for another is a two-match.
  const numericHits = candidates.filter((c) => c.hits.some((h) => isNumericToken(normalizeTokens(h).join(''))));
  if (numericHits.length === 1) {
    const others = candidates.filter((c) => c !== numericHits[0]);
    // Another candidate matched on a word alone: ambiguous (the dangerous case).
    if (others.length > 0) return { kind: 'two_match', candidates, tokens };
    return { kind: 'match', candidate: numericHits[0]!, tokens };
  }
  return { kind: 'two_match', candidates, tokens };
}

// ---------------------------------------------------------------------------
// 4. Two signs in one frame
// ---------------------------------------------------------------------------

export function boxArea(box: OcrRead['box']): number {
  return Math.max(0, box[2]) * Math.max(0, box[3]);
}

/** The read with the largest box, ignoring empties. */
export function pickLargestRead(reads: readonly OcrRead[]): OcrRead | null {
  let best: OcrRead | null = null;
  for (const r of reads) {
    if (normalizeText(r.text).length === 0) continue;
    if (!best || boxArea(r.box) > boxArea(best.box)) best = r;
  }
  return best;
}

// ---------------------------------------------------------------------------
// 5. 2-of-3 vote
// ---------------------------------------------------------------------------

export const VOTE_WINDOW_MS = 3000;
export const VOTE_NEED = 2;
export const VOTE_OF = 3;

export interface Vote {
  id: string;
  confidence: number;
  t: number;
}

export interface VoteWinner {
  id: string;
  confidence: number;   // mean OCR confidence of the agreeing reads
  agreeing: number;
}

export interface Voter {
  push(v: Vote): VoteWinner | null;
  /** Last `of` votes, oldest first (tests / DebugPanel). */
  history(): Vote[];
  reset(): void;
}

export function createVoter(opts: { windowMs?: number; need?: number; of?: number } = {}): Voter {
  const windowMs = opts.windowMs ?? VOTE_WINDOW_MS;
  const need = opts.need ?? VOTE_NEED;
  const of = opts.of ?? VOTE_OF;
  let ring: Vote[] = [];
  return {
    push(v) {
      ring.push(v);
      ring = ring.filter((x) => v.t - x.t <= windowMs);
      if (ring.length > of) ring = ring.slice(ring.length - of);
      const agreeing = ring.filter((x) => x.id === v.id);
      if (agreeing.length < need) return null;
      const confidence = agreeing.reduce((s, x) => s + x.confidence, 0) / agreeing.length;
      return { id: v.id, confidence, agreeing: agreeing.length };
    },
    history: () => [...ring],
    reset() {
      ring = [];
    },
  };
}

// ---------------------------------------------------------------------------
// 6. Plausibility hold
// ---------------------------------------------------------------------------

export const PLAUSIBLE_ORDER_SPAN = 2;
export const IMPLAUSIBLE_STREAK_NEEDED = 3;

export interface PlausibilityGate {
  /** True when the candidate may be emitted now. */
  admit(id: string, plausible: boolean): boolean;
  reset(): void;
}

/** A candidate the navigator calls implausible is admitted only after three reads in a row agree. */
export function createPlausibilityGate(needed = IMPLAUSIBLE_STREAK_NEEDED): PlausibilityGate {
  let streakId: string | null = null;
  let streak = 0;
  return {
    admit(id, plausible) {
      if (plausible) {
        streakId = null;
        streak = 0;
        return true;
      }
      if (streakId === id) streak += 1;
      else {
        streakId = id;
        streak = 1;
      }
      if (streak >= needed) {
        streakId = null;
        streak = 0;
        return true;
      }
      return false;
    },
    reset() {
      streakId = null;
      streak = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// 7. The matcher: reads in, at most one identification out
// ---------------------------------------------------------------------------

export const IDENTIFY_DEDUPE_MS = 10_000;
export const CLAUDE_HANDOFF_MIN_INTERVAL_MS = 4000;

export interface Identification {
  id: string;
  kind: MatchKind;
  order: number;
  label: string;
  confidence: number;
}

export interface MatcherOutput {
  /** Set when a new sign was identified (2-of-3, plausible, not a 10 s re-read). */
  identified: Identification | null;
  /** Set when the caller should ask Claude (no match with real text, or a two-match). */
  handoff: 'no_match' | 'two_match' | null;
  /** Normalized tokens of the read that was processed (facts for Claude). */
  tokens: string[];
  result: MatchResult | null;
}

export interface AisleMatcherOptions {
  map: AisleStoreMap;
  /** The navigator's window: |order − currentOrder| ≤ 2, or current unknown. */
  isPlausible: (order: number) => boolean;
  now?: () => number;
  minBoxHeight?: number;
  voter?: Voter;
}

export interface AisleMatcher {
  process(reads: readonly OcrRead[]): MatcherOutput;
  /** Latest normalized token set (scene-change gating for Claude). */
  lastTokens(): string[];
  reset(): void;
}

export function createAisleMatcher(opts: AisleMatcherOptions): AisleMatcher {
  const now = opts.now ?? Date.now;
  const voter = opts.voter ?? createVoter();
  const gate = createPlausibilityGate();
  const lastEmitted = new Map<string, number>();
  let lastHandoffAt = -Infinity;
  let lastTokens: string[] = [];

  const labelFor = (id: string, kind: MatchKind): string => {
    if (kind === 'aisle') return opts.map.aisles.find((a) => a.id === id)?.label ?? id;
    return opts.map.landmarks.find((l) => l.id === id)?.label ?? id;
  };

  const empty = (result: MatchResult | null, tokens: string[]): MatcherOutput => ({ identified: null, handoff: null, tokens, result });

  return {
    process(reads) {
      const read = pickLargestRead(reads);
      if (!read) return empty(null, []);
      const t = now();
      const result = matchRead(read, opts.map, opts.minBoxHeight);
      lastTokens = result.tokens;

      if (result.kind === 'rejected') return empty(result, result.tokens);

      if (result.kind === 'none' || result.kind === 'two_match') {
        const realText = result.tokens.some((tok) => tok.length >= MIN_ALPHA_TOKEN_LEN);
        const wants = result.kind === 'two_match' || realText;
        if (wants && t - lastHandoffAt >= CLAUDE_HANDOFF_MIN_INTERVAL_MS) {
          lastHandoffAt = t;
          return { identified: null, handoff: result.kind === 'two_match' ? 'two_match' : 'no_match', tokens: result.tokens, result };
        }
        return empty(result, result.tokens);
      }

      const c = result.candidate;
      const win = voter.push({ id: c.id, confidence: read.confidence, t });
      if (!win) return empty(result, result.tokens);

      const order = orderOf(opts.map, c.id) ?? c.order;
      if (!gate.admit(c.id, opts.isPlausible(order))) return empty(result, result.tokens);

      const last = lastEmitted.get(c.id);
      if (last !== undefined && t - last < IDENTIFY_DEDUPE_MS) return empty(result, result.tokens);
      lastEmitted.set(c.id, t);

      return {
        identified: { id: c.id, kind: c.kind, order, label: labelFor(c.id, c.kind), confidence: win.confidence },
        handoff: null,
        tokens: result.tokens,
        result,
      };
    },
    lastTokens: () => [...lastTokens],
    reset() {
      voter.reset();
      gate.reset();
      lastEmitted.clear();
      lastHandoffAt = -Infinity;
      lastTokens = [];
    },
  };
}
