/**
 * p50 / p95 per key (05 Part 2: "Put p50/p95 per question in /api/health and
 * DebugPanel"). Ring buffer per key; pure arithmetic.
 */

export interface LatencyStats {
  p50: number | null;
  p95: number | null;
  n: number;
}

export interface LatencyTracker {
  record(key: string, ms: number): void;
  stats(key: string): LatencyStats;
  all(): Record<string, LatencyStats>;
  reset(): void;
}

export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? null;
}

export function createLatencyTracker(windowSize = 200): LatencyTracker {
  const buckets = new Map<string, number[]>();
  const statsOf = (arr: number[] | undefined): LatencyStats => {
    if (!arr || arr.length === 0) return { p50: null, p95: null, n: 0 };
    const sorted = [...arr].sort((a, b) => a - b);
    return { p50: percentile(sorted, 50), p95: percentile(sorted, 95), n: sorted.length };
  };
  return {
    record(key, ms) {
      if (!Number.isFinite(ms) || ms < 0) return;
      let arr = buckets.get(key);
      if (!arr) {
        arr = [];
        buckets.set(key, arr);
      }
      arr.push(Math.round(ms));
      if (arr.length > windowSize) arr.splice(0, arr.length - windowSize);
    },
    stats: (key) => statsOf(buckets.get(key)),
    all() {
      const out: Record<string, LatencyStats> = {};
      for (const [k, v] of buckets) out[k] = statsOf(v);
      return out;
    },
    reset() {
      buckets.clear();
    },
  };
}

export const latency: LatencyTracker = createLatencyTracker();
