import { TRACE_FLUSH_MS, TRACE_MAX_PENDING, createTracer } from './trace';

describe('tracer', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  function fakeFetch() {
    const calls: Array<{ url: string; lines: Array<Record<string, unknown>> }> = [];
    const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), lines: (JSON.parse(String(init?.body)) as { lines: Array<Record<string, unknown>> }).lines });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    return { fn, calls };
  }

  it('batches lines for a second, stamps them, and posts to /api/trace once', async () => {
    const f = fakeFetch();
    let t = 1000;
    const trace = createTracer({ proxyUrl: 'http://proxy:8787/', fetchImpl: f.fn, now: () => t });
    trace('guide', { text: 'Fridge ahead.' });
    t = 1200;
    trace('said', { role: 'aisle' });
    expect(f.calls).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(TRACE_FLUSH_MS);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe('http://proxy:8787/api/trace');
    expect(f.calls[0]?.lines).toEqual([{ at: 1000, kind: 'guide', text: 'Fridge ahead.' }, { at: 1200, kind: 'said', role: 'aisle' }]);
    trace.dispose();
  });

  it('keeps only the newest lines under pressure, stays silent on failure, and does nothing without a proxy', async () => {
    const f = fakeFetch();
    const trace = createTracer({ proxyUrl: 'http://proxy:8787', fetchImpl: f.fn, now: () => 0 });
    for (let i = 0; i < TRACE_MAX_PENDING + 20; i += 1) trace('seen', { i });
    await trace.flush();
    expect(f.calls[0]?.lines).toHaveLength(TRACE_MAX_PENDING);
    expect(f.calls[0]?.lines[0]?.i).toBe(20);

    const failing = createTracer({ proxyUrl: 'http://proxy:8787', fetchImpl: (async () => { throw new Error('down'); }) as typeof fetch });
    failing('guide', {});
    await expect(failing.flush()).resolves.toBeUndefined();

    const off = createTracer({ proxyUrl: '', fetchImpl: f.fn });
    off('guide', {});
    await off.flush();
    expect(f.calls).toHaveLength(1);
    trace.dispose();
    failing.dispose();
    off.dispose();
  });
});
