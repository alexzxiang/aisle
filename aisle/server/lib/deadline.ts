/**
 * First-token deadline helper (01 §9, 05 Part 2 "/api/plan hosting duties").
 *
 * Nemotron streams; if the first token has not arrived within `firstTokenMs`
 * (1.5 s) — or the whole answer within `totalMs` — the upstream request is
 * abandoned and the caller's deterministic fallback is returned with
 * `fallback: true` and the measured latency. B's route uses it as:
 *
 *   const out = await withFirstTokenDeadline(() => nimChat({...}), {
 *     firstTokenMs: 1500, totalMs: 8000, fallback: () => templateFor(job, input),
 *   });
 *   res.json(toPlannerResult(job, out));
 *
 * Pure apart from timers, which are injectable for tests.
 */
import type { PlannerJob, PlannerResult } from '../../src/core/contracts';

export interface StreamHandle<T> {
  /** Resolves with ms-since-start when the first token arrives; rejects on upstream failure. */
  firstToken: Promise<number>;
  /** Resolves with the completed value once the stream has ended. */
  result: Promise<T>;
  /** Abandon the upstream request (idempotent). */
  abort(): void;
  /** Where the answer came from, for the log line. */
  provider?: string;
  model?: string;
}

export type DeadlineReason = 'first_token_deadline' | 'total_deadline' | 'upstream_error';

export interface DeadlineOutcome<U> {
  value: U;
  fallback: boolean;
  reason?: DeadlineReason;
  firstTokenMs: number | null;
  latencyMs: number;
  error?: string;
  provider?: string;
  model?: string;
}

export interface DeadlineOptions<T, U = T> {
  firstTokenMs: number;
  totalMs?: number;
  fallback: () => U;
  /** Validate/transform the completed value; throwing here counts as an upstream error → fallback. */
  accept?: (value: T) => U;
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export const DEFAULT_FIRST_TOKEN_MS = 1500;

export async function withFirstTokenDeadline<T, U = T>(
  start: () => StreamHandle<T>,
  opts: DeadlineOptions<T, U>,
): Promise<DeadlineOutcome<U>> {
  const now = opts.now ?? Date.now;
  const setT = opts.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearT = opts.clearTimeoutFn ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const t0 = now();

  let handle: StreamHandle<T>;
  try {
    handle = start();
  } catch (e) {
    return {
      value: opts.fallback(),
      fallback: true,
      reason: 'upstream_error',
      firstTokenMs: null,
      latencyMs: now() - t0,
      error: errMsg(e),
    };
  }

  const timers: unknown[] = [];
  const clearAll = (): void => {
    for (const t of timers.splice(0)) clearT(t);
  };
  const timeout = (ms: number, reason: DeadlineReason): Promise<{ timedOut: DeadlineReason }> =>
    new Promise((resolve) => {
      timers.push(setT(() => resolve({ timedOut: reason }), ms));
    });

  // Swallow late rejections on the promises we may stop listening to.
  handle.result.catch(() => undefined);
  handle.firstToken.catch(() => undefined);

  const base = { provider: handle.provider, model: handle.model };
  const fail = (reason: DeadlineReason, firstTokenMs: number | null, error?: string): DeadlineOutcome<U> => {
    clearAll();
    handle.abort();
    return { value: opts.fallback(), fallback: true, reason, firstTokenMs, latencyMs: now() - t0, error, ...base };
  };

  // Phase 1: first token vs deadline.
  let firstTokenMs: number;
  try {
    const first = await Promise.race([
      handle.firstToken.then((ms) => ({ ms })),
      timeout(opts.firstTokenMs, 'first_token_deadline'),
    ]);
    if ('timedOut' in first) return fail(first.timedOut, null);
    firstTokenMs = first.ms;
  } catch (e) {
    return fail('upstream_error', null, errMsg(e));
  }
  clearAll();

  // Phase 2: completion vs total budget (measured from t0).
  const remaining = opts.totalMs === undefined ? null : Math.max(0, opts.totalMs - (now() - t0));
  try {
    const done = await Promise.race([
      handle.result.then((value) => ({ value })),
      ...(remaining === null ? [] : [timeout(remaining, 'total_deadline' as const)]),
    ]);
    clearAll();
    if ('timedOut' in done) return fail(done.timedOut, firstTokenMs);
    const value = opts.accept ? opts.accept(done.value) : (done.value as unknown as U);
    return { value, fallback: false, firstTokenMs, latencyMs: now() - t0, ...base };
  } catch (e) {
    return fail('upstream_error', firstTokenMs, errMsg(e));
  }
}

/** Wrap an outcome in the 01 §9 envelope. */
export function toPlannerResult<U>(job: PlannerJob, out: DeadlineOutcome<U>): PlannerResult<U> {
  return { job, output: out.value, fallback: out.fallback, latencyMs: out.latencyMs };
}

/** A StreamHandle over a plain promise (no streaming upstream): first token = completion. */
export function handleFromPromise<T>(p: Promise<T>, now: () => number = Date.now): StreamHandle<T> {
  const t0 = now();
  let aborted = false;
  const result = p.then((v) => {
    if (aborted) throw new Error('aborted');
    return v;
  });
  return {
    firstToken: result.then(() => now() - t0),
    result,
    abort() {
      aborted = true;
    },
  };
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
