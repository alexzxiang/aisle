/**
 * SemanticVision — the Tier 1 Claude client (01 §8, 04 Task 8, 04 Task 12).
 *
 * Only slack-tolerant questions, only on ambiguity / storefront / active
 * perception / user speech, never on a timer in a time-critical mode. The
 * request and response are 01 §8 verbatim; the proxy (Agent D) owns the route
 * and the model choice.
 *
 * Layers:
 *   - `VisionTransport` — `ask(req) → Promise<VisionResponse>`. Structurally the
 *     same shape as D's `mocks/types.ts` `SemanticVisionClient`, so the composition
 *     root hands over the replayer in mock mode and nothing here knows.
 *   - `createHttpVisionTransport` — `POST /api/vision`, 4 s timeout, no retries.
 *   - `createWsVisionTransport` — the same body over the persistent WebSocket for
 *     the indoor loop; the proxy relays ElevenLabs audio as `streamId = seq` the
 *     moment the `speech` string closes, and the full JSON follows. Falls back to
 *     HTTP while the socket is not open.
 *   - `createSemanticVision` — the policy: snapshot width per question, on-device
 *     facts as text, scene-change gate, per-question minimum interval, ≤ 3 in
 *     flight, sequence + freshness windows, confidence < 0.5 → ignore, forbidden-
 *     word filter, `speech` → say / playStream, `cameraRequest` / `userAction` →
 *     bus events + ≤ 6-word cached prompts (≤ 1 per 3 s, never while COURSE buzzes).
 *
 * WebSocket protocol — D's `server/ws/frames.ts` (server/README.md "WebSocket protocol"):
 *   → { type: 'vision', req: VisionRequest, priority: 'NAV' | 'INFO' }
 *   → { type: 'warm', mode: AppMode }                      (re-warms the grammar pairs that mode uses)
 *   → { type: 'ping' }                                     ← { type: 'pong' }
 *   ← { type: 'hello', maxInFlight, audio }
 *   ← { type: 'speech_start', streamId }                   (streamId = seq; audio follows; play it)
 *   ← <binary: uint32 big-endian streamId + mp3 bytes>     (`onAudioChunk`)
 *   ← { type: 'speech_end', streamId, firstAudioMs }
 *   ← { type: 'result', res: VisionResponse | { confidence: 0, seq } }
 *   ← { type: 'error', seq, code }                         (a `result` with confidence 0 follows for seq errors)
 */
import {
  SCENE_SETTINGS,
  type AppMode,
  type CameraDirection,
  type DepthSummary,
  type Detection,
  type PerceptionService,
  type SceneSetting,
  type SignalState,
  type SpeechPriority,
  type SpeechService,
  type UserAction,
  type VisionQuestion,
  type VisionRequest,
  type VisionResponse,
} from '../core/contracts';
import type { AppEventBus } from '../core/bus';
import type { AppStore } from '../core/store';
import { MAX_PROMPT_WORDS, MAX_UTTERANCE_WORDS, countWords, findForbiddenTerm, hasDigit, phraseText } from '../core/phrases';
import { normalizeTokens } from '../indoor/ocrMatcher';

// ---------------------------------------------------------------------------
// Constants (01 §8)
// ---------------------------------------------------------------------------

export const VISION_TIMEOUT_MS = 4000;
export const MAX_IN_FLIGHT = 3;
export const FRESHNESS_CROSSING_MS = 3000;
export const FRESHNESS_INDOOR_MS = 6000;
export const MIN_CONFIDENCE = 0.5;
export const AISLE_MATCH_MIN_CONFIDENCE = 0.7;
export const PROMPT_MIN_INTERVAL_MS = 3000;
export { MAX_PROMPT_WORDS };

/** 04 Task 8: minimum interval per question. Scans and the curb crop are one-shots B paces. */
export const MIN_INTERVAL_MS: Readonly<Record<VisionQuestion, number>> = Object.freeze({
  aisle_disambiguate: 4000,
  storefront: 5000,
  hand_guidance: 2000,
  scan_left: 0,
  scan_right: 0,
  curb_crop: 0,
  free: 0,
  task_step: 2500,   // the guided loop re-asks about once per scene change, never faster than this
  situate: 6000,     // the awareness loop: a slow, scene-gated "where am I" (situate.ts)
});

