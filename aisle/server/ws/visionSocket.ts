/**
 * /ws — the persistent per-phone socket (05 Part 2 "WebSocket streaming", 01 §8).
 *
 *   client → { type: 'vision', req: VisionRequest, priority }
 *   client → { type: 'warm', mode }                 // re-fires the (model, schema) pairs that mode uses
 *   server → { type: 'speech_start', streamId: seq }
 *   server → <binary: uint32BE streamId + mp3 bytes>
 *   server → { type: 'speech_end', streamId: seq }
 *   server → { type: 'result', res: VisionResponse }
 *   server → { type: 'error', seq, code }
 *
 * Per request: the ElevenLabs input socket is opened at request start (in parallel
 * with Claude's TTFT); Claude streams with the structured-output schema; when the
 * `speech` string closes and passes the language rule, the text is sent with
 * `flush: true`, audio is relayed as `streamId = seq`, then the full result
 * follows. Empty speech closes the ElevenLabs socket without flushing and sends no
 * `speech_start`. ≤ 3 requests in flight per socket; a fourth is answered
 * `{ confidence: 0 }` immediately. `seq` must increase per socket.
 *
 * The audio port is injectable (`deps.tts.openInput`), so the framing is tested
 * with a fake ElevenLabs and a fake Claude.
 */
import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { VisionResponse } from '../../src/core/contracts';
import type { AppDeps } from '../deps';
import { MAX_VISION_IN_FLIGHT } from '../lib/routeDeps';
import { validateVisionRequest } from '../lib/visionRequest';
import { type ServerMessage, encodeAudioFrame, parseClientMessage } from './frames';

/** How long the result may wait for the TTS socket to finish after speech closed. */
export const SPEECH_END_GRACE_MS = 2500;

export interface VisionSocketOptions {
  path?: string;
  /** Bounded wait for speech_end before sending the result. */
  speechEndGraceMs?: number;
  now?: () => number;
}

export interface ConnectionState {
  lastSeq: number;
  inFlight: number;
}

const send = (ws: WebSocket, msg: ServerMessage): void => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
};

export function handleConnection(ws: WebSocket, deps: AppDeps, opts: VisionSocketOptions = {}): ConnectionState {
  const state: ConnectionState = { lastSeq: -1, inFlight: 0 };
  const grace = opts.speechEndGraceMs ?? SPEECH_END_GRACE_MS;
  const now = opts.now ?? Date.now;
  send(ws, { type: 'hello', maxInFlight: MAX_VISION_IN_FLIGHT, audio: deps.tts.openInput !== undefined });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return; // the phone never sends binary
    const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8');
    const parsed = parseClientMessage(text);
    if (!parsed.ok) {
      send(ws, { type: 'error', seq: parsed.seq, code: parsed.code });
      return;
    }
    const msg = parsed.msg;
    if (msg.type === 'ping') {
      send(ws, { type: 'pong' });
      return;
    }
    if (msg.type === 'warm') {
      void deps.warmup.warmForMode(msg.mode);
      return;
    }
    void handleVision(ws, deps, state, msg.req, { grace, now });
  });

  return state;
}

