/**
 * POST /api/vision (01 §8, 05 Part 2). HTTP variant: the full VisionResponse JSON.
 * The streamed audio variant lives on the WebSocket (server/ws/visionSocket.ts).
 *
 * Rules enforced here: body validation (question enum, mode, image ≤ 1024 long edge),
 * `seq` monotonic per client (a lower seq answers `{ confidence: 0, seq }` and is
 * logged `stale_seq`), ≤ 3 requests in flight per client (a fourth answers
 * `{ confidence: 0 }` immediately), and on any upstream failure the client gets
 * `{ confidence: 0, seq }` and nothing else. Every request writes one log line.
 */
import { Router, type Request } from 'express';
import { getDefaultDeps } from '../deps';
import { MAX_VISION_IN_FLIGHT, type DepsSource, createClientRegistry, resolveDeps } from '../lib/routeDeps';
import { validateVisionRequest } from '../lib/visionRequest';

export function clientKey(req: Request): string {
  const h = req.header('x-aisle-client');
  return h && h.trim() ? h.trim().slice(0, 64) : (req.ip ?? 'unknown');
}

export function createVisionRouter(src: DepsSource): Router {
  const router = Router();
  const clients = createClientRegistry();

  router.post('/', async (req, res) => {
    const deps = await resolveDeps(src);
    const t0 = Date.now();
    const v = validateVisionRequest(req.body);
    if (!v.ok) {
      deps.log.write({ route: 'vision', seq: v.seq ?? undefined, totalMs: Date.now() - t0, status: 400, error: v.error, verdict: 'n/a' });
      res.status(400).json({ error: v.error, confidence: 0, seq: v.seq ?? 0 });
      return;
    }
    const vr = v.req;
    const client = clients.get(clientKey(req));
    if (vr.seq <= client.lastSeq) {
      deps.log.write({ route: 'vision', seq: vr.seq, key: vr.question, totalMs: Date.now() - t0, status: 200, error: 'stale_seq', verdict: 'n/a' });
      res.json({ confidence: 0, seq: vr.seq });
      return;
    }
    client.lastSeq = vr.seq;
    if (client.inFlight >= MAX_VISION_IN_FLIGHT) {
      deps.log.write({ route: 'vision', seq: vr.seq, key: vr.question, totalMs: Date.now() - t0, status: 200, error: 'too_many_in_flight', verdict: 'n/a' });
      res.json({ confidence: 0, seq: vr.seq });
      return;
    }
    client.inFlight += 1;
    try {
      const r = await deps.vision(vr, {});
      deps.latency.record(`vision.${vr.question}`, r.totalMs);
      deps.log.write({
        route: 'vision', seq: vr.seq, key: vr.question, model: r.model, provider: 'anthropic',
        firstTokenMs: r.firstTokenMs, totalMs: Date.now() - t0, status: 200, verdict: r.response ? r.verdict : 'n/a', error: r.error,
        // `image` says whether the phone attached a still (a camera that is not producing frames shows up here first).
        extra: { speechClosedMs: r.speechClosedMs, stopReason: r.stopReason, image: vr.image ? `${vr.image.width}x${vr.image.height}` : 'none', detections: vr.facts.detections.length },
      });
      if (!r.response) {
        res.json({ confidence: 0, seq: vr.seq });
        return;
      }
      res.json(r.response);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if ((e as { status?: number })?.status === 429) deps.counters.bump('anthropic');
      deps.log.write({ route: 'vision', seq: vr.seq, key: vr.question, totalMs: Date.now() - t0, status: 200, error: msg, verdict: 'n/a' });
      res.json({ confidence: 0, seq: vr.seq });
    } finally {
      client.inFlight -= 1;
    }
  });

  return router;
}

const router: Router = createVisionRouter(() => getDefaultDeps());
export default router;
