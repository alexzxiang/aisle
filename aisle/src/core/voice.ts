/**
 * Push-to-talk voice input (02 Task 7; first thing cut, keyboard dictation is
 * the zero-risk fallback that always ships).
 *
 * Flow on release of the talk button:
 *   recording mode on → on-device `expo-speech-recognition` (contextual
 *   strings = the store's item vocabulary; the audio is persisted only when a
 *   Scribe upload is configured) → final transcript, or the persisted clip
 *   through the proxy `/api/stt` (ElevenLabs Scribe) when on-device returned
 *   nothing → `POST /api/plan
 *   {job: 'parseIntent'}` with a 1.5 s first-token deadline on the proxy and a
 *   local keyword fallback here → one ≤ 12-word reply via `say()` → recording
 *   mode off. `ITEM_REQUESTED {source}` records which path produced the item.
 *
 * COURSE pauses while recording (iOS suppresses haptics in a recording
 * session), through `haptics.setSuspended`.
 *
 * Privacy: a persisted clip lives exactly as long as the utterance. It is
 * deleted as soon as `end()` has finished with it (uploaded or not) and on
 * `cancel()`, so no voice recording ever accumulates on the phone.
 *
 * The recognizer, the STT upload and fetch are injected so the flow is
 * unit-tested; the expo implementations are at the bottom and required lazily.
 */
import type { AppMode, ParseIntentInput, ParseIntentOutput, PlannerResult, SpeechService, TaskContext } from './contracts';
import { classifyGoalPhrase } from '../outdoor/plannerJobs';
import { explicitHomeGoal } from './indoorIntent';
import { classForWords } from './sceneMemory';
import type { AppEventBus } from './bus';
import type { ConversationLog } from './conversation';
import type { AppStore } from './store';
import { MAX_UTTERANCE_WORDS, PHRASES, checkPhrase, countWords, findForbiddenTerm, hasDigit, phraseKeyForText } from './phrases';
import { isAffirmative, isNegative, leansYes, normalizeAnswer } from './yesNo';

// ---------------------------------------------------------------------------
// Pure: intent fallback and transcript choice
// ---------------------------------------------------------------------------

export const FALLBACK_REPLY = PHRASES.say_item_again;
export const RECOGNIZER_FINAL_TIMEOUT_MS = 3000;
export const PLAN_TIMEOUT_MS = 2500;
export const STT_TIMEOUT_MS = 4000;
export const MAX_KEYTERMS = 100;
/**
 * A hold shorter than this (a one-word "yes") keeps the microphone open a little after
 * release: people let go as the word ends, which clips its tail, and Apple's recogniser
 * answers "no speech" to a clip under about a second. Only applies when the recogniser
 * reported when it actually started listening (`readyAt`).
 */
export const SHORT_HOLD_MS = 1200;
export const SHORT_HOLD_TAIL_MAX_MS = 600;
/** Below this on-device confidence a spoken goal is read back before it starts. */
export const UNCERTAIN_CONFIDENCE = 0.45;

const ABORT_RE = /\b(?:stop|cancel|quit|abort|never mind|nevermind|end (?:the )?(?:trip|route))\b/i;
const REPEAT_RE = /\b(?:repeat|again|what did you say|say that again)\b/i;
const HOW_FAR_RE = /\b(?:how far|how much further|how much farther|how long)\b/i;
const WHERE_RE = /\b(?:where am i|where are we|what street)\b/i;
const HELP_RE = /\b(?:help|what can you do|instructions)\b/i;
/**
 * "Describe" requests are answered locally by the scene describer (round 3).
 * 01 §9 freezes the `ParseIntentOutput.intent` union, so this is not a new
 * planner intent: the transcript is mapped before the planner is called and
 * the outcome carries `localIntent: 'describe'`.
 */
