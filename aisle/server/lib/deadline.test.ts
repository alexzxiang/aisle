import { describe, expect, it } from 'vitest';
import { type StreamHandle, handleFromPromise, toPlannerResult, withFirstTokenDeadline } from './deadline';

function handle(opts: { firstAfterMs: number; doneAfterMs: number; value?: string; failFirst?: boolean; failResult?: boolean }): StreamHandle<string> & { aborted: boolean } {
  const h = {
    aborted: false,
    provider: 'nim',
    model: 'm',
    firstToken: new Promise<number>((res, rej) => setTimeout(() => (opts.failFirst ? rej(new Error('boom')) : res(opts.firstAfterMs)), opts.firstAfterMs)),
    result: new Promise<string>((res, rej) => setTimeout(() => (opts.failResult ? rej(new Error('mid-stream')) : res(opts.value ?? '{"ok":true}')), opts.doneAfterMs)),
    abort() {
      h.aborted = true;
    },
  };
  h.firstToken.catch(() => undefined);
  h.result.catch(() => undefined);
  return h;
}

describe('withFirstTokenDeadline', () => {
  it('returns the streamed value when the first token beats the deadline', async () => {
    const h = handle({ firstAfterMs: 10, doneAfterMs: 30 });
    const out = await withFirstTokenDeadline(() => h, { firstTokenMs: 200, totalMs: 1000, fallback: () => 'FALLBACK' });
    expect(out.fallback).toBe(false);
    expect(out.value).toBe('{"ok":true}');
    expect(out.firstTokenMs).toBe(10);
    expect(out.provider).toBe('nim');
    expect(h.aborted).toBe(false);
  });

  it('falls back and aborts the upstream when the first token misses the deadline', async () => {
    const h = handle({ firstAfterMs: 300, doneAfterMs: 400 });
    const out = await withFirstTokenDeadline(() => h, { firstTokenMs: 50, fallback: () => 'FALLBACK' });
    expect(out.fallback).toBe(true);
    expect(out.reason).toBe('first_token_deadline');
    expect(out.value).toBe('FALLBACK');
    expect(out.firstTokenMs).toBeNull();
    expect(h.aborted).toBe(true);
  });

  it('falls back on the total budget even after a fast first token', async () => {
    const h = handle({ firstAfterMs: 5, doneAfterMs: 500 });
    const out = await withFirstTokenDeadline(() => h, { firstTokenMs: 100, totalMs: 60, fallback: () => 'FALLBACK' });
    expect(out.fallback).toBe(true);
    expect(out.reason).toBe('total_deadline');
    expect(out.firstTokenMs).toBe(5);
    expect(h.aborted).toBe(true);
  });

  it('falls back on an upstream error before the first token', async () => {
    const h = handle({ firstAfterMs: 5, doneAfterMs: 10, failFirst: true });
    const out = await withFirstTokenDeadline(() => h, { firstTokenMs: 100, fallback: () => 'FALLBACK' });
    expect(out.fallback).toBe(true);
    expect(out.reason).toBe('upstream_error');
    expect(out.error).toBe('boom');
  });

  it('falls back when the stream fails mid-answer', async () => {
    const h = handle({ firstAfterMs: 5, doneAfterMs: 20, failResult: true });
    const out = await withFirstTokenDeadline(() => h, { firstTokenMs: 100, fallback: () => 'FALLBACK' });
    expect(out.fallback).toBe(true);
    expect(out.reason).toBe('upstream_error');
    expect(out.error).toBe('mid-stream');
  });

  it('a throwing accept() (schema-invalid answer) becomes the fallback', async () => {
    const h = handle({ firstAfterMs: 5, doneAfterMs: 10, value: 'not json' });
    const out = await withFirstTokenDeadline<string, { ok: boolean }>(() => h, {
      firstTokenMs: 100,
      fallback: () => ({ ok: false }),
      accept: (v) => JSON.parse(v) as { ok: boolean },
    });
    expect(out.fallback).toBe(true);
    expect(out.value).toEqual({ ok: false });
  });

  it('maps a valid answer through accept()', async () => {
    const h = handle({ firstAfterMs: 5, doneAfterMs: 10 });
    const out = await withFirstTokenDeadline<string, { ok: boolean }>(() => h, {
      firstTokenMs: 100,
      fallback: () => ({ ok: false }),
      accept: (v) => JSON.parse(v) as { ok: boolean },
    });
    expect(out.fallback).toBe(false);
    expect(out.value).toEqual({ ok: true });
  });

  it('a start() that throws (no key) is an upstream error, not a crash', async () => {
    const out = await withFirstTokenDeadline<string>(() => {
      throw new Error('NVIDIA_API_KEY is not set');
    }, { firstTokenMs: 100, fallback: () => 'FALLBACK' });
    expect(out.fallback).toBe(true);
    expect(out.error).toMatch(/NVIDIA_API_KEY/);
  });

  it('toPlannerResult wraps the 01 §9 envelope', async () => {
    const out = await withFirstTokenDeadline(() => handleFromPromise(Promise.resolve({ legs: [] })), { firstTokenMs: 100, fallback: () => ({ legs: [] }) });
    const env = toPlannerResult('routeCompile', out);
    expect(env.job).toBe('routeCompile');
    expect(env.fallback).toBe(false);
    expect(typeof env.latencyMs).toBe('number');
  });
});
