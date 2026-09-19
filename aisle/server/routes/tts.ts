/**
 * POST /api/tts (07 §2, 05 Part 2): ElevenLabs Flash v2.5, `model_id` passed
 * explicitly, `output_format` mp3_44100_64.
 *
 * Body: `{ text, cacheKey?, lane?: 'live' | 'batch', stream?: boolean }`.
 *  - The language rule runs first: a forbidden word or > 12 words → 422 with the
 *    verdict, except the one hash-allow-listed sentence (Google's walking-beta
 *    warning), which logs `allowlisted` and synthesizes.
 *  - `lane` picks the semaphore lane: pre-synthesis batches ('batch', the default
 *    for anything with a cacheKey) wait behind live speech.
 *  - `stream: true` (or `?stream=1`) pipes the /stream body for progressive playback.
 * Response: `audio/mpeg`, with `X-Aisle-Verdict` and `X-Aisle-Words` headers.
 */
import { Router } from 'express';
import { Readable } from 'node:stream';
import { getDefaultDeps } from '../deps';
import { checkLanguage } from '../lib/language';
import { type DepsSource, resolveDeps } from '../lib/routeDeps';
import type { Lane } from '../lib/semaphore';

export const TTS_MAX_CHARS = 600;

export function createTtsRouter(src: DepsSource): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    const deps = await resolveDeps(src);
    const t0 = Date.now();
    const body = (req.body ?? {}) as { text?: unknown; cacheKey?: unknown; lane?: unknown; stream?: unknown };
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const cacheKey = typeof body.cacheKey === 'string' ? body.cacheKey : undefined;
    const wantStream = body.stream === true || req.query.stream === '1';
    const lane: Lane = body.lane === 'live' || body.lane === 'batch' ? body.lane : cacheKey ? 'batch' : 'live';

    if (!text) {
      res.status(400).json({ error: 'text required' });
      return;
    }
    if (text.length > TTS_MAX_CHARS) {
      res.status(413).json({ error: `text longer than ${TTS_MAX_CHARS} characters` });
      return;
    }

    const check = checkLanguage(text, { lane: 'tts' });
    if (check.verdict === 'rejected_422') {
      deps.log.write({ route: 'tts', key: cacheKey, totalMs: Date.now() - t0, status: 422, verdict: check.verdict, extra: { reason: check.reason, term: check.term, words: check.words } });
      res.status(422).json({ error: 'language rule', reason: check.reason, term: check.term, words: check.words, verdict: check.verdict });
      return;
    }

    try {
      res.setHeader('X-Aisle-Verdict', check.verdict);
      res.setHeader('X-Aisle-Words', String(check.words));
      if (wantStream) {
        const stream = await deps.slots.run(lane, () => deps.tts.stream(text));
        res.status(200).type('audio/mpeg');
        Readable.fromWeb(stream as import('node:stream/web').ReadableStream<Uint8Array>).pipe(res);
        deps.log.write({ route: 'tts', key: cacheKey, provider: 'elevenlabs', totalMs: Date.now() - t0, status: 200, verdict: check.verdict, extra: { lane, stream: true } });
        return;
      }
      const audio = await deps.slots.run(lane, () => deps.tts.flash(text));
      deps.latency.record('tts.flash', Date.now() - t0);
      deps.log.write({ route: 'tts', key: cacheKey, provider: 'elevenlabs', totalMs: Date.now() - t0, status: 200, verdict: check.verdict, extra: { lane, bytes: audio.length } });
      res.status(200).type('audio/mpeg').send(audio);
    } catch (e) {
      const status = (e as { status?: number })?.status;
      if (status === 429) deps.counters.bump('elevenlabs_tts');
      const msg = e instanceof Error ? e.message : String(e);
      deps.log.write({ route: 'tts', key: cacheKey, provider: 'elevenlabs', totalMs: Date.now() - t0, status: 502, verdict: check.verdict, error: msg });
      res.status(502).json({ error: 'tts upstream failed', detail: msg });
    }
  });

  return router;
}

const router: Router = createTtsRouter(() => getDefaultDeps());
export default router;
