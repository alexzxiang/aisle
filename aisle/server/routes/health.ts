/**
 * GET /api/health (05 Part 2, 07 §4): each upstream individually, `schemasWarm`
 * per (model, schema) pair, p50/p95 per question. Cached per check; `?force=1`
 * re-runs everything (pre-demo readiness). `GET /api/health/warm` re-fires every
 * warm-up pair and returns their status (a stop-the-line check 30 minutes out).
 */
import { Router } from 'express';
import { getDefaultDeps } from '../deps';
import { type DepsSource, resolveDeps } from '../lib/routeDeps';

export function createHealthRouter(src: DepsSource): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const deps = await resolveDeps(src);
    const t0 = Date.now();
    const report = await deps.health.report({ force: req.query.force === '1' });
    deps.log.write({ route: 'health', totalMs: Date.now() - t0, status: 200, extra: { ok: report.ok } });
    res.status(200).json(report);
  });

  router.get('/warm', async (_req, res) => {
    const deps = await resolveDeps(src);
    const status = await deps.warmup.warmAll();
    res.json({ schemasWarm: deps.warmup.schemasWarm(), status });
  });

  router.get('/log', async (req, res) => {
    const deps = await resolveDeps(src);
    const route = typeof req.query.route === 'string' ? req.query.route : undefined;
    res.json({ lines: deps.log.recent(route ? { route } : undefined).slice(-500) });
  });

  return router;
}

const router: Router = createHealthRouter(() => getDefaultDeps());
export default router;
