/**
 * SceneDescriber — "the voice should see more".
 *
 * While the user walks (OUTDOOR_NAV, INDOOR_NAV, AT_ITEM, CHECKOUT_NAV) and the
 * `describeSurroundings` preference is on, it asks Claude the `free` question
 * through C's SemanticVision client — a 512-px still plus the on-device facts —
 * and speaks the ≤ 12-word `speech` at INFO priority with `dedupeKey:
 * 'describe'`, so guidance always wins: an INFO is dropped whenever anything is
 * queued, and the dedupe cooldown keeps it to one description per cadence.
 *
 * Cadence: a new ask only when the scene fingerprint (detector classes and
 * boxes on a 10 % grid, OCR tokens) has changed since the last ask, and never
 * more often than every 8 s. Never in APPROACH_CROSSING / AT_CURB / CROSSING:
 * no ask is made there, and a result that lands after the mode changed into
 * one of them is dropped, not spoken.
 *
 * `describeNow()` is the on-demand path ("what do you see"): it ignores the
 * cadence and the preference, speaks at NAV priority, and resolves to the
 * spoken text (or null when nothing usable came back), so the voice flow can
 * reply "Nothing to describe right now." itself.
 *
 * Every description is also pushed to the conversation log (source 'describe').
 */
import type { AppMode, Detection, PerceptionService, SpeechPriority, SpeechService } from './contracts';
import type { AppEventBus } from './bus';
import type { ConversationLog } from './conversation';
import type { AppStore } from './store';
import { checkPhrase } from './phrases';
import { sceneKey, type SemanticVision } from '../perception/semanticVision';
import { normalizeTokens } from '../indoor/ocrMatcher';

export const DESCRIBE_PROMPT =
  'In at most twelve words, say what is ahead that matters for walking: obstacles, people, doors, signs, aisles.';
export const DESCRIBE_MIN_INTERVAL_MS = 8000;
export const DESCRIBE_TICK_MS = 1000;
/** The same wording twice inside this window is not news. */
export const DESCRIBE_REPEAT_SUPPRESS_MS = 30_000;
export const DESCRIBE_DEDUPE_KEY = 'describe';
export const DESCRIBE_SNAPSHOT_WIDTH = 768;

/** Modes the cadence runs in. */
export const DESCRIBE_MODES: ReadonlySet<AppMode> = new Set<AppMode>(['OUTDOOR_NAV', 'INDOOR_NAV', 'AT_ITEM', 'CHECKOUT_NAV']);
/** Modes in which nothing is asked and nothing is spoken, on demand or otherwise. */
export const DESCRIBE_SILENT_MODES: ReadonlySet<AppMode> = new Set<AppMode>(['APPROACH_CROSSING', 'AT_CURB', 'CROSSING']);

export interface SceneDescriberDeps {
  vision: Pick<SemanticVision, 'ask'>;
  speech: Pick<SpeechService, 'say'>;
  store: Pick<AppStore, 'getState' | 'subscribe'>;
  bus: Pick<AppEventBus, 'emit'>;
  conversation: Pick<ConversationLog, 'pushAisle'>;
  perception: Pick<PerceptionService, 'onDetections' | 'onOcrText'>;
  /** The `describeSurroundings` preference (the cadence only; `describeNow` ignores it). */
  enabled: () => boolean;
  now?: () => number;
  minIntervalMs?: number;
  tickMs?: number;
}

export interface SceneDescriberStats {
  running: boolean;
  asks: number;
  spoken: number;
  dropped: number;
  inFlight: boolean;
  lastAskAt: number | null;
  lastText: string | null;
}

export interface SceneDescriber {
  start(): void;
  stop(): void;
  /** On-demand look; an optional question ("is the fridge open?") is sent as the vision prompt. */
  describeNow(question?: string): Promise<string | null>;
  getStats(): SceneDescriberStats;
}

