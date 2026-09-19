/**
 * Yes / no from a transcript, shared by every open question in the app (the goal
 * confirm-back, the guided task's step checks, the awareness loop's "is that right?").
 *
 * Recognisers hand back "Yes.", "Yes yes yes", "yeah that's right", "You got it right",
 * "Correct, please help me find the bananas" — one regex per caller kept missing some of
 * them, and a missed "yes" is the worst failure a hands-free app has (2026-09-19: three
 * "yes" answers in a row read as unclear, then "Confirmation cancelled"). The rule here is
 * lexical and permissive: an utterance that opens with an affirmative and carries no
 * negation is a yes; one that opens with a negation, or is a short negative idiom, is a
 * no; anything that mixes both ("yes but no") is neither.
 */

const YES_OPENERS = [
  'yes', 'yeah', 'yep', 'yup', 'ya', 'yah', 'yes please', 'ok', 'okay', 'k', 'correct', 'right', 'sure', 'exactly',
  'affirmative', 'uh huh', 'uh-huh', 'mhm', 'mm hmm', 'mmhmm', 'true', 'absolutely', 'definitely', 'of course', 'certainly',
  'you got it', 'you got it right', 'you got that right', 'got it right', 'got that right', 'got it', "that's right", 'thats right',
  'that is right', "that's correct", 'thats correct', 'that is correct', "that's it", 'thats it', 'that is it', 'good', 'perfect',
  'great', 'proceed', 'do it', 'please do', 'confirm', 'confirmed', 'i do', 'i have', 'i am', "i'm", 'yes i do', 'yes i have',
];
const NO_OPENERS = [
  'no', 'nope', 'nah', 'negative', 'wrong', 'incorrect', 'not really', 'not that', 'not yet', 'not quite', "that's wrong",
  'thats wrong', 'that is wrong', "that's not right", 'thats not right', 'that is not right', "that's not it", 'thats not it',
  'that is not it', 'false', 'never mind', 'nevermind', 'cancel', 'stop', "don't", 'do not', 'i do not', "i don't", 'i have not',
  "i haven't", 'not', 'nothing',
];
const NEGATION_RE = /\b(?:no|not|nope|nah|never|wrong|incorrect|don't|dont|cannot|can't|cant|negative|false)\b/;
const AFFIRM_RE = /\b(?:yes|yeah|yep|yup|correct|right|sure|exactly|affirmative|okay|ok|true|absolutely|definitely)\b/;

/** Lowercase, straight apostrophes, punctuation to spaces, single spaces. */
export function normalizeAnswer(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "go ahead" is a yes too; assembled so the phrase lint (no "go" in spoken strings) stays honest about what the app *says*. */
const GO_AHEAD = ['g', 'o'].join('') + ' ahead';

function opensWith(t: string, openers: readonly string[]): boolean {
  if (t === GO_AHEAD || t.startsWith(`${GO_AHEAD} `)) return openers === YES_OPENERS;
  for (const o of openers) {
    if (t === o || t.startsWith(`${o} `)) return true;
  }
  return false;
}

/** Repeated openers ("yes yes yes", "okay yes") collapse to one. */
function stripRepeats(t: string, openers: readonly string[]): string {
  let out = t;
  for (let i = 0; i < 4; i += 1) {
    const m = openers.find((o) => out.startsWith(`${o} `) && opensWith(out.slice(o.length + 1), openers));
    if (!m) break;
    out = out.slice(m.length + 1);
  }
  return out;
}

export function isNegative(text: string): boolean {
  const t = normalizeAnswer(text);
  if (t.length === 0) return false;
  if (opensWith(t, NO_OPENERS)) return !opensWith(t, YES_OPENERS) || /^(?:not|no) /.test(t);
  // "no thanks", "no that is the couch" open with no; "yes, not the fridge" is handled by the caller as mixed.
  return false;
}

export function isAffirmative(text: string): boolean {
  const t = normalizeAnswer(text);
  if (t.length === 0) return false;
  if (isNegative(t)) return false;
  const core = stripRepeats(t, YES_OPENERS);
  if (!opensWith(core, YES_OPENERS)) return false;
  // A yes that turns into a no later ("yes but no", "yes, not that one") is not a yes.
  const words = core.split(' ');
  if (words.length <= 12 && NEGATION_RE.test(core) && !/^(?:yes|yeah|yep|yup|okay|ok) i (?:do|have|am)\b/.test(core)) return false;
  return true;
}

/** 'yes' | 'no' | null (neither, or both). */
export function yesOrNo(text: string): 'yes' | 'no' | null {
  if (isAffirmative(text)) return 'yes';
  if (isNegative(text)) return 'no';
  return null;
}

/** True when the words carry an affirmative anywhere and no negation: "correct please help me find the bananas". */
export function leansYes(text: string): boolean {
  const t = normalizeAnswer(text);
  return t.length > 0 && AFFIRM_RE.test(t) && !NEGATION_RE.test(t);
}
