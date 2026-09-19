/**
 * `POST /api/plan { job, input }` — the five Nemotron Planner jobs (01 §9, 03 Task 7).
 *
 * Schemas, prompts, validators and templates live in `src/outdoor/plannerJobs.ts`
 * (B's, shared with the phone so the app can fall back locally). This file is
 * the hosting: D's `nimChat` (streaming, `nvext.guided_json`, thinking off,
 * OpenRouter failover) under D's `withFirstTokenDeadline` (1.5 s first token;
 * 8 s total for the two route-time jobs), then the grammar-level output is
 * validated field by field and every miss falls back to the template. The
 * route never waits past its deadline and never returns a phrase with a digit,
 * more than twelve words or a forbidden word.
 *
 * `runPlannerJob` is exported for `route.ts` (routeCompile / crossingAnnounce
 * in-process, no second round trip) and for D's warm-up.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { PlannerJob, PlannerResult } from '../../src/core/contracts';
import {
  JOB_DEADLINES_MS,
  JOB_SPECS,
  PLANNER_JOBS,
  extractJsonObject,
  isPlannerJob,
  templateFor,
  validateFor,
  type JobInput,
  type JobOutput,
} from '../../src/outdoor/plannerJobs';
import { loadConfig, type ProxyConfig } from '../config';
import { toPlannerResult, withFirstTokenDeadline, type DeadlineOutcome, type StreamHandle } from '../lib/deadline';
import { requestLog, type RequestLog } from '../lib/log';
import { nimChat, type NimChatParams, type NimChatResult } from '../lib/nim';
import { sdkClaudePlan, type ClaudePlanStarter } from '../lib/claudePlan';

export type NimStarter = (params: NimChatParams) => StreamHandle<NimChatResult>;

/** How long after Nemotron's deadline the understudy may still answer before the template wins. */
export const CLAUDE_GRACE_MS = 1500;

