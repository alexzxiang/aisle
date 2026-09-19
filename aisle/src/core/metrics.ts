/**
 * DebugPanel metrics (02 Task 9, 01 §11): per-tier latency plus the speech and
 * store counters, gathered without a poll loop of their own.
 *
 * - `LatencyRing` keeps the last N samples of a path and answers last / p95.
 * - `observePlanner` and `timedTransport` wrap B's Planner client and C's
 *   VisionTransport so every Tier 2 / Tier 1 call is measured whichever
 *   implementation (real or D's mock) sits behind them.
 * - `liveMetrics` builds the object the DebugPanel takes as `metrics`: every
 *   field is a getter, so the panel's own 1 Hz re-render reads fresh numbers
 *   and nothing re-renders the whole tree to push them.
 */
import type { PlannerJob, PlannerResult } from './contracts';
import type { PlannerClient } from '../outdoor/planner';
import type { VisionTransport } from '../perception/semanticVision';

export const LATENCY_RING_SIZE = 32;

/** Nearest-rank percentile; null on an empty set. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank] ?? null;
}

export class LatencyRing {
  private readonly values: number[] = [];
  private lastValue: number | null = null;
  constructor(private readonly capacity: number = LATENCY_RING_SIZE) {}
  push(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.lastValue = ms;
    this.values.push(ms);
    if (this.values.length > this.capacity) this.values.shift();
  }
  last(): number | null {
    return this.lastValue;
  }
  p95(): number | null {
    return percentile(this.values, 95);
  }
  count(): number {
    return this.values.length;
  }
}

export interface PlannerObservation {
  job: PlannerJob;
  latencyMs: number;
  fallback: boolean;
  /** Wall time of the call as seen by the phone (proxy latency + transport). */
  roundTripMs: number;
}

/** Wrap a Planner client so every result (real or mock) is reported. */
export function observePlanner(planner: PlannerClient, onResult: (o: PlannerObservation) => void, now: () => number = Date.now): PlannerClient {
  return {
    async run(job, input) {
      const t0 = now();
      const r = await planner.run(job, input);
      const res = r as PlannerResult<unknown>;
      onResult({ job, latencyMs: res.latencyMs, fallback: res.fallback, roundTripMs: now() - t0 });
      return r;
    },
  };
}

/** Wrap a VisionTransport so every `ask` (real or mock) reports its round trip. */
export function timedTransport(transport: VisionTransport, onLatency: (ms: number) => void, now: () => number = Date.now): VisionTransport {
  const wrapped: VisionTransport = {
    async ask(req, opts) {
      const t0 = now();
      try {
        return await transport.ask(req, opts);
      } finally {
        onLatency(now() - t0);
      }
    },
  };
  if (transport.warm) wrapped.warm = (mode) => transport.warm?.(mode);
  return wrapped;
}

/** What `src/ui/ports.ts` DebugMetrics reads, expressed without importing the UI. */
export interface LiveMetrics {
  readonly tier0FrameToEventMs: number | null;
  readonly tier1LastMs: number | null;
  readonly tier1P95Ms: number | null;
  readonly tier2FirstTokenMs: number | null;
  readonly tier2Fallback: boolean | null;
  readonly utterancesPerMinute: number | null;
  readonly lastSpeechBackend: string | null;
  readonly policyDroppedCount: number | null;
  readonly illegalTransitions: number | null;
  readonly batteryPercent: number | null;
}

export interface MetricSources {
  tier0FrameToEventMs?: () => number | null;
  tier1: Pick<LatencyRing, 'last' | 'p95'>;
  tier2: () => { latencyMs: number | null; fallback: boolean | null };
  speech?: () => { utterancesPerMinute: number; lastBackend: string | null; policyDropped: number } | null;
  illegalTransitions?: () => number;
  batteryPercent?: () => number | null;
}

function safe<T>(fn: (() => T) | undefined, fallback: T): T {
  if (!fn) return fallback;
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** Getter-backed metrics: reading a field runs the source; nothing is cached. */
export function liveMetrics(src: MetricSources): LiveMetrics {
  return {
    get tier0FrameToEventMs() {
      return safe(src.tier0FrameToEventMs, null);
    },
    get tier1LastMs() {
      return src.tier1.last();
    },
    get tier1P95Ms() {
      return src.tier1.p95();
    },
    get tier2FirstTokenMs() {
      return safe(src.tier2, { latencyMs: null, fallback: null }).latencyMs;
    },
    get tier2Fallback() {
      return safe(src.tier2, { latencyMs: null, fallback: null }).fallback;
    },
    get utterancesPerMinute() {
      return safe(src.speech, null)?.utterancesPerMinute ?? null;
    },
    get lastSpeechBackend() {
      return safe(src.speech, null)?.lastBackend ?? null;
    },
    get policyDroppedCount() {
      return safe(src.speech, null)?.policyDropped ?? null;
    },
    get illegalTransitions() {
      return safe(src.illegalTransitions, null);
    },
    get batteryPercent() {
      return safe(src.batteryPercent, null);
    },
  };
}
