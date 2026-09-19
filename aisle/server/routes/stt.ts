/**
 * POST /api/stt (07 §2, 05 Part 2): ElevenLabs Scribe v2, the fallback STT in store
 * noise (primary STT is on-device). `keyterms` = the store's item and aisle words,
 * capped at 100 (100+ triggers a 20 s minimum billable duration). Minimum audio 100 ms.
 *
 * Two request shapes, both without a multipart parser dependency:
 *  - raw audio body (`Content-Type: audio/*` or `application/octet-stream`),
 *    `?keyterms=eggs,milk,aisle three` and optional `?lang=en`;
 *  - JSON `{ audioBase64, mimeType?, filename?, keyterms?: string[], languageCode? }`.
 * Response: `{ text, languageCode, ms }`.
 */
import { Router, raw } from 'express';
import { getDefaultDeps } from '../deps';
import { STT_MAX_KEYTERMS, STT_MIN_AUDIO_MS } from '../lib/elevenlabs';
import { type DepsSource, resolveDeps } from '../lib/routeDeps';

export const STT_MAX_BYTES = 10 * 1024 * 1024;

/** Duration of a 16-bit PCM WAV from its header; null for other containers. */
export function wavDurationMs(buf: Buffer): number | null {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);
  const bytesPerSec = sampleRate * channels * (bitsPerSample / 8);
  if (!bytesPerSec) return null;
  return ((buf.length - 44) / bytesPerSec) * 1000;
}

/** Enough audio for Scribe? WAV is measured; compressed containers use a byte floor (~100 ms of AAC/MP3). */
export function tooShort(buf: Buffer): boolean {
  const wav = wavDurationMs(buf);
  if (wav !== null) return wav < STT_MIN_AUDIO_MS;
  return buf.length < 1500;
}

export function parseKeyterms(v: unknown): string[] {
  const list = Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(',') : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of list) {
    const s = t.trim();
    if (s && !seen.has(s.toLowerCase())) {
      seen.add(s.toLowerCase());
      out.push(s);
    }
  }
  return out.slice(0, STT_MAX_KEYTERMS);
}

export function createSttRouter(src: DepsSource): Router {
  const router = Router();
  const rawParser = raw({ type: ['audio/*', 'application/octet-stream'], limit: STT_MAX_BYTES });

  router.post('/', rawParser, async (req, res) => {
    const deps = await resolveDeps(src);
    const t0 = Date.now();
    let audio: Buffer | null = null;
    let mimeType = 'audio/m4a';
    let filename = 'utterance.m4a';
    let keyterms: string[] = [];
    let languageCode: string | undefined;

    if (Buffer.isBuffer(req.body) && req.body.length > 0) {
      audio = req.body;
      mimeType = req.header('content-type') ?? mimeType;
      if (mimeType.includes('wav')) filename = 'utterance.wav';
      keyterms = parseKeyterms(req.query.keyterms);
      languageCode = typeof req.query.lang === 'string' ? req.query.lang : undefined;
    } else if (req.body && typeof req.body === 'object' && typeof (req.body as { audioBase64?: unknown }).audioBase64 === 'string') {
      const b = req.body as { audioBase64: string; mimeType?: string; filename?: string; keyterms?: unknown; languageCode?: string };
      try {
        audio = Buffer.from(b.audioBase64, 'base64');
      } catch {
        audio = null;
      }
      mimeType = b.mimeType ?? mimeType;
      filename = b.filename ?? filename;
      keyterms = parseKeyterms(b.keyterms);
      languageCode = b.languageCode;
    }

    if (!audio || audio.length === 0) {
      res.status(400).json({ error: 'audio required (raw audio body or { audioBase64 })' });
      return;
    }
    if (tooShort(audio)) {
      deps.log.write({ route: 'stt', totalMs: Date.now() - t0, status: 422, error: 'audio_too_short' });
      res.status(422).json({ error: `audio shorter than ${STT_MIN_AUDIO_MS} ms` });
      return;
    }

    try {
      const r = await deps.stt(audio, { mimeType, filename, keyterms, languageCode });
      const ms = Date.now() - t0;
      deps.latency.record('stt.scribe', ms);
      deps.log.write({ route: 'stt', provider: 'elevenlabs', totalMs: ms, status: 200, extra: { bytes: audio.length, keyterms: keyterms.length, chars: r.text.length } });
      res.json({ text: r.text, languageCode: r.languageCode, ms });
    } catch (e) {
      const status = (e as { status?: number })?.status;
      if (status === 429) deps.counters.bump('elevenlabs_stt');
      const msg = e instanceof Error ? e.message : String(e);
      deps.log.write({ route: 'stt', provider: 'elevenlabs', totalMs: Date.now() - t0, status: 502, error: msg });
      res.status(502).json({ error: 'stt upstream failed', detail: msg });
    }
  });

  return router;
}

const router: Router = createSttRouter(() => getDefaultDeps());
export default router;
