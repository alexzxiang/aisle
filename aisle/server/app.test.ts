import { Router } from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from './app';
import { fakeDeps } from './test/fakes';

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

async function listen(app: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  close = () => new Promise((r) => server.close(() => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('createApp', () => {
  it("boots without B's routes and answers 503 { fallback: true } on their mounts", async () => {
    const { app, external } = await createApp({
      deps: fakeDeps(),
      externalRoutes: [
        { mount: '/api/plan', load: () => Promise.reject(new Error("Cannot find module './routes/plan'")) },
        { mount: '/api/route', load: () => Promise.reject(new Error("Cannot find module './routes/route'")) },
      ],
    });
    expect(external).toEqual({ '/api/plan': false, '/api/route': false });
    const url = await listen(app);
    const res = await fetch(`${url}/api/plan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { fallback: boolean }).fallback).toBe(true);
    expect((await fetch(`${url}/api/route`)).status).toBe(503);
    const root = (await (await fetch(`${url}/`)).json()) as { routes: string[] };
    expect(root.routes).toContain('/ws');
  });

  it("mounts B's routers when their default export is a Router", async () => {
    const plan = Router();
    plan.post('/', (_req, res) => res.json({ job: 'parseIntent', fallback: false }));
    const { app, external } = await createApp({
      deps: fakeDeps(),
      externalRoutes: [{ mount: '/api/plan', load: async () => ({ default: plan }) }],
    });
    expect(external['/api/plan']).toBe(true);
    const url = await listen(app);
    const res = await fetch(`${url}/api/plan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(((await res.json()) as { job: string }).job).toBe('parseIntent');
  });

  it('answers malformed JSON bodies with 400, not a crash', async () => {
    const { app } = await createApp({ deps: fakeDeps(), externalRoutes: [] });
    const url = await listen(app);
    const res = await fetch(`${url}/api/vision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
    expect(res.status).toBe(400);
  });
});
