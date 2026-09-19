/**
 * The five Nemotron Planner jobs (01 §9, 03 Task 7): JSON schemas for
 * `nvext.guided_json`, system prompts, output validators and the deterministic
 * templated fallbacks. Pure. Shared by `server/routes/plan.ts` (the proxy) and
 * `src/outdoor/planner.ts` (the client, which falls back locally when the proxy
 * is unreachable) so the walk never waits on the model.
 *
 * Validation after the grammar: ≤ 12 words per phrase, no digits, none of the
 * forbidden phrases, enums exact — and fall back per field, never per call.
 */
import type {
  AnswerInput,
  AnswerOutput,
  CrossingAnnounceInput,
  CrossingAnnounceOutput,
  DisambiguateInput,
  DisambiguateOutput,
  ParseIntentInput,
  ParseIntentOutput,
  PlannerJob,
  RouteCompileInput,
  RouteCompileOutput,
  TaskPlanInput,
  TaskPlanOutput,
} from '../core/contracts';
import { countWords, findForbiddenTerm, hasDigit } from '../core/phrases';
import { feetWords, integerToWords, spokenStreet } from './numberWords';
import { WALKING_BETA_WARNING } from './types';

export const PLANNER_JOBS: readonly PlannerJob[] = ['routeCompile', 'parseIntent', 'disambiguate', 'crossingAnnounce', 'answer', 'taskPlan'];

export const MAX_PHRASE_WORDS = 12;

/** Per-job deadlines (01 §9 table). */
export const JOB_DEADLINES_MS: Readonly<Record<PlannerJob, { firstToken: number; total: number }>> = {
  // NIM is non-streaming (see server/lib/nim.ts): the whole answer arrives at once, so the
  // first-token and total deadlines are equal. routeCompile / crossingAnnounce run at route
  // fetch (not user-facing latency); the three interactive jobs cap at 4.5 s then template.
  // Round 6c: 6 s — Haiku races as understudy (server/lib/claudePlan.ts) and answers a miss within
  // its 1.5 s grace, so a route no longer waits 8 s on a slow Nemotron night.
  routeCompile: { firstToken: 6000, total: 6000 },
  crossingAnnounce: { firstToken: 6000, total: 6000 },
  parseIntent: { firstToken: 4500, total: 4500 },
  disambiguate: { firstToken: 4500, total: 4500 },
  answer: { firstToken: 4500, total: 4500 },
  taskPlan: { firstToken: 8000, total: 8000 },   // once per task, off the real-time path
};

export type JobInput<J extends PlannerJob> =
  J extends 'routeCompile' ? RouteCompileInput :
  J extends 'parseIntent' ? ParseIntentInput :
  J extends 'disambiguate' ? DisambiguateInput :
  J extends 'crossingAnnounce' ? CrossingAnnounceInput :
  J extends 'taskPlan' ? TaskPlanInput :
  AnswerInput;

export type JobOutput<J extends PlannerJob> =
  J extends 'routeCompile' ? RouteCompileOutput :
  J extends 'parseIntent' ? ParseIntentOutput :
  J extends 'disambiguate' ? DisambiguateOutput :
  J extends 'crossingAnnounce' ? CrossingAnnounceOutput :
  J extends 'taskPlan' ? TaskPlanOutput :
  AnswerOutput;

// ---------------------------------------------------------------------------
// Phrase validity
// ---------------------------------------------------------------------------

/** A spoken phrase is valid when it is ≤ 12 words, digit-free and clean. Empty is valid. */
export function isValidPhrase(text: unknown, allowEmpty = true): text is string {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (t === '') return allowEmpty;
  if (countWords(t) > MAX_PHRASE_WORDS) return false;
  if (hasDigit(t)) return false;
  if (t !== WALKING_BETA_WARNING && findForbiddenTerm(t) !== null) return false;
  return true;
}

/** Model replies often carry bare integers ("400 feet") despite the prompt; spell them out
 * before validation so the no-digits rule rejects only what cannot be repaired. Decimals,
 * times and codes (anything with '.', ':', '/', letters glued on) are left alone → rejected. */
export function digitsToWords(text: string): string {
  return text.replace(/(?<![\w.:/-])(\d{1,6})(?![\w.:/-])/g, (m) => {
    const n = Number(m);
    return Number.isSafeInteger(n) ? integerToWords(n) : m;
  });
}

