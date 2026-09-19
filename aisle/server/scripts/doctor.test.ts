import { describe, expect, it } from 'vitest';
import type { HealthReport } from '../lib/health';
import { doctor, DOCTOR_BUDGET_MS, DOCTOR_TIMEOUT_MS, failureKind, formatHealth } from './doctor';

describe('doctor', () => {
  it('distinguishes authentication, configuration, quota, and network failures', () => {
    expect(failureKind('http 401')).toBe('AUTH / PERMISSION');
    expect(failureKind('google routes 403')).toBe('AUTH / PERMISSION');
    expect(failureKind('NVIDIA_API_KEY not set')).toBe('MISSING KEY');
    expect(failureKind('429')).toBe('QUOTA');
    expect(failureKind('fetch failed')).toBe('NETWORK');
  });
  it('renders colour and optional upstreams without printing error bodies', () => {
    const report = { upstreams: { anthropic: { ok: false, err: '401 secret-body', ms: 10 }, openrouter: { ok: false, required: false, err: 'not set', ms: 0 } }, overpass: { ok: true, err: null, ms: 20 }, missingKeys: [] } as unknown as HealthReport;
    const text = formatHealth(report);
    expect(text).toContain('\u001b[31mAUTH / PERMISSION');
    expect(text).toContain('OPTIONAL MISSING KEY');
    expect(text).not.toContain('secret-body');
    expect(formatHealth(report, false)).not.toContain('\u001b');
  });
  it('uses the selected proxy and exits nonzero when it is unreachable', async () => {
    const output: string[] = [];
    let url = '';
    const code = await doctor('http://proxy.test:8787/', { write: (s) => output.push(s), fetchFn: (async (u) => { url = String(u); throw new TypeError('fetch failed'); }) as typeof fetch });
    expect(url).toBe(`http://proxy.test:8787/api/health?budgetMs=${DOCTOR_BUDGET_MS}`);
    expect(code).toBe(1);
    expect(output[0]).toContain('NETWORK');
  });
  it('asks the proxy to bound each cold probe, so the diagnosis arrives inside its own wait', async () => {
    const urls: string[] = [];
    const fetchFn = (async (u) => { urls.push(String(u)); throw new TypeError('fetch failed'); }) as typeof fetch;
    await doctor('http://proxy.test', { fetchFn, write: () => {}, budgetMs: 800 });
    expect(urls[0]).toContain('budgetMs=800');
    expect(DOCTOR_BUDGET_MS).toBeLessThan(DOCTOR_TIMEOUT_MS);
  });
  it('bounds the wait and distinguishes a slow health report', async () => {
    const output: string[] = [];
    const fetchFn: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('timeout')));
    });
    expect(await doctor('http://proxy.test', { fetchFn, timeoutMs: 10, write: (s) => output.push(s) })).toBe(1);
    expect(output[0]).toContain('PROXY TIMEOUT');
  });
});
