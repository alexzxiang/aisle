/**
 * SpeechService (01 §3, 02 Task 4): one priority queue in front of three
 * backends (cached expo-audio players, live/prefetched files from the proxy's
 * `/api/tts`, and `expo-speech` as the offline fallback), plus the Tier-1
 * stream player (`playStream`). Callers never check mode, never dedupe, never
 * pace themselves: every rule lives here.
 *
 * Rules (01 §3 "Queue rules", 02 Task 4):
 *   - one current playback handle across every backend; CRITICAL stops it,
 *     flushes everything below and plays at once;
 *   - NAV queues with one pending slot (newest wins); INFO is dropped when
 *     anything is pending;
 *   - a `dedupeKey` that fired inside `cooldownMs` (default 8 s) is dropped;
 *   - never more than one utterance per 4 s outside CRITICAL;
 *   - > 12 words or a digit in `text`: throw in dev, truncate/flag in prod,
 *     `ERROR {scope: 'speech'}` on the bus; the long-phrase allow-list has one
 *     member (`disclaimer`) and never exempts the forbidden-word check;
 *   - forbidden words: throw in dev, drop + ERROR in prod;
 *   - a phrase-table `cacheKey` speaks the table's wording (02 Task 4: the only
 *     permitted wording); caller text that differs throws in dev and is replaced
 *     + reported in prod; only runtime `tts:` keys carry caller text;
 *   - mode policy from the store (01 §3 table), checked at enqueue and again
 *     at dequeue so nothing queued before AT_CURB leaks into the curb silence;
 *   - CRITICAL bypasses the mode table only for hazard classes (vehicle,
 *     obstacle, scan, always); free text or a stream marked CRITICAL is
 *     policy-dropped + ERROR, so the curb silence cannot be bought with a flag;
 *   - dedupe / prompt timestamps are recorded only when the queue accepts the
 *     item, so an INFO the queue dropped does not burn its cooldown;
 *   - Tier-1 prompt keys (`tilt_camera_up`, `turn_*_a_little`): ≤ 1 per 3 s and
 *     never while COURSE is buzzing; A's own `course_hint_*` are exempt.
 *
 * The service is pure with respect to the platform: `SpeechBackend` is
 * injected (see `speechBackend.ts` for the expo one) so the queue is unit-
 * tested with fake timers and a fake backend.
 */
import type { AppMode, SpeechPriority, SpeechRequest, SpeechService } from './contracts';
import type { AppEventBus } from './bus';
import type { ConversationLog } from './conversation';
import type { AppStore } from './store';
import {
  LONG_PHRASE_ALLOWLIST,
  MAX_PROMPT_WORDS,
  MAX_UTTERANCE_WORDS,
  PHRASES,
  PHRASE_CATEGORY,
  TIER1_PROMPT_KEYS,
  checkPhrase,
  isPhraseKey,
  truncateWords,
  phraseKeyForText,
  type PhraseCategory,
} from './phrases';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MIN_GAP_MS = 4000;
export const DEFAULT_COOLDOWN_MS = 8000;
export const PROMPT_MIN_INTERVAL_MS = 3000;
/** Live synthesis budget before falling to expo-speech (01 §11: first audio < 400 ms; be generous on cellular). */
export const LIVE_SYNTH_TIMEOUT_MS = 500;
export const PREFETCH_TIMEOUT_MS = 8000;
/** Watchdogs so a missed "finished" event can never wedge the queue. */
export const UTTERANCE_WATCHDOG_MS = 10_000;
export const LONG_UTTERANCE_WATCHDOG_MS = 13_000;
export const STREAM_WATCHDOG_MS = 15_000;
export const RUNTIME_KEY_PREFIX = 'tts:';

const PRIORITY_RANK: Readonly<Record<SpeechPriority, number>> = { INFO: 0, NAV: 1, CRITICAL: 2 };

// ---------------------------------------------------------------------------
// Mode policy (01 §3 table). CRITICAL skips the table only for hazard classes.
// ---------------------------------------------------------------------------