function pick(candidate: unknown, fallback: string, allowEmpty = true): string {
  const c = typeof candidate === 'string' ? digitsToWords(candidate) : candidate;
  return isValidPhrase(c, allowEmpty) ? (c as string).trim() : fallback;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// routeCompile
// ---------------------------------------------------------------------------

const MANEUVER_WORDS: Record<string, { soon: string; now: string } | null> = {
  TURN_LEFT: { soon: 'Turn left in sixty feet.', now: 'Turn left now.' },
  TURN_RIGHT: { soon: 'Turn right in sixty feet.', now: 'Turn right now.' },
  SLIGHT_LEFT: { soon: 'Bear left in sixty feet.', now: 'Bear left now.' },
  SLIGHT_RIGHT: { soon: 'Bear right in sixty feet.', now: 'Bear right now.' },
  UTURN: { soon: 'Turn around in sixty feet.', now: 'Turn around now.' },
  STRAIGHT: null,
  ARRIVE: null,
};

/** "Continue on Forbes Avenue, about two hundred feet." — trimmed to 12 words. */
export function confirmPhrase(street: string, distanceM: number, maneuver: string): string {
  if (maneuver === 'ARRIVE') return `Entrance ahead, ${feetWords(distanceM)}.`;
  const spoken = spokenStreet(street);
  if (spoken !== '') {
    const full = `Continue on ${spoken}, ${feetWords(distanceM)}.`;
    if (countWords(full) <= MAX_PHRASE_WORDS) return full;
    const short = `Continue on ${spoken}.`;
    if (countWords(short) <= MAX_PHRASE_WORDS) return short;
  }
  return `Continue straight, ${feetWords(distanceM)}.`;
}

export function templateLeg(step: RouteCompileInput['steps'][number]): RouteCompileOutput['legs'][number] {
  const words = MANEUVER_WORDS[step.maneuver] ?? null;
  const street = streetFromInstruction(step.instruction);
  return {
    index: step.index,
    soon: words?.soon ?? '',
    now: words?.now ?? '',
    confirm: confirmPhrase(street, step.distanceM, step.maneuver),
  };
}

/** The street named in a Google instruction ("Turn right onto Forbes Ave" → "Forbes Ave"). */
export function streetFromInstruction(instruction: string): string {
  const first = (instruction ?? '').split(/\n|\r/)[0] ?? '';
  const m = /\b(?:onto|on)\s+(.+)$/i.exec(first.trim());
  if (!m) return '';
  return ((m[1] ?? '').split(/\s+(?:toward|towards|then)\b/i)[0] ?? '').replace(/[.,;:]+$/, '').trim();
}

/** "Crossing ahead: Forbes Avenue. Signalized. Push button likely." */
export function crossingAnnouncementText(c: { street: string; signalized: boolean | null; pushButtonLikely: boolean }): string {
  const street = spokenStreet(c.street);
  let text = street === '' ? 'Crossing ahead.' : `Crossing ahead: ${street}.`;
  if (c.signalized === true) text += ' Signalized.';
  if (c.pushButtonLikely) text += ' Push button likely.';
  if (countWords(text) > MAX_PHRASE_WORDS) {
    text = street === '' ? 'Crossing ahead.' : `Crossing ahead: ${street}.`;
  }
  if (countWords(text) > MAX_PHRASE_WORDS) text = 'Crossing ahead.';
  return text;
}

export function templateRouteCompile(input: RouteCompileInput): RouteCompileOutput {
  return {
    legs: input.steps.map(templateLeg),
    crossingAnnouncements: input.crossings.map((c) => ({ crossingId: c.crossingId, text: crossingAnnouncementText(c) })),
  };
}

export const ROUTE_COMPILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['legs', 'crossingAnnouncements'],
  properties: {
    legs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'soon', 'now', 'confirm'],
        properties: {
          index: { type: 'integer', minimum: 0 },
          soon: { type: 'string', maxLength: 90 },
          now: { type: 'string', maxLength: 60 },
          confirm: { type: 'string', maxLength: 100 },
        },
      },
    },
    crossingAnnouncements: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['crossingId', 'text'],
        properties: {
          crossingId: { type: 'string' },
          text: { type: 'string', maxLength: 100 },
        },
      },
    },
  },
} as const;

export const ROUTE_COMPILE_PROMPT = [
  'You compile walking directions for a blind pedestrian walking at a normal pace.',
  'Input: JSON with steps (index, instruction, maneuver, distanceM, startBearingDeg) and crossings.',
  'For every step output one leg with the same index and three phrases:',
  '- soon: spoken about sixty feet before the maneuver; say "sixty feet" or give no distance.',
  '- now: the imperative at the maneuver point, e.g. "Turn left now."',
  '- confirm: names the street to continue on and its length in feet, written as words.',
  'Maneuver STRAIGHT: soon and now are empty strings. Maneuver ARRIVE: soon and now are empty; confirm is "Entrance ahead, about N feet." with N as words.',
  'Rules for every phrase: at most twelve words; no digits, write every number as words; no abbreviations, spell street names out ("Forbes Avenue", "South Bouquet Street").',
  'Never say anything about when to cross, traffic, or whether it is fine to proceed.',
  'For every crossing output text exactly "Crossing ahead: <street>. Signalized." when signalized is true, or "Crossing ahead: <street>." otherwise, adding " Push button likely." when pushButtonLikely is true.',
  'Output JSON only.',
].join('\n');

