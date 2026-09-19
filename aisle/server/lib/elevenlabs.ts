/**
 * ElevenLabs (07 §2, 05 Part 2): Flash v2.5 for every word the user hears, Scribe
 * for the STT fallback. Pinned to api.us.elevenlabs.io.
 *
 *  - `ttsFlash`          POST /v1/text-to-speech/{voice}  whole mp3 (cached phrases,
 *                        pre-synthesis at route/store load). `model_id` is passed
 *                        explicitly — the endpoint default is multilingual v2.
 *  - `ttsFlashStream`    the /stream variant, piped to the phone for progressive playback.
 *  - `openTtsInputStream` the WebSocket input-streaming path for Claude's `speech`:
 *                        opened per request (ElevenLabs closes idle sockets after 20 s),
 *                        `flush: true` the instant the text is complete so a < 120-char
 *                        utterance is not held by the default chunk schedule.
 *  - `sttScribe`         POST /v1/speech-to-text, scribe_v2, multipart, keyterms ≤ 100.
 *  - `subscription`      credits for /api/health.
 *
 * fetch and the WebSocket constructor are injectable for tests.
 */
import WebSocket from 'ws';
import type { ProxyConfig } from '../config';
import { MODELS } from '../config';

export const TTS_OUTPUT_FORMAT = 'mp3_44100_64';
export const DEFAULT_VOICE_SETTINGS = Object.freeze({ stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true });
export const STT_MAX_KEYTERMS = 100;
export const STT_MIN_AUDIO_MS = 100;

export interface ElevenDeps {
  config: ProxyConfig;
  fetchFn?: typeof fetch;
  WebSocketCtor?: typeof WebSocket;
  now?: () => number;
}

export class ElevenConfigError extends Error {
  constructor(what: string) {
    super(`${what} is not set`);
    this.name = 'ElevenConfigError';
  }
}

export class ElevenHttpError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`elevenlabs http ${status}`);
    this.name = 'ElevenHttpError';
  }
}

function requireKey(cfg: ProxyConfig): { key: string; voice: string } {
  if (!cfg.elevenLabsApiKey) throw new ElevenConfigError('ELEVENLABS_API_KEY');
  if (!cfg.elevenLabsVoiceId) throw new ElevenConfigError('ELEVENLABS_VOICE_ID');
  return { key: cfg.elevenLabsApiKey, voice: cfg.elevenLabsVoiceId };
}

export interface TtsOptions {
  voiceId?: string;
  speed?: number;             // generate at 1.0; rate is applied on-device (07 §2)
  signal?: AbortSignal;
}

export function ttsBody(text: string, opts: TtsOptions = {}): Record<string, unknown> {
  return {
    text,
    model_id: MODELS.flash,
    voice_settings: { ...DEFAULT_VOICE_SETTINGS, ...(opts.speed !== undefined ? { speed: opts.speed } : {}) },
  };
}

/** Whole-file synthesis. Returns mp3 bytes. */
export async function ttsFlash(text: string, deps: ElevenDeps, opts: TtsOptions = {}): Promise<Buffer> {
  const { key, voice } = requireKey(deps.config);
  const fetchFn = deps.fetchFn ?? fetch;
  const url = `${deps.config.elevenLabsBaseUrl}/v1/text-to-speech/${opts.voiceId ?? voice}?output_format=${TTS_OUTPUT_FORMAT}`;
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify(ttsBody(text, opts)),
    signal: opts.signal ?? AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new ElevenHttpError(res.status, await safeText(res));
  return Buffer.from(await res.arrayBuffer());
}

/** Streamed synthesis: the raw body stream, for progressive playback through the proxy. */
export async function ttsFlashStream(text: string, deps: ElevenDeps, opts: TtsOptions = {}): Promise<ReadableStream<Uint8Array>> {
  const { key, voice } = requireKey(deps.config);
  const fetchFn = deps.fetchFn ?? fetch;
  const url = `${deps.config.elevenLabsBaseUrl}/v1/text-to-speech/${opts.voiceId ?? voice}/stream?output_format=${TTS_OUTPUT_FORMAT}`;
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify(ttsBody(text, opts)),
    signal: opts.signal ?? AbortSignal.timeout(10_000),
  });
  if (!res.ok || !res.body) throw new ElevenHttpError(res.status, await safeText(res));
  return res.body;
}

// ---------------------------------------------------------------------------
// WebSocket input streaming (the vision → speech path)
// ---------------------------------------------------------------------------

export interface TtsInputStream {
  /** Resolves when the socket is open and the BOS message has been sent. */
  ready: Promise<void>;
  /** Send text. `flush` forces generation immediately (use when the utterance is complete). */
  send(text: string, flush?: boolean): void;
  /** Send the end-of-stream message; audio for anything buffered follows, then `onEnd`. */
  end(): void;
  /** Close without flushing (speech came back empty). */
  close(): void;
  onAudio(cb: (chunk: Buffer) => void): void;
  onEnd(cb: () => void): void;
  onError(cb: (e: Error) => void): void;
  /** ms from open() to the first audio chunk, once known. */
  firstAudioMs(): number | null;
}

export function ttsInputStreamUrl(cfg: ProxyConfig, voiceId: string): string {
  return `${cfg.elevenLabsWsBaseUrl}/v1/text-to-speech/${voiceId}/stream-input?model_id=${MODELS.flash}&output_format=${TTS_OUTPUT_FORMAT}&auto_mode=true`;
}

