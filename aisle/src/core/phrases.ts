/**
 * The closed phrase set (01 §3, canonical text from 07 §2) plus the language
 * rules every utterance must pass.
 *
 * This file is plain TypeScript with no React Native imports, because
 * `scripts/generate-audio.ts` and `scripts/lint-phrases.ts` import it under
 * Node. The text here is the only permitted wording for a cache key: other
 * agents pass `cacheKey`s, never their own words for the same file.
 *
 * Keys in `CacheKey` (contracts.ts) are frozen by 01 §3. The A-side additions
 * below are flagged for 01 §3 and listed in `A_SIDE_KEYS`; nobody else calls
 * them until the flag is acked:
 *   - course_hint_left / course_hint_right   (02 Task 3: COURSE side hint while the buzz runs)
 *   - looking_for_signs                      (07 §2: second beat of the handoff, INFO, ≥ 4 s later)
 *   - signal_read_delayed                    (03 Task 6 rung 2: the fallback wording, no variable words)
 *   - say_item_again                         (01 §9: parseIntent fallback reply)
 *   - onboarding_*                           (02 Task 8 script, split to ≤ 12 words per line)
 *   - label_turn / label_stop / label_okay   (02 Task 3: training-mode one-word labels)
 */
import type { CacheKey } from './contracts';
import { PREPARED_GUIDANCE, type PreparedKey } from './preparedGuidance';

// ---------------------------------------------------------------------------
// Language rules
// ---------------------------------------------------------------------------

export const MAX_UTTERANCE_WORDS = 12;
/** Tier-1 camera/user prompts are shorter still (01 §8 item 4). */
export const MAX_PROMPT_WORDS = 6;
/** Long-phrase allow-list (01 §3): the one member is the first-launch disclaimer. */
export const LONG_PHRASE_ALLOWLIST: ReadonlySet<string> = new Set(['disclaimer']);
/** Allow-listed long phrases must still fit this much generated audio. */
export const LONG_PHRASE_MAX_AUDIO_MS = 12_000;

/**
 * Forbidden words (00 principle 7, 01 §3). Matched on word boundaries,
 * case-insensitive, in user-facing text only — identifiers such as
 * `clearQueue` are not text. `go` is the bare word (01 §3); the phrase
 * "go now" is therefore covered as well.
 */
export const FORBIDDEN_TERMS: readonly string[] = ['safe', 'clear', 'go', 'cross now', 'no cars', 'you can cross'];

const FORBIDDEN_RE = new RegExp(
  `\\b(?:${FORBIDDEN_TERMS.map((t) => t.replace(/\s+/g, '\\s+')).join('|')})\\b`,
  'i',
);

/** Returns the first forbidden term found in `text`, or null. */
export function findForbiddenTerm(text: string): string | null {
  const m = text.match(FORBIDDEN_RE);
  return m ? m[0].toLowerCase().replace(/\s+/g, ' ') : null;
}

export function hasDigit(text: string): boolean {
  return /\d/.test(text);
}

/**
 * Word count as a listener hears it: whitespace-separated tokens that contain
 * at least one letter or digit. "don't" and "open-ear" are one word each; a
 * lone dash or ellipsis is not a word.
 */
export function countWords(text: string): number {
  let n = 0;
  for (const tok of text.trim().split(/\s+/)) {
    if (/[\p{L}\p{N}]/u.test(tok)) n += 1;
  }
  return n;
}

/** Keeps the first `max` words (prod truncation path). */
export function truncateWords(text: string, max: number = MAX_UTTERANCE_WORDS): string {
  const toks = text.trim().split(/\s+/);
  const kept: string[] = [];
  let n = 0;
  for (const tok of toks) {
    if (n >= max) break;
    kept.push(tok);
    if (/[\p{L}\p{N}]/u.test(tok)) n += 1;
  }
  return kept.join(' ');
}

export type PhraseViolation =
  | { kind: 'forbidden'; term: string }
  | { kind: 'too_long'; words: number; max: number }
  | { kind: 'digit' }
  | { kind: 'empty' };