function validateRouteCompile(raw: unknown, input: RouteCompileInput): { output: RouteCompileOutput; usedFallback: boolean } {
  const template = templateRouteCompile(input);
  let usedFallback = false;
  const rawObj = (raw ?? {}) as Partial<RouteCompileOutput>;
  const rawLegs = Array.isArray(rawObj.legs) ? rawObj.legs : [];
  const rawXings = Array.isArray(rawObj.crossingAnnouncements) ? rawObj.crossingAnnouncements : [];

  const legs = template.legs.map((t) => {
    const candidate = rawLegs.find((l) => l && typeof l === 'object' && (l as { index?: unknown }).index === t.index) as Partial<RouteCompileOutput['legs'][number]> | undefined;
    if (!candidate) {
      usedFallback = true;
      return t;
    }
    const soonNowAllowed = MANEUVER_WORDS[input.steps.find((s) => s.index === t.index)?.maneuver ?? ''] !== null;
    const soon = soonNowAllowed ? pick(candidate.soon, t.soon) : '';
    const now = soonNowAllowed ? pick(candidate.now, t.now) : '';
    const confirm = pick(candidate.confirm, t.confirm, false);
    if (soon !== (candidate.soon ?? '').trim() || now !== (candidate.now ?? '').trim() || confirm !== (candidate.confirm ?? '').trim()) usedFallback = true;
    return { index: t.index, soon, now, confirm };
  });

  const crossingAnnouncements = template.crossingAnnouncements.map((t) => {
    const candidate = rawXings.find((x) => x && typeof x === 'object' && (x as { crossingId?: unknown }).crossingId === t.crossingId) as Partial<RouteCompileOutput['crossingAnnouncements'][number]> | undefined;
    const text = pick(candidate?.text, t.text, false);
    if (!candidate || text !== (candidate.text ?? '').trim()) usedFallback = true;
    return { crossingId: t.crossingId, text };
  });

  return { output: { legs, crossingAnnouncements }, usedFallback };
}

// ---------------------------------------------------------------------------
// parseIntent
// ---------------------------------------------------------------------------

export const INTENTS = ['find_item', 'navigate_to', 'guided_task', 'repeat', 'how_far', 'where_am_i', 'abort', 'help', 'unknown'] as const;

export const PARSE_INTENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'item', 'destination', 'goal', 'reply'],
  properties: {
    intent: { type: 'string', enum: [...INTENTS] },
    item: { type: ['string', 'null'] },
    destination: { type: ['string', 'null'], maxLength: 60 },
    goal: { type: ['string', 'null'], maxLength: 120 },
    reply: { type: 'string', maxLength: 90 },
  },
} as const;

export const PARSE_INTENT_PROMPT = [
  'You classify one short push-to-talk transcript from a blind shopper. The transcript may contain speech-recognition errors.',
  'Input: JSON with transcript, mode and knownItems.',
  'intent is one of: find_item (they name something to buy in the store), navigate_to (they want to be taken to a place: a shop, pharmacy, library, address, "take me to CVS"), guided_task (a goal at home or in a room that needs step-by-step camera guidance: "eggs in my fridge", "find my keys", "get to the living room"), repeat (say the last instruction again), how_far (distance to the next turn or crossing), where_am_i, abort (stop, cancel, quit), help, unknown.',
  'item: the matching entry from knownItems when intent is find_item, else null. Prefer a knownItems match even if the transcript is misspelled. If the transcript names something to buy that is NOT in knownItems and no place is named, intent is still find_item with item null.',
  'destination: for navigate_to, the place name as spoken, without "take me to" ("CVS", "the library"); else null. goal: for guided_task, the goal in the user\'s words ("eggs in my fridge"); else null.',
  'Decide by context words: a shop, pharmacy, store name, street or address means navigate_to; fridge, kitchen, living room, bedroom, door, couch, desk, keys, phone or "in my" means guided_task.',
  'reply: at most twelve words, no digits, confirming what you understood, e.g. "Eggs. Finding a route." or "Say the item again." For navigate_to and guided_task the reply is only the echo ("CVS. Got it."): the app speaks the next prompts itself.',
  'Never mention crossing, traffic or whether it is fine to proceed.',
  'Output JSON only.',
].join('\n');

const REPEAT_RE = /\b(repeat|again|what did you say|say that|pardon)\b/i;
const HOW_FAR_RE = /\b(how far|how long|how many|far away|distance)\b/i;
const WHERE_RE = /\b(where am i|where are we|were am i|what street|where is this)\b/i;
const ABORT_RE = /\b(stop|cancel|quit|abort|never mind|nevermind|end route)\b/i;
const HELP_RE = /\b(help|what can you do|instructions|how does this work)\b/i;
const GO_TO_RE = /\b(?:take me to|bring me to|walk me to|guide me to|navigate to|directions to|go to|get to|find (?:the |a |my )?)\s*(.+)$/i;
const HOME_WORDS_RE = /\b(fridge|refrigerator|freezer|kitchen|living room|bedroom|bathroom|hallway|closet|couch|sofa|desk|table|door ?frame|my keys|my phone|my wallet|my bag|remote|charger|stairs|in my)\b/i;
const PLACE_WORDS_RE = /\b(cvs|walgreens|rite aid|pharmacy|store|shop|market|grocery|giant eagle|target|walmart|costco|trader joe|whole foods|library|bank|station|cafe|coffee|starbucks|restaurant|hospital|clinic|school|university|campus|park|bus stop|address|street|avenue|ave|road)\b/i;