export function openTtsInputStream(deps: ElevenDeps, opts: { voiceId?: string } = {}): TtsInputStream {
  const { key, voice } = requireKey(deps.config);
  const Ctor = deps.WebSocketCtor ?? WebSocket;
  const now = deps.now ?? Date.now;
  const t0 = now();
  const ws = new Ctor(ttsInputStreamUrl(deps.config, opts.voiceId ?? voice));
  let audioCb: ((c: Buffer) => void) | null = null;
  let endCb: (() => void) | null = null;
  let errCb: ((e: Error) => void) | null = null;
  let firstAudioAt: number | null = null;
  let ended = false;
  const queue: string[] = [];
  let open = false;

  const sendRaw = (msg: Record<string, unknown>): void => {
    const s = JSON.stringify(msg);
    if (open) ws.send(s);
    else queue.push(s);
  };

  const ready = new Promise<void>((resolve, reject) => {
    ws.on('open', () => {
      open = true;
      ws.send(JSON.stringify({ text: ' ', voice_settings: DEFAULT_VOICE_SETTINGS, xi_api_key: key }));
      for (const s of queue.splice(0)) ws.send(s);
      resolve();
    });
    ws.on('error', (e: Error) => {
      reject(e);
      errCb?.(e);
    });
  });
  ready.catch(() => undefined);

  const finish = (): void => {
    if (ended) return;
    ended = true;
    endCb?.();
  };

  ws.on('message', (data: WebSocket.RawData) => {
    let msg: { audio?: string | null; isFinal?: boolean | null; error?: string; message?: string };
    try {
      msg = JSON.parse(typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8'));
    } catch {
      return;
    }
    if (msg.error) {
      errCb?.(new Error(msg.message ?? msg.error));
      return;
    }
    if (msg.audio) {
      if (firstAudioAt === null) firstAudioAt = now() - t0;
      audioCb?.(Buffer.from(msg.audio, 'base64'));
    }
    if (msg.isFinal) finish();
  });
  ws.on('close', () => finish());

  return {
    ready,
    send(text, flush = false) {
      sendRaw(flush ? { text: text.endsWith(' ') ? text : `${text} `, flush: true } : { text });
    },
    end() {
      sendRaw({ text: '' });
    },
    close() {
      ended = true;
      try {
        ws.close();
      } catch {
        // already closed
      }
    },
    onAudio(cb) {
      audioCb = cb;
    },
    onEnd(cb) {
      endCb = cb;
    },
    onError(cb) {
      errCb = cb;
    },
    firstAudioMs: () => firstAudioAt,
  };
}

// ---------------------------------------------------------------------------
// Scribe STT
// ---------------------------------------------------------------------------

export interface SttOptions {
  filename?: string;
  mimeType?: string;
  keyterms?: string[];
  languageCode?: string;
  signal?: AbortSignal;
}

export interface SttResult {
  text: string;
  languageCode: string | null;
  raw: unknown;
}

export function buildSttForm(audio: Buffer | Uint8Array, opts: SttOptions = {}): FormData {
  const form = new FormData();
  form.append('model_id', MODELS.scribe);
  const bytes = new Uint8Array(audio.byteLength);
  bytes.set(audio);
  form.append('file', new Blob([bytes], { type: opts.mimeType ?? 'audio/m4a' }), opts.filename ?? 'utterance.m4a');
  if (opts.languageCode) form.append('language_code', opts.languageCode);
  form.append('tag_audio_events', 'false');
  const terms = (opts.keyterms ?? []).map((t) => t.trim()).filter(Boolean).slice(0, STT_MAX_KEYTERMS);
  for (const t of terms) form.append('keyterms', t);
  return form;
}

export async function sttScribe(audio: Buffer | Uint8Array, deps: ElevenDeps, opts: SttOptions = {}): Promise<SttResult> {
  if (!deps.config.elevenLabsApiKey) throw new ElevenConfigError('ELEVENLABS_API_KEY');
  const fetchFn = deps.fetchFn ?? fetch;
  const res = await fetchFn(`${deps.config.elevenLabsBaseUrl}/v1/speech-to-text`, {
    method: 'POST',
    headers: { 'xi-api-key': deps.config.elevenLabsApiKey },
    body: buildSttForm(audio, opts),
    signal: opts.signal ?? AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new ElevenHttpError(res.status, await safeText(res));
  const raw = (await res.json()) as { text?: string; language_code?: string };
  return { text: (raw.text ?? '').trim(), languageCode: raw.language_code ?? null, raw };
}

// ---------------------------------------------------------------------------
// Subscription (credits) for /api/health
// ---------------------------------------------------------------------------

export interface SubscriptionInfo {
  characterCount: number;
  characterLimit: number;
  creditsLeft: number;
  tier: string | null;
}

export async function subscription(deps: ElevenDeps, signal?: AbortSignal): Promise<SubscriptionInfo> {
  if (!deps.config.elevenLabsApiKey) throw new ElevenConfigError('ELEVENLABS_API_KEY');
  const fetchFn = deps.fetchFn ?? fetch;
  const res = await fetchFn(`${deps.config.elevenLabsBaseUrl}/v1/user/subscription`, {
    headers: { 'xi-api-key': deps.config.elevenLabsApiKey },
    signal: signal ?? AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new ElevenHttpError(res.status, await safeText(res));
  const j = (await res.json()) as { character_count?: number; character_limit?: number; tier?: string };
  const count = j.character_count ?? 0;
  const limit = j.character_limit ?? 0;
  return { characterCount: count, characterLimit: limit, creditsLeft: Math.max(0, limit - count), tier: j.tier ?? null };
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '';
  }
}