const DESCRIBE_RE = /(?:\b(?:what(?:'s| is) (?:around|ahead of|in front of) me|what(?:'s| is) (?:around|ahead)|what (?:do|can) you see|look around)\b|^describe(?:\s+(?:the\s+)?(?:surroundings|scene|what you see|around me|ahead))?$)/i;
/** Two unclear tries in a row earn the shorter ask (say_item_one_word). */
export const UNCLEAR_TRIES_BEFORE_ONE_WORD = 2;
const FIND_PREFIX_RE = /^(?:(?:i|we)\s+(?:need|want|am looking for|'m looking for)|find|get|(?:take|bring) me to|looking for|where (?:is|are)(?: the)?|(?:i|we)\s+(?:need|want) to (?:find|get|buy))\s+/i;
const FILLER_RE = /\b(?:uh|um|please|some|the|a|an|like)\b/gi;

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim();
}

function titleCase(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/** True when the transcript asks for a description of the surroundings. */
export function isDescribeRequest(transcript: string): boolean {
  return DESCRIBE_RE.test(normalize(transcript));
}

/** Deterministic keyword parser: the templated fallback when the planner misses its deadline. */
export function parseIntentFallback(transcript: string, knownItems: readonly string[]): ParseIntentOutput {
  const t = normalize(transcript);
  if (t.length === 0) return { intent: 'unknown', item: null, reply: FALLBACK_REPLY };
  if (ABORT_RE.test(t)) return { intent: 'abort', item: null, reply: 'Stopping.' };
  if (REPEAT_RE.test(t)) return { intent: 'repeat', item: null, reply: 'Repeating.' };
  if (HOW_FAR_RE.test(t)) return { intent: 'how_far', item: null, reply: 'Checking the distance.' };
  if (WHERE_RE.test(t)) return { intent: 'where_am_i', item: null, reply: 'Checking where you are.' };

  // Round 4: home goals ("eggs in my fridge", "the living room") are never store items.
  const goal = classifyGoalPhrase(transcript);
  if (goal?.kind === 'guided_task') {
    return { intent: 'guided_task', item: null, destination: null, goal: goal.goal, reply: `${titleCase(goal.goal)}. Got it.` };
  }

  // Known vocabulary first: longest match wins ("egg noodles" over "egg").
  let best: string | null = null;
  for (const raw of knownItems) {
    const k = normalize(raw);
    if (k.length === 0) continue;
    if (new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t) && (best === null || k.length > best.length)) {
      best = k;
    }
  }
  if (best) return { intent: 'find_item', item: best, reply: `${titleCase(best)}. Finding it.` };

  if (HELP_RE.test(t)) return { intent: 'help', item: null, reply: 'Hold the button and name an item.' };

  // Round 4: "take me to CVS" → a place to walk to.
  if (goal?.kind === 'navigate_to') {
    return { intent: 'navigate_to', item: null, destination: goal.destination, goal: null, reply: `${titleCase(goal.destination)}. Got it.` };
  }

  // Free-form "I need X" with the filler stripped.
  const m = t.match(FIND_PREFIX_RE);
  if (m) {
    const rest = t.slice(m[0].length).replace(FILLER_RE, ' ').replace(/\s+/g, ' ').trim();
    if (rest.length > 0 && rest.split(' ').length <= 4) {
      return { intent: 'find_item', item: rest, reply: `${titleCase(rest)}. Finding it.` };
    }
  }
  return { intent: 'unknown', item: null, reply: FALLBACK_REPLY };
}

export interface RecognizedResult {
  transcript: string;
  confidence: number;
}

/** Highest-confidence non-empty transcript, or ''. */
export function bestTranscript(results: readonly RecognizedResult[]): string {
  let best: RecognizedResult | null = null;
  for (const r of results) {
    if (!r.transcript || r.transcript.trim().length === 0) continue;
    if (best === null || r.confidence > best.confidence) best = r;
  }
  return best ? best.transcript.trim() : '';
}

/** Repairs a planner reply so it can never violate the language rules. */
export function sanitizeReply(reply: unknown, fallback: string = FALLBACK_REPLY): string {
  if (typeof reply !== 'string' || reply.trim().length === 0) return fallback;
  const v = checkPhrase(reply, { allowLong: false });
  return v.length === 0 ? reply.trim() : fallback;
}

const INTENTS: ReadonlySet<ParseIntentOutput['intent']> = new Set([
  'find_item', 'navigate_to', 'guided_task', 'repeat', 'how_far', 'where_am_i', 'abort', 'help', 'unknown',
]);

/**
 * Modes with a route or store trip already running. Outside these the app is idle with the
 * camera up (the awareness loop owns the scene), which is where an item request is served by
 * the model finding it, not by a surveyed store map.
 */
const ON_TRIP: ReadonlySet<AppMode> = new Set<AppMode>([
  'OUTDOOR_NAV', 'APPROACH_CROSSING', 'AT_CURB', 'CROSSING', 'TRANSITION',
  'INDOOR_NAV', 'AT_ITEM', 'ITEM_PICKUP', 'CHECKOUT_NAV',
]);

const STREET_CLASSES = new Set(['traffic_light', 'stop_sign', 'hydrant', 'bench', 'car', 'bus', 'truck', 'bicycle', 'motorcycle', 'person', 'cart']);
/** Something the detector knows as a household thing (a couch, bananas, a remote): a home task, not a store trip. */
export function isHouseholdThing(words: string): boolean {
  const cls = classForWords(words);
  return cls !== null && !STREET_CLASSES.has(cls);
}

/** "Pasta. Did I get that right?" — null when the goal cannot be spoken safely (digits, forbidden word, too long). */
export function goalConfirmQuestion(goal: string): string | null {
  const g = goal.trim().replace(/[.!?]+$/, '');
  if (g.length === 0 || hasDigit(g) || findForbiddenTerm(g) !== null) return null;
  const q = `${g[0].toUpperCase()}${g.slice(1)}. Did I get that right?`;
  return countWords(q) <= MAX_UTTERANCE_WORDS ? q : null;
}

export function coerceParseIntentOutput(raw: unknown, fallback: ParseIntentOutput): ParseIntentOutput {
  if (!raw || typeof raw !== 'object') return fallback;
  const o = raw as Partial<ParseIntentOutput>;
  const intent = INTENTS.has(o.intent as ParseIntentOutput['intent']) ? (o.intent as ParseIntentOutput['intent']) : fallback.intent;
  const item = typeof o.item === 'string' && o.item.trim().length > 0 ? o.item.trim().toLowerCase() : intent === 'find_item' ? fallback.item : null;
  const cleanName = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim().slice(0, max) : null);
  const destination = intent === 'navigate_to' ? cleanName(o.destination, 60) ?? fallback.destination ?? null : null;
  const goal = intent === 'guided_task' ? cleanName(o.goal, 120) ?? fallback.goal ?? null : null;
  return { intent, item, destination, goal, reply: sanitizeReply(o.reply, fallback.reply) };
}

/**
 * Words the recognisers should expect beyond the store's items: the commands, the
 * answers to the app's questions, home goals and the demo's places. Biases both
 * Apple's recogniser (contextualStrings) and Scribe (keyterms); nothing is forced.
 */