/** Rough goal classification shared by the template and A's on-device fallback parser. */
export function classifyGoalPhrase(transcript: string): { kind: 'navigate_to'; destination: string } | { kind: 'guided_task'; goal: string } | null {
  const t = transcript.trim().replace(/[.?!]+$/, '');
  const m = GO_TO_RE.exec(t);
  const captured = m?.[1] ?? '';
  const rest = (m ? captured : t).trim().replace(/^(the|a|my)\s+/i, '');
  if (rest.length === 0) return null;
  if (HOME_WORDS_RE.test(t)) return { kind: 'guided_task', goal: rest };
  if (m && (PLACE_WORDS_RE.test(rest) || /^[A-Z][\w&' .-]{1,40}$/.test(captured.trim()))) return { kind: 'navigate_to', destination: rest };
  if (!m && PLACE_WORDS_RE.test(t) && /\b(where is|nearest|closest)\b/i.test(t)) return { kind: 'navigate_to', destination: rest };
  return null;
}

function normalizeWords(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Fuzzy item match: exact word, plural/singular, or a one-edit (two on long items) typo sharing the first letter. */
export function matchKnownItem(transcript: string, knownItems: readonly string[]): string | null {
  const text = normalizeWords(transcript);
  if (text === '') return null;
  const words = text.split(' ');
  let best: { item: string; score: number } | null = null;
  for (const item of knownItems) {
    const key = normalizeWords(item);
    if (key === '') continue;
    let score = 0;
    if (text.includes(key)) score = 3;
    else {
      const keyWords = key.split(' ');
      for (const kw of keyWords) {
        for (const w of words) {
          if (w === kw || w === `${kw}s` || `${w}s` === kw) score = Math.max(score, 2);
          // Fuzzy only with the same first letter: "bred" → bread, "egs" → eggs, but never "nice" → rice or "read" → bread.
          else if (kw.length >= 4 && w.length >= 3 && w[0] === kw[0] && editDistance(w, kw) <= (kw.length >= 7 ? 2 : 1)) score = Math.max(score, 1);
        }
      }
    }
    if (score > 0 && (best === null || score > best.score || (score === best.score && key.length > normalizeWords(best.item).length))) {
      best = { item, score };
    }
  }
  return best?.item ?? null;
}

export function editDistance(a: string, b: string): number {
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = dp[0] ?? 0;
    dp[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = dp[j] ?? 0;
      dp[j] = Math.min((dp[j] ?? 0) + 1, (dp[j - 1] ?? 0) + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length] ?? 0;
}

export function templateParseIntent(input: ParseIntentInput): ParseIntentOutput {
  const t = input.transcript ?? '';
  if (ABORT_RE.test(t)) return { intent: 'abort', item: null, reply: 'Stopping.' };
  if (REPEAT_RE.test(t)) return { intent: 'repeat', item: null, reply: 'Repeating.' };
  if (HOW_FAR_RE.test(t)) return { intent: 'how_far', item: null, reply: 'Checking the distance.' };
  if (WHERE_RE.test(t)) return { intent: 'where_am_i', item: null, reply: 'Checking where you are.' };
  if (HELP_RE.test(t)) return { intent: 'help', item: null, reply: 'Say an item, repeat, how far, or where am I.' };
  // Home words ("in my fridge", "living room") can never mean a store item, so they win
  // over a knownItems match ("eggs"); everything else lets the store vocabulary win first.
  const goal = classifyGoalPhrase(t);
  if (goal?.kind === 'guided_task') return { intent: 'guided_task', item: null, destination: null, goal: goal.goal, reply: `${capitalize(goal.goal)}. Got it.` };
  const item = matchKnownItem(t, input.knownItems ?? []);
  if (item) return { intent: 'find_item', item, reply: `${capitalize(item)}. Finding a route.` };
  if (goal?.kind === 'navigate_to') return { intent: 'navigate_to', item: null, destination: goal.destination, goal: null, reply: `${capitalize(goal.destination)}. Got it.` };
  return { intent: 'unknown', item: null, reply: 'Say the item again.' };
}

function validateParseIntent(raw: unknown, input: ParseIntentInput): { output: ParseIntentOutput; usedFallback: boolean } {
  const template = templateParseIntent(input);
  const r = (raw ?? {}) as Partial<ParseIntentOutput>;
  let usedFallback = false;
  const intent = (INTENTS as readonly string[]).includes(String(r.intent)) ? (r.intent as ParseIntentOutput['intent']) : (usedFallback = true, template.intent);
  let item: string | null = null;
  if (intent === 'find_item') {
    const known = input.knownItems ?? [];
    if (typeof r.item === 'string' && known.some((k) => normalizeWords(k) === normalizeWords(r.item as string))) {
      item = known.find((k) => normalizeWords(k) === normalizeWords(r.item as string)) ?? null;
    } else {
      item = matchKnownItem(typeof r.item === 'string' ? `${r.item} ${input.transcript}` : input.transcript, known);
      usedFallback = true;
    }
  }
  const cleanName = (v: unknown, max: number): string | null => {
    if (typeof v !== 'string') return null;
    // The model sometimes echoes the verb ("find the eggs in my kitchen"): keep the thing, not the ask.
    const c = v.trim().replace(/[\r\n]+/g, ' ')
      .replace(/^(?:please\s+)?(?:find|get|locate|reach|take me to|bring me to|walk me to|guide me to|go to)\s+(?:the\s+|a\s+|my\s+)?/i, (m) => (/\bmy\s*$/i.test(m) ? 'my ' : ''))
      .trim()
      .slice(0, max);
    return c.length > 0 && findForbiddenTerm(c) === null ? c : null;
  };
  let destination: string | null = null;
  let goal: string | null = null;
  if (intent === 'navigate_to') {
    const fromModel = cleanName(r.destination, 60);
    destination = fromModel ?? (template.intent === 'navigate_to' ? template.destination ?? null : null);
    if (fromModel === null) usedFallback = true;
  } else if (intent === 'guided_task') {
    const fromModel = cleanName(r.goal, 120);
    goal = fromModel ?? (template.intent === 'guided_task' ? template.goal ?? null : null);
    if (fromModel === null) usedFallback = true;
  }
  const reply = pick(r.reply, template.reply, false);
  if (reply !== (typeof r.reply === 'string' ? r.reply.trim() : '')) usedFallback = true;
  return { output: { intent, item, destination, goal, reply }, usedFallback };
}

// ---------------------------------------------------------------------------
// disambiguate
// ---------------------------------------------------------------------------

export const DISAMBIGUATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['aisleId', 'confidence', 'askBack'],
  properties: {
    aisleId: { type: ['string', 'null'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    askBack: { type: ['string', 'null'] },
  },
} as const;

export const DISAMBIGUATE_PROMPT = [
  'You map a grocery item to one aisle of a small store map.',
  'Input: JSON with item and storeMap (aisles with id, label, categories; itemIndex).',
  'Choose the aisle whose categories best contain the item. aisleId must be one of the aisle ids or null.',
  'confidence is 0 to 1. When two aisles fit equally, set aisleId to the better one, confidence below 0.5, and askBack to a question of at most twelve words offering both, e.g. "Dairy or bakery?". Otherwise askBack is null.',
  'No digits anywhere in askBack. Output JSON only.',
].join('\n');

export function templateDisambiguate(input: DisambiguateInput): DisambiguateOutput {
  const item = normalizeWords(input.item ?? '');
  const map = input.storeMap;
  const aisles = map?.aisles ?? [];
  if (item === '' || aisles.length === 0) return { aisleId: null, confidence: 0, askBack: 'Say the item again.' };

  const direct = map.itemIndex?.[item] ?? map.itemIndex?.[item.replace(/s$/, '')];
  if (direct && aisles.some((a) => a.id === direct.aisleId)) return { aisleId: direct.aisleId, confidence: 0.9, askBack: null };

  const hits = aisles.filter((a) => a.categories.some((c) => {
    const cat = normalizeWords(c);
    return cat !== '' && (item.includes(cat) || cat.includes(item));
  }));
  const firstHit = hits[0];
  if (firstHit && hits.length === 1) return { aisleId: firstHit.id, confidence: 0.7, askBack: null };
  if (firstHit && hits.length > 1) {
    const names = hits.slice(0, 2).map((a) => spokenLabelOf(a));
    return { aisleId: firstHit.id, confidence: 0.4, askBack: `${names[0] ?? ''} or ${names[1] ?? ''}?` };
  }
  return { aisleId: null, confidence: 0, askBack: 'Say the item again.' };
}

function spokenLabelOf(a: { label: string; categories: string[] } & { spokenLabel?: string }): string {
  if (a.spokenLabel && !hasDigit(a.spokenLabel)) return a.spokenLabel;
  const cat = a.categories.find((c) => !hasDigit(c));
  return capitalize(cat ?? 'that aisle');
}

function validateDisambiguate(raw: unknown, input: DisambiguateInput): { output: DisambiguateOutput; usedFallback: boolean } {
  const template = templateDisambiguate(input);
  const r = (raw ?? {}) as Partial<DisambiguateOutput>;
  const ids = new Set((input.storeMap?.aisles ?? []).map((a) => a.id));
  let usedFallback = false;
  let aisleId: string | null;
  if (r.aisleId === null) aisleId = null;
  else if (typeof r.aisleId === 'string' && ids.has(r.aisleId)) aisleId = r.aisleId;
  else {
    aisleId = template.aisleId;
    usedFallback = true;
  }
  const confidence = typeof r.confidence === 'number' && r.confidence >= 0 && r.confidence <= 1 ? r.confidence : (usedFallback = true, template.confidence);
  let askBack: string | null;
  if (r.askBack === null || r.askBack === undefined) askBack = r.askBack === undefined ? template.askBack : null;
  else if (isValidPhrase(r.askBack, false)) askBack = r.askBack.trim();
  else {
    askBack = template.askBack;
    usedFallback = true;
  }
  return { output: { aisleId, confidence, askBack }, usedFallback };
}

// ---------------------------------------------------------------------------
// crossingAnnounce
// ---------------------------------------------------------------------------

export const CROSSING_ANNOUNCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['nodeId', 'signalized', 'pushButtonLikely', 'text'],
  properties: {
    nodeId: { type: ['string', 'null'] },
    signalized: { type: ['boolean', 'null'] },
    pushButtonLikely: { type: 'boolean' },
    text: { type: 'string', maxLength: 100 },
  },
} as const;

export const CROSSING_ANNOUNCE_PROMPT = [
  'You judge which OpenStreetMap crossing node is on a blind pedestrian\'s path and what the map data says about its signal.',
  'Input: JSON with candidates (nodeId, distToPolylineM, tags, optional wprdcOperationType from the city signal inventory) and street.',
  'Pick the node closest to the path with the most specific tags. nodeId must be one of the candidate ids or null.',
  'signalized: true when tags say crossing=traffic_signals or crossing:signals=yes, or a wprdcOperationType is present; false when tags say marked, uncontrolled or unmarked with no signal; null when the data is silent or contradictory.',
  'pushButtonLikely: true when button_operated=yes or wprdcOperationType contains Actuated or PED.',
  'text is exactly "Crossing ahead: <street>. Signalized." or "Crossing ahead: <street>." plus " Push button likely." when pushButtonLikely; use "Crossing ahead." when street is empty. No digits, no abbreviations.',
  'You never see an image and you never write anything about whether to cross. Output JSON only.',
].join('\n');

export function templateCrossingAnnounce(input: CrossingAnnounceInput): CrossingAnnounceOutput {
  const candidates = input.candidates ?? [];
  const nearest = candidates.reduce<CrossingAnnounceInput['candidates'][number] | null>(
    (best, c) => (best === null || c.distToPolylineM < best.distToPolylineM ? c : best),
    null,
  );
  let signalized: boolean | null = null;
  let pushButtonLikely = false;
  const anySignal = candidates.some((c) => c.tags?.crossing === 'traffic_signals' || c.tags?.['crossing:signals'] === 'yes' || Boolean(c.wprdcOperationType));
  const allUnsignal = candidates.length > 0 && candidates.every((c) => {
    const s = c.tags?.['crossing:signals'];
    return ['marked', 'uncontrolled', 'unmarked'].includes(c.tags?.crossing ?? '') && (s === undefined || s === 'no') && !c.wprdcOperationType;
  });
  if (anySignal) signalized = true;
  else if (allUnsignal) signalized = false;
  pushButtonLikely = candidates.some((c) => c.tags?.button_operated === 'yes' || /ACTUATED|PED/i.test(c.wprdcOperationType ?? ''));
  return {
    nodeId: nearest?.nodeId ?? null,
    signalized,
    pushButtonLikely,
    text: crossingAnnouncementText({ street: input.street ?? '', signalized, pushButtonLikely }),
  };
}

function validateCrossingAnnounce(raw: unknown, input: CrossingAnnounceInput): { output: CrossingAnnounceOutput; usedFallback: boolean } {
  const template = templateCrossingAnnounce(input);
  const r = (raw ?? {}) as Partial<CrossingAnnounceOutput>;
  const ids = new Set((input.candidates ?? []).map((c) => c.nodeId));
  let usedFallback = false;
  const nodeId = r.nodeId === null ? null : typeof r.nodeId === 'string' && ids.has(r.nodeId) ? r.nodeId : (usedFallback = true, template.nodeId);
  const signalized = r.signalized === null || typeof r.signalized === 'boolean' ? r.signalized : (usedFallback = true, template.signalized);
  const pushButtonLikely = typeof r.pushButtonLikely === 'boolean' ? r.pushButtonLikely : (usedFallback = true, template.pushButtonLikely);
  // The text is a fixed template of the judged facts; the model's wording is not trusted.
  const text = crossingAnnouncementText({ street: input.street ?? '', signalized, pushButtonLikely });
  return { output: { nodeId, signalized, pushButtonLikely, text }, usedFallback };
}

// ---------------------------------------------------------------------------
// answer
// ---------------------------------------------------------------------------

export const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply'],
  properties: { reply: { type: 'string', maxLength: 90 } },
} as const;

export const ANSWER_PROMPT = [
  'You answer one navigation question for a blind pedestrian in at most twelve words.',
  'Input: JSON with question (repeat, how_far, where_am_i, replan) and context (current leg phrases, metres to the next maneuver and crossing, street names, mode).',
  'repeat: say the current instruction again. how_far: distance to the turn in feet, as words. where_am_i: the street and the distance to the next street, as words. replan: say that the route is being recomputed.',
  'No digits: write every number as words. Never mention crossing timing, traffic or whether it is fine to proceed. Output JSON only.',
  'Keep the reply under twelve words and do not restate the street unless asked. Examples — how_far: {"reply":"About four hundred feet to the turn."} where_am_i: {"reply":"On Fifth Avenue, two hundred feet from Forbes Avenue."} repeat: {"reply":"Turn right now."}',
].join('\n');

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export function templateAnswer(input: AnswerInput): AnswerOutput {
  const ctx = input.context ?? {};
  switch (input.question) {
    case 'repeat': {
      const last = str(ctx.lastPhrase) || str(ctx.now) || str(ctx.confirm);
      return { reply: isValidPhrase(last, false) ? last : 'Keep going.' };
    }
    case 'how_far': {
      const m = num(ctx.metersToManeuver);
      if (m === null) return { reply: 'Distance unknown. Keep going.' };
      const next = str(ctx.nextManeuver);
      const what = next === 'ARRIVE' ? 'the entrance' : 'the turn';
      return { reply: `${capitalize(feetWords(m))} to ${what}.` };
    }
    case 'where_am_i': {
      const street = spokenStreet(str(ctx.street));
      const next = spokenStreet(str(ctx.nextStreet));
      const m = num(ctx.metersToManeuver);
      if (street === '') return { reply: 'Street unknown. Keep going.' };
      if (next !== '' && m !== null) {
        const reply = `On ${street}, ${feetWords(m)} from ${next}.`;
        if (countWords(reply) <= MAX_PHRASE_WORDS) return { reply };
      }
      return { reply: `On ${street}.` };
    }
    case 'replan':
    default:
      return { reply: 'Re-routing.' };
  }
}

function validateAnswer(raw: unknown, input: AnswerInput): { output: AnswerOutput; usedFallback: boolean } {
  const template = templateAnswer(input);
  const r = (raw ?? {}) as Partial<AnswerOutput>;
  const reply = pick(r.reply, template.reply, false);
  const normalizedRaw = typeof r.reply === 'string' ? digitsToWords(r.reply).trim() : '';
  return { output: { reply }, usedFallback: reply !== normalizedRaw };
}

// ---------------------------------------------------------------------------
// taskPlan — goal → 3–8 steps for the guided-task loop (Nemotron as the decision layer)
// ---------------------------------------------------------------------------

export const TASK_PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['askFirst', 'steps'],
  properties: {
    askFirst: { type: 'string', maxLength: 90 },
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['instruction', 'lookFor'],
        properties: { instruction: { type: 'string', maxLength: 90 }, lookFor: { type: 'string', maxLength: 80 } },
      },
    },
  },
} as const;

export const TASK_PLAN_PROMPT = [
  'You plan step-by-step camera-guided help for a blind person reaching a goal. Input: JSON with goal, context (home, store, street, unknown) and optional facts the camera already sees.',
  'Return askFirst: one short request to look around first, e.g. "Let me see your surroundings." Then steps: three to eight ordered steps, each an instruction of at most twelve words the person performs (walk, turn, reach, open) and lookFor: what the camera should confirm to call that step done.',
  'Adjust to the context: at home use rooms, door frames, appliances and furniture ("Walk to the kitchen door frame.", "Open the fridge."); in a store use aisles, signs and shelves; on the street use doors, entrances and crossings only as places to stand, never when to cross.',
  'facts.scene says where the person is and facts.description says what the camera sees right now, with sides. Plan from there: if the fridge is already on the left, the first step is "Turn left to face the fridge.", not a look around. Start with a "turn slowly" step only when facts say nothing useful. Put the target where it usually is ("Eggs are often on the door shelf or the middle shelf.") in the reach step.',
  'No digits: numbers as words. Never state or imply that it is fine to proceed, that a way is free of traffic, or when to cross a street. Output JSON only.',
].join('\n');

const TASK_STEP_DEFAULTS: Record<string, Array<{ instruction: string; lookFor: string }>> = {
  home: [
    { instruction: 'Turn slowly so I can see the room.', lookFor: 'the room layout and the nearest door' },
    { instruction: 'Walk toward the door frame ahead.', lookFor: 'a door frame close in front' },
    { instruction: 'Walk through the door and stop.', lookFor: 'the next room' },
    { instruction: 'Walk to the target and reach out.', lookFor: 'the target within arm\'s reach' },
  ],
  store: [
    { instruction: 'Turn slowly so I can see the aisle signs.', lookFor: 'an aisle sign' },
    { instruction: 'Walk to the matching aisle.', lookFor: 'the target aisle sign' },
    { instruction: 'Face the shelf and reach out.', lookFor: 'the item within arm\'s reach' },
  ],
  street: [
    { instruction: 'Turn slowly so I can see the street.', lookFor: 'the sidewalk and nearby doors' },
    { instruction: 'Walk toward the entrance ahead.', lookFor: 'a door or entrance close in front' },
    { instruction: 'Stop at the door and reach for it.', lookFor: 'the door within arm\'s reach' },
  ],
};

export function templateTaskPlan(input: TaskPlanInput): TaskPlanOutput {
  const ctx = input.context in TASK_STEP_DEFAULTS ? input.context : 'home';
  const steps = TASK_STEP_DEFAULTS[ctx]!.map((s) => ({ ...s }));
  const last = steps[steps.length - 1]!;
  const goal = String(input.goal ?? '').trim();
  if (goal.length > 0 && countWords(`Walk to ${goal} and reach out.`) <= MAX_PHRASE_WORDS && !hasDigit(goal) && findForbiddenTerm(goal) === null) {
    last.instruction = `Walk to ${goal.replace(/^(the|a|my)\s+/i, '')} and reach out.`;
    last.lookFor = goal;
  }
  return { askFirst: 'Let me see your surroundings.', steps };
}

function validateTaskPlan(raw: unknown, input: TaskPlanInput): { output: TaskPlanOutput; usedFallback: boolean } {
  const template = templateTaskPlan(input);
  const r = (raw ?? {}) as Partial<TaskPlanOutput>;
  let usedFallback = false;
  const askFirst = pick(r.askFirst, template.askFirst, false);
  if (askFirst !== (typeof r.askFirst === 'string' ? r.askFirst.trim() : '')) usedFallback = true;
  const steps: TaskPlanOutput['steps'] = [];
  if (Array.isArray(r.steps)) {
    for (const st of r.steps.slice(0, 8)) {
      const o = (st ?? {}) as Partial<{ instruction: string; lookFor: string }>;
      const instruction = typeof o.instruction === 'string' ? digitsToWords(o.instruction).trim() : '';
      const lookFor = typeof o.lookFor === 'string' ? o.lookFor.trim().slice(0, 80) : '';
      if (isValidPhrase(instruction, false) && lookFor.length > 0) steps.push({ instruction, lookFor });
      else usedFallback = true;
    }
  }
  if (steps.length === 0) return { output: template, usedFallback: true };
  return { output: { askFirst, steps }, usedFallback };
}

// ---------------------------------------------------------------------------
// Job table
// ---------------------------------------------------------------------------

export interface JobSpec<J extends PlannerJob> {
  job: J;
  schema: Record<string, unknown>;
  prompt: string;
  template(input: JobInput<J>): JobOutput<J>;
  validate(raw: unknown, input: JobInput<J>): { output: JobOutput<J>; usedFallback: boolean };
}

export const JOB_SPECS: { [J in PlannerJob]: JobSpec<J> } = {
  routeCompile: { job: 'routeCompile', schema: ROUTE_COMPILE_SCHEMA, prompt: ROUTE_COMPILE_PROMPT, template: templateRouteCompile, validate: validateRouteCompile },
  parseIntent: { job: 'parseIntent', schema: PARSE_INTENT_SCHEMA, prompt: PARSE_INTENT_PROMPT, template: templateParseIntent, validate: validateParseIntent },
  disambiguate: { job: 'disambiguate', schema: DISAMBIGUATE_SCHEMA, prompt: DISAMBIGUATE_PROMPT, template: templateDisambiguate, validate: validateDisambiguate },
  crossingAnnounce: { job: 'crossingAnnounce', schema: CROSSING_ANNOUNCE_SCHEMA, prompt: CROSSING_ANNOUNCE_PROMPT, template: templateCrossingAnnounce, validate: validateCrossingAnnounce },
  answer: { job: 'answer', schema: ANSWER_SCHEMA, prompt: ANSWER_PROMPT, template: templateAnswer, validate: validateAnswer },
  taskPlan: { job: 'taskPlan', schema: TASK_PLAN_SCHEMA, prompt: TASK_PLAN_PROMPT, template: templateTaskPlan, validate: validateTaskPlan },
};

export function isPlannerJob(v: unknown): v is PlannerJob {
  return typeof v === 'string' && (PLANNER_JOBS as readonly string[]).includes(v);
}

/** Templated output for any job (the app's offline path and the proxy's fallback). */
export function templateFor<J extends PlannerJob>(job: J, input: JobInput<J>): JobOutput<J> {
  const spec = JOB_SPECS[job] as unknown as JobSpec<J>;
  return spec.template(input);
}

/** Validate a model output for any job, falling back per field to the template. */
export function validateFor<J extends PlannerJob>(job: J, raw: unknown, input: JobInput<J>): { output: JobOutput<J>; usedFallback: boolean } {
  const spec = JOB_SPECS[job] as unknown as JobSpec<J>;
  return spec.validate(raw, input);
}

/** Third line of defence: the last `{...}` in a model reply that parses as JSON. */
export function extractJsonObject(text: string): unknown | null {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}
