import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createTraceRouter } from './trace';

describe('POST /api/trace', () => {
  let server: Server | null = null;
  let dir = '';
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = null;
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  async function start(file: string): Promise<string> {
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api/trace', createTraceRouter({ file, now: () => 1234 }));
    server = createServer(app);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const addr = server.address();
    return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  }

  it('appends one JSON line per entry, creating the folder, and answers 204', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aisle-trace-'));
    const file = path.join(dir, 'nested', 'trace.jsonl');
    const base = await start(file);
    const post = (lines: unknown) => fetch(`${base}/api/trace`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lines }) });
    expect((await post([{ at: 1, kind: 'guide', text: 'Fridge ahead.' }])).status).toBe(204);
    expect((await post([{ at: 2, kind: 'said', role: 'aisle' }, { at: 3, kind: 'seen', n: 0 }])).status).toBe(204);
    const rows = (await fs.readFile(file, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(rows.map((r) => r.kind)).toEqual(['guide', 'said', 'seen']);
    expect(rows[0]).toMatchObject({ received: 1234, at: 1, text: 'Fridge ahead.' });
    expect((await post('nope')).status).toBe(400);
  });
});
