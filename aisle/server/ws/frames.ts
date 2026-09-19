/**
 * Wire framing for the /ws socket (05 Part 2 "WebSocket streaming").
 *
 * Text frames are JSON messages. Audio is binary: a 4-byte big-endian uint32
 * `streamId` (= the request's `seq`) followed by the mp3 bytes as ElevenLabs
 * emitted them. The phone routes each chunk to the player for that streamId.
 */
import type { AppMode, VisionRequest, VisionResponse } from '../../src/core/contracts';

export const STREAM_ID_BYTES = 4;

export type ClientMessage =
  | { type: 'vision'; req: VisionRequest; priority?: 'NAV' | 'INFO' }
  | { type: 'warm'; mode: AppMode }
  | { type: 'ping' };

export type ServerMessage =
  | { type: 'speech_start'; streamId: number }
  | { type: 'speech_end'; streamId: number; firstAudioMs?: number | null }
  | { type: 'result'; res: VisionResponse | { confidence: 0; seq: number } }
  | { type: 'error'; seq: number | null; code: WsErrorCode; message?: string }
  | { type: 'pong' }
  | { type: 'hello'; maxInFlight: number; audio: boolean };

export type WsErrorCode = 'bad_json' | 'bad_request' | 'stale_seq' | 'too_many_in_flight' | 'upstream' | 'unknown_type';

export function encodeAudioFrame(streamId: number, chunk: Uint8Array): Buffer {
  const out = Buffer.alloc(STREAM_ID_BYTES + chunk.length);
  out.writeUInt32BE(streamId >>> 0, 0);
  out.set(chunk, STREAM_ID_BYTES);
  return out;
}

export function decodeAudioFrame(frame: Uint8Array): { streamId: number; audio: Uint8Array } | null {
  if (frame.length < STREAM_ID_BYTES) return null;
  const view = Buffer.isBuffer(frame) ? frame : Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  return { streamId: view.readUInt32BE(0), audio: view.subarray(STREAM_ID_BYTES) };
}

export function parseClientMessage(text: string): { ok: true; msg: ClientMessage } | { ok: false; code: WsErrorCode; seq: number | null } {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { ok: false, code: 'bad_json', seq: null };
  }
  if (typeof v !== 'object' || v === null) return { ok: false, code: 'bad_json', seq: null };
  const m = v as { type?: unknown; req?: unknown; mode?: unknown; priority?: unknown };
  if (m.type === 'vision') {
    const seq = typeof (m.req as { seq?: unknown })?.seq === 'number' ? ((m.req as { seq: number }).seq) : null;
    if (typeof m.req !== 'object' || m.req === null) return { ok: false, code: 'bad_request', seq };
    const priority = m.priority === 'INFO' ? 'INFO' : 'NAV';
    return { ok: true, msg: { type: 'vision', req: m.req as VisionRequest, priority } };
  }
  if (m.type === 'warm') {
    if (typeof m.mode !== 'string') return { ok: false, code: 'bad_request', seq: null };
    return { ok: true, msg: { type: 'warm', mode: m.mode as AppMode } };
  }
  if (m.type === 'ping') return { ok: true, msg: { type: 'ping' } };
  return { ok: false, code: 'unknown_type', seq: null };
}
