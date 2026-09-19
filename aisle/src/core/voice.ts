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
import type { AppMode, ParseIntentInput, ParseIntentOutput, PlannerResult, SpeechService } from './contracts';
import type { AppEventBus } from './bus';
import type { AppStore } from './store';
import { PHRASES, checkPhrase } from './phrases';

// ---------------------------------------------------------------------------
// Pure: intent fallback and transcript choice
// ---------------------------------------------------------------------------

export const FALLBACK_REPLY = PHRASES.say_item_again;
export const RECOGNIZER_FINAL_TIMEOUT_MS = 3000;
export const PLAN_TIMEOUT_MS = 2500;
export const STT_TIMEOUT_MS = 4000;
export const MAX_KEYTERMS = 100;

const ABORT_RE = /\b(?:stop|cancel|quit|abort|never mind|nevermind|end (?:the )?(?:trip|route))\b/i;
const REPEAT_RE = /\b(?:repeat|again|what did you say|say that again)\b/i;
const HOW_FAR_RE = /\b(?:how far|how much further|how much farther|how long)\b/i;
const WHERE_RE = /\b(?:where am i|where are we|what street)\b/i;
const HELP_RE = /\b(?:help|what can you do|instructions)\b/i;
const FIND_PREFIX_RE = /^(?:(?:i|we)\s+(?:need|want|am looking for|'m looking for)|find|get|(?:take|bring) me to|looking for|where (?:is|are)(?: the)?|(?:i|we)\s+(?:need|want) to (?:find|get|buy))\s+/i;
const FILLER_RE = /\b(?:uh|um|please|some|the|a|an|like)\b/gi;

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim();
}

function titleCase(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/** Deterministic keyword parser: the templated fallback when the planner misses its deadline. */
export function parseIntentFallback(transcript: string, knownItems: readonly string[]): ParseIntentOutput {
  const t = normalize(transcript);
  if (t.length === 0) return { intent: 'unknown', item: null, reply: FALLBACK_REPLY };
  if (ABORT_RE.test(t)) return { intent: 'abort', item: null, reply: 'Stopping.' };
  if (REPEAT_RE.test(t)) return { intent: 'repeat', item: null, reply: 'Repeating.' };
  if (HOW_FAR_RE.test(t)) return { intent: 'how_far', item: null, reply: 'Checking the distance.' };
  if (WHERE_RE.test(t)) return { intent: 'where_am_i', item: null, reply: 'Checking where you are.' };

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
  'find_item', 'repeat', 'how_far', 'where_am_i', 'abort', 'help', 'unknown',
]);

export function coerceParseIntentOutput(raw: unknown, fallback: ParseIntentOutput): ParseIntentOutput {
  if (!raw || typeof raw !== 'object') return fallback;
  const o = raw as Partial<ParseIntentOutput>;
  const intent = INTENTS.has(o.intent as ParseIntentOutput['intent']) ? (o.intent as ParseIntentOutput['intent']) : fallback.intent;
  const item = typeof o.item === 'string' && o.item.trim().length > 0 ? o.item.trim().toLowerCase() : intent === 'find_item' ? fallback.item : null;
  return { intent, item, reply: sanitizeReply(o.reply, fallback.reply) };
}

/** Keyterms for Scribe: item + aisle vocabulary, capped so billing stays sane (07 §2). */
export function keytermsFrom(words: readonly string[], max: number = MAX_KEYTERMS): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const w of words) {
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
  speech: SpeechService;
  bus: AppEventBus;
  store: AppStore;
  proxyUrl: string;
  /** Item + aisle vocabulary (store map); used for contextual strings, Scribe keyterms and the fallback parser. */
  knownItems: () => string[];
  recognizer?: Recognizer;
  audio?: { setRecordingMode(on: boolean): Promise<void> };
  haptics?: { setSuspended(suspended: boolean): void };
  /** Upload the persisted clip to `/api/stt`; resolves to the transcript or null. Absent = never persist audio. */
  sttUpload?: (uri: string, keyterms: string[], timeoutMs: number) => Promise<string | null>;
  /** Remove a persisted clip once the utterance is over. Default: expo-file-system. Failures are swallowed. */
  deleteFile?: (uri: string) => Promise<void> | void;
  fetchImpl?: typeof fetch;
  now?: () => number;
  finalTimeoutMs?: number;
  planTimeoutMs?: number;
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
}

