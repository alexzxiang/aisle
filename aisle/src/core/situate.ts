/**
 * Situate — the awareness loop: the app keeps a working guess about where the
 * user is and checks it with them.
 *
 * Rhythm (while the mode is one of `AWARE_MODES`, i.e. the camera is up and no
 * walking guidance owns speech):
 *   - No confident guess yet → "Turn slowly. Show me your surroundings." at most
 *     once per `promptIntervalMs`, starting `settleMs` after the loop begins.
 *   - Every `askIntervalMs`, ask Tier 1 `situate` (scene-gated by the vision
 *     service: a still frame is not re-asked). Claude's cameraRequest prompts
 *     ("Tilt the camera up.") are spoken by the vision service as usual.
 *   - A confident reading that differs from the current guess → "You seem to be
 *     <label>. Is that right?" (one live line, ≤ 12 words), at most once per
 *     `questionGapMs` once a guess exists, and never while a question is open.
 *   - "Yes" → confirmed ("Got it."). "No" → "Tell me where you are." and the next
 *     utterance becomes the scene in the user's own words. "I'm in the kitchen"
 *     at any time does the same without being asked.
 *
 * The guess lives in the store (`scene`) for the screens and for whoever needs a
 * context: voice.ts maps it to the guided task's home / store / street.
 *
 * Speech classes: the cached lines are 'reply' phrases; the question is live
 * text ('unknown'), allowed in every aware mode by the mode policy.
 */
import type { AppMode, PerceptionService, SceneClassEvent, SceneHypothesis, SceneSetting, SpeechService, TaskContext, VisionResponse } from './contracts';
import type { AppStore } from './store';
import type { ConversationLog } from './conversation';
import { MAX_UTTERANCE_WORDS, PHRASES, countWords, findForbiddenTerm, hasDigit } from './phrases';
import { sanitizeSpeech, type SemanticVision } from '../perception/semanticVision';

export const SITUATE_TICK_MS = 1000;
export const SITUATE_SETTLE_MS = 3000;
/** Looks this often when the scene keeps changing (the vision service's scene gate skips a still frame). */
export const SITUATE_ASK_INTERVAL_MS = 4000;
/** Narration ("You are looking at a wall.") no more often than this, and never the same words twice within the suppress window. */
export const SITUATE_NARRATE_GAP_MS = 5000;
export const SITUATE_NARRATE_REPEAT_MS = 30_000;
export const SITUATE_PROMPT_INTERVAL_MS = 20_000;
export const SITUATE_QUESTION_GAP_MS = 30_000;
export const SITUATE_QUESTION_TTL_MS = 20_000;
/** After the voice becomes free again (a trip or task ended), hold prompts this long so their last line is not clobbered. */
export const SITUATE_REENTRY_MS = 8000;
export const SITUATE_MIN_CONFIDENCE = 0.6;
export const SITUATE_MAX_LABEL_WORDS = 7;

/** Modes in which the loop looks: the camera is up. */
export const AWARE_MODES: ReadonlySet<AppMode> = new Set<AppMode>(['IDLE', 'GUIDED_TASK']);
/**
 * Modes in which the loop may speak (the standing ask and the question). In a
 * guided task the step instructions own the voice; the loop only keeps the
 * scene line fresh. A pending request in IDLE (an item or a place being
 * resolved) is also left alone: the trip is already talking.
 */
export const SPEAK_MODES: ReadonlySet<AppMode> = new Set<AppMode>(['IDLE']);