export const VOICE_VOCABULARY: readonly string[] = [
  'take me to', 'bring me to', 'walk me to', 'find', 'where is', 'how far', 'repeat', 'stop', 'cancel', 'help',
  'yes', 'no', 'correct', 'next', 'done', 'skip', 'describe', 'what do you see', 'look around',
  'fridge', 'refrigerator', 'kitchen', 'living room', 'bedroom', 'bathroom', 'hallway', 'door', 'door frame', 'couch', 'my keys', 'my phone',
  // Common grocery staples: with no surveyed store map the store's own items are absent, so
  // these bias the recogniser toward what a shopper asks for at the aisle (the demo path).
  'milk', 'eggs', 'bread', 'butter', 'cheese', 'yogurt', 'pasta', 'pasta sauce', 'rice', 'cereal',
  'coffee', 'bananas', 'apples', 'tomatoes', 'onions', 'potatoes', 'chicken', 'orange juice',
  'peanut butter', 'cooking oil', 'canned soup', 'frozen pizza', 'ice cream', 'paper towels',
  'toilet paper', 'chips', 'cookies', 'water',
  'checkout', 'register', 'cashier', 'self checkout',   // the demo's last beat: find the item, then head to checkout
  'CVS', 'Walgreens', 'Rite Aid', 'Giant Eagle', "Trader Joe's", 'Target', 'Whole Foods', 'pharmacy', 'grocery store',
  'Forbes Avenue', 'Fifth Avenue', 'Craig Street', 'Murray Avenue', 'Penn Avenue', 'Centre Avenue', 'Oakland', 'Squirrel Hill', 'Shadyside',
  'I am in the kitchen', "I'm on the sidewalk", 'in front of my fridge',
];

