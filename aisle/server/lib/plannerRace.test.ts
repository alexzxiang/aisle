import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { templateFor } from '../../src/outdoor/plannerJobs';
import { runPlannerJob, warmInputFor, type NimStarter } from '../routes/plan';
import type { ClaudePlanStarter } from './claudePlan';
import { createRequestLog } from './log';
import { plannerPrimary } from './plannerRace';

const input = { transcript: 'I need eggs', mode: 'IDLE' as const, knownItems: ['eggs'] };
const valid = JSON.stringify(templateFor('parseIntent', input));
const silentLog = () => createRequestLog({ sink: () => {} });

function providers(nimMs: number, haikuMs: number, nimText = valid, claudeText = valid) {
  const delayed = (text: string, model: string, ms: number) => {
    let reject: (e: Error) => void = () => {};
    let timer: ReturnType<typeof setTimeout>;
    const result = new Promise<{ text: string; model: string }>((res, rej) => {
      reject = rej;
      timer = setTimeout(() => res({ text, model }), ms);
    });
    const abort = vi.fn(() => { clearTimeout(timer); reject(new Error('aborted')); });
    return { result, abort };
  };
  const nimHandle = delayed(nimText, 'nemotron', nimMs);
  const claudeHandle = delayed(claudeText, 'haiku', haikuMs);
  const nim: NimStarter = () => ({
    result: nimHandle.result.then((r) => ({ ...r, provider: 'nim', keyLabel: 'primary', firstTokenMs: nimMs, totalMs: nimMs, thinkingLeaked: false, failovers: [] })),
    firstToken: nimHandle.result.then(() => nimMs), abort: nimHandle.abort, provider: 'nim', model: 'nemotron',
  });
  const claude: ClaudePlanStarter = () => claudeHandle;
  return { nim, claude, nimHandle, claudeHandle };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('planner provider timing and preference', () => {
  it('records both timings while preferring a valid Nemotron answer', async () => {
    const log = silentLog();
    const p = providers(100, 20);
    const result = runPlannerJob('parseIntent', input, { ...p, log });
    await vi.runAllTimersAsync();
    expect((await result).provider).toBe('nim');
    expect(log.recent()[0]!.extra!.attempts).toMatchObject([
      { provider: 'nim', status: 'valid', elapsedMs: 100 },
      { provider: 'anthropic', status: 'valid', elapsedMs: 20 },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('uses Haiku after invalid Nemotron output, with Haiku timing and metadata', async () => {
    const log = silentLog();
    const result = runPlannerJob('parseIntent', input, { ...providers(20, 50, '{}'), log });
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ provider: 'anthropic', model: 'haiku', fallback: false, firstTokenMs: 50, latencyMs: 50 });
    expect(log.recent()[0]!.extra!.attempts).toMatchObject([{ status: 'invalid' }, { status: 'valid' }]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('falls back within deadline plus grace and cancels both slow calls once', async () => {
    const p = providers(30_000, 30_000);
    const result = runPlannerJob('parseIntent', input, { ...p, log: silentLog() });
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ fallback: true, latencyMs: 6000 });
    expect(p.nimHandle.abort).toHaveBeenCalledTimes(1);
    expect(p.claudeHandle.abort).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('switches parseIntent only after enough slow samples, never routeCompile', async () => {
    const log = silentLog();
    for (let i = 0; i < 5; i++) {
      expect(plannerPrimary('parseIntent', log)).toBe('nim');
      log.write({ route: 'plan', key: 'parseIntent', totalMs: 3300, extra: { attempts: [{ provider: 'nim', status: 'valid', elapsedMs: 3300 }] } });
    }
    expect(plannerPrimary('parseIntent', log)).toBe('anthropic');
    expect(plannerPrimary('routeCompile', log)).toBe('nim');
    const p = providers(3500, 20);
    const result = runPlannerJob('parseIntent', input, { ...p, log });
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ provider: 'anthropic', latencyMs: 20 });
    expect(p.nimHandle.abort).toHaveBeenCalledTimes(1);
    const routeInput = warmInputFor('routeCompile');
    const text = JSON.stringify(templateFor('routeCompile', routeInput as never));
    const route = runPlannerJob('routeCompile', routeInput as never, { ...providers(100, 20, text, text), log });
    await vi.runAllTimersAsync();
    expect((await route).provider).toBe('nim');
  });
  it('still tries Nemotron if Haiku-first fails, and handles synchronous starter errors', async () => {
    const log = silentLog();
    for (let i = 0; i < 5; i++) log.write({ route: 'plan', key: 'parseIntent', totalMs: 4500, extra: { attempts: [{ provider: 'nim', status: 'timeout', elapsedMs: 4500 }] } });
    const p = providers(100, 20);
    p.claudeHandle.result.catch(() => {});
    p.claudeHandle.abort();
    const result = runPlannerJob('parseIntent', input, { nim: p.nim, claude: () => { throw new Error('unavailable'); }, log });
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ provider: 'nim', fallback: false });
  });
});