export interface VoiceInput {
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
  let session: Session | null = null;
  let last: VoiceOutcome | null = null;

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

  const act = (output: ParseIntentOutput, source: VoiceSource): void => {
    if (output.intent === 'find_item' && output.item) {
      opts.bus.emit({ type: 'ITEM_REQUESTED', item: output.item, source });
    } else if (output.intent === 'abort') {
      opts.store.getState().abort();
    }
    opts.speech.say({ text: output.reply, priority: 'NAV', dedupeKey: `voice-reply`, cooldownMs: 1000 });
  };

  const finishWith = async (transcript: string, sttPath: VoiceOutcome['sttPath'], source: VoiceSource): Promise<VoiceOutcome> => {
    const r = transcript.length > 0
      ? await plan(transcript)
      : { output: parseIntentFallback('', []), planner: false, latencyMs: null };
    act(r.output, source);
    last = { output: r.output, transcript, sttPath, planner: r.planner, plannerLatencyMs: r.latencyMs };
    return last;
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
  };

  return {
    async begin() {
      if (session) return;
      const s: Session = { handle: null, results: [], finalTranscript: null, audioUri: null, ended: false, error: null, done: false, waiters: [] };
      session = s;
      opts.haptics?.setSuspended(true);
      try {
        await opts.audio?.setRecordingMode(true);
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
        { lang: 'en-US', onDevice: rec.supportsOnDevice(), contextualStrings: keytermsFrom(opts.knownItems()), persistAudio },
        {
          onResult(e) {
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
    },

    async end() {
      const s = session;
      if (!s) return finishWith('', 'none', 'voice');
      try {
        s.handle?.stop();
        await waitForFinal(s);
        let transcript = s.finalTranscript ?? bestTranscript(s.results);
        let sttPath: VoiceOutcome['sttPath'] = transcript ? 'on-device' : 'none';
        if (!transcript && s.audioUri && opts.sttUpload) {
          const scribe = await opts.sttUpload(s.audioUri, keytermsFrom(opts.knownItems()), STT_TIMEOUT_MS);
          if (scribe && scribe.trim()) {
            transcript = scribe.trim();
            sttPath = 'scribe';
          }
        }
        session = null;
        await teardown(s);
        return await finishWith(transcript, sttPath, 'voice');
      } catch {
        session = null;
        await teardown(s);
        return finishWith('', 'none', 'voice');
      }
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
      const subs = [
        M.addListener('result', (e) => h.onResult({ isFinal: e.isFinal, results: e.results.map((r) => ({ transcript: r.transcript, confidence: r.confidence })) })),
        M.addListener('error', (e) => h.onError(e.error)),
        M.addListener('end', () => {
          h.onEnd();
          for (const s of subs) s.remove();
        }),
        M.addListener('audioend', (e) => h.onAudioEnd(e.uri)),
      ];
      M.start({
        lang: o.lang,
        interimResults: true,
        continuous: false,
        requiresOnDeviceRecognition: o.onDevice,
        contextualStrings: o.contextualStrings,
        iosTaskHint: 'search',
        // Keep playback on the speaker and duck instead of re-routing (02 Task 7).
        iosCategory: {
          category: 'playAndRecord',
          categoryOptions: ['duckOthers', 'defaultToSpeaker', 'allowBluetooth'],
          mode: 'measurement',
        },
        // Persist only for the Scribe fallback; otherwise nothing is written to disk.
        ...(o.persistAudio
          ? { recordingOptions: { persist: true, outputSampleRate: 16_000, outputEncoding: 'pcmFormatInt16' } }
          : {}),
      });
      return {
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