/** Keyterms for the recognisers: the fixed vocabulary, then the store's items, capped so Scribe billing stays sane (07 §2). */
export function keytermsFrom(words: readonly string[], max: number = MAX_KEYTERMS): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const w of [...VOICE_VOCABULARY, ...words]) {
    const k = w.trim();
    if (!k || seen.has(k.toLowerCase())) continue;
    seen.add(k.toLowerCase());
    out.push(k);
    if (out.length >= max) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Injected platform pieces
// ---------------------------------------------------------------------------

export interface RecognizerHandlers {
  onResult(e: { isFinal: boolean; results: RecognizedResult[] }): void;
  onError(code: string): void;
  onEnd(): void;
  /** Persisted recording, when the recognizer was asked to keep it. */
  onAudioEnd(uri: string | null): void;
}

export interface RecognizerSession {
  /** Resolves on the native audio-capture event, not merely after calling start(). */
  ready?: Promise<void>;
  ended?: Promise<void>;
  stop(): void;
  abort(): void;
}

export interface ListenOptions {
  lang: string;
  onDevice: boolean;
  contextualStrings: string[];
  /** Keep the clip on disk for the Scribe fallback; false = record nothing. */
  persistAudio: boolean;
}

export interface Recognizer {
  isAvailable(): boolean;
  supportsOnDevice(): boolean;
  requestPermissions(): Promise<boolean>;
  listen(opts: ListenOptions, handlers: RecognizerHandlers): RecognizerSession;
}

export interface VoiceInputOptions {
  onDiagnostic?: (data: Record<string, unknown>) => void;
  speech: SpeechService & { setSuspended?(on: boolean): void };
  bus: AppEventBus;
  store: AppStore;
  proxyUrl: string;
  /** Item + aisle vocabulary (store map); used for contextual strings, Scribe keyterms and the fallback parser. */
  knownItems: () => string[];
  recognizer?: Recognizer;
  audio?: { setRecordingMode(on: boolean): Promise<void>; suspendForRecording?(): void };
  haptics?: { setSuspended(suspended: boolean): void };
  /** Upload the persisted clip to `/api/stt`; resolves to the transcript or null. Absent = never persist audio. */
  sttUpload?: (uri: string, keyterms: string[], timeoutMs: number) => Promise<string | null>;
  /** Remove a persisted clip once the utterance is over. Default: expo-file-system. Failures are swallowed. */
  deleteFile?: (uri: string) => Promise<void> | void;
  fetchImpl?: typeof fetch;
  now?: () => number;
  finalTimeoutMs?: number;
  planTimeoutMs?: number;
  /** The transcript blurb: the user's words ('you') and the reply ('aisle'). */
  conversation?: Pick<ConversationLog, 'pushUser' | 'pushAisle'>;
  /** The scene describer's on-demand path; resolves to the text it spoke, or null. */
  describe?: () => Promise<string | null>;
  /** Ask the camera a free question in the user's words ("is the fridge open?"); resolves to the spoken answer, or null. */
  askScene?: (question: string) => Promise<string | null>;
  /**
   * Answers to open questions, before the planner: the awareness loop's "yes" /
   * "no" / "I'm in the kitchen", the guided task's "yes" to a step check. Returns
   * true when the transcript was consumed (no planner call, no reply here).
   */
  intercept?: (transcript: string) => boolean;
  /** The awareness loop's view of where the user is (home / store / street), or null. */
  sceneContext?: () => TaskContext | null;
  /** Prefer supported on-device recognition to avoid network startup latency. Default true. */
  preferOnDeviceStt?: boolean;
  /** The short-hold tail's clock (tests). Default setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export type VoiceSource = 'voice' | 'keyboard';

export interface VoiceOutcome {
  output: ParseIntentOutput;
  transcript: string;
  /** Which recognizer produced the transcript ('none' when nothing was heard). */
  sttPath: 'on-device' | 'scribe' | 'keyboard' | 'none';
  /** Planner answered (false = local keyword fallback). */
  planner: boolean;
  plannerLatencyMs: number | null;
  /** Answered locally, before the planner: a "describe" request, or an answer an open question consumed (01 §9's intent union is frozen). */
  localIntent?: 'describe' | 'intercepted';
}

export interface VoiceInput {
  isAwaitingConfirmation(): boolean;
  /** Talk button pressed. Resolves once the recognizer is listening (or has failed to). */
  begin(): Promise<void>;
  /** Talk button released. Runs STT → parseIntent → reply. */
  end(): Promise<VoiceOutcome>;
  /** Drop the current utterance without parsing. */
  cancel(): void;
  isListening(): boolean;
  /** Keyboard / dictation path: same parse and the same reply, `source: 'keyboard'`. */
  submitText(text: string): Promise<VoiceOutcome>;
  getLast(): VoiceOutcome | null;
}

interface Session {
  handle: RecognizerSession | null;
  /** Talk button down (ms). */
  pressedAt: number;
  /** The recogniser's own "listening" moment (ms), when it reports one. */
  readyAt: number | null;
  results: RecognizedResult[];
  finalTranscript: string | null;
  audioUri: string | null;
  ended: boolean;
  error: string | null;
  /** end()/cancel() are through with the clip: delete it now, or as soon as it arrives. */
  done: boolean;
  waiters: Array<() => void>;
}

export function createVoiceInput(opts: VoiceInputOptions): VoiceInput {
  const now = opts.now ?? Date.now;
  const finalTimeoutMs = opts.finalTimeoutMs ?? RECOGNIZER_FINAL_TIMEOUT_MS;
  const planTimeoutMs = opts.planTimeoutMs ?? PLAN_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const persistAudio = opts.sttUpload !== undefined;
  const deleteFile = opts.deleteFile ?? createExpoFileDelete();
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let session: Session | null = null;
  let ending: Promise<VoiceOutcome> | null = null;
  /** The previous utterance's microphone teardown: the next press waits for this, never for its planning. */
  let capturing: Promise<void> | null = null;
  /** Utterances are understood in the order they were spoken, even when the mic reopened meanwhile. */
  let processing: Promise<unknown> = Promise.resolve();
  let lastEmptyNotice = -Infinity;
  let last: VoiceOutcome | null = null;
  let unclearStreak = 0;
  let confirmationMisses = 0;
  /** A task goal or a route destination spoken back for a yes/no before the big commitment starts (v2 B-4). */
  let pendingConfirm:
    | { kind: 'task'; goal: string; context: TaskContext }
    | { kind: 'route'; destination: string }
    | null = null;

  const pushUser = (transcript: string, source: VoiceSource): void => {
    if (transcript.length > 0) opts.conversation?.pushUser(transcript, source);
  };

  /** Delete the persisted clip (if any) exactly once; never throws. */
  const discardClip = (s: Session): void => {
    const uri = s.audioUri;
    if (!uri) return;
    s.audioUri = null;
    try {
      void Promise.resolve(deleteFile(uri)).catch(() => undefined);
    } catch {
      // a clip we cannot delete is not worth failing the reply over
    }
  };

  const wake = (s: Session): void => {
    for (const w of s.waiters.splice(0)) w();
  };

  const waitForFinal = (s: Session): Promise<void> =>
    new Promise((resolve) => {
      if (s.finalTranscript !== null || s.ended || s.error) {
        resolve();
        return;
      }
      const t = setTimeout(resolve, finalTimeoutMs);
      s.waiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });

  const plan = async (transcript: string): Promise<{ output: ParseIntentOutput; planner: boolean; latencyMs: number | null }> => {
    const knownItems = opts.knownItems();
    const fallback = parseIntentFallback(transcript, knownItems);
    const mode: AppMode = opts.store.getState().mode;
    const input: ParseIntentInput = { transcript, mode, knownItems };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), planTimeoutMs);
    const t0 = now();
    try {
      const res = await fetchImpl(`${opts.proxyUrl}/api/plan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ job: 'parseIntent', input }),
        signal: controller.signal,
      });
      if (!res.ok) return { output: fallback, planner: false, latencyMs: now() - t0 };
      const body = (await res.json()) as Partial<PlannerResult<ParseIntentOutput>>;
      const output = coerceParseIntentOutput(body.output, fallback);
      return { output, planner: body.fallback !== true, latencyMs: typeof body.latencyMs === 'number' ? body.latencyMs : now() - t0 };
    } catch {
      return { output: fallback, planner: false, latencyMs: null };
    } finally {
      clearTimeout(timer);
    }
  };

  /** Two unclear tries in a row: the canonical "say the item again" becomes the one-word ask. */
  const withUnclearPrompt = (output: ParseIntentOutput): ParseIntentOutput => {
    if (output.intent === 'unknown') unclearStreak += 1;
    else unclearStreak = 0;
    if (output.intent === 'unknown' && unclearStreak >= UNCLEAR_TRIES_BEFORE_ONE_WORD && output.reply === FALLBACK_REPLY) {
      return { ...output, reply: PHRASES.say_item_one_word };
    }
    return output;
  };

  const act = (output: ParseIntentOutput, source: VoiceSource, confirm = false): void => {
    const reply = (): void => {
      const cacheKey = phraseKeyForText(output.reply);
      opts.speech.say({ text: output.reply, priority: 'NAV', dedupeKey: `voice-reply`, cooldownMs: 1000, ...(cacheKey ? { cacheKey } : {}) });
      opts.conversation?.pushAisle(output.reply, 'speech');
    };
    // Confirm-back before a big commitment (v2 B-4): a spoken *route* is read back for a yes/no
    // first, so a misheard place does not launch a wrong walk. A spoken *task* starts at once
    // ("Bananas on the table. Got it.") unless the recogniser itself was unsure of the words:
    // a wrong task costs one "stop", while every confirmation costs a press, a word and a
    // recognition — the round that failed three times on 2026-09-19. Typed input starts at once.
    const askConfirm = (q: string, pending: NonNullable<typeof pendingConfirm>): void => {
      pendingConfirm = pending;
      confirmationMisses = 0;
      opts.speech.say({ text: q, priority: 'NAV', dedupeKey: 'confirm-back', cooldownMs: 5000 });
      opts.conversation?.pushAisle(q, 'prompt');
    };
    const startTask = (goal: string, context: TaskContext): void => {
      // An explicit new mission replaces a route or an older mission through the legal
      // abort edge. Previously TASK_REQUESTED was silently ignored outside IDLE.
      if (opts.store.getState().mode !== 'IDLE') opts.store.getState().abort();
      const q = source === 'voice' && confirm ? goalConfirmQuestion(goal) : null;
      if (q) {
        askConfirm(q, { kind: 'task', goal, context });
        return;
      }
      reply();
      opts.bus.emit({ type: 'TASK_REQUESTED', goal, context, source });
    };
    const startRoute = (destination: string): void => {
      const q = source === 'voice' ? goalConfirmQuestion(destination) : null;
      if (q) {
        askConfirm(q, { kind: 'route', destination });
        return;
      }
      reply();
      opts.bus.emit({ type: 'DESTINATION_REQUESTED', name: destination, source });
    };
    if (output.intent === 'find_item' && output.item) {
      // No surveyed store map: when the awareness loop already places the user in a store
      // (or at home) and they are not on a trip, the model finds the item by looking — a
      // guided task with that context — instead of the map-driven trip. On any trip, or when
      // the scene is a street or unknown, the item still drives the trip (ITEM_REQUESTED),
      // so the outdoor "walk me to a store" path is untouched.
      const onTrip = ON_TRIP.has(opts.store.getState().mode);
      const scene = onTrip ? null : opts.sceneContext?.() ?? null;
      if (scene === 'store' || scene === 'home') {
        startTask(output.item, scene);
        return;
      }
      // A household thing named off any trip is a home task whatever the scene guess says
      // ("bananas" while the awareness loop still believes "street" — 2026-09-19 trace).
      if (!onTrip && isHouseholdThing(output.item)) {
        startTask(output.item, 'home');
        return;
      }
      opts.bus.emit({ type: 'ITEM_REQUESTED', item: output.item, source });
    } else if (output.intent === 'navigate_to' && output.destination) {
      // Voice: confirm the place first ("The CVS on Forbes — right?"). Keyboard: the echo
      // ("CVS. Got it.") then the trip's own prompts queue behind it.
      startRoute(output.destination);
      return;
    } else if (output.intent === 'guided_task' && output.goal) {
      const m = opts.store.getState().mode;
      const inStore = m === 'INDOOR_NAV' || m === 'AT_ITEM' || m === 'ITEM_PICKUP' || m === 'CHECKOUT_NAV';
      // The awareness loop's confirmed or observed scene beats the mode's guess; the mode still wins inside a trip.
      const context: TaskContext = explicitHomeGoal(output.goal) !== null || /\b(fridge|refrigerator|my kitchen|my living room)\b/i.test(output.goal)
        ? 'home' : inStore ? 'store' : m === 'OUTDOOR_NAV' ? 'street' : (opts.sceneContext?.() ?? 'home');
      startTask(output.goal, context);
      return;
    } else if (output.intent === 'abort') {
      opts.store.getState().abort();
    }
    reply();
  };

  const finishWith = async (transcript: string, sttPath: VoiceOutcome['sttPath'], source: VoiceSource, uncertain = false): Promise<VoiceOutcome> => {
    if (!transcript.trim() && source === 'voice') {
      // Capture failure is not an unclear intent or a rejected confirmation.
      const reply = 'No speech recorded. Wait for listening, then speak while holding.';
      if (now() - lastEmptyNotice >= 15_000) {
        lastEmptyNotice = now();
        opts.speech.say({ text: reply, priority: 'NAV', dedupeKey: 'voice-empty', cooldownMs: 15_000 });
        opts.conversation?.pushAisle(reply, 'speech');
      }
      last = { output: { intent: 'unknown', item: null, reply }, transcript: '', sttPath, planner: false, plannerLatencyMs: null, localIntent: 'intercepted' };
      return last;
    }
    pushUser(transcript, source);
    const previousGoal = opts.store.getState().taskGoal ?? (pendingConfirm?.kind === 'task' ? pendingConfirm.goal : null);
    const previousItem = previousGoal ?? opts.store.getState().targetItem ?? last?.output.item;
    const placeCorrection = /^(?:in|from|inside) (?:my|the) (?:fridge|refrigerator)[.!]?$/i.test(transcript.trim());
    const homeGoal = placeCorrection && previousItem
      ? `${previousItem.replace(/\s+(?:in|from|inside)\s+.*$/i, '')} in my fridge`
      : explicitHomeGoal(transcript);
    // A confirm-back is waiting ("Eggs in my fridge. Did I get that right?"): consume yes/no
    // here, before the planner or any other intercept. Yes in any of its spoken forms, or the
    // same request said again, starts it; no asks again; a different request replaces it; one
    // unclear answer earns "say yes or no" and the pending goal survives; a second unclear
    // answer is simply treated as a fresh utterance (never a dead end that tells the user
    // their confirmation was "cancelled").
    if (pendingConfirm) {
      const c = pendingConfirm;
      const restated = c.kind === 'task'
        ? sameGoal(homeGoal ?? parseIntentFallback(transcript, opts.knownItems()).goal ?? parseIntentFallback(transcript, opts.knownItems()).item, c.goal)
        : sameGoal(parseIntentFallback(transcript, opts.knownItems()).destination, c.destination);
      if (isAffirmative(transcript) || restated || (leansYes(transcript) && c.kind === 'task' && mentions(transcript, c.goal))) {
        pendingConfirm = null;
        unclearStreak = 0;
        if (c.kind === 'task') opts.bus.emit({ type: 'TASK_REQUESTED', goal: c.goal, context: c.context, source });
        else opts.bus.emit({ type: 'DESTINATION_REQUESTED', name: c.destination, source });
        const output: ParseIntentOutput = c.kind === 'task'
          ? { intent: 'guided_task', item: null, destination: null, goal: c.goal, reply: '' }
          : { intent: 'navigate_to', item: null, destination: c.destination, goal: null, reply: '' };
        last = { output, transcript, sttPath, planner: false, plannerLatencyMs: null, localIntent: 'intercepted' };
        return last;
      }
      if (isNegative(transcript) && !homeGoal && !['guided_task', 'navigate_to', 'find_item'].includes(parseIntentFallback(transcript, opts.knownItems()).intent)) {
        pendingConfirm = null;
        opts.speech.say({ text: PHRASES.say_item_again, priority: 'NAV', cacheKey: 'say_item_again', dedupeKey: 'voice-reply', cooldownMs: 1000 });
        opts.conversation?.pushAisle(PHRASES.say_item_again, 'speech');
        last = { output: { intent: 'unknown', item: null, reply: PHRASES.say_item_again }, transcript, sttPath, planner: false, plannerLatencyMs: null, localIntent: 'intercepted' };
        return last;
      }
      const correction = parseIntentFallback(transcript, opts.knownItems());
      const newRequest = homeGoal !== null || ABORT_RE.test(transcript) || ['guided_task', 'navigate_to', 'find_item'].includes(correction.intent);
      if (!newRequest && confirmationMisses < 1) {
        confirmationMisses += 1;
        const question = 'Say yes to confirm, or tell me your request again.';
        opts.speech.say({ text: question, priority: 'NAV', dedupeKey: 'confirm-retry', cooldownMs: 1000 });
        opts.conversation?.pushAisle(question, 'prompt');
        last = { output: { intent: 'unknown', item: null, reply: question }, transcript, sttPath, planner: false, plannerLatencyMs: null, localIntent: 'intercepted' };
        return last;
      }
      pendingConfirm = null;
    }
    if (homeGoal && !ABORT_RE.test(transcript)) {
      if (opts.store.getState().mode === 'GUIDED_TASK' && previousGoal &&
          (homeGoal === previousGoal || /^(?:my |the )?(?:fridge|refrigerator)$/i.test(homeGoal)) &&
          opts.intercept?.('repeat')) {
        last = { output: { intent: 'guided_task', item: null, goal: previousGoal, reply: '' }, transcript, sttPath, planner: false, plannerLatencyMs: null, localIntent: 'intercepted' };
        return last;
      }
      const output: ParseIntentOutput = { intent: 'guided_task', item: null, goal: homeGoal, reply: sanitizeReply(`${titleCase(homeGoal)}. Got it.`, PHRASES.noted) };
      pendingConfirm = null;
      act(output, source, false); // explicit local indoor commands need no model confirmation
      last = { output, transcript, sttPath, planner: false, plannerLatencyMs: null };
      return last;
    }
    if (transcript.length > 0 && opts.intercept?.(transcript)) {
      unclearStreak = 0;
      const output: ParseIntentOutput = { intent: 'unknown', item: null, reply: '' };
      last = { output, transcript, sttPath, planner: false, plannerLatencyMs: null, localIntent: 'intercepted' };
      return last;
    }
    if (transcript.length > 0 && opts.describe && isDescribeRequest(transcript)) {
      unclearStreak = 0;
      let text: string | null = null;
      try {
        text = await opts.describe();
      } catch {
        text = null;
      }
      // The describer spoke (and logged) its own words; only the empty case needs a reply here.
      const output: ParseIntentOutput = { intent: 'unknown', item: null, reply: text ?? PHRASES.describe_nothing };
      if (text === null) act(output, source);
      last = { output, transcript, sttPath, planner: false, plannerLatencyMs: null, localIntent: 'describe' };
      return last;
    }
    const r = transcript.length > 0
      ? await plan(transcript)
      : { output: parseIntentFallback('', []), planner: false, latencyMs: null };
    const output = withUnclearPrompt(r.output);
    // B-3: an unrecognised utterance is usually a question ("is the fridge open?", "how many
    // steps?"), not noise — send it to the camera as a free question in the user's words rather
    // than "Say the item again." Scene / "where is X" questions were already taken by intercept.
    if (output.intent === 'unknown' && transcript.length > 0 && opts.askScene) {
      unclearStreak = 0;
      let answer: string | null = null;
      try {
        answer = await opts.askScene(transcript);
      } catch {
        answer = null;
      }
      if (answer && answer.trim().length > 0) {
        // The vision service spoke and logged its own answer; nothing more to say here.
        last = { output: { intent: 'unknown', item: null, reply: answer }, transcript, sttPath, planner: r.planner, plannerLatencyMs: r.latencyMs, localIntent: 'describe' };
        return last;
      }
      opts.speech.say({ text: PHRASES.not_caught, priority: 'NAV', cacheKey: 'not_caught', dedupeKey: 'voice-reply', cooldownMs: 1000 });
      opts.conversation?.pushAisle(PHRASES.not_caught, 'speech');
      last = { output: { intent: 'unknown', item: null, reply: PHRASES.not_caught }, transcript, sttPath, planner: r.planner, plannerLatencyMs: r.latencyMs, localIntent: 'intercepted' };
      return last;
    }
    act(output, source, uncertain);
    last = { output, transcript, sttPath, planner: r.planner, plannerLatencyMs: r.latencyMs };
    return last;
  };

  /** "bananas on the table" ≈ "the bananas on the table": the same request in other words. */
  const sameGoal = (a: string | null | undefined, b: string | null | undefined): boolean => {
    if (!a || !b) return false;
    const norm = (s: string): string => normalizeAnswer(s).replace(/\b(?:the|a|an|my|some|please|find|get|me)\b/g, ' ').replace(/\s+/g, ' ').trim();
    const x = norm(a);
    const y = norm(b);
    return x.length > 0 && (x === y || x.includes(y) || y.includes(x));
  };
  /** The request's own words appear in the answer ("correct, the bananas on the table"). */
  const mentions = (answer: string, goal: string): boolean => {
    const a = normalizeAnswer(answer);
    const words = normalizeAnswer(goal).split(' ').filter((w) => w.length > 3 && !['from', 'with', 'into', 'that', 'this', 'please'].includes(w));
    return words.length > 0 && words.some((w) => a.includes(w));
  };

  const teardown = async (s: Session | null): Promise<void> => {
    if (s) {
      s.done = true;
      discardClip(s);
    }
    opts.haptics?.setSuspended(false);
    try {
      await opts.audio?.setRecordingMode(false);
    } catch {
      // the session comes back on the next configureSession()
    }
    opts.speech.setSuspended?.(false);
    // Native end is awaited before teardown. Do not schedule another playback
    // reset: its async retries can otherwise overwrite the next recording session.
  };

  return {
    async begin() {
      // The previous utterance may still be planning (a proxy round trip, a camera question);
      // the microphone only needs its *capture* to be over. Waiting for the planning was
      // the first second of the next answer going unheard.
      if (capturing) await capturing;
      if (session) return;
      const s: Session = { handle: null, pressedAt: now(), readyAt: null, results: [], finalTranscript: null, audioUri: null, ended: false, error: null, done: false, waiters: [] };
      session = s;
      // Stop the app talking into its own microphone (B-1): clear the queue and cut the
      // current utterance the instant the talk button opens the mic. Half the bad transcripts
      // were the recogniser hearing Aisle narrate.
      opts.speech.clearQueue();
      opts.speech.setSuspended?.(true);
      opts.haptics?.setSuspended(true);
      try {
        if (opts.audio?.suspendForRecording) opts.audio.suspendForRecording();
        else await opts.audio?.setRecordingMode(true);
      } catch {
        // continue: the recognizer configures its own category on iOS
      }
      const rec = opts.recognizer;
      if (!rec || !rec.isAvailable()) {
        s.error = 'unavailable';
        s.ended = true;
        return;
      }
      const granted = await rec.requestPermissions();
      if (!granted) {
        s.error = 'not-allowed';
        s.ended = true;
        return;
      }
      if (session !== s) return; // cancelled while asking
      s.handle = rec.listen(
        // Start locally when supported; saved audio still permits the existing STT fallback.
        { lang: 'en-US', onDevice: opts.preferOnDeviceStt !== false && rec.supportsOnDevice(), contextualStrings: keytermsFrom(opts.knownItems()), persistAudio },
        {
          onResult(e) {
            if (!bestTranscript(e.results)) return; // an empty final must not erase useful partials
            s.results = e.results;
            if (e.isFinal) {
              s.finalTranscript = bestTranscript(e.results);
              wake(s);
            }
          },
          onError(code) {
            s.error = code;
            s.ended = true;
            wake(s);
          },
          onEnd() {
            s.ended = true;
            wake(s);
          },
          onAudioEnd(uri) {
            s.audioUri = uri;
            // The recognizer may hand the file over after end()/cancel() finished: delete it then.
            if (s.done) discardClip(s);
          },
        },
      );
      if (s.handle.ready) {
        await s.handle.ready;
        s.readyAt = now();
      }
    },

    end() {
      if (ending) return ending;
      const s = session;
      if (!s) {
        return Promise.resolve({ output: { intent: 'unknown' as const, item: null, reply: '' }, transcript: '', sttPath: 'none' as const, planner: false, plannerLatencyMs: null });
      }
      const releasedAt = now();
      // 1. Capture: keep a short tail for a short hold, stop, wait for the final result, tear
      //    the session down. The next press can start as soon as this settles.
      const capture = (async (): Promise<{ transcript: string; sttPath: VoiceOutcome['sttPath']; uncertain: boolean }> => {
        let tailMs = 0;
        try {
          if (s.readyAt !== null) {
            const heard = releasedAt - s.readyAt;
            if (heard < SHORT_HOLD_MS) {
              tailMs = Math.min(SHORT_HOLD_TAIL_MAX_MS, SHORT_HOLD_MS - heard);
              await sleep(tailMs);
            }
          }
          s.handle?.stop();
          await waitForFinal(s);
          if (s.handle?.ended && !s.ended) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([s.handle.ended, new Promise<void>((resolve) => { timer = setTimeout(resolve, 2000); })]);
            if (timer) clearTimeout(timer);
          }
          let transcript = s.finalTranscript || bestTranscript(s.results);
          let sttPath: VoiceOutcome['sttPath'] = transcript ? 'on-device' : 'none';
          const confidence = Math.max(...s.results.map((r) => r.confidence ?? -1));
          let uncertain = confidence >= 0 && confidence < UNCERTAIN_CONFIDENCE;
          if ((!transcript || uncertain) && s.audioUri && opts.sttUpload) {
            const scribe = await opts.sttUpload(s.audioUri, keytermsFrom(opts.knownItems()), STT_TIMEOUT_MS);
            if (scribe && scribe.trim()) {
              transcript = scribe.trim();
              sttPath = 'scribe';
              uncertain = false;
            }
          }
          opts.onDiagnostic?.({
            error: s.error, ended: s.ended, hasClip: !!s.audioUri, resultCount: s.results.length, transcriptLength: transcript.length, sttPath,
            startMs: s.readyAt === null ? null : s.readyAt - s.pressedAt, heldMs: releasedAt - s.pressedAt, tailMs, finalMs: now() - releasedAt - tailMs,
            confidence: confidence >= 0 ? Math.round(confidence * 100) / 100 : null,
          });
          return { transcript, sttPath, uncertain };
        } catch {
          return { transcript: '', sttPath: 'none', uncertain: false };
        } finally {
          if (session === s) session = null;
          await teardown(s);
        }
      })();
      capturing = capture.then(() => undefined, () => undefined);
      void capturing.then(() => { capturing = null; });
      // 2. Understanding, in spoken order, off the microphone's critical path.
      const result = processing.then(async () => {
        const c = await capture;
        return finishWith(c.transcript, c.sttPath, 'voice', c.uncertain);
      });
      processing = result.then(() => undefined, () => undefined);
      ending = result;
      void result.then(() => { ending = null; }, () => { ending = null; });
      return result;
    },

    cancel() {
      const s = session;
      session = null;
      if (s) {
        try {
          s.handle?.abort();
        } catch {
          // already gone
        }
      }
      void teardown(s);
    },

    isListening: () => session !== null && !session.ended,
    isAwaitingConfirmation: () => pendingConfirm !== null,

    async submitText(text) {
      return finishWith(text.trim(), 'keyboard', 'keyboard');
    },

    getLast: () => last,
  };
}

// ---------------------------------------------------------------------------
// expo-speech-recognition recognizer (required lazily)
// ---------------------------------------------------------------------------

export function createExpoRecognizer(): Recognizer {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const SR = require('expo-speech-recognition') as typeof import('expo-speech-recognition');
  const M = SR.ExpoSpeechRecognitionModule;
  return {
    isAvailable: () => {
      try {
        return M.isRecognitionAvailable();
      } catch {
        return false;
      }
    },
    supportsOnDevice: () => {
      try {
        return M.supportsOnDeviceRecognition();
      } catch {
        return false;
      }
    },
    async requestPermissions() {
      try {
        return (await M.requestPermissionsAsync()).granted;
      } catch {
        return false;
      }
    },
    listen(o, h) {
      let readyResolve!: () => void;
      let readyReject!: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
      let endResolve!: () => void;
      const ended = new Promise<void>((resolve) => { endResolve = resolve; });
      void ready.catch(() => undefined); // start() can throw before begin() attaches its await
      const readyTimer = setTimeout(() => readyReject(new Error('Microphone startup timed out')), 5000);
      const markReady = (): void => { clearTimeout(readyTimer); readyResolve(); };
      const subs = [
        M.addListener('audiostart', markReady),
        M.addListener('result', (e) => h.onResult({ isFinal: e.isFinal, results: e.results.map((r) => ({ transcript: r.transcript, confidence: r.confidence })) })),
        M.addListener('error', (e) => { clearTimeout(readyTimer); readyReject(new Error(e.error)); h.onError(e.error); }),
        M.addListener('end', () => {
          clearTimeout(readyTimer);
          readyReject(new Error('Recording ended before microphone became ready'));
          h.onEnd();
          endResolve();
          for (const s of subs) s.remove();
        }),
        M.addListener('audioend', (e) => h.onAudioEnd(e.uri)),
      ];
      M.start({
        lang: o.lang,
        interimResults: true,
        continuous: true, // push-to-talk ends on release, not the first brief silence
        requiresOnDeviceRecognition: o.onDevice,
        contextualStrings: o.contextualStrings,
        iosTaskHint: 'search',
        // Keep playback on the speaker and duck instead of re-routing (02 Task 7).
        iosCategory: {
          category: 'playAndRecord',
          categoryOptions: ['duckOthers', 'defaultToSpeaker', 'allowBluetooth'],
          mode: 'default',
        },
        // Persist only for the Scribe fallback; otherwise nothing is written to disk.
        ...(o.persistAudio
          ? { recordingOptions: { persist: true, outputSampleRate: 16_000, outputEncoding: 'pcmFormatInt16' } }
          : {}),
      });
      return {
        ready,
        ended,
        stop: () => M.stop(),
        abort: () => M.abort(),
      };
    },
  };
}

/** Deletes a persisted clip through expo-file-system; every failure is swallowed. */
export function createExpoFileDelete(): NonNullable<VoiceInputOptions['deleteFile']> {
  return (uri) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const FS = require('expo-file-system') as typeof import('expo-file-system');
      const file = new FS.File(uri);
      if (file.exists) file.delete();
    } catch {
      // nothing to delete, or the module is absent (tests)
    }
  };
}

/** Scribe fallback through the proxy: multipart upload of the persisted clip. */
export function createExpoSttUpload(proxyUrl: string): NonNullable<VoiceInputOptions['sttUpload']> {
  return async (uri, keyterms, timeoutMs) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const FS = require('expo-file-system') as typeof import('expo-file-system');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const file = new FS.File(uri);
      if (!file.exists) return null;
      const res = await file.upload(`${proxyUrl}/api/stt`, {
        httpMethod: 'POST',
        uploadType: FS.UploadType.MULTIPART,
        fieldName: 'audio',
        mimeType: file.type || 'audio/wav',
        parameters: { keyterms: JSON.stringify(keyterms), model_id: 'scribe_v2' },
        signal: controller.signal,
      });
      if (res.status < 200 || res.status >= 300) return null;
      const body = JSON.parse(res.body) as { transcript?: unknown; text?: unknown };
      const t = typeof body.transcript === 'string' ? body.transcript : typeof body.text === 'string' ? body.text : null;
      return t;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