/** Thumbnail width per question: 640 when text must be read, 1024 for the curb crop, 512 otherwise. */
export const SNAPSHOT_WIDTH: Readonly<Record<VisionQuestion, 512 | 640 | 1024 | null>> = Object.freeze({
  storefront: 512,
  scan_left: 512,
  scan_right: 512,
  aisle_disambiguate: 640,
  hand_guidance: 640,
  curb_crop: 1024,
  free: null,
  task_step: 640,   // read labels, door signs, fridge contents
  situate: 512,
});

const CROSSING_QUESTIONS: ReadonlySet<VisionQuestion> = new Set<VisionQuestion>(['scan_left', 'scan_right', 'curb_crop']);
/** Questions the scene-change gate applies to; user- or loop-driven ones bypass it. */
const SCENE_GATED: ReadonlySet<VisionQuestion> = new Set<VisionQuestion>(['aisle_disambiguate', 'storefront', 'scan_left', 'scan_right', 'curb_crop', 'situate']);

export function freshnessWindowMs(question: VisionQuestion): number {
  return CROSSING_QUESTIONS.has(question) ? FRESHNESS_CROSSING_MS : FRESHNESS_INDOOR_MS;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface VisionTransport {
  /** `opts.priority` rides along on the WebSocket envelope (the proxy's speech lane); HTTP ignores it. */
  ask(req: VisionRequest, opts?: { priority?: 'NAV' | 'INFO' }): Promise<VisionResponse>;
  /** Grammar warm-up for a mode where the transport has a cheap way to ask for it (WS `warm`). */
  warm?(mode: AppMode): void;
}

/** `{ confidence: 0, seq }` — what the proxy returns on timeout and what every failure collapses to. */
export function emptyVisionResponse(seq: number): VisionResponse {
  return {
    speech: '',
    cameraRequest: 'none',
    userAction: 'none',
    aisle: { matchedAisleId: null, matchedLandmarkId: null, confidence: 0 },
    storefront: { visible: false, confidence: 0 },
    scan: { vehiclesSeen: 'unclear', confidence: 0 },
    signal: { state: 'UNKNOWN', confidence: 0 },
    hand: { hint: 'not_seen' },
    task: { done: false, confidence: 0 },
    scene: { setting: 'unknown', label: '', confidence: 0 },
    confidence: 0,
    seq,
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Coerce whatever the wire gave us into a full VisionResponse; anything malformed is confidence 0. */
export function coerceVisionResponse(raw: unknown, seq: number): VisionResponse {
  if (!isRecord(raw)) return emptyVisionResponse(seq);
  const base = emptyVisionResponse(typeof raw.seq === 'number' ? raw.seq : seq);
  const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const str = (v: unknown, d: string): string => (typeof v === 'string' ? v : d);
  const sub = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});
  const aisle = sub(raw.aisle);
  const storefront = sub(raw.storefront);
  const scan = sub(raw.scan);
  const signal = sub(raw.signal);
  const hand = sub(raw.hand);
  return {
    speech: str(raw.speech, ''),
    cameraRequest: str(raw.cameraRequest, 'none') as CameraDirection,
    userAction: str(raw.userAction, 'none') as UserAction,
    aisle: {
      matchedAisleId: typeof aisle.matchedAisleId === 'string' ? aisle.matchedAisleId : null,
      matchedLandmarkId: typeof aisle.matchedLandmarkId === 'string' ? aisle.matchedLandmarkId : null,
      confidence: num(aisle.confidence, 0),
    },
    storefront: { visible: storefront.visible === true, confidence: num(storefront.confidence, 0) },
    scan: { vehiclesSeen: str(scan.vehiclesSeen, 'unclear') as VisionResponse['scan']['vehiclesSeen'], confidence: num(scan.confidence, 0) },
    signal: { state: str(signal.state, 'UNKNOWN') as SignalState, confidence: num(signal.confidence, 0) },
    hand: { hint: str(hand.hint, 'not_seen') as VisionResponse['hand']['hint'] },
    task: { done: sub(raw.task).done === true, confidence: num(sub(raw.task).confidence, 0) },
    scene: {
      setting: (SCENE_SETTINGS as readonly string[]).includes(str(sub(raw.scene).setting, 'unknown')) ? (str(sub(raw.scene).setting, 'unknown') as SceneSetting) : 'unknown',
      label: str(sub(raw.scene).label, '').trim(),
      confidence: num(sub(raw.scene).confidence, 0),
    },
    confidence: num(raw.confidence, 0),
    seq: base.seq,
  };
}

export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface HttpTransportOptions {
  proxyUrl: string;
  fetchFn?: FetchLike;
  timeoutMs?: number;
}

/** `POST /api/vision`. Timeout, non-2xx and bad JSON all resolve to confidence 0 — never a retry. */
export function createHttpVisionTransport(opts: HttpTransportOptions): VisionTransport {
  const fetchFn: FetchLike = opts.fetchFn ?? ((input, init) => fetch(input, init));
  const timeoutMs = opts.timeoutMs ?? VISION_TIMEOUT_MS;
  const url = `${opts.proxyUrl.replace(/\/+$/, '')}/api/vision`;
  return {
    async ask(req) {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = setTimeout(() => controller?.abort(), timeoutMs);
      try {
        const res = await fetchFn(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(req),
          signal: controller?.signal,
        });
        if (!res.ok) return emptyVisionResponse(req.seq);
        return coerceVisionResponse(await res.json(), req.seq);
      } catch {
        return emptyVisionResponse(req.seq);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** The subset of the WebSocket API the transport needs (injectable for tests). */
export interface WsLike {
  readyState: number;
  /** React Native and browsers accept 'arraybuffer'; set when present so audio frames arrive decodable. */
  binaryType?: string;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export const WS_OPEN = 1;
export const STREAM_ID_BYTES = 4;

/** Client → proxy messages (D's `frames.ts` `ClientMessage`). */
export type WsClientMessage =
  | { type: 'vision'; req: VisionRequest; priority: 'NAV' | 'INFO' }
  | { type: 'warm'; mode: AppMode }
  | { type: 'ping' };

/** Binary frame: uint32 big-endian streamId followed by mp3 bytes. Pure; null for a short frame. */
export function decodeAudioFrame(data: ArrayBuffer | Uint8Array): { streamId: number; audio: Uint8Array } | null {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < STREAM_ID_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { streamId: view.getUint32(0, false), audio: bytes.subarray(STREAM_ID_BYTES) };
}

export interface WsTransportOptions {
  proxyWs: string;
  /** Default: the global WebSocket. */
  WebSocketCtor?: new (url: string) => WsLike;
  /** Used while the socket is not open. */
  fallback?: VisionTransport;
  /** `speech_start`: audio for `seq` is about to stream under `streamId` (= seq); play it now, before the JSON lands. */
  onSpeechStream?: (seq: number, streamId: string) => void;
  /** One mp3 chunk of a stream. The composition root hands these to whatever plays `streamId` (A's stream player). */
  onAudioChunk?: (streamId: string, audio: Uint8Array) => void;
  /** `speech_end`: no more audio for `streamId`. `firstAudioMs` is the proxy's measured first-audio latency. */
  onSpeechEnd?: (streamId: string, firstAudioMs: number | null) => void;
  timeoutMs?: number;
  now?: () => number;
}

export interface WsVisionTransport extends VisionTransport {
  open(): void;
  close(): void;
  isOpen(): boolean;
  /** `{type: 'warm', mode}` when the socket is open; a no-op otherwise (the proxy warms itself at start). */
  warm(mode: AppMode): void;
  ping(): void;
  /** From the proxy's `hello`; null until it arrives. */
  serverInfo(): { maxInFlight: number; audio: boolean } | null;
}

export function createWsVisionTransport(opts: WsTransportOptions): WsVisionTransport {
  const timeoutMs = opts.timeoutMs ?? VISION_TIMEOUT_MS;
  const Ctor = opts.WebSocketCtor ?? (typeof WebSocket !== 'undefined' ? (WebSocket as unknown as new (url: string) => WsLike) : null);
  let ws: WsLike | null = null;
  let hello: { maxInFlight: number; audio: boolean } | null = null;
  const pending = new Map<number, { resolve: (r: VisionResponse) => void; timer: ReturnType<typeof setTimeout> }>();

  const settle = (seq: number, r: VisionResponse): void => {
    const p = pending.get(seq);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(seq);
    p.resolve(r);
  };

  const failAll = (): void => {
    for (const seq of Array.from(pending.keys())) settle(seq, emptyVisionResponse(seq));
  };

  const handleText = (text: string): void => {
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!isRecord(msg) || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'hello':
        hello = { maxInFlight: typeof msg.maxInFlight === 'number' ? msg.maxInFlight : MAX_IN_FLIGHT, audio: msg.audio === true };
        return;
      case 'speech_start':
        if (typeof msg.streamId === 'number') opts.onSpeechStream?.(msg.streamId, String(msg.streamId));
        return;
      case 'speech_end':
        if (typeof msg.streamId === 'number') opts.onSpeechEnd?.(String(msg.streamId), typeof msg.firstAudioMs === 'number' ? msg.firstAudioMs : null);
        return;
      case 'result': {
        const res = msg.res;
        if (!isRecord(res) || typeof res.seq !== 'number') return;
        settle(res.seq, coerceVisionResponse(res, res.seq));
        return;
      }
      case 'error':
        // Seq-bound errors (stale_seq, too_many_in_flight, upstream) are followed by a `result`
        // with confidence 0; settling here is idempotent. Socket-level errors carry seq null.
        if (typeof msg.seq === 'number') settle(msg.seq, emptyVisionResponse(msg.seq));
        return;
      default:
        return;   // pong, unknown
    }
  };

  const handle = (data: unknown): void => {
    if (typeof data === 'string') {
      handleText(data);
      return;
    }
    if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
      const frame = decodeAudioFrame(data);
      if (frame) opts.onAudioChunk?.(String(frame.streamId), frame.audio);
      return;
    }
    if (isRecord(data)) handleText(JSON.stringify(data));
  };

  const isOpen = (): boolean => ws !== null && ws.readyState === WS_OPEN;

  const sendMessage = (m: WsClientMessage): boolean => {
    if (!isOpen()) return false;
    try {
      ws!.send(JSON.stringify(m));
      return true;
    } catch {
      return false;
    }
  };

  return {
    open() {
      if (ws || !Ctor) return;
      try {
        ws = new Ctor(opts.proxyWs);
      } catch {
        ws = null;
        return;
      }
      try {
        ws.binaryType = 'arraybuffer';   // audio frames arrive as ArrayBuffer, not Blob
      } catch {
        // read-only on an exotic implementation; binary frames are then ignored
      }
      ws.onmessage = (ev) => handle(ev.data);
      ws.onclose = () => {
        ws = null;
        hello = null;
        failAll();
      };
      ws.onerror = () => {
        // onclose follows; nothing to do here.
      };
    },
    close() {
      const s = ws;
      ws = null;
      hello = null;
      failAll();
      try {
        s?.close();
      } catch {
        // already closed
      }
    },
    isOpen,
    serverInfo: () => hello,
    warm(mode) {
      sendMessage({ type: 'warm', mode });
    },
    ping() {
      sendMessage({ type: 'ping' });
    },
    ask(req, o) {
      if (!isOpen()) {
        return opts.fallback ? opts.fallback.ask(req, o) : Promise.resolve(emptyVisionResponse(req.seq));
      }
      return new Promise<VisionResponse>((resolve) => {
        const timer = setTimeout(() => settle(req.seq, emptyVisionResponse(req.seq)), timeoutMs);
        pending.set(req.seq, { resolve, timer });
        if (!sendMessage({ type: 'vision', req, priority: o?.priority === 'INFO' ? 'INFO' : 'NAV' })) {
          settle(req.seq, emptyVisionResponse(req.seq));
        }
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Facts and the scene-change gate (pure)
// ---------------------------------------------------------------------------

export interface VisionFacts {
  detections: Detection[];
  ocrTokens: string[];
  depth?: DepthSummary;
  signalState?: SignalState;
  headingDeg?: number;
}

/**
 * A coarse fingerprint of the scene: detector classes with their boxes rounded
 * to a 10 % grid, plus the sorted OCR token set. Two calls with the same key and
 * a fresh result are the same question asked twice.
 */
export function sceneKey(detections: readonly Detection[], ocrTokens: readonly string[]): string {
  const det = detections
    .map((d) => `${d.cls}@${Math.round(d.box[0] * 10)},${Math.round(d.box[1] * 10)},${Math.round(d.box[2] * 10)},${Math.round(d.box[3] * 10)}`)
    .sort()
    .join('|');
  const ocr = Array.from(new Set(ocrTokens)).sort().join(' ');
  return `${det}#${ocr}`;
}

export interface GateInput {
  question: VisionQuestion;
  now: number;
  inFlight: number;
  lastCallAt: number | null;
  lastResult: { at: number; sceneKey: string } | null;
  currentSceneKey: string;
  force?: boolean;
}

export type GateVerdict = 'ok' | 'in_flight' | 'interval' | 'scene_unchanged';

export function gateVerdict(g: GateInput): GateVerdict {
  if (g.inFlight >= MAX_IN_FLIGHT) return 'in_flight';
  if (g.force) return 'ok';
  const minInterval = MIN_INTERVAL_MS[g.question];
  if (g.lastCallAt !== null && g.now - g.lastCallAt < minInterval) return 'interval';
  if (SCENE_GATED.has(g.question) && g.lastResult && g.now - g.lastResult.at <= freshnessWindowMs(g.question)
      && g.lastResult.sceneKey === g.currentSceneKey) {
    return 'scene_unchanged';
  }
  return 'ok';
}

/**
 * Speech leaves the client only if it is non-empty, ≤ 12 words, carries no
 * forbidden word and no digit (01 §11: Flash does no text normalization and
 * speech.say() rejects a digit in `text`, so 'Aisle 3' must be blanked here
 * rather than thrown from apply()).
 */
export function sanitizeSpeech(speech: string): string | null {
  const s = speech.trim();
  if (!s) return null;
  if (findForbiddenTerm(s)) return null;
  if (hasDigit(s)) return null;
  if (countWords(s) > MAX_UTTERANCE_WORDS) return null;
  return s;
}

/** Cached ≤ 6-word prompt for a camera request, or a short live text; null when nothing should be said. */
export function cameraPrompt(direction: CameraDirection): { cacheKey?: 'tilt_camera_up' | 'turn_left_a_little' | 'turn_right_a_little'; text: string } | null {
  switch (direction) {
    case 'up': return { cacheKey: 'tilt_camera_up', text: phraseText('tilt_camera_up') };
    case 'left': return { cacheKey: 'turn_left_a_little', text: phraseText('turn_left_a_little') };
    case 'right': return { cacheKey: 'turn_right_a_little', text: phraseText('turn_right_a_little') };
    case 'down': return { text: 'Tilt the camera down.' };
    case 'closer': return { text: 'Move a little closer.' };
    default: return null;
  }
}

export function userActionPrompt(action: UserAction): { cacheKey?: 'turn_left_a_little' | 'turn_right_a_little' | 'reach_out'; text: string } | null {
  switch (action) {
    case 'turn_left': return { cacheKey: 'turn_left_a_little', text: phraseText('turn_left_a_little') };
    case 'turn_right': return { cacheKey: 'turn_right_a_little', text: phraseText('turn_right_a_little') };
    case 'reach': return { cacheKey: 'reach_out', text: phraseText('reach_out') };
    case 'walk_forward': return { text: 'Walk forward.' };
    case 'stop': return { text: 'Stop.' };
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export type AskStatus =
  | 'applied'          // fields applied (and speech spoken if any)
  | 'low_confidence'   // < 0.5: ignored, silent
  | 'stale'            // seq below last applied, or outside the freshness window
  | 'skipped'          // gate said no (see `gate`)
  | 'error';           // transport rejected; treated as silence

export interface AskOutcome {
  status: AskStatus;
  gate?: GateVerdict;
  seq: number;
  response: VisionResponse | null;
  /** True when the audio was streamed (WS) so `speech` was not spoken again. */
  streamed: boolean;
  latencyMs: number | null;
}

export interface AskOptions {
  userText?: string;
  targetItem?: string;
  knownSigns?: string[];
  /** Override the per-question width; `'none'` sends facts only. */
  image?: 512 | 640 | 1024 | 'none';
  /** Bypass the interval and scene gates (B's one-shot scans; the pickup loop). */
  force?: boolean;
  /** Speech priority for the `speech` field; default NAV (`free` → INFO). */
  priority?: SpeechPriority;
  /** Skip speaking `speech` even when present (the caller speaks its own words). */
  silent?: boolean;
}

export interface SemanticVisionOptions {
  transport: VisionTransport;
  perception: Pick<PerceptionService, 'snapshotJPEG' | 'onDetections' | 'onOcrText' | 'onDepth' | 'onSignalState'>;
  speech: Pick<SpeechService, 'say' | 'playStream'>;
  bus: Pick<AppEventBus, 'emit'>;
  store: Pick<AppStore, 'getState'>;
  /** Fused heading for the facts block. */
  getHeadingDeg?: () => number | null;
  /** The COURSE buzz is on: no camera / user prompt now (04 Task 8). */
  isCourseBuzzing?: () => boolean;
  now?: () => number;
  /** Streamed audio arrives as `streamId = seq` (WS transport calls `noteStream`). */
  streamPriority?: SpeechPriority;
}

export interface SemanticVisionStats {
  calls: number;
  applied: number;
  skipped: number;
  stale: number;
  lowConfidence: number;
  errors: number;
  inFlight: number;
  lastLatencyMs: number | null;
  lastAppliedSeq: number;
}

export interface SemanticVision {
  ask(question: VisionQuestion, opts?: AskOptions): Promise<AskOutcome>;
  /**
   * For a caller that builds its own `VisionRequest` (D's TransitionDetector asks
   * `storefront` at its own ≤ 1 / 5 s pace): the shared, monotonic seq counter —
   * the proxy's socket rejects a seq that does not increase.
   */
  nextSeq(): number;
  /**
   * The same transport and in-flight cap, as the `{ ask(req) }` shape D's detector
   * takes. Nothing from this path is spoken here: the caller reads the fields.
   */
  asVisionAsk(): { ask(req: VisionRequest): Promise<VisionResponse> };
  /** The WS transport reports that audio for `seq` is streaming; play it through A's queue. */
  noteStream(seq: number, streamId: string): void;
  /** Warm the proxy's grammar cache for a mode: the WS `warm` message, or over HTTP a `free` request with no image and `userText: 'warm'`. */
  warm(mode?: AppMode): Promise<void>;
  getFacts(): VisionFacts;
  getStats(): SemanticVisionStats;
  dispose(): void;
}

export function createSemanticVision(opts: SemanticVisionOptions): SemanticVision {
  const now = opts.now ?? Date.now;
  const { transport, perception, speech, bus, store } = opts;

  // Facts, refreshed from the perception streams.
  const facts: VisionFacts = { detections: [], ocrTokens: [] };
  const unsubs: Array<() => void> = [];
  unsubs.push(perception.onDetections((d) => {
    facts.detections = d;
  }));
  unsubs.push(perception.onOcrText((reads) => {
    const toks = new Set<string>();
    for (const r of reads) for (const t of normalizeTokens(r.text)) toks.add(t);
    facts.ocrTokens = Array.from(toks);
  }));
  unsubs.push(perception.onDepth((d) => {
    facts.depth = d;
  }));
  unsubs.push(perception.onSignalState((e) => {
    facts.signalState = e.state;
  }));

  let seq = 0;            // last seq handed out (ask() and nextSeq())
  let lastSentSeq = 0;    // last seq that went to the transport; the socket rejects a lower one
  let inFlight = 0;
  let lastAppliedSeq = 0;
  let lastPromptAt = -Infinity;
  const lastCallAt = new Map<VisionQuestion, number>();
  const lastResult = new Map<VisionQuestion, { at: number; sceneKey: string }>();
  const requestedAt = new Map<number, { at: number; question: VisionQuestion; priority: SpeechPriority; silent: boolean }>();
  const streamed = new Set<number>();
  const stats: SemanticVisionStats = { calls: 0, applied: 0, skipped: 0, stale: 0, lowConfidence: 0, errors: 0, inFlight: 0, lastLatencyMs: null, lastAppliedSeq: 0 };

  const sayPrompt = (p: { cacheKey?: string; text: string } | null, priority: SpeechPriority): void => {
    if (!p) return;
    const t = now();
    if (opts.isCourseBuzzing?.()) return;
    if (t - lastPromptAt < PROMPT_MIN_INTERVAL_MS) return;
    if (countWords(p.text) > MAX_PROMPT_WORDS || findForbiddenTerm(p.text)) return;
    lastPromptAt = t;
    speech.say({ text: p.text, priority, cacheKey: p.cacheKey, dedupeKey: `prompt-${p.cacheKey ?? p.text}`, cooldownMs: PROMPT_MIN_INTERVAL_MS });
  };

  const apply = (res: VisionResponse, meta: { priority: SpeechPriority; silent: boolean }): void => {
    lastAppliedSeq = Math.max(lastAppliedSeq, res.seq);
    stats.lastAppliedSeq = lastAppliedSeq;
    if (!meta.silent && !streamed.has(res.seq)) {
      const text = sanitizeSpeech(res.speech);
      if (text) speech.say({ text, priority: meta.priority, dedupeKey: `vision-${text}`, cooldownMs: 8000 });
    }
    if (res.cameraRequest !== 'none') {
      bus.emit({ type: 'CAMERA_REQUEST', direction: res.cameraRequest });
      sayPrompt(cameraPrompt(res.cameraRequest), 'INFO');
    }
    if (res.userAction !== 'none') {
      bus.emit({ type: 'USER_ACTION', action: res.userAction });
      sayPrompt(userActionPrompt(res.userAction), 'INFO');
    }
  };

  const buildRequest = async (question: VisionQuestion, o: AskOptions, n: number): Promise<VisionRequest> => {
    const mode = store.getState().mode;
    const width = o.image === 'none' ? null : (o.image ?? SNAPSHOT_WIDTH[question]);
    let image: VisionRequest['image'];
    if (width !== null) {
      try {
        const snap = await perception.snapshotJPEG(width);
        image = { base64: snap.base64, width: snap.width, height: snap.height };
      } catch {
        image = undefined; // facts-only request rather than no request
      }
    }
    const heading = opts.getHeadingDeg?.();
    const req: VisionRequest = {
      seq: n,
      question,
      mode,
      facts: {
        detections: facts.detections,
        ocr: facts.ocrTokens,
        ...(facts.depth ? { depth: facts.depth } : {}),
        ...(facts.signalState ? { signalState: facts.signalState } : {}),
        ...(typeof heading === 'number' ? { headingDeg: heading } : {}),
        ...(question === 'aisle_disambiguate' && o.knownSigns ? { knownSigns: o.knownSigns } : {}),
        ...(question === 'hand_guidance' && o.targetItem ? { targetItem: o.targetItem } : {}),
      },
    };
    if (image) req.image = image;
    if ((question === 'free' || question === 'task_step' || question === 'situate') && o.userText) req.userText = o.userText;
    return req;
  };

  return {
    async ask(question, o = {}) {
      const t0 = now();
      const key = sceneKey(facts.detections, facts.ocrTokens);
      const verdict = gateVerdict({
        question,
        now: t0,
        inFlight,
        lastCallAt: lastCallAt.get(question) ?? null,
        lastResult: lastResult.get(question) ?? null,
        currentSceneKey: key,
        force: o.force,
      });
      if (verdict !== 'ok') {
        stats.skipped += 1;
        return { status: 'skipped', gate: verdict, seq: seq, response: null, streamed: false, latencyMs: null };
      }

      seq += 1;
      const n = seq;
      lastSentSeq = n;
      const priority: SpeechPriority = o.priority ?? (question === 'free' ? 'INFO' : 'NAV');
      const meta = { at: t0, question, priority, silent: o.silent === true };
      requestedAt.set(n, meta);
      lastCallAt.set(question, t0);
      inFlight += 1;
      stats.calls += 1;
      stats.inFlight = inFlight;

      let res: VisionResponse;
      try {
        res = coerceVisionResponse(await transport.ask(await buildRequest(question, o, n), { priority: priority === 'INFO' ? 'INFO' : 'NAV' }), n);
      } catch {
        inFlight -= 1;
        stats.inFlight = inFlight;
        stats.errors += 1;
        requestedAt.delete(n);
        return { status: 'error', seq: n, response: null, streamed: false, latencyMs: now() - t0 };
      }
      inFlight -= 1;
      stats.inFlight = inFlight;
      requestedAt.delete(n);
      const latencyMs = now() - t0;
      stats.lastLatencyMs = latencyMs;
      const wasStreamed = streamed.has(n);

      if (res.seq < lastAppliedSeq || res.seq !== n || latencyMs > freshnessWindowMs(question)) {
        streamed.delete(n);
        stats.stale += 1;
        return { status: 'stale', seq: n, response: res, streamed: wasStreamed, latencyMs };
      }
      lastResult.set(question, { at: now(), sceneKey: key });
      if (res.confidence < MIN_CONFIDENCE) {
        streamed.delete(n);
        stats.lowConfidence += 1;
        return { status: 'low_confidence', seq: n, response: res, streamed: wasStreamed, latencyMs };
      }
      apply(res, meta);   // skips `speech` when the audio already streamed for this seq
      streamed.delete(n);
      stats.applied += 1;
      return { status: 'applied', seq: n, response: res, streamed: wasStreamed, latencyMs };
    },

    nextSeq() {
      seq += 1;
      return seq;
    },

    asVisionAsk() {
      return {
        ask: async (req: VisionRequest): Promise<VisionResponse> => {
          if (inFlight >= MAX_IN_FLIGHT) return emptyVisionResponse(req.seq);
          // A caller that did not take its seq from `nextSeq()` must still not go backwards.
          const n = req.seq > lastSentSeq ? req.seq : ++seq;
          seq = Math.max(seq, n);
          lastSentSeq = n;
          const sent: VisionRequest = n === req.seq ? req : { ...req, seq: n };
          inFlight += 1;
          stats.calls += 1;
          stats.inFlight = inFlight;
          try {
            return coerceVisionResponse(await transport.ask(sent, { priority: 'INFO' }), n);
          } catch {
            stats.errors += 1;
            return emptyVisionResponse(n);
          } finally {
            inFlight -= 1;
            stats.inFlight = inFlight;
          }
        },
      };
    },

    noteStream(n, streamId) {
      const meta = requestedAt.get(n);
      if (!meta) return;                              // unknown or already settled: never play a stale stream
      if (n < lastAppliedSeq) return;
      if (now() - meta.at > freshnessWindowMs(meta.question)) return;
      if (meta.silent) return;
      streamed.add(n);
      speech.playStream(streamId, opts.streamPriority ?? meta.priority);
    },

    async warm(mode) {
      const m = mode ?? store.getState().mode;
      if (typeof transport.warm === 'function') {
        // D's socket has a dedicated `warm` message; no seq is spent and no model is called.
        transport.warm(m);
        return;
      }
      // HTTP: the 04 Task 12 convention — a `free` request with no image and `userText: 'warm'`.
      const n = ++seq;
      lastSentSeq = n;
      const req: VisionRequest = { seq: n, question: 'free', mode: m, facts: { detections: [], ocr: [] }, userText: 'warm' };
      try {
        await transport.ask(req);
      } catch {
        // warm-up is best effort
      }
    },

    getFacts: () => ({ ...facts, detections: [...facts.detections], ocrTokens: [...facts.ocrTokens] }),
    getStats: () => ({ ...stats }),
    dispose() {
      for (const u of unsubs.splice(0)) u();
    },
  };
}