async function handleVision(
  ws: WebSocket,
  deps: AppDeps,
  state: ConnectionState,
  rawReq: unknown,
  o: { grace: number; now: () => number },
): Promise<void> {
  const t0 = o.now();
  const v = validateVisionRequest(rawReq);
  if (!v.ok) {
    send(ws, { type: 'error', seq: v.seq, code: 'bad_request', message: v.error });
    deps.log.write({ route: 'vision', seq: v.seq ?? undefined, totalMs: o.now() - t0, status: 400, error: v.error, verdict: 'n/a', extra: { transport: 'ws' } });
    return;
  }
  const req = v.req;
  if (req.seq <= state.lastSeq) {
    send(ws, { type: 'error', seq: req.seq, code: 'stale_seq' });
    send(ws, { type: 'result', res: { confidence: 0, seq: req.seq } });
    deps.log.write({ route: 'vision', seq: req.seq, key: req.question, totalMs: o.now() - t0, status: 200, error: 'stale_seq', verdict: 'n/a', extra: { transport: 'ws' } });
    return;
  }
  state.lastSeq = req.seq;
  if (state.inFlight >= MAX_VISION_IN_FLIGHT) {
    send(ws, { type: 'error', seq: req.seq, code: 'too_many_in_flight' });
    send(ws, { type: 'result', res: { confidence: 0, seq: req.seq } });
    deps.log.write({ route: 'vision', seq: req.seq, key: req.question, totalMs: o.now() - t0, status: 200, error: 'too_many_in_flight', verdict: 'n/a', extra: { transport: 'ws' } });
    return;
  }
  state.inFlight += 1;

  // Open ElevenLabs in parallel with Claude's TTFT. Null when TTS is not configured.
  let tts: ReturnType<AppDeps['tts']['openInput']> = null;
  try {
    tts = deps.tts.openInput();
  } catch {
    tts = null;
  }
  let speechStarted = false;
  let speechEnded = false;
  let resolveSpeechEnd: () => void = () => undefined;
  const speechEnd = new Promise<void>((r) => {
    resolveSpeechEnd = r;
  });
  const finishSpeech = (): void => {
    if (speechEnded) return;
    speechEnded = true;
    if (speechStarted) send(ws, { type: 'speech_end', streamId: req.seq, firstAudioMs: tts?.firstAudioMs() ?? null });
    resolveSpeechEnd();
  };
  if (tts) {
    tts.onAudio((chunk) => {
      if (!speechStarted || ws.readyState !== ws.OPEN) return;
      ws.send(encodeAudioFrame(req.seq, chunk), { binary: true });
    });
    tts.onEnd(finishSpeech);
    tts.onError(() => finishSpeech());
    tts.ready.catch(() => finishSpeech());
  }

  let speechForLog = '';
  const onSpeechReady = (speech: string): void => {
    speechForLog = speech;
    if (!speech) {
      // Nothing to say: close without flushing, no speech_start.
      tts?.close();
      finishSpeech();
      return;
    }
    if (!tts) {
      finishSpeech();
      return;
    }
    speechStarted = true;
    send(ws, { type: 'speech_start', streamId: req.seq });
    tts.send(speech, true);
    tts.end();
  };

  let result: VisionResponse | { confidence: 0; seq: number } = { confidence: 0, seq: req.seq };
  let logExtra: Record<string, unknown> = {};
  try {
    const r = await deps.vision(req, { onSpeechReady });
    deps.latency.record(`vision.${req.question}`, r.totalMs);
    logExtra = { transport: 'ws', speechClosedMs: r.speechClosedMs, stopReason: r.stopReason, model: r.model, verdict: r.verdict, firstTokenMs: r.firstTokenMs, error: r.error, usage: r.usage };
    if (r.response) result = r.response;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if ((e as { status?: number })?.status === 429) deps.counters.bump('anthropic');
    logExtra = { transport: 'ws', error: msg };
    send(ws, { type: 'error', seq: req.seq, code: 'upstream', message: msg });
    tts?.close();
    finishSpeech();
  }

  // Speech first, then the JSON — but never hold the JSON on a stuck TTS socket.
  if (!speechEnded) {
    await Promise.race([speechEnd, new Promise<void>((r) => setTimeout(r, o.grace))]);
    if (!speechEnded) {
      tts?.close();
      finishSpeech();
    }
  }
  send(ws, { type: 'result', res: result });
  state.inFlight -= 1;
  const totalMs = o.now() - t0;
  deps.latency.record(`ws.${req.question}.total`, totalMs);
  if (tts?.firstAudioMs() != null) deps.latency.record(`ws.${req.question}.firstAudio`, tts.firstAudioMs() as number);
  deps.log.write({
    route: 'vision', seq: req.seq, key: req.question, provider: 'anthropic',
    model: typeof logExtra.model === 'string' ? logExtra.model : undefined,
    firstTokenMs: typeof logExtra.firstTokenMs === 'number' ? logExtra.firstTokenMs : null,
    totalMs, status: 200,
    verdict: (logExtra.verdict as 'pass' | 'blanked' | undefined) ?? 'n/a',
    error: typeof logExtra.error === 'string' ? logExtra.error : undefined,
    extra: { ...logExtra, spoke: speechForLog.length > 0, firstAudioMs: tts?.firstAudioMs() ?? null },
  });
}

export function attachVisionSocket(server: HttpServer, deps: AppDeps, opts: VisionSocketOptions = {}): WebSocketServer {
  const wss = new WebSocketServer({ server, path: opts.path ?? '/ws', maxPayload: 4 * 1024 * 1024 });
  wss.on('connection', (ws) => {
    handleConnection(ws, deps, opts);
  });
  return wss;
}
