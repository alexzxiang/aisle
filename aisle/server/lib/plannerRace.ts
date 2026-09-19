import type { PlannerJob } from '../../src/core/contracts';
import { handleFromPromise, withFirstTokenDeadline, type DeadlineOptions, type DeadlineOutcome, type StreamHandle } from './deadline';
import type { RequestLog } from './log';

export interface PlanCompletion { text: string; model: string; provider?: string; thinkingLeaked?: boolean }
export interface PlanAttempt {
  provider: string;
  model?: string;
  status: 'pending' | 'valid' | 'invalid' | 'error' | 'timeout' | 'cancelled';
  elapsedMs: number;
  firstTokenMs: number | null;
}

/** Five completed or deadline-limited samples; cancellations are not latency samples. */
/**
 * How many recent log lines to look through for those samples. This runs before every planner
 * call, and reading the whole buffer to use ten samples measured 10 ms at the 50k-line cap.
 * The budget is generous because most `nim` attempts are cancelled once it loses a race — a
 * live run had 50 cancellations in 60 calls — and cancellations are not latency samples.
 * Bounding it also keeps the median rolling: a switch about current latency should not reach
 * back hours into the retention window to fill its window.
 */
export const PLANNER_SAMPLE_LINES = 200;

export function plannerPrimary(job: PlannerJob, log: RequestLog): 'nim' | 'anthropic' {
  if (job !== 'parseIntent') return 'nim';
  const samples = log.tail(PLANNER_SAMPLE_LINES, { route: 'plan', key: job })
    .flatMap((line) => (line.extra?.attempts ?? []) as PlanAttempt[])
    .filter((a) => a.provider === 'nim' && ['valid', 'invalid', 'timeout'].includes(a.status))
    .slice(-10).map((a) => a.elapsedMs).sort((a, b) => a - b);
  const middle = Math.floor(samples.length / 2);
  const median = samples.length % 2 ? samples[middle]! : (samples[middle - 1]! + samples[middle]!) / 2;
  return samples.length >= 5 && median > 3000 ? 'anthropic' : 'nim';
}

export function claudeHandle(handle: { result: Promise<{ text: string; model: string }>; abort(): void }, now: () => number): StreamHandle<PlanCompletion> {
  const adapted = handleFromPromise(handle.result, now);
  return { ...adapted, provider: 'anthropic', abort: () => handle.abort() };
}

/** Start both providers, prefer the selected one until its deadline, then bounded backup. */
export async function racePlanner<T>(opts: {
  primary: 'nim' | 'anthropic';
  nim: () => StreamHandle<PlanCompletion>;
  claude?: (() => StreamHandle<PlanCompletion>) | null;
  validate: (r: PlanCompletion) => { output: T; usedFallback: boolean };
  deadline: Omit<DeadlineOptions<PlanCompletion, T>, 'accept'>;
  graceMs: number;
}): Promise<{ outcome: DeadlineOutcome<T>; attempts: PlanAttempt[]; validationFallback: boolean; thinkingLeaked: boolean }> {
  const now = opts.deadline.now ?? Date.now;
  const startAt = now();
  const setT = opts.deadline.setTimeoutFn ?? setTimeout;
  const clearT = opts.deadline.clearTimeoutFn ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const start = (provider: string, factory: () => StreamHandle<PlanCompletion>) => {
    const attempt: PlanAttempt = { provider, status: 'pending', elapsedMs: 0, firstTokenMs: null };
    let stopped = false;
    let handle: StreamHandle<PlanCompletion>;
    try { handle = factory(); } catch (error) {
      handle = { result: Promise.reject(error), firstToken: Promise.reject(error), abort() {} };
    }
    const result = handle.result.then((r) => {
      const validated = opts.validate(r);
      if (attempt.status === 'pending') Object.assign(attempt, {
        provider: r.provider ?? provider, model: r.model,
        elapsedMs: now() - startAt, status: validated.usedFallback ? 'invalid' : 'valid',
      });
      return { ...validated, completion: r };
    }).catch((error: unknown) => {
      if (attempt.status === 'pending') Object.assign(attempt, { status: 'error', elapsedMs: now() - startAt });
      throw error;
    });
    result.catch(() => undefined);
    handle.firstToken.then((ms) => { attempt.firstTokenMs = ms; }, () => undefined);
    const stop = (status: 'cancelled' | 'timeout') => {
      if (stopped) return;
      stopped = true;
      if (attempt.status === 'pending') Object.assign(attempt, { status, elapsedMs: now() - startAt });
      handle.abort();
    };
    return { handle, result, attempt, stop };
  };
  const nim = start('nim', opts.nim);
  const claude = opts.claude ? start('anthropic', opts.claude) : null;
  const primary = opts.primary === 'anthropic' && claude ? claude : nim;
  const backup = primary === nim ? claude : nim;
  let selected: Awaited<typeof primary.result> | null = null;
  let outcome = await withFirstTokenDeadline(() => ({
    ...primary.handle,
    result: primary.result,
    abort: () => primary.stop('timeout'),
  }), {
    ...opts.deadline,
    accept: (r) => { selected = r; return r.output; },
  });
  let chosen = primary;
  // Invalid fields are template repairs, not a model success; try the backup too.
  if (backup && (outcome.fallback || primary.attempt.status === 'invalid')) {
    let timer: unknown;
    try {
      const answer = await Promise.race([
        backup.result.catch(() => null),
        new Promise<null>((resolve) => { timer = setT(() => resolve(null), opts.graceMs); }),
      ]);
      if (answer && !answer.usedFallback) {
        selected = answer;
        chosen = backup;
        outcome = { value: answer.output, fallback: false, firstTokenMs: backup.attempt.firstTokenMs,
          latencyMs: now() - startAt, provider: backup.attempt.provider, model: answer.completion.model };
      }
    } finally { if (timer !== undefined) clearT(timer); }
  }
  // Always cancel the unused work, including late result/error handlers.
  const unused = chosen === nim ? claude : nim;
  unused?.stop('cancelled');
  if (outcome.fallback) chosen.stop('timeout');
  const answer = selected as Awaited<typeof primary.result> | null;
  outcome.latencyMs = now() - startAt;
  if (answer && !outcome.fallback) {
    outcome.provider = chosen.attempt.provider;
    outcome.model = answer.completion.model;
    outcome.firstTokenMs = chosen.attempt.firstTokenMs;
  }
  return { outcome, attempts: [nim.attempt, ...(claude ? [claude.attempt] : [])].map((a) => ({ ...a })),
    validationFallback: answer?.usedFallback ?? false, thinkingLeaked: answer?.completion.thinkingLeaked ?? false };
}
