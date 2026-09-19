/**
 * Schema warm-up (05 Part 2): at process start and every 20 minutes, one request per
 * (model, schema) pair — Haiku + VisionResponse, Sonnet + VisionResponse, and each
 * of B's five Planner job schemas against NIM (confirms `nvext.guided_json` is
 * accepted and that thinking is actually off; logs the first 50 characters). The
 * phone's `warm` message on a mode change re-fires the pair that mode will use.
 * `/api/health` reports `schemasWarm` per pair; a red pair before a demo is a
 * stop-the-line item.
 *
 * The two runners are injectable; the registry itself is pure bookkeeping.
 */
import type { AppMode, PlannerJob } from '../../src/core/contracts';
import { info, warn } from './log';

export type WarmPair = `haiku:vision` | `sonnet:vision` | `nim:${PlannerJob}`;

export interface WarmStatus {
  lastWarmAt: string | null;   // ISO of the last successful warm
  lastTriedAt: string | null;
  ok: boolean | null;          // null = never tried
  ms: number | null;
  note: string | null;         // first 50 chars of the answer, or the error
}

export interface WarmRunners {
  /** Warm Claude (model, VisionResponse schema) with a no-image request. Resolve with a short note. */
  vision(model: 'haiku' | 'sonnet'): Promise<string>;
  /** Warm NIM with the job's schema. Resolve with the first 50 chars; reject on failure. */
  nim(job: PlannerJob, schema: Record<string, unknown>): Promise<string>;
}

export interface WarmupRegistry {
  pairs(): WarmPair[];
  status(): Record<string, WarmStatus>;
  /** Report per 05: pair → ISO time of the last successful warm, or null. */
  schemasWarm(): Record<string, string | null>;
  warm(pair: WarmPair): Promise<WarmStatus>;
  warmAll(): Promise<Record<string, WarmStatus>>;
  warmForMode(mode: AppMode): Promise<void>;
  /** Start the 20-minute schedule (idempotent). */
  start(): void;
  stop(): void;
}

export const WARM_INTERVAL_MS = 20 * 60 * 1000;

export interface WarmupOptions {
  runners: WarmRunners;
  /** B's job schemas, when available. Missing → the nim pairs are listed but marked "no schema". */
  jobSchemas: Partial<Record<PlannerJob, Record<string, unknown>>>;
  now?: () => number;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (h: unknown) => void;
  intervalMs?: number;
}

export const PLANNER_JOBS_ORDER: readonly PlannerJob[] = ['routeCompile', 'parseIntent', 'disambiguate', 'crossingAnnounce', 'answer'];

/** Which Claude pairs a mode will use (curb modes may fall to the Sonnet curb-crop rung). */
export function pairsForMode(mode: AppMode): WarmPair[] {
  switch (mode) {
    case 'APPROACH_CROSSING':
    case 'AT_CURB':
    case 'CROSSING':
      return ['haiku:vision', 'sonnet:vision'];
    case 'IDLE':
    case 'ONBOARDING':
    case 'DONE':
      return [];
    default:
      return ['haiku:vision'];
  }
}

export function createWarmupRegistry(opts: WarmupOptions): WarmupRegistry {
  const now = opts.now ?? Date.now;
  const setI = opts.setIntervalFn ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clearI = opts.clearIntervalFn ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
  const pairs: WarmPair[] = ['haiku:vision', 'sonnet:vision', ...PLANNER_JOBS_ORDER.map((j) => `nim:${j}` as const)];
  const status = new Map<WarmPair, WarmStatus>();
  for (const p of pairs) status.set(p, { lastWarmAt: null, lastTriedAt: null, ok: null, ms: null, note: null });
  const inFlight = new Map<WarmPair, Promise<WarmStatus>>();
  let handle: unknown = null;

  const run = async (pair: WarmPair): Promise<WarmStatus> => {
    const t0 = now();
    const prev = status.get(pair)!;
    const tried = new Date(t0).toISOString();
    try {
      let note: string;
      if (pair === 'haiku:vision' || pair === 'sonnet:vision') {
        note = await opts.runners.vision(pair === 'haiku:vision' ? 'haiku' : 'sonnet');
      } else {
        const job = pair.slice(4) as PlannerJob;
        const schema = opts.jobSchemas[job];
        if (!schema) throw new Error('no schema (server/routes/plan.ts not present)');
        note = await opts.runners.nim(job, schema);
      }
      const s: WarmStatus = { lastWarmAt: tried, lastTriedAt: tried, ok: true, ms: now() - t0, note: note.slice(0, 50) };
      status.set(pair, s);
      info('warm ok', { pair, ms: s.ms, note: s.note });
      return s;
    } catch (e) {
      const s: WarmStatus = { lastWarmAt: prev.lastWarmAt, lastTriedAt: tried, ok: false, ms: now() - t0, note: (e instanceof Error ? e.message : String(e)).slice(0, 120) };
      status.set(pair, s);
      warn('warm failed', { pair, note: s.note });
      return s;
    }
  };

  const warm = (pair: WarmPair): Promise<WarmStatus> => {
    const existing = inFlight.get(pair);
    if (existing) return existing;
    const p = run(pair).finally(() => inFlight.delete(pair));
    inFlight.set(pair, p);
    return p;
  };

  return {
    pairs: () => [...pairs],
    status() {
      const out: Record<string, WarmStatus> = {};
      for (const [k, v] of status) out[k] = { ...v };
      return out;
    },
    schemasWarm() {
      const out: Record<string, string | null> = {};
      for (const [k, v] of status) out[k] = v.lastWarmAt;
      return out;
    },
    warm,
    async warmAll() {
      await Promise.all(pairs.map((p) => warm(p)));
      return this.status();
    },
    async warmForMode(mode) {
      await Promise.all(pairsForMode(mode).map((p) => warm(p)));
    },
    start() {
      if (handle !== null) return;
      handle = setI(() => {
        void this.warmAll();
      }, opts.intervalMs ?? WARM_INTERVAL_MS);
    },
    stop() {
      if (handle === null) return;
      clearI(handle);
      handle = null;
    },
  };
}

/** B's schemas, if `src/outdoor/plannerJobs.ts` exists (it is B's file; we only read it). */
export async function loadJobSchemas(): Promise<Partial<Record<PlannerJob, Record<string, unknown>>>> {
  try {
    const mod = (await import('../../src/outdoor/plannerJobs')) as {
      JOB_SPECS?: Record<string, { schema?: Record<string, unknown> }>;
    };
    const out: Partial<Record<PlannerJob, Record<string, unknown>>> = {};
    for (const job of PLANNER_JOBS_ORDER) {
      const schema = mod.JOB_SPECS?.[job]?.schema;
      if (schema) out[job] = schema;
    }
    return out;
  } catch {
    return {};
  }
}