export interface CheckPhraseOptions {
  /** Skip the word-count and digit checks (allow-listed long phrase). Never skips the forbidden check. */
  allowLong?: boolean;
  /** Word limit; default 12, 6 for Tier-1 prompts. */
  maxWords?: number;
}

/** All violations for one utterance, in severity order (forbidden first). */
export function checkPhrase(text: string, opts: CheckPhraseOptions = {}): PhraseViolation[] {
  const out: PhraseViolation[] = [];
  const term = findForbiddenTerm(text);
  if (term) out.push({ kind: 'forbidden', term });
  if (countWords(text) === 0) {
    out.push({ kind: 'empty' });
    return out;
  }
  if (!opts.allowLong) {
    const max = opts.maxWords ?? MAX_UTTERANCE_WORDS;
    const words = countWords(text);
    if (words > max) out.push({ kind: 'too_long', words, max });
    if (hasDigit(text)) out.push({ kind: 'digit' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** A-side additions to 01 §3 (flagged; see file header). */
export type ASideKey =
  | PreparedKey
  | 'course_hint_left' | 'course_hint_right'
  | 'looking_for_signs'
  | 'signal_read_delayed'
  | 'say_item_again'
  | 'label_turn' | 'label_stop' | 'label_okay'
  | 'onboarding_intro' | 'onboarding_course_intro' | 'onboarding_course_turn_away'
  | 'onboarding_turn_back' | 'onboarding_this_is_turn' | 'onboarding_this_is_stop'
  | 'onboarding_this_is_okay' | 'onboarding_beacon' | 'onboarding_ticker_slow_fast'
  | 'onboarding_ticker_countdown' | 'onboarding_keep_cane' | 'onboarding_wear_phone'
  | 'onboarding_ring_switch' | 'onboarding_walk_straight' | 'onboarding_practice_scene' | 'onboarding_done'
  | 'route_unavailable' | 'no_route_data'
  | 'need_location' | 'no_store_nearby' | 'say_item_one_word' | 'describe_nothing' | 'not_caught'
  | 'let_me_see' | 'planning_route' | 'no_place_found' | 'arrived_destination' | 'task_done' | 'task_next' | 'task_step_done' | 'task_still_looking'
  | 'show_surroundings' | 'tell_me_where' | 'noted'
  | 'grab_it' | 'hold_out_hand' | 'move_hand_slowly';

export type PhraseKey = CacheKey | ASideKey | PreparedKey;

/**
 * Category drives the SpeechService mode policy (01 §3 table). One category
 * per key; callers never pass a category.
 */
export type PhraseCategory =
  | 'always'        // disclaimer, offline notice — any mode
  | 'compass'       // compass_uncertain — outdoor + curb
  | 'leg'           // turn instructions — walking modes
  | 'crossing_fact' // approach announcements — walking modes
  | 'signal'        // signal transitions — curb
  | 'countdown'     // curb + crossing
  | 'far_curb'      // crossing (and the OUTDOOR_NAV instant after FAR_CURB_REACHED)
  | 'vehicle'       // vehicle alerts — outdoor, curb, crossing (CRITICAL in practice)
  | 'scan'          // unsignalized scan flow and reports — curb
  | 'indoor'        // aisle facts, handoff, checkout, hand hints
  | 'obstacle'      // obstacle ahead — everywhere but the crossing itself
  | 'prompt'        // Tier-1 camera/user prompts — gated (≤ 6 words, ≤ 1 / 3 s, never while COURSE buzzes)
  | 'course_hint'   // A's own side hint — exempt from the COURSE gate
  | 'reply'         // voice replies
  | 'training'      // one-word haptic labels
  | 'onboarding';   // tutorial lines

export interface Phrase {
  key: PhraseKey;
  text: string;
  category: PhraseCategory;
  /** True for A-side additions not yet in 01 §3. */
  aSide?: boolean;
}

const P = (key: PhraseKey, text: string, category: PhraseCategory, aSide?: boolean): Phrase =>
  aSide ? { key, text, category, aSide } : { key, text, category };

/** The closed set, in 01 §3 order, then the A-side additions. */
export const PHRASE_LIST: readonly Phrase[] = [
  ...PREPARED_GUIDANCE.map(({ key, text }) => P(key, text, 'indoor', true)),
  P('disclaimer',
    'Aisle is a prototype, not a safety device. Keep using your cane or guide dog. ' +
    'Aisle reads walk signals and warns about vehicles it can see; it cannot see everything ' +
    'and never decides when to cross.',
    'always'),
  P('compass_uncertain', 'Compass uncertain.', 'compass'),
  P('crossing_ahead_signalized', 'Crossing ahead. Signalized.', 'crossing_fact'),
  P('push_button_likely', 'Push button likely.', 'crossing_fact'),
  P('walk_signal_on', 'Walk signal on.', 'signal'),
  P('walk_already_on_wait', 'Walk already on. Wait for next.', 'signal'),
  P('dont_walk', "Don't walk.", 'signal'),
  P('countdown', 'Countdown.', 'countdown'),
  P('cant_see_signal', "Can't see the signal.", 'signal'),
  P('vehicle_left', 'Vehicle left.', 'vehicle'),
  P('vehicle_right', 'Vehicle right.', 'vehicle'),
  P('vehicle_ahead', 'Vehicle ahead.', 'vehicle'),
  P('far_curb', 'Far curb.', 'far_curb'),
  P('no_signal_point_left', 'No signal here. Point the camera left.', 'scan'),
  P('now_right', 'Now right.', 'scan'),
  P('no_vehicles_left', 'No vehicles seen to the left.', 'scan'),
  P('no_vehicles_right', 'No vehicles seen to the right.', 'scan'),
  P('listen_then_cross', 'Listen, then cross.', 'scan'),
  P('vehicle_approaching_left', 'Vehicle approaching from the left.', 'scan'),
  P('vehicle_approaching_right', 'Vehicle approaching from the right.', 'scan'),
  P('cant_see_well_left', "Can't see well to the left.", 'scan'),
  P('cant_see_well_right', "Can't see well to the right.", 'scan'),
  P('turn_left_soon', 'Turn left in sixty feet.', 'leg'),
  P('turn_right_soon', 'Turn right in sixty feet.', 'leg'),
  P('turn_left_now', 'Turn left now.', 'leg'),
  P('turn_right_now', 'Turn right now.', 'leg'),
  P('entering_store', 'Entering the store.', 'indoor'),
  P('keep_going', 'Keep going, looking for a sign.', 'indoor'),
  P('passed_it_turn_around', "You've passed it. Turn around.", 'indoor'),
  P('checkout_ahead', 'Checkout ahead.', 'indoor'),
  P('obstacle_ahead', 'Obstacle ahead.', 'obstacle'),
  P('tilt_camera_up', 'Tilt the camera up.', 'prompt'),
  P('turn_left_a_little', 'Turn left a little.', 'prompt'),
  P('turn_right_a_little', 'Turn right a little.', 'prompt'),
  P('reach_out', 'Face the shelf. Reach out.', 'indoor'),
  P('higher', 'Higher.', 'indoor'),
  P('lower', 'Lower.', 'indoor'),
  P('left', 'Left.', 'indoor'),
  P('right', 'Right.', 'indoor'),
  P('touching', 'Touching.', 'indoor'),
  P('reach_forward', 'Reach forward.', 'indoor'),
  P('grab_it', 'Grab it.', 'indoor', true),
  P('hold_out_hand', 'Hold out your hand.', 'indoor', true),
  P('move_hand_slowly', 'I do not see it. Move your hand slowly.', 'indoor', true),
  P('ask_staff', 'Ask staff for help finding it.', 'indoor'),
  P('offline_notice', 'Offline. Signal reading and directions still work.', 'always'),
  P('route_unavailable', 'Route unavailable. Try again shortly.', 'always', true),
  P('no_route_data', 'No route data. Heading straight to the store.', 'always', true),
  // Round 4: destinations ("take me to CVS") and guided tasks ("eggs in my fridge")
  P('let_me_see', 'Let me see your surroundings.', 'always', true),
  P('planning_route', 'Planning your route.', 'always', true),
  P('no_place_found', 'I could not find that place nearby.', 'always', true),
  P('arrived_destination', 'You have arrived.', 'always', true),
  P('task_done', 'Done. Task complete.', 'indoor', true),
  P('task_next', 'Next step.', 'indoor', true),
  P('task_step_done', 'Step done.', 'indoor', true),
  // A guided task can go quiet between the 20 s step reminders (the describer and situate
  // stay silent in GUIDED_TASK); this fills the gap so it feels like a guide, at INFO.
  P('task_still_looking', 'Still with you. Keep turning slowly.', 'indoor', true),
  // Awareness loop (situate.ts): the standing ask, the follow-up after a "no", the acknowledgement.
  P('show_surroundings', 'Turn slowly. Show me your surroundings.', 'reply', true),
  P('tell_me_where', 'Tell me where you are.', 'reply', true),
  P('noted', 'Got it.', 'reply', true),
  // Proactive prompts when information is missing (round 3; flagged for 01 §3).
  P('need_location', 'I need your location. Step outside.', 'always', true),
  P('no_store_nearby', 'I cannot find a store nearby.', 'always', true),
  P('say_item_one_word', 'Say the item again, one word.', 'reply', true),
  P('describe_nothing', 'Nothing to describe right now.', 'reply', true),
  P('not_caught', 'I did not catch that. Say it again.', 'reply', true),
  // --- A-side additions (flagged for 01 §3) ---
  P('course_hint_left', 'Bear left.', 'course_hint', true),
  P('course_hint_right', 'Bear right.', 'course_hint', true),
  P('looking_for_signs', 'Looking for aisle signs.', 'indoor', true),
  P('signal_read_delayed', 'Signal read is delayed.', 'signal', true),
  P('say_item_again', 'Say the item again.', 'reply', true),
  P('label_turn', 'Turn.', 'training', true),
  P('label_stop', 'Stop.', 'training', true),
  P('label_okay', 'Okay.', 'training', true),
  P('onboarding_intro', "Aisle uses four vibrations and two sounds. Let's learn them.", 'onboarding', true),
  P('onboarding_course_intro', 'When you are on course, Aisle is silent.', 'onboarding', true),
  P('onboarding_course_turn_away', 'Turn away from the target and feel the buzz grow.', 'onboarding', true),
  P('onboarding_turn_back', 'Turn back until it stops.', 'onboarding', true),
  P('onboarding_this_is_turn', 'This is turn.', 'onboarding', true),
  P('onboarding_this_is_stop', 'This is stop. It means a vehicle or an obstacle.', 'onboarding', true),
  P('onboarding_this_is_okay', 'This is okay.', 'onboarding', true),
  P('onboarding_beacon', 'This pulse points where to walk. Turn until it is centered.', 'onboarding', true),
  P('onboarding_ticker_slow_fast', "At a crossing, slow ticks mean don't walk. Fast ticks mean walk.", 'onboarding', true),
  P('onboarding_ticker_countdown', 'Medium ticks mean countdown. No ticks means Aisle cannot see the signal.', 'onboarding', true),
  P('onboarding_keep_cane', 'Keep your cane or dog. Use open-ear headphones to hear traffic.', 'onboarding', true),
  P('onboarding_wear_phone', 'Wear the phone on the lanyard, screen out.', 'onboarding', true),
  P('onboarding_ring_switch', 'Keep the ring switch on.', 'onboarding', true),
  P('onboarding_walk_straight', 'Now walk straight for five seconds.', 'onboarding', true),
  // The lesson's last beat rehearses the awareness loop's yes / no answer (situate.ts).
  P('onboarding_practice_scene', 'You seem to be indoors. Is that right?', 'onboarding', true),
  P('onboarding_done', 'All set. Hold the talk button and say what you need.', 'onboarding', true),
];

export const PHRASES: Readonly<Record<PhraseKey, string>> = Object.freeze(
  Object.fromEntries(PHRASE_LIST.map((p) => [p.key, p.text])) as Record<PhraseKey, string>,
);

export const PHRASE_CATEGORY: Readonly<Record<PhraseKey, PhraseCategory>> = Object.freeze(
  Object.fromEntries(PHRASE_LIST.map((p) => [p.key, p.category])) as Record<PhraseKey, PhraseCategory>,
);

export const PHRASE_KEYS: readonly PhraseKey[] = PHRASE_LIST.map((p) => p.key);
export const A_SIDE_KEYS: readonly ASideKey[] = PHRASE_LIST.filter((p) => p.aSide).map((p) => p.key as ASideKey);

/** The 01 §3 list, verbatim, for the coverage test and the generator. */
export const CONTRACT_CACHE_KEYS: readonly CacheKey[] = [
  'disclaimer', 'compass_uncertain', 'crossing_ahead_signalized', 'push_button_likely',
  'walk_signal_on', 'walk_already_on_wait', 'dont_walk', 'countdown', 'cant_see_signal',
  'vehicle_left', 'vehicle_right', 'vehicle_ahead', 'far_curb', 'no_signal_point_left', 'now_right',
  'no_vehicles_left', 'no_vehicles_right', 'listen_then_cross', 'vehicle_approaching_left',
  'vehicle_approaching_right', 'cant_see_well_left', 'cant_see_well_right',
  'turn_left_soon', 'turn_right_soon', 'turn_left_now', 'turn_right_now', 'entering_store',
  'keep_going', 'passed_it_turn_around', 'checkout_ahead', 'obstacle_ahead', 'tilt_camera_up',
  'turn_left_a_little', 'turn_right_a_little', 'reach_out', 'higher', 'lower', 'left', 'right',
  'touching', 'ask_staff', 'offline_notice', 'reach_forward',
];

/** Tier-1 prompt keys: the only class gated "never while COURSE is buzzing" (02 Task 4). */
export const TIER1_PROMPT_KEYS: ReadonlySet<string> = new Set<PhraseKey>([
  'tilt_camera_up', 'turn_left_a_little', 'turn_right_a_little',
]);

export function isPhraseKey(key: string): key is PhraseKey {
  return Object.prototype.hasOwnProperty.call(PHRASES, key);
}

export function phraseText(key: PhraseKey): string {
  const text = PHRASES[key];
  if (text === undefined) throw new Error(`Unknown phrase key: ${key}`);
  return text;
}

export function phraseCategory(key: string): PhraseCategory | null {
  return isPhraseKey(key) ? PHRASE_CATEGORY[key] ?? null : null;
}

const KEY_BY_TEXT: ReadonlyMap<string, PhraseKey> = new Map(PHRASE_LIST.map((p) => [p.text, p.key]));

/** The cache key whose canonical wording is exactly `text`, or null (free text). */
export function phraseKeyForText(text: string): PhraseKey | null {
  return KEY_BY_TEXT.get(text) ?? null;
}

/** Violations for every phrase in the table (the lint script and the unit test share this). */
export function lintPhraseTable(): Array<{ key: PhraseKey; violations: PhraseViolation[] }> {
  const out: Array<{ key: PhraseKey; violations: PhraseViolation[] }> = [];
  for (const p of PHRASE_LIST) {
    const v = checkPhrase(p.text, {
      allowLong: LONG_PHRASE_ALLOWLIST.has(p.key),
      maxWords: p.category === 'prompt' ? MAX_PROMPT_WORDS : MAX_UTTERANCE_WORDS,
    });
    if (v.length > 0) out.push({ key: p.key, violations: v });
  }
  return out;
}