export type SpeechClass = PhraseCategory | 'unknown' | 'stream';

const ALL_CLASSES: readonly SpeechClass[] = [
  'always', 'compass', 'leg', 'crossing_fact', 'signal', 'countdown', 'far_curb', 'vehicle', 'scan',
  'indoor', 'obstacle', 'prompt', 'course_hint', 'reply', 'training', 'onboarding', 'unknown', 'stream',
];

const WALKING: readonly SpeechClass[] = [
  'always', 'compass', 'leg', 'crossing_fact', 'far_curb', 'vehicle', 'obstacle', 'prompt', 'course_hint',
  'reply', 'training', 'unknown', 'stream',
];
const CURB: readonly SpeechClass[] = ['always', 'compass', 'signal', 'countdown', 'vehicle', 'scan'];
const CROSSING: readonly SpeechClass[] = ['always', 'vehicle', 'countdown', 'far_curb'];
const INDOOR: readonly SpeechClass[] = [
  'always', 'indoor', 'obstacle', 'prompt', 'course_hint', 'reply', 'training', 'unknown', 'stream',
];

export const MODE_POLICY: Readonly<Record<AppMode, ReadonlySet<SpeechClass>>> = {
  IDLE: new Set(ALL_CLASSES),
  ONBOARDING: new Set(ALL_CLASSES),
  OUTDOOR_NAV: new Set(WALKING),
  APPROACH_CROSSING: new Set(WALKING),
  AT_CURB: new Set(CURB),
  CROSSING: new Set(CROSSING),
  TRANSITION: new Set(INDOOR),
  INDOOR_NAV: new Set(INDOOR),
  AT_ITEM: new Set(INDOOR),
  ITEM_PICKUP: new Set(INDOOR),
  CHECKOUT_NAV: new Set(INDOOR),
  DONE: new Set(ALL_CLASSES),
  GUIDED_TASK: new Set(INDOOR),   // step instructions, hazards, describe; never crossing classes
};

export function classifyRequest(req: { cacheKey?: string; streamId?: string }): SpeechClass {
  if (req.streamId !== undefined) return 'stream';
  if (req.cacheKey && isPhraseKey(req.cacheKey)) return PHRASE_CATEGORY[req.cacheKey];
  return 'unknown';
}

/**
 * The only classes CRITICAL may carry (01 §3: "CRITICAL interrupts" is for
 * hazards). Anything else marked CRITICAL — free text, a Tier-1 stream, a leg
 * cue — is policy-dropped and reported, in every mode.
 */
export const CRITICAL_CLASSES: ReadonlySet<SpeechClass> = new Set<SpeechClass>(['always', 'vehicle', 'obstacle', 'scan']);

export function isAllowedInMode(mode: AppMode, cls: SpeechClass, priority: SpeechPriority): boolean {
  if (priority === 'CRITICAL') return CRITICAL_CLASSES.has(cls);
  return MODE_POLICY[mode].has(cls);
}

// ---------------------------------------------------------------------------
// Text validation (dev throws, prod repairs + reports)
// ---------------------------------------------------------------------------

export class SpeechTextError extends Error {
  constructor(message: string, public readonly text: string) {
    super(message);
    this.name = 'SpeechTextError';
  }
}

export interface ValidatedText {
  text: string;
  /** Problems found (already repaired in prod; empty in a clean call). */
  problems: string[];
  /** True when the utterance must be dropped (forbidden word in prod). */
  drop: boolean;
}