const YES_RE = /^(?:yes|yeah|yep|yup|correct|right|that's right|thats right|that is right|exactly|sure|uh huh|mm hmm|affirmative|true)[.!]?$/i;
const NO_RE = /^(?:no|nope|nah|wrong|incorrect|not really|that's wrong|thats wrong|that is wrong|negative|false)[.!]?$/i;
const HERE_PREFIX_RE = /^(?:i(?:'m| am)|we(?:'re| are)|i think i(?:'m| am))\s+/i;
const PLACE_PREP_RE = /^(?:at|in|on|inside|outside|by|near|next to)\s/i;

export function isYes(t: string): boolean {
  return YES_RE.test(t.trim());
}
export function isNo(t: string): boolean {
  return NO_RE.test(t.trim());
}

/** "I'm in the kitchen" → "in the kitchen"; null when the utterance is not a whereabouts statement. */
export function whereaboutsFrom(transcript: string): string | null {
  const t = transcript.trim().replace(/[.!?]+$/, '');
  if (!HERE_PREFIX_RE.test(t)) return null;
  const rest = t.replace(HERE_PREFIX_RE, '').trim();
  if (rest.length < 2 || rest.length > 60) return null;
  // Keep the preposition the user used so the label reads naturally.
  return PLACE_PREP_RE.test(rest) ? rest : `in ${rest}`;
}

const SETTING_WORDS: ReadonlyArray<[RegExp, SceneSetting]> = [
  [/\b(kitchen|fridge|refrigerator|freezer|stove|oven|sink|counter|pantry)\b/i, 'kitchen'],
  [/\b(hall|hallway|corridor|stairs|staircase|landing)\b/i, 'hallway'],
  [/\b(living room|bedroom|bathroom|office|dining room|room|couch|sofa|bed|desk|apartment|house|home|flat)\b/i, 'room'],
  [/\b(crosswalk|crossing|intersection|corner|curb|kerb)\b/i, 'crossing'],
  [/\b(entrance|door|doorway|front of|lobby|gate)\b/i, 'entrance'],
  [/\b(store|shop|market|grocery|aisle|pharmacy|cvs|walgreens|giant eagle|target|walmart|mall|checkout)\b/i, 'store'],
  [/\b(street|sidewalk|road|outside|outdoors|avenue|block|park|bus stop|campus)\b/i, 'street'],
  [/\b(car|bus|train|taxi|uber|vehicle|subway)\b/i, 'vehicle'],
];

/** The coarse setting a whereabouts phrase implies. */
export function settingFromWords(phrase: string): SceneSetting {
  for (const [re, setting] of SETTING_WORDS) if (re.test(phrase)) return setting;
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Apple's on-device scene classifier (round 6): identifiers → a setting + phrase
// ---------------------------------------------------------------------------

/** Substrings of `VNClassifyImageRequest` identifiers that vote for a setting. Order matters only for ties. */
const SCENE_VOTES: ReadonlyArray<[SceneSetting, RegExp]> = [
  ['kitchen', /kitchen|refrigerator|fridge|stove|oven|microwave|dishwasher|kettle|toaster|countertop/],
  ['crossing', /crosswalk|zebra|intersection|traffic_light|traffic_sign|pedestrian/],
  ['store', /supermarket|grocery|store|shop|market|mall|shelf|shelves|aisle|pharmacy|checkout|cashier|bakery|deli|retail/],
  ['entrance', /door|doorway|entrance|gate|porch|entryway|foyer|vestibule/],
  ['hallway', /hallway|corridor|stair|elevator|escalator|lobby|passage/],
  ['vehicle', /car_interior|vehicle_interior|bus_interior|train|subway|cockpit|dashboard|steering/],
  ['street', /street|sidewalk|road|avenue|alley|parking|city|urban|building|skyscraper|park|campus|plaza|outdoor|bus_stop|storefront/],
  ['room', /living_room|bedroom|bathroom|dining_room|office|couch|sofa|bed|television|bookshelf|desk|apartment|home|indoor|lamp|carpet|curtain|room/],
];

/** The thing worth naming next to the setting ("in a kitchen by a fridge"). */
const SCENE_OBJECT: ReadonlyArray<[RegExp, string]> = [
  [/refrigerator|fridge/, 'a fridge'], [/stove|oven/, 'a stove'], [/sink/, 'a sink'], [/couch|sofa/, 'a couch'],
  [/television|tv/, 'a tv'], [/\bbed\b/, 'a bed'], [/dining_table|table/, 'a table'], [/desk/, 'a desk'],
  [/door|doorway/, 'a door'], [/stair/, 'stairs'], [/elevator/, 'an elevator'], [/shelf|shelves/, 'shelves'],
  [/traffic_light/, 'a traffic light'], [/crosswalk|zebra/, 'a crosswalk'], [/bus_stop/, 'a bus stop'],
  [/storefront|shop_window/, 'a storefront'], [/bench/, 'a bench'], [/plant|tree/, 'a plant'],
];

const SETTING_PHRASE: Readonly<Record<SceneSetting, string>> = {
  street: 'on a street', crossing: 'at a crossing', entrance: 'at a doorway', store: 'in a store', home: 'at home',
  kitchen: 'in a kitchen', hallway: 'in a hallway', room: 'in a room', vehicle: 'in a vehicle', unknown: '',
};

const ROOM_PHRASE: ReadonlyArray<[RegExp, string]> = [
  [/living_room/, 'in a living room'], [/bedroom/, 'in a bedroom'], [/bathroom/, 'in a bathroom'],
  [/dining_room/, 'in a dining room'], [/office/, 'in an office'], [/supermarket|grocery/, 'in a grocery store'],
  [/pharmacy/, 'in a pharmacy'], [/sidewalk/, 'on a sidewalk'], [/parking/, 'in a parking lot'], [/park\b/, 'in a park'],
];

export interface SceneClassReading {
  setting: SceneSetting;
  /** "in a living room by a couch" */
  label: string;
  /** Summed label confidence for the winning setting, 0..1+. */
  score: number;
}

/** Weigh Apple's labels into one setting + phrase; null when nothing votes. Pure; tested. */
export function classifySceneLabels(labels: SceneClassEvent['labels']): SceneClassReading | null {
  const votes = new Map<SceneSetting, number>();
  const ids: string[] = [];
  for (const l of labels) {
    const id = l.id.toLowerCase();
    ids.push(id);
    for (const [setting, re] of SCENE_VOTES) {
      if (re.test(id)) {
        votes.set(setting, (votes.get(setting) ?? 0) + l.confidence);
        break; // one vote per label, the most specific setting first
      }
    }
  }
  if (votes.size === 0) return null;
  const [setting, score] = Array.from(votes.entries()).sort((a, b) => b[1] - a[1])[0]!;
  const joined = ids.join(' ');
  let phrase = SETTING_PHRASE[setting];
  for (const [re, p] of ROOM_PHRASE) if (re.test(joined)) { phrase = p; break; }
  const object = SCENE_OBJECT.find(([re]) => re.test(joined))?.[1];
  const label = object && !phrase.includes(object.replace(/^an? /, '')) ? `${phrase} by ${object}` : phrase;
  return { setting, label, score };
}

const SETTING_LABEL: Readonly<Record<SceneSetting, string>> = {
  street: 'on a street',
  crossing: 'at a crossing',
  entrance: 'at an entrance',
  store: 'in a store',
  home: 'at home',
  kitchen: 'in a kitchen',
  hallway: 'in a hallway',
  room: 'in a room',
  vehicle: 'in a vehicle',
  unknown: '',
};

/** The task context a setting implies (voice.ts hands it to TASK_REQUESTED). */
export function contextForSetting(setting: SceneSetting): TaskContext {
  switch (setting) {
    case 'street':
    case 'crossing':
    case 'entrance':
      return 'street';
    case 'store':
      return 'store';
    case 'home':
    case 'kitchen':
    case 'hallway':
    case 'room':
      return 'home';
    default:
      return 'unknown';
  }
}

/** A speakable label: ≤ 7 words, no digits, no forbidden term; else the setting's own words. */
export function speakableLabel(label: string, setting: SceneSetting): string {
  const l = label.trim().replace(/[.!?]+$/, '').toLowerCase();
  if (l.length > 0 && countWords(l) <= SITUATE_MAX_LABEL_WORDS && !hasDigit(l) && findForbiddenTerm(l) === null) return l;
  return SETTING_LABEL[setting];
}

/**
 * "You seem to be in a kitchen. Is that right?" — a longer label gets the one-word
 * tail ("… by a refrigerator. Correct?") so the whole line stays within twelve words;
 * null when there is nothing safe to say.
 */
export function sceneQuestion(label: string, setting: SceneSetting): string | null {
  const l = speakableLabel(label, setting);
  if (!l) return null;
  const long = `You seem to be ${l}. Is that right?`;
  if (countWords(long) <= MAX_UTTERANCE_WORDS) return long;
  const short = `You seem to be ${l}. Correct?`;
  if (countWords(short) <= MAX_UTTERANCE_WORDS) return short;
  const fallback = SETTING_LABEL[setting];
  return fallback ? `You seem to be ${fallback}. Is that right?` : null;
}

const STOP_WORDS = new Set(['the', 'and', 'with', 'near', 'next', 'from', 'into', 'onto', 'that', 'this', 'some', 'your', 'my']);

/** Two readings are "the same place" when the setting matches and the labels share a content word. */
export function sameScene(a: Pick<SceneHypothesis, 'setting' | 'label'>, b: Pick<SceneHypothesis, 'setting' | 'label'>): boolean {
  if (a.setting !== b.setting) return false;
  const words = (s: string): string[] => s.toLowerCase().split(/\s+/).filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  const wa = words(a.label);
  const wb = words(b.label);
  if (wa.length === 0 || wb.length === 0) return true;
  return wa.some((w) => wb.includes(w));
}

export const SITUATE_CLASS_MIN_SCORE = 0.15;
/** Two agreeing on-device readings (≈1 s at 2 fps) before a place is proposed from them. */
export const SITUATE_CLASS_STREAK = 2;

export interface SituateDeps {
  store: Pick<AppStore, 'getState' | 'setState' | 'subscribe'>;
  speech: Pick<SpeechService, 'say'>;
  vision: Pick<SemanticVision, 'ask'>;
  /** Apple's on-device scene classifier (round 6): the fast path to "where am I". */
  perception?: Pick<PerceptionService, 'onSceneClass'>;
  conversation?: Pick<ConversationLog, 'pushAisle'>;
  /** Default: the mode is in AWARE_MODES. */
  active?: () => boolean;
  /** Default: the mode is in SPEAK_MODES and no request is pending. */
  mayspeak?: () => boolean;
  /** Narrate what the camera faces (the `describeSurroundings` preference). Default: on. */
  narrate?: () => boolean;
  narrateGapMs?: number;
  narrateRepeatMs?: number;
  now?: () => number;
  tickMs?: number;
  settleMs?: number;
  askIntervalMs?: number;
  promptIntervalMs?: number;
  questionGapMs?: number;
  questionTtlMs?: number;
  reentryMs?: number;
  minConfidence?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export interface SituateDebugState {
  running: boolean;
  scene: SceneHypothesis | null;
  pending: 'question' | 'whereabouts' | null;
  asks: number;
  prompts: number;
  questions: number;
  narrations: number;
  /** On-device classifier readings received / accepted into a hypothesis. */
  classReadings: number;
  classAccepted: number;
  lastAskAt: number | null;
}

export interface Situate {
  start(): void;
  stop(): void;
  /**
   * Voice, before the planner: consumes "yes" / "no" while a question is open, the
   * answer after "Tell me where you are.", and a spontaneous "I'm in the kitchen".
   * Returns true when the transcript was handled here.
   */
  intercept(transcript: string): boolean;
  getScene(): SceneHypothesis | null;
  /** The task context the current scene implies, or null when nothing is known. */
  getContext(): TaskContext | null;
  getDebugState(): SituateDebugState;
  dispose(): void;
}

type Pending = { kind: 'question'; scene: SceneHypothesis; at: number } | { kind: 'whereabouts'; at: number };

export function createSituate(deps: SituateDeps): Situate {
  const now = deps.now ?? Date.now;
  const tickMs = deps.tickMs ?? SITUATE_TICK_MS;
  const settleMs = deps.settleMs ?? SITUATE_SETTLE_MS;
  const askIntervalMs = deps.askIntervalMs ?? SITUATE_ASK_INTERVAL_MS;
  const promptIntervalMs = deps.promptIntervalMs ?? SITUATE_PROMPT_INTERVAL_MS;
  const questionGapMs = deps.questionGapMs ?? SITUATE_QUESTION_GAP_MS;
  const questionTtlMs = deps.questionTtlMs ?? SITUATE_QUESTION_TTL_MS;
  const reentryMs = deps.reentryMs ?? SITUATE_REENTRY_MS;
  const narrateGapMs = deps.narrateGapMs ?? SITUATE_NARRATE_GAP_MS;
  const narrateRepeatMs = deps.narrateRepeatMs ?? SITUATE_NARRATE_REPEAT_MS;
  const narrateOn = deps.narrate ?? (() => true);
  const minConfidence = deps.minConfidence ?? SITUATE_MIN_CONFIDENCE;
  const setI: typeof setInterval = deps.setIntervalFn ?? setInterval;
  const clearI: typeof clearInterval = deps.clearIntervalFn ?? clearInterval;
  const active = deps.active ?? (() => AWARE_MODES.has(deps.store.getState().mode));
  const voiceFree = deps.mayspeak ?? (() => {
    const s = deps.store.getState();
    return SPEAK_MODES.has(s.mode) && s.targetItem === null;
  });
  /** Free, and free for long enough that a trip's or task's last line has played. */
  const maySpeak = (): boolean => {
    const t = now();
    if (!voiceFree()) {
      speakSince = null;
      return false;
    }
    if (speakSince === null) speakSince = t;
    return t - speakSince >= reentryMs;
  };

  let handle: ReturnType<typeof setInterval> | null = null;
  let disposed = false;
  let startedAt: number | null = null;
  let inFlight = false;
  let lastAskAt: number | null = null;
  let lastPromptAt: number | null = null;
  let lastQuestionAt: number | null = null;
  let pending: Pending | null = null;
  /** When the voice last became ours (null while someone else has it). */
  let speakSince: number | null = null;
  /** The last guess put to the user, so a guess parked during a hold is asked once the voice is free. */
  let proposedKey: string | null = null;
  const keyOf = (s: Pick<SceneHypothesis, 'setting' | 'label'>): string => `${s.setting}|${s.label.toLowerCase()}`;
  let asks = 0;
  let prompts = 0;
  let questions = 0;
  let narrations = 0;
  let lastNarrationAt: number | null = null;
  const recentNarration = new Map<string, number>();
  let classReadings = 0;
  let classAccepted = 0;
  let classStreak: { setting: SceneSetting; n: number } | null = null;
  let unsubScene: (() => void) | null = null;

  const scene = (): SceneHypothesis | null => deps.store.getState().scene;
  const setScene = (s: SceneHypothesis | null): void => deps.store.setState({ scene: s });

  const sayKey = (key: 'show_surroundings' | 'tell_me_where' | 'noted', cooldownMs: number): void => {
    deps.speech.say({ text: PHRASES[key], cacheKey: key, priority: 'NAV', dedupeKey: `situate-${key}`, cooldownMs });
    deps.conversation?.pushAisle(PHRASES[key], 'prompt');
  };

  const ask = (text: string): void => {
    deps.speech.say({ text, priority: 'NAV', dedupeKey: 'situate-question', cooldownMs: 5000 });
    deps.conversation?.pushAisle(text, 'prompt');
  };

  const propose = (candidate: SceneHypothesis, t: number): void => {
    const q = sceneQuestion(candidate.label, candidate.setting);
    if (!q) return;
    questions += 1;
    lastQuestionAt = t;
    proposedKey = keyOf(candidate);
    pending = { kind: 'question', scene: candidate, at: t };
    // The guess shows on screen at once; `confirmed` waits for the answer.
    setScene(candidate);
    ask(q);
  };

  /** "You are looking at a wall." — INFO, so any guidance in the queue wins; the same words are not news for a while. */
  const narrate = (res: VisionResponse, t: number): void => {
    if (!narrateOn() || !voiceFree()) return;
    const text = sanitizeSpeech(res.speech);
    if (!text) return;
    if (lastNarrationAt !== null && t - lastNarrationAt < narrateGapMs) return;
    const key = text.toLowerCase();
    const seenAt = recentNarration.get(key);
    if (seenAt !== undefined && t - seenAt < narrateRepeatMs) return;
    for (const [k, at] of Array.from(recentNarration.entries())) if (t - at >= narrateRepeatMs) recentNarration.delete(k);
    recentNarration.set(key, t);
    lastNarrationAt = t;
    narrations += 1;
    deps.speech.say({ text, priority: 'INFO', dedupeKey: 'situate-narration', cooldownMs: narrateGapMs });
    deps.conversation?.pushAisle(text, 'describe');
  };

  const consider = (r: { setting: SceneSetting; label: string; confidence: number }, t: number): void => {
    if (r.setting === 'unknown' || r.confidence < minConfidence) return;
    const candidate: SceneHypothesis = { setting: r.setting, label: r.label, confidence: r.confidence, confirmed: false, source: 'camera', at: t };
    const cur = scene();
    if (cur && sameScene(cur, candidate)) {
      // Same place: refresh silently, keep the user's confirmation and wording.
      if (cur.source === 'camera') setScene({ ...cur, confidence: r.confidence, at: t, label: cur.confirmed ? cur.label : candidate.label });
      else setScene({ ...cur, at: t });
      return;
    }
    if (pending) return;
    if (cur && lastQuestionAt !== null && t - lastQuestionAt < questionGapMs) return;
    if (!maySpeak()) {
      // A task or a request owns the voice: keep the line on screen honest, ask later.
      if (!cur || !cur.confirmed) setScene(candidate);
      return;
    }
    propose(candidate, t);
  };

  const tick = (): void => {
    if (disposed || !active()) return;
    const t = now();
    const canSpeak = maySpeak();
    if (pending && t - pending.at > questionTtlMs) pending = null; // no answer: keep the guess, stop waiting
    const cur = scene();
    const confident = cur !== null && (cur.confirmed || cur.confidence >= minConfidence);
    const settled = startedAt !== null && t - startedAt >= settleMs;
    // A guess parked while something else had the voice: ask now.
    if (canSpeak && !pending && cur && !cur.confirmed && cur.source === 'camera' && cur.confidence >= minConfidence && proposedKey !== keyOf(cur)
        && (lastQuestionAt === null || t - lastQuestionAt >= questionGapMs)) {
      propose(cur, t);
      return;
    }
    if (!confident && !pending && settled && canSpeak && (lastPromptAt === null || t - lastPromptAt >= promptIntervalMs)) {
      prompts += 1;
      lastPromptAt = t;
      sayKey('show_surroundings', promptIntervalMs);
    }
    if (!inFlight && settled && (lastAskAt === null || t - lastAskAt >= askIntervalMs)) {
      inFlight = true;
      asks += 1;
      lastAskAt = t;
      const said = cur?.source === 'user' ? `User says they are ${cur.label}.` : undefined;
      void deps.vision.ask('situate', { silent: true, ...(said ? { userText: said } : {}) })
        .then((out) => {
          if (disposed) return;
          if (out.status === 'applied' && out.response) {
            const at = now();
            narrate(out.response, at);
            consider(out.response.scene, at);
          }
        })
        .catch(() => undefined)
        .then(() => {
          inFlight = false;
        });
    }
  };

  /** An on-device reading: two in a row for the same setting become a camera hypothesis (Claude refines the words later). */
  const onSceneClass = (e: SceneClassEvent): void => {
    if (disposed || !active()) return;
    classReadings += 1;
    const r = classifySceneLabels(e.labels);
    if (!r || r.score < SITUATE_CLASS_MIN_SCORE) {
      classStreak = null;
      return;
    }
    classStreak = classStreak && classStreak.setting === r.setting ? { setting: r.setting, n: classStreak.n + 1 } : { setting: r.setting, n: 1 };
    if (classStreak.n < SITUATE_CLASS_STREAK) return;
    classAccepted += 1;
    consider({ setting: r.setting, label: r.label, confidence: Math.min(0.95, 0.45 + r.score) }, now());
  };

  const confirmScene = (label: string, setting: SceneSetting, source: SceneHypothesis['source'], t: number): void => {
    const cur = scene();
    const confidence = source === 'camera' && cur ? Math.max(cur.confidence, minConfidence) : 1;
    setScene({ setting, label, confidence, confirmed: true, source, at: t });
    pending = null;
    sayKey('noted', 0);
  };

  const stop = (): void => {
    if (handle !== null) clearI(handle);
    handle = null;
    startedAt = null;
    pending = null;
    classStreak = null;
    unsubScene?.();
    unsubScene = null;
  };

  return {
    start() {
      if (handle !== null || disposed) return;
      startedAt = now();
      speakSince = voiceFree() ? startedAt : null;
      handle = setI(tick, tickMs);
      if (deps.perception && !unsubScene) unsubScene = deps.perception.onSceneClass(onSceneClass);
    },
    stop,
    intercept(transcript) {
      if (disposed) return false;
      const t = now();
      const text = transcript.trim();
      if (text.length === 0) return false;
      if (pending?.kind === 'question') {
        if (isYes(text)) {
          confirmScene(pending.scene.label, pending.scene.setting, 'camera', t);
          return true;
        }
        if (isNo(text)) {
          pending = { kind: 'whereabouts', at: t };
          sayKey('tell_me_where', 0);
          return true;
        }
      }
      const said = whereaboutsFrom(text);
      if (said) {
        confirmScene(said, settingFromWords(said), 'user', t);
        return true;
      }
      if (pending?.kind === 'whereabouts' && !isNo(text) && countWords(text) <= 8) {
        const label = PLACE_PREP_RE.test(text) ? text.toLowerCase() : `in ${text.toLowerCase()}`;
        confirmScene(label.replace(/[.!?]+$/, ''), settingFromWords(text), 'user', t);
        return true;
      }
      return false;
    },
    getScene: scene,
    getContext() {
      const s = scene();
      if (!s) return null;
      const c = contextForSetting(s.setting);
      return c === 'unknown' ? null : c;
    },
    getDebugState() {
      return { running: handle !== null, scene: scene(), pending: pending?.kind ?? null, asks, prompts, questions, narrations, classReadings, classAccepted, lastAskAt };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
    },
  };
}
