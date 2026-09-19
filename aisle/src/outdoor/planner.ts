/**
 * Planner client (01 §9, 03 Task 7): `Planner.run(job, input)` → `POST /api/plan`.
 *
 * Exported from `src/outdoor/` for A (`parseIntent`) and C (`disambiguate`) to
 * import [open: confirm the client's home with A and C]. The proxy owns the
 * 1.5 s first-token deadline; this client adds a total timeout and, when the
 * proxy is unreachable or the shape is wrong, returns the same deterministic
 * template the proxy would have (`fallback: true`) — nothing ever waits.
 */
import type { PlannerJob, PlannerResult } from '../core/contracts';
import { JOB_DEADLINES_MS, templateFor, validateFor, type JobInput, type JobOutput } from './plannerJobs';

export interface PlannerClient {
  run<J extends PlannerJob>(job: J, input: JobInput<J>): Promise<PlannerResult<JobOutput<J>>>;
}

export interface PlannerClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  /** Extra time over the job's total deadline before the local template wins. */
  graceMs?: number;
  now?: () => number;
  /** Debug hook: every result, with whether the proxy or the local template answered. */
  onResult?: (r: PlannerResult<unknown> & { source: 'proxy' | 'local' }) => void;
}

export function planUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/plan`;
}

export function localFallback<J extends PlannerJob>(job: J, input: JobInput<J>, latencyMs: number): PlannerResult<JobOutput<J>> {
  return { job, output: templateFor(job, input), fallback: true, latencyMs };
}

export function createPlannerClient(opts: PlannerClientOptions): PlannerClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const grace = opts.graceMs ?? 500;

  return {
    async run(job, input) {
      const started = now();
      const total = JOB_DEADLINES_MS[job].total + grace;
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = setTimeout(() => controller?.abort(), total);
      try {
        const res = await fetchImpl(planUrl(opts.baseUrl), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ job, input }),
          signal: controller?.signal,
        });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as Partial<PlannerResult<unknown>>;
        // Validate again on the phone: the proxy is trusted, the model is not.
        const { output, usedFallback } = validateFor(job, body.output, input);
        const result: PlannerResult<JobOutput<typeof job>> = {
          job,
          output,
          fallback: body.fallback === true || usedFallback,
          latencyMs: typeof body.latencyMs === 'number' ? body.latencyMs : now() - started,
        };
        opts.onResult?.({ ...result, source: 'proxy' });
        return result;
      } catch {
        clearTimeout(timer);
        const result = localFallback(job, input, now() - started);
        opts.onResult?.({ ...result, source: 'local' });
        return result;
      }
    },
  };
}