export function createSceneDescriber(deps: SceneDescriberDeps): SceneDescriber {
  const now = deps.now ?? Date.now;
  const minIntervalMs = deps.minIntervalMs ?? DESCRIBE_MIN_INTERVAL_MS;
  const tickMs = deps.tickMs ?? DESCRIBE_TICK_MS;

  let running = false;
  let inFlight = false;
  let currentKey = '';
  let lastAskedKey: string | null = null;
  let lastAskAt: number | null = null;
  let lastText: string | null = null;
  let lastSpokenAt = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let detections: Detection[] = [];
  let ocrTokens: string[] = [];
  const unsubs: Array<() => void> = [];
  const stats = { asks: 0, spoken: 0, dropped: 0 };

  const mode = (): AppMode => deps.store.getState().mode;

  const refreshKey = (): void => {
    currentKey = sceneKey(detections, ocrTokens);
  };

  const sceneChanged = (): boolean => lastAskedKey === null || currentKey !== lastAskedKey;

  const report = (message: string): void => {
    try {
      deps.bus.emit({ type: 'ERROR', scope: 'describer', message });
    } catch {
      // never let reporting break the loop
    }
  };

  /** One question; resolves to the text spoken, or null. */
  const ask = async (priority: SpeechPriority, onDemand: boolean, question?: string): Promise<string | null> => {
    const t0 = now();
    lastAskAt = t0;
    lastAskedKey = currentKey;
    inFlight = true;
    stats.asks += 1;
    let speechText: string | null = null;
    try {
      const outcome = await deps.vision.ask('free', {
        userText: question && question.trim().length > 0 ? question.trim() : DESCRIBE_PROMPT,
        image: DESCRIBE_SNAPSHOT_WIDTH,
        priority: 'INFO',
        silent: true,   // spoken here, under the 'describe' dedupe key, not by the vision client
      });
      if (outcome.status === 'applied' && outcome.response) {
        const s = outcome.response.speech.trim();
        speechText = s.length > 0 && checkPhrase(s, { allowLong: false }).length === 0 ? s : null;
      }
    } catch (e) {
      report(`describe failed: ${e instanceof Error ? e.message : String(e)}`);
      speechText = null;
    } finally {
      inFlight = false;
    }
    if (!speechText) {
      stats.dropped += 1;
      return null;
    }
    // Curb silence: a result that lands after the mode changed is never spoken.
    const m = mode();
    if (DESCRIBE_SILENT_MODES.has(m) || (!onDemand && !DESCRIBE_MODES.has(m))) {
      stats.dropped += 1;
      return null;
    }
    const t = now();
    if (!onDemand && speechText === lastText && t - lastSpokenAt < DESCRIBE_REPEAT_SUPPRESS_MS) {
      stats.dropped += 1;
      return null;
    }
    lastText = speechText;
    lastSpokenAt = t;
    stats.spoken += 1;
    deps.speech.say({
      text: speechText,
      priority,
      dedupeKey: DESCRIBE_DEDUPE_KEY,
      cooldownMs: onDemand ? 1000 : minIntervalMs,
    });
    deps.conversation.pushAisle(speechText, 'describe');
    return speechText;
  };

  const maybeAsk = (): void => {
    if (!running || inFlight) return;
    if (!DESCRIBE_MODES.has(mode())) return;
    if (!deps.enabled()) return;
    if (lastAskAt !== null && now() - lastAskAt < minIntervalMs) return;
    if (!sceneChanged()) return;
    void ask('INFO', false);
  };

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = (): void => {
    clearTimer();
    if (!running) return;
    timer = setTimeout(() => {
      timer = null;
      maybeAsk();
      schedule();
    }, tickMs);
  };

  return {
    start() {
      if (running) return;
      running = true;
      unsubs.push(deps.perception.onDetections((d) => {
        detections = d;
        refreshKey();
      }));
      unsubs.push(deps.perception.onOcrText((reads) => {
        const toks = new Set<string>();
        for (const r of reads) for (const tok of normalizeTokens(r.text)) toks.add(tok);
        ocrTokens = Array.from(toks);
        refreshKey();
      }));
      unsubs.push(deps.store.subscribe((s, prev) => {
        if (s.mode === prev.mode) return;
        // A fresh mode is a fresh scene: describe it as soon as the cadence allows.
        if (DESCRIBE_MODES.has(s.mode)) {
          lastAskedKey = null;
          maybeAsk();
        }
      }));
      refreshKey();
      maybeAsk();
      schedule();
    },
    stop() {
      if (!running) return;
      running = false;
      clearTimer();
      for (const u of unsubs.splice(0)) u();
    },
    async describeNow(question?: string) {
      if (DESCRIBE_SILENT_MODES.has(mode())) return null;
      if (inFlight) return null;
      return ask('NAV', true, question);
    },
    getStats: () => ({ running, ...stats, inFlight, lastAskAt, lastText }),
  };
}