export function validateText(text: string, opts: { allowLong: boolean; isPrompt: boolean; isDev: boolean }): ValidatedText {
  const violations = checkPhrase(text, {
    allowLong: opts.allowLong,
    maxWords: opts.isPrompt ? MAX_PROMPT_WORDS : MAX_UTTERANCE_WORDS,
  });
  if (violations.length === 0) return { text, problems: [], drop: false };
  const problems = violations.map((v) =>
    v.kind === 'forbidden' ? `forbidden word "${v.term}"`
      : v.kind === 'too_long' ? `${v.words} words (max ${v.max})`
        : v.kind === 'digit' ? 'digits must be written as words'
          : 'empty text');
  if (opts.isDev) {
    throw new SpeechTextError(`[speech] rejected "${text}": ${problems.join('; ')}`, text);
  }
  let out = text;
  let drop = false;
  for (const v of violations) {
    if (v.kind === 'forbidden' || v.kind === 'empty') drop = true;
    if (v.kind === 'too_long') out = truncateWords(out, v.max);
  }
  return { text: out, problems, drop };
}

// ---------------------------------------------------------------------------
// Backend contract
// ---------------------------------------------------------------------------

export type SpeechBackendName = 'cached' | 'file' | 'stream' | 'expo-speech';

export interface PlaybackHandle {
  backend: SpeechBackendName;
  stop(): void;
}

