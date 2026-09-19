/**
 * `POST /api/trace` — the phone's decisions, one JSON line each, appended to
 * `server/data/cache/trace.jsonl` (round 7b). Read it with:
 *   tail -f server/data/cache/trace.jsonl | jq -c .
 * Never blocks the phone: any failure is a 204 too.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';

export const TRACE_FILE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'data', 'cache', 'trace.jsonl');
const MAX_LINES = 500;

const Body = z.object({ lines: z.array(z.record(z.string(), z.unknown())).max(MAX_LINES) });

export function createTraceRouter(deps: { file?: string; now?: () => number } = {}): Router {
  const router = Router();
  const file = deps.file ?? TRACE_FILE;
  router.post('/', async (req, res) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'expected { lines: object[] }' });
      return;
    }
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const received = deps.now?.() ?? Date.now();
      await fs.appendFile(file, parsed.data.lines.map((l) => JSON.stringify({ received, ...l })).join('\n') + '\n');
    } catch {
      // disk is a convenience
    }
    res.status(204).end();
  });
  return router;
}
