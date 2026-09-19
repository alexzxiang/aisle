import { describe, expect, it } from 'vitest';
import { testConfig } from '../test/fakes';
import { createHealthService, createRateLimitCounters } from './health';
import { createLatencyTracker, percentile } from './latency';
import { createRequestLog } from './log';
import { createSemaphore } from './semaphore';

describe('semaphore', () => {
  it('caps concurrency at the limit', async () => {
    const s = createSemaphore(2);
    let active = 0;
    let peak = 0;
    const job = () => s.run('batch', async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
    });
    await Promise.all([job(), job(), job(), job(), job()]);
    expect(peak).toBe(2);
  });

  it('serves the live lane before waiting batch work', async () => {
    const s = createSemaphore(1);
    const order: string[] = [];
    const hold = await s.acquire('batch');
    const b = s.run('batch', async () => {
      order.push('batch');
    });
    const l = s.run('live', async () => {
      order.push('live');
    });
    expect(s.waiting()).toEqual({ live: 1, batch: 1 });
    hold();
    await Promise.all([b, l]);
    expect(order).toEqual(['live', 'batch']);
  });

  it('setLimit(10) admits waiting work immediately (Creator perk)', async () => {
    const s = createSemaphore(1);
    const rel = await s.acquire('live');
    const p = s.acquire('batch');
    s.setLimit(10);
    const rel2 = await p;
    rel();
    rel2();
    expect(s.inUse()).toBe(0);
  });
});

describe('latency', () => {
  it('computes p50/p95 over a window', () => {
    const t = createLatencyTracker(5);
    for (const ms of [100, 200, 300, 400, 500, 900]) t.record('vision.storefront', ms);
    const s = t.stats('vision.storefront');
    expect(s.n).toBe(5);              // window dropped the first sample
    expect(s.p50).toBe(400);
    expect(s.p95).toBe(900);
    expect(t.stats('nope')).toEqual({ p50: null, p95: null, n: 0 });
    expect(percentile([], 50)).toBeNull();
  });
});

describe('request log', () => {
  it('keeps 24 h of lines, filters, and survives a broken sink', () => {
    let t = 0;
    const log = createRequestLog({ now: () => t, sink: () => { throw new Error('disk full'); }, retentionMs: 1000 });
    log.write({ route: 'vision', seq: 1, totalMs: 10 });
    t = 500;
    log.write({ route: 'tts', totalMs: 20 });
    t = 1200;
    log.write({ route: 'vision', seq: 2, totalMs: 30 });
    expect(log.recent().map((l) => l.seq ?? l.route)).toEqual(['tts', 2]);
    expect(log.recent({ route: 'vision' }).length).toBe(1);
  });

  it('tail returns the newest matches oldest-first, and agrees with recent()', () => {
    const log = createRequestLog({ sink: () => {} });
    for (let i = 0; i < 100; i += 1) log.write({ route: i % 2 ? 'plan' : 'vision', key: 'parseIntent', seq: i, totalMs: 1 });
    expect(log.tail(3, { route: 'plan' }).map((l) => l.seq)).toEqual([95, 97, 99]);
    // Same answer as the full scan it replaces, just without copying the whole buffer.
    expect(log.tail(50, { route: 'plan' })).toEqual(log.recent({ route: 'plan' }).slice(-50));
    expect(log.tail(0, { route: 'plan' })).toEqual([]);
    expect(log.tail(5, { route: 'nope' })).toEqual([]);
  });

  it('tail stops early instead of reading the whole buffer', () => {
    const log = createRequestLog({ sink: () => {} });
    for (let i = 0; i < 50_000; i += 1) log.write({ route: 'plan', key: 'parseIntent', seq: i, totalMs: 1 });
    const t0 = performance.now();
    for (let i = 0; i < 200; i += 1) log.tail(10, { route: 'plan', key: 'parseIntent' });
    const perCall = (performance.now() - t0) / 200;
    // recent() measured ~10 ms per call at this size; a bounded scan is orders of magnitude less.
    expect(perCall).toBeLessThan(1);
  });
});

describe('health service', () => {
  const ok = async (): Promise<void> => undefined;
  const base = {
    anthropic: ok, openrouter: async () => ({ modelSeen: false }), elevenlabs_tts: async () => ({ creditsLeft: 10 }), elevenlabs_stt: ok, google_routes: ok, overpass: ok,
  };

  it('is ok when the five required upstreams pass; openrouter is informational', async () => {
    const h = createHealthService({
      config: testConfig(), checks: { ...base, nvidia: async () => ({ modelSeen: true }) }, counters: createRateLimitCounters(),
      schemasWarm: () => ({ 'haiku:vision': null }), latency: () => ({}), missingKeys: () => [],
    });
    const r = await h.report();
    expect(r.ok).toBe(true);
    expect(r.upstreams.openrouter.required).toBe(false);
    expect(r.upstreams.openrouter.ok).toBe(false);
    expect(r.upstreams.elevenlabs_tts.creditsLeft).toBe(10);
    expect(r.upstreams.nvidia.modelSeen).toBe(true);
    expect(r.schemasWarm).toEqual({ 'haiku:vision': null });
  });

  it('is red when the Nemotron id is missing or a required check throws, and caches results', async () => {
    let calls = 0;
    let t = 0;
    const h = createHealthService({
      config: testConfig(),
      now: () => t,
      checks: { ...base, nvidia: async () => { calls += 1; return { modelSeen: false }; }, anthropic: async () => { throw new Error('401'); } },
      counters: createRateLimitCounters(),
      schemasWarm: () => ({}), latency: () => ({}), missingKeys: () => ['ANTHROPIC_API_KEY'],
    });
    const r1 = await h.report();
    expect(r1.ok).toBe(false);
    expect(r1.upstreams.nvidia.err).toBe('model not listed');
    expect(r1.upstreams.anthropic.err).toBe('401');
    expect(r1.missingKeys).toEqual(['ANTHROPIC_API_KEY']);
    t = 10_000;
    const r2 = await h.report();
    expect(r2.upstreams.nvidia.fromCache).toBe(true);
    expect(calls).toBe(1);
    await h.report({ force: true });
    expect(calls).toBe(2);
  });

  it('reports a timeout for a hanging check', async () => {
    const h = createHealthService({
      config: testConfig(),
      timeoutMs: 20,
      checks: { ...base, nvidia: (signal) => new Promise((_r, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))) },
      counters: createRateLimitCounters(), schemasWarm: () => ({}), latency: () => ({}), missingKeys: () => [],
    });
    const r = await h.report();
    expect(r.upstreams.nvidia.ok).toBe(false);
    expect(r.upstreams.nvidia.err).toBe('timeout');
    expect(r.ok).toBe(false);
  });

  it('bounds a cold report by one short budget: every probe runs at once and still diagnoses', async () => {
    const hang = (signal: AbortSignal) => new Promise<void>((_r, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))));
    const h = createHealthService({
      config: testConfig(),
      timeoutMs: 10_000,
      checks: { ...base, nvidia: hang, overpass: hang },
      counters: createRateLimitCounters(), schemasWarm: () => ({}), latency: () => ({}), missingKeys: () => [],
    });
    const t0 = Date.now();
    const r = await h.report({ timeoutMs: 30 });
    // Two hanging probes, one budget: overpass waits alongside the upstreams, not after them.
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(r.upstreams.nvidia.err).toBe('timeout');
    expect(r.overpass.err).toBe('timeout');
    expect(r.upstreams.anthropic.ok).toBe(true);
  });
});