export interface PlanDeps {
  config?: ProxyConfig;
  /** Override the NIM transport (tests, fault injection). Default: D's `nimChat` with `config`. */
  nim?: NimStarter;
  /** The understudy (lib/claudePlan.ts). Default: Haiku with the config key; `null` disables the race. */
  claude?: ClaudePlanStarter | null;
  log?: RequestLog;
  now?: () => number;
  /** Deadline timer injection (tests). */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export interface PlanRunResult<T> extends PlannerResult<T> {
  firstTokenMs: number | null;
  provider: string | null;
  model: string | null;
  reason: DeadlineOutcome<unknown>['reason'] | 'validation' | null;
  thinkingLeaked: boolean;
  error?: string;
}

export const MAX_COMPLETION_TOKENS = 400;

function defaultNim(config: ProxyConfig): NimStarter {
  return (params) => nimChat(params, { config });
}

/**
 * One job, end to end: prompt + schema → NIM (streamed, guided) → deadline →
 * parse → per-field validation → template where anything is off.
 */
export async function runPlannerJob<J extends PlannerJob>(job: J, input: JobInput<J>, deps: PlanDeps = {}): Promise<PlanRunResult<JobOutput<J>>> {
  const now = deps.now ?? Date.now;
  const spec = JOB_SPECS[job];
  const config = deps.config ?? loadConfig();
  const nim = deps.nim ?? defaultNim(config);
  const deadlines = JOB_DEADLINES_MS[job];
  let validationFallback = false;
  let thinkingLeaked = false;

  // The understudy starts now; it is only read if Nemotron misses (see lib/claudePlan.ts).
  const claudeStarter = deps.claude === undefined ? (config.anthropicApiKey ? sdkClaudePlan(config.anthropicApiKey) : null) : deps.claude;
  const understudy = claudeStarter
    ? claudeStarter({ system: spec.prompt, user: JSON.stringify(input), schema: spec.schema, maxTokens: MAX_COMPLETION_TOKENS })
    : null;
  if (understudy) understudy.result.catch(() => undefined); // an aborted / failed understudy is not an unhandled rejection

  let outcome = await withFirstTokenDeadline<NimChatResult, JobOutput<J>>(
    () => nim({
      system: spec.prompt,
      user: JSON.stringify(input),
      schema: spec.schema,
      schemaName: job,
      maxTokens: MAX_COMPLETION_TOKENS,
      temperature: 0,
    }),
    {
      firstTokenMs: deadlines.firstToken,
      totalMs: deadlines.total,
      fallback: () => templateFor(job, input),
      accept: (r) => {
        thinkingLeaked = r.thinkingLeaked;
        const parsed = extractJsonObject(r.text);
        if (parsed === null) throw new Error('model reply is not JSON');
        const v = validateFor(job, parsed, input);
        validationFallback = v.usedFallback;
        return v.output;
      },
      now,
      setTimeoutFn: deps.setTimeoutFn,
      clearTimeoutFn: deps.clearTimeoutFn,
    },
  );

  if (understudy) {
    if (!outcome.fallback) {
      understudy.abort();
    } else {
      // Nemotron missed or answered badly: take Haiku's answer if it is in (or arrives within the grace).
      const t1 = now();
      const graced = await Promise.race<{ text: string; model: string } | null>([
        understudy.result.catch(() => null),
        new Promise<null>((resolve) => { (deps.setTimeoutFn ?? setTimeout)(() => resolve(null), CLAUDE_GRACE_MS); }),
      ]);
      if (graced) {
        const parsed = extractJsonObject(graced.text);
        if (parsed !== null) {
          const v = validateFor(job, parsed, input);
          validationFallback = v.usedFallback;
          outcome = {
            value: v.output,
            fallback: false,
            firstTokenMs: outcome.firstTokenMs,
            latencyMs: outcome.latencyMs + (now() - t1),
            provider: 'anthropic',
            model: graced.model,
            reason: outcome.reason,
          };
        }
      } else {
        understudy.abort();
      }
    }
  }

  const base = toPlannerResult(job, outcome);
  const result: PlanRunResult<JobOutput<J>> = {
    ...base,
    fallback: base.fallback || validationFallback,
    firstTokenMs: outcome.firstTokenMs,
    provider: outcome.provider ?? null,
    model: outcome.model ?? null,
    reason: outcome.reason ?? (validationFallback ? 'validation' : null),
    thinkingLeaked,
  };
  if (outcome.error) result.error = outcome.error;

  (deps.log ?? requestLog).write({
    route: 'plan',
    key: job,
    model: result.model ?? undefined,
    provider: result.provider ?? undefined,
    firstTokenMs: result.firstTokenMs,
    totalMs: result.latencyMs,
    fallback: result.fallback,
    verdict: 'pass',
    error: result.error,
    extra: { reason: result.reason, thinkingLeaked },
  });
  return result;
}

const BodySchema = z.object({
  job: z.enum(PLANNER_JOBS as unknown as [PlannerJob, ...PlannerJob[]]),
  input: z.record(z.string(), z.unknown()),
});

/** Warm every job's schema with one dummy call (grammar compile is cached per schema). */
export async function warmPlannerSchemas(deps: PlanDeps = {}): Promise<Record<PlannerJob, { fallback: boolean; latencyMs: number }>> {
  const out = {} as Record<PlannerJob, { fallback: boolean; latencyMs: number }>;
  for (const job of PLANNER_JOBS) {
    const r = await runPlannerJob(job, warmInputFor(job), deps);
    out[job] = { fallback: r.fallback, latencyMs: r.latencyMs };
  }
  return out;
}

export function warmInputFor(job: PlannerJob): JobInput<PlannerJob> {
  switch (job) {
    case 'routeCompile':
      return { steps: [{ index: 0, instruction: 'Turn right onto Forbes Ave', maneuver: 'TURN_RIGHT', distanceM: 120, startBearingDeg: 250 }], crossings: [] };
    case 'parseIntent':
      return { transcript: 'I need eggs', mode: 'IDLE', knownItems: ['eggs', 'milk'] };
    case 'disambiguate':
      return {
        item: 'eggs',
        storeMap: {
          storeId: 'warm', displayName: 'Warm', entrance: { lat: 0, lng: 0, radiusM: 30, pinnedBy: 'warm', pinnedAt: '' },
          aisles: [{ id: 'a3', label: 'Aisle 3', spokenLabel: 'Aisle three', signText: ['3'], order: 3, categories: ['dairy', 'eggs'] }],
          landmarks: [], itemIndex: {},
        },
      };
    case 'crossingAnnounce':
      return { candidates: [{ nodeId: '1', distToPolylineM: 2, tags: { highway: 'crossing' } }], street: 'Forbes Ave' };
    case 'taskPlan':
      return { goal: 'eggs in my fridge', context: 'home' };
    case 'answer':
    default:
      return { question: 'replan', context: {} };
  }
}

export function createPlanRouter(deps: PlanDeps = {}): Router {
  const router = Router();
  // D's app mounts this router at '/api/plan' (so the path is '/'); a bare app.use(router) also works.
  router.post(['/', '/api/plan'], async (req: Request, res: Response) => {
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success || !isPlannerJob(parsed.data.job)) {
      res.status(400).json({ error: 'expected { job: PlannerJob, input: object }' });
      return;
    }
    const { job, input } = parsed.data;
    try {
      const result = await runPlannerJob(job, input as unknown as JobInput<typeof job>, deps);
      const body: PlannerResult<unknown> & { firstTokenMs: number | null; provider: string | null; model: string | null; reason: string | null } = {
        job: result.job,
        output: result.output,
        fallback: result.fallback,
        latencyMs: result.latencyMs,
        firstTokenMs: result.firstTokenMs,
        provider: result.provider,
        model: result.model,
        reason: result.reason ?? null,   // 'first_token_deadline' | 'total_deadline' | 'upstream_error' | 'validation' | null
      };
      res.json(body);
    } catch (e) {
      // Even a programming error must not leave the phone waiting: template it.
      const output = templateFor(job, input as unknown as JobInput<typeof job>);
      res.json({ job, output, fallback: true, latencyMs: 0, error: (e as Error)?.message ?? 'plan failed' });
    }
  });
  return router;
}

const router = createPlanRouter();
export default router;
