/**
 * Mock Planner client (01 §9) — replays fixtures/plan/<job>.json.
 *
 * Entry selection, in order: an entry whose `match` fields all equal the input's
 * (strings compared case-insensitively, trimmed), then an entry whose `seq` equals
 * this job's call count (1-based), then `"*"`. No match → `{ fallback: true }` with
 * an empty-but-typed output for the job (never a throw: B's templated fallback path
 * is the contract). Includes ASR-noise transcripts and one `fallback: true` reply.
 */
import type { PlannerJob, PlannerResult } from '../src/core/contracts';
import type { NetworkGate } from './network';
import { MockNetworkError, type PlannerClient, type PlannerJobInput, type PlannerJobOutput } from './types';

export interface PlanFixtureEntry {
  seq?: number | '*';
  match?: Record<string, unknown>;
  delayMs?: number;
  result: PlannerResult<unknown>;
}

export interface PlanFixtureFile {
  job: PlannerJob | string;
  note?: string;
  entries: PlanFixtureEntry[];
}

const norm = (v: unknown): unknown => (typeof v === 'string' ? v.trim().toLowerCase() : v);

export function matches(match: Record<string, unknown> | undefined, input: unknown): boolean {
  if (!match) return false;
  if (typeof input !== 'object' || input === null) return false;
  const obj = input as Record<string, unknown>;
  return Object.entries(match).every(([k, v]) => norm(obj[k]) === norm(v));
}

export function pickPlanEntry(file: PlanFixtureFile | undefined, input: unknown, callNo: number): PlanFixtureEntry | null {
  if (!file) return null;
  return (
    file.entries.find((e) => matches(e.match, input)) ??
    file.entries.find((e) => e.seq === callNo) ??
    file.entries.find((e) => e.seq === '*') ??
    null
  );
}

export function emptyOutput<J extends PlannerJob>(job: J): PlannerJobOutput<J> {
  const out: { [K in PlannerJob]: PlannerJobOutput<K> } = {
    routeCompile: { legs: [], crossingAnnouncements: [] },
    parseIntent: { intent: 'unknown', item: null, reply: 'Say the item again.' },
    disambiguate: { aisleId: null, confidence: 0, askBack: 'Say the item again.' },
    crossingAnnounce: { nodeId: null, signalized: null, pushButtonLikely: false, text: 'Crossing ahead.' },
    answer: { reply: '' },
    taskPlan: { askFirst: 'Let me see your surroundings.', steps: [] },
  };
  return out[job] as PlannerJobOutput<J>;
}

export interface MockPlannerOptions {
  fixtures: Partial<Record<PlannerJob, PlanFixtureFile>>;
  network?: NetworkGate;
  /** Scale simulated latency (uses the entry's delayMs, else min(latencyMs, 1500)). Default 1. */
  latencyScale?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  onCall?: (job: PlannerJob, input: unknown, entry: PlanFixtureEntry | null) => void;
}

export interface MockPlanner extends PlannerClient {
  callCount(job: PlannerJob): number;
}

export function createMockPlanner(opts: MockPlannerOptions): MockPlanner {
  const scale = opts.latencyScale ?? 1;
  const later = opts.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const counts = new Map<PlannerJob, number>();

  const wait = (ms: number): Promise<void> => new Promise((r) => {
    const d = Math.max(0, Math.round(ms * scale));
    if (d === 0) r();
    else later(r, d);
  });

  return {
    callCount: (job) => counts.get(job) ?? 0,
    async run<J extends PlannerJob>(job: J, input: PlannerJobInput<J>): Promise<PlannerResult<PlannerJobOutput<J>>> {
      const n = (counts.get(job) ?? 0) + 1;
      counts.set(job, n);
      if (opts.network && !opts.network.isOnline()) throw new MockNetworkError(`plan/${job}`);
      const entry = pickPlanEntry(opts.fixtures[job], input, n);
      opts.onCall?.(job, input, entry);
      if (!entry) {
        return { job, output: emptyOutput(job), fallback: true, latencyMs: 0 };
      }
      const delay = entry.delayMs ?? Math.min(entry.result.latencyMs, 1500);
      await wait(delay);
      return { ...entry.result, job, output: entry.result.output as PlannerJobOutput<J> };
    },
  };
}