export interface SpeechBackend {
  hasCached(key: string): boolean;
  /** Returns null when the key is unknown or the player failed to start. `onDone` fires once. */
  playCached(key: string, rate: number, onDone: () => void): PlaybackHandle | null;
  playFile(uri: string, rate: number, onDone: () => void): PlaybackHandle | null;
  playUrl(url: string, rate: number, onDone: () => void): PlaybackHandle | null;
  /** expo-speech; never fails to return a handle. */
  speak(text: string, rate: number, onDone: () => void): PlaybackHandle;
  /** POST /api/tts and persist; resolves to a file uri, or null on any failure/timeout. */
  synthesize(text: string, timeoutMs: number): Promise<string | null>;
  /** URL of a Tier-1 stream relayed by the proxy. */
  streamUrl(streamId: string): string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface SpeechStats {
  spoken: number;
  utterancesPerMinute: number;
  policyDropped: number;
  dedupeDropped: number;
  gateDropped: number;
  queueDropped: number;
  textRepaired: number;
  lastBackend: SpeechBackendName | null;
  lastText: string | null;
  lastStartedAt: number | null;
  pending: number;
  speaking: boolean;
}

export interface AisleSpeechService extends SpeechService {
  setSuspended(on: boolean): void;
  /**
   * A-side extension (flagged for 01 §3): synthesize variable text through
   * `/api/tts` now and cache it on the phone, so `say({ text })` with the same
   * text — or `say({ cacheKey })` with the returned key — never goes live
   * during the walk. Resolves to the runtime key, or null when offline
   * (`say` then falls back to expo-speech).
   */
  prefetch(text: string): Promise<string | null>;
  /** Runtime key `say()` would resolve for this text (B's shared path convention). */
  runtimeKeyFor(text: string): string;
  getStats(): SpeechStats;
  dispose(): void;
}

export interface SpeechServiceOptions {
  backend: SpeechBackend;
  store: AppStore;
  bus?: AppEventBus;
  /** Default: `__DEV__` when defined, else NODE_ENV !== 'production'. */
  isDev?: boolean;
  /** The COURSE buzz is on (HapticService.isCourseBuzzing). */
  isCourseBuzzing?: () => boolean;
  now?: () => number;
  /** Override the live-synthesis budget (tests). */
  liveSynthTimeoutMs?: number;
  /**
   * The transcript blurb: every utterance that actually starts playing is
   * pushed as role 'aisle' (source 'speech'). Dropped requests never appear.
   * Optional so fake-backend tests and stub shells run without one.
   */
  conversation?: Pick<ConversationLog, 'pushAisle'>;
}

interface QueueItem {
  id: number;
  priority: SpeechPriority;
  cls: SpeechClass;
  text: string;
  cacheKey?: string;
  streamId?: string;
  allowLong: boolean;
  interrupt: boolean;
}

interface Current {
  item: QueueItem;
  handle: PlaybackHandle | null;
  cancelled: boolean;
  watchdog: ReturnType<typeof setTimeout> | null;
}

/** FNV-1a 32-bit, hex. Stable across runs; the cache file name for live text. */
export function fnv1a32(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function defaultIsDev(): boolean {
  const g = globalThis as { __DEV__?: boolean };
  if (typeof g.__DEV__ === 'boolean') return g.__DEV__;
  return typeof process !== 'undefined' && process.env.NODE_ENV !== 'production';
}

export function createSpeechService(opts: SpeechServiceOptions): AisleSpeechService {
  const { backend, store } = opts;
  const now = opts.now ?? Date.now;
  const isDev = opts.isDev ?? defaultIsDev();
  const liveTimeout = opts.liveSynthTimeoutMs ?? LIVE_SYNTH_TIMEOUT_MS;

  let nextId = 1;
  let current: Current | null = null;
  let pending: QueueItem | null = null;          // one NAV/INFO slot, newest NAV wins
  const criticals: QueueItem[] = [];             // FIFO behind a playing CRITICAL
  let gapTimer: ReturnType<typeof setTimeout> | null = null;
  let lastNonCriticalStart = -Infinity;
  let lastPromptAt = -Infinity;
  const lastFired = new Map<string, number>();
  const runtimeUris = new Map<string, string>();  // runtime key → file uri
  const utteranceTimes: number[] = [];
  let rate = store.getState().speechRate;
  let disposed = false;
  let suspended = false;

  const stats = {
    spoken: 0, policyDropped: 0, dedupeDropped: 0, gateDropped: 0, queueDropped: 0, textRepaired: 0,
    lastBackend: null as SpeechBackendName | null, lastText: null as string | null,
    lastStartedAt: null as number | null,
  };

  const report = (message: string): void => {
    opts.bus?.emit({ type: 'ERROR', scope: 'speech', message });
  };

  const mode = (): AppMode => store.getState().mode;

  const runtimeKeyFor = (text: string): string => RUNTIME_KEY_PREFIX + fnv1a32(text);

  // --- playback ---------------------------------------------------------------

  const clearGapTimer = (): void => {
    if (gapTimer !== null) {
      clearTimeout(gapTimer);
      gapTimer = null;
    }
  };

  const finish = (c: Current): void => {
    if (current !== c) return;
    if (c.watchdog !== null) clearTimeout(c.watchdog);
    current = null;
    pump();
  };

  const stopCurrent = (): void => {
    const c = current;
    if (!c) return;
    c.cancelled = true;
    if (c.watchdog !== null) clearTimeout(c.watchdog);
    try {
      c.handle?.stop();
    } catch {
      // a backend that throws on stop must not take the queue down
    }
    current = null;
  };

  const markStarted = (c: Current, handle: PlaybackHandle, watchdogMs: number): void => {
    c.handle = handle;
    const t = now();
    if (c.item.priority !== 'CRITICAL') lastNonCriticalStart = t;
    stats.spoken += 1;
    stats.lastBackend = handle.backend;
    stats.lastText = c.item.streamId !== undefined ? `<stream ${c.item.streamId}>` : c.item.text;
    stats.lastStartedAt = t;
    utteranceTimes.push(t);
    while (utteranceTimes.length > 0 && t - utteranceTimes[0] > 60_000) utteranceTimes.shift();
    c.watchdog = setTimeout(() => { c.handle?.stop(); finish(c); }, watchdogMs);
    // The blurb records what is being heard; a stream has no text to show.
    if (opts.conversation && c.item.streamId === undefined && c.item.text.length > 0) {
      try {
        opts.conversation.pushAisle(c.item.text, 'speech');
      } catch {
        // the log must never take the queue down
      }
    }
  };

  const begin = (item: QueueItem): void => {
    const c: Current = { item, handle: null, cancelled: false, watchdog: null };
    current = c;
    const onDone = (): void => finish(c);
    const watchdogMs = item.streamId !== undefined
      ? STREAM_WATCHDOG_MS
      : item.allowLong ? LONG_UTTERANCE_WATCHDOG_MS : UTTERANCE_WATCHDOG_MS;

    const startWith = (h: PlaybackHandle | null): boolean => {
      if (!h) return false;
      markStarted(c, h, watchdogMs);
      return true;
    };

    // 1. Tier-1 stream.
    if (item.streamId !== undefined) {
      if (!startWith(backend.playUrl(backend.streamUrl(item.streamId), rate, onDone))) finish(c);
      return;
    }
    // 2. Bundled cached phrase.
    if (item.cacheKey && backend.hasCached(item.cacheKey)) {
      if (startWith(backend.playCached(item.cacheKey, rate, onDone))) return;
    }
    // 3. Prefetched runtime file (by key or by text).
    const runtimeUri =
      (item.cacheKey && runtimeUris.get(item.cacheKey)) || runtimeUris.get(runtimeKeyFor(item.text));
    if (runtimeUri && startWith(backend.playFile(runtimeUri, rate, onDone))) return;
    // 4. Live synthesis with a short budget, else 5. expo-speech.
    if (item.text.length === 0) {
      finish(c);
      return;
    }
    // A walking/hand instruction must not wait for a network voice. Prepared phrases
    // above retain ElevenLabs; new task wording speaks locally immediately.
    if (mode() === 'GUIDED_TASK') {
      startWith(backend.speak(item.text, rate, onDone));
      return;
    }
    // Hold the slot while synthesizing so nothing else starts; the stop() handle cancels.
    c.handle = { backend: 'file', stop: () => { c.cancelled = true; } };
    let deadline: ReturnType<typeof setTimeout>;
    const bounded = Promise.race([
      backend.synthesize(item.text, liveTimeout),
      new Promise<null>((resolve) => { deadline = setTimeout(() => resolve(null), liveTimeout); }),
    ]);
    void bounded.finally(() => clearTimeout(deadline)).then(
      (uri) => {
        if (c.cancelled || current !== c) return;
        if (uri) {
          runtimeUris.set(runtimeKeyFor(item.text), uri);
          if (startWith(backend.playFile(uri, rate, onDone))) return;
        }
        if (!startWith(backend.speak(item.text, rate, onDone))) finish(c);
      },
      () => {
        if (c.cancelled || current !== c) return;
        if (!startWith(backend.speak(item.text, rate, onDone))) finish(c);
      },
    );
  };

  const pump = (): void => {
    if (disposed || current || suspended) return;
    if (criticals.length > 0) {
      clearGapTimer();
      begin(criticals.shift() as QueueItem);
      return;
    }
    if (!pending) return;
    // Re-check the policy at dequeue: the mode may have changed while pending.
    if (!isAllowedInMode(mode(), pending.cls, pending.priority)) {
      stats.policyDropped += 1;
      pending = null;
      return;
    }
    const handKey = pending.cacheKey;
    const handCue = mode() === 'GUIDED_TASK' && handKey !== undefined &&
      ['left', 'right', 'higher', 'lower', 'reach_forward', 'grab_it'].includes(handKey);
    const wait = lastNonCriticalStart + (handCue ? 1000 : MIN_GAP_MS) - now();
    if (wait > 0) {
      if (gapTimer === null) {
        gapTimer = setTimeout(() => {
          gapTimer = null;
          pump();
        }, wait);
      }
      return;
    }
    const item = pending;
    pending = null;
    begin(item);
  };

  // --- enqueue ------------------------------------------------------------------

  /** Returns true when the item now sits in the queue (or started); false when the queue dropped it. */
  const enqueue = (item: QueueItem): boolean => {
    if (item.priority === 'CRITICAL') {
      // Flush everything below; pre-empt anything that is not itself CRITICAL,
      // or a CRITICAL when asked to interrupt.
      pending = null;
      clearGapTimer();
      if (current && (current.item.priority !== 'CRITICAL' || item.interrupt)) stopCurrent();
      // An interrupting CRITICAL plays at once, ahead of any CRITICAL still waiting.
      if (item.interrupt) criticals.unshift(item);
      else criticals.push(item);
      pump();
      return true;
    }
    if (item.priority === 'NAV') {
      if (pending) stats.queueDropped += 1;   // the older pending item loses (newest wins)
      pending = item;
      pump();
      return true;
    }
    // INFO: dropped if anything is queued.
    if (pending || criticals.length > 0) {
      stats.queueDropped += 1;
      return false;
    }
    pending = item;
    pump();
    return true;
  };

  /**
   * Keyed requests speak the phrase table, never the caller's text (02 Task 4).
   * Returns the text to validate and the key to play (dev throws on a mismatch
   * or an unknown key; prod repairs + reports).
   */
  const resolveKeyedText = (req: SpeechRequest): { text: string; cacheKey?: string } => {
    const key = req.cacheKey;
    if (key === undefined || key.startsWith(RUNTIME_KEY_PREFIX)) return { text: req.text, cacheKey: key };
    if (isPhraseKey(key)) {
      const canonical = PHRASES[key];
      if (req.text === canonical) return { text: canonical, cacheKey: key };
      const msg = `say({cacheKey: "${key}"}) text differs from the phrase table: "${req.text}"`;
      if (isDev) throw new SpeechTextError(`[speech] ${msg}`, req.text);
      stats.textRepaired += 1;
      report(`${msg} — spoke the table wording`);
      return { text: canonical, cacheKey: key };
    }
    // Neither a table key nor a runtime key: nothing is cached under it, and the
    // caller cannot ride a privileged class on it.
    const msg = `say({cacheKey: "${key}"}) is not a phrase key or a ${RUNTIME_KEY_PREFIX} key`;
    if (isDev) throw new SpeechTextError(`[speech] ${msg}`, req.text);
    report(`${msg} — spoke as free text`);
    return { text: req.text };
  };

  const policyDrop = (what: string, cls: SpeechClass, priority: SpeechPriority): void => {
    stats.policyDropped += 1;
    // A non-hazard marked CRITICAL is a caller bug, not a quiet mode: say so on the bus.
    if (priority === 'CRITICAL') report(`CRITICAL ${what} dropped: class "${cls}" is not a hazard class`);
  };

  const say = (req: SpeechRequest): void => {
    if (disposed || suspended) return;
    if (!req.cacheKey) {
      const key = phraseKeyForText(req.text);
      if (key && !LONG_PHRASE_ALLOWLIST.has(key)) req = { ...req, cacheKey: key };
    }
    // Keyed requests speak the table; the class, the long-phrase exemption and
    // the playback key all derive from the resolved key, never from caller text.
    const resolved = resolveKeyedText(req);
    const cacheKey = resolved.cacheKey;
    const cls = classifyRequest({ cacheKey });
    const allowLong = cacheKey !== undefined && LONG_PHRASE_ALLOWLIST.has(cacheKey);
    const isPrompt = cls === 'prompt' || (cacheKey !== undefined && TIER1_PROMPT_KEYS.has(cacheKey));

    // Text guard: dev throws, prod repairs and reports (forbidden words drop).
    const v = validateText(resolved.text, { allowLong, isPrompt, isDev });
    if (v.problems.length > 0) {
      stats.textRepaired += 1;
      report(`say("${resolved.text}"): ${v.problems.join('; ')}${v.drop ? ' — dropped' : ' — truncated'}`);
      if (v.drop) return;
    }
    const text = v.text;

    // Mode policy (CRITICAL exempt only for hazard classes).
    if (!isAllowedInMode(mode(), cls, req.priority)) {
      policyDrop(`say("${text}")`, cls, req.priority);
      return;
    }

    // Tier-1 prompt gate: ≤ 1 per 3 s, never while the COURSE buzz runs.
    const t = now();
    if (isPrompt && (opts.isCourseBuzzing?.() || t - lastPromptAt < PROMPT_MIN_INTERVAL_MS)) {
      stats.gateDropped += 1;
      return;
    }

    // Dedupe.
    if (req.dedupeKey) {
      const cooldown = req.cooldownMs ?? DEFAULT_COOLDOWN_MS;
      const last = lastFired.get(req.dedupeKey);
      if (last !== undefined && t - last < cooldown) {
        stats.dedupeDropped += 1;
        return;
      }
    }

    const accepted = enqueue({
      id: nextId++,
      priority: req.priority,
      cls,
      text,
      cacheKey,
      allowLong,
      interrupt: req.priority === 'CRITICAL' && req.interrupt === true,
    });
    // Only an accepted item burns its cooldown / prompt slot: a queue-dropped
    // INFO was never heard, so its natural retry must still play.
    if (!accepted) return;
    if (isPrompt) lastPromptAt = t;
    if (req.dedupeKey) lastFired.set(req.dedupeKey, t);
  };

  const playStream = (streamId: string, priority: SpeechPriority): void => {
    if (disposed) return;
    if (!isAllowedInMode(mode(), 'stream', priority)) {
      policyDrop(`playStream("${streamId}")`, 'stream', priority);
      return;
    }
    enqueue({ id: nextId++, priority, cls: 'stream', text: '', streamId, allowLong: false, interrupt: false });
  };

  const clearQueue = (priority?: SpeechPriority): void => {
    const rank = priority ? PRIORITY_RANK[priority] : PRIORITY_RANK.CRITICAL;
    if (pending && PRIORITY_RANK[pending.priority] <= rank) pending = null;
    for (let i = criticals.length - 1; i >= 0; i -= 1) {
      if (PRIORITY_RANK[criticals[i].priority] <= rank) criticals.splice(i, 1);
    }
    if (current && PRIORITY_RANK[current.item.priority] <= rank) stopCurrent();
    clearGapTimer();
    pump();
  };

  const setRate = (r: number): void => {
    if (!Number.isFinite(r)) return;
    rate = Math.min(1.6, Math.max(0.8, r));
    if (store.getState().speechRate !== rate) store.getState().setSpeechRate(rate);
  };

  const prefetch = async (text: string): Promise<string | null> => {
    const key = runtimeKeyFor(text);
    if (runtimeUris.has(key)) return key;
    const v = checkPhrase(text, { allowLong: false });
    if (v.some((x) => x.kind === 'forbidden')) {
      const msg = `prefetch("${text}") rejected: forbidden word`;
      if (isDev) throw new SpeechTextError(msg, text);
      report(msg);
      return null;
    }
    const uri = await backend.synthesize(text, PREFETCH_TIMEOUT_MS);
    if (!uri) return null;
    runtimeUris.set(key, uri);
    return key;
  };

  // Store subscriptions: rate changes and mode changes.
  const unsubStore = store.subscribe((s, prev) => {
    if (s.speechRate !== prev.speechRate) rate = s.speechRate;
    if (s.mode !== prev.mode) {
      if (s.mode === 'IDLE') {
        clearQueue();
      } else if (pending && !isAllowedInMode(s.mode, pending.cls, pending.priority)) {
        stats.policyDropped += 1;
        pending = null;
        clearGapTimer();
      }
    }
  });

  return {
    setSuspended(on) {
      suspended = on;
      if (on) clearQueue();
      else { lastNonCriticalStart = -Infinity; pump(); }
    },
    say,
    playStream,
    clearQueue,
    isSpeaking: () => current !== null,
    setRate,
    prefetch,
    runtimeKeyFor,
    getStats: () => {
      const t = now();
      while (utteranceTimes.length > 0 && t - utteranceTimes[0] > 60_000) utteranceTimes.shift();
      return {
        ...stats,
        utterancesPerMinute: utteranceTimes.length,
        pending: (pending ? 1 : 0) + criticals.length,
        speaking: current !== null,
      };
    },
    dispose() {
      disposed = true;
      unsubStore();
      clearGapTimer();
      stopCurrent();
      pending = null;
      criticals.length = 0;
    },
  };
}
