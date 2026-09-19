/**
 * Mock SemanticVision client (01 §8) — replays fixtures/vision/<question>.json.
 *
 * Entries are keyed by `seq`, with `"*"` as the default for any other seq. Unknown
 * question or no matching entry → `{ confidence: 0, seq }` (what the proxy returns
 * on timeout). Hard cases the fixtures carry, so C's error handling meets them
 * before the venue:
 *   - low-confidence storefront (0.3)              → callers ignore < 0.5
 *   - malformed body                                → `ask` rejects like a JSON.parse failure
 *   - 4 s timeout                                   → `{ confidence: 0, seq }` after timeoutMs
 *   - a response whose seq is lower than requested  → the caller must drop it, never speak it
 *   - scan_left 'unclear'                           → "Can't see well to the left"
 * ≤ 3 requests in flight; a fourth resolves `{ confidence: 0 }` immediately (§8 rule 3).
 * Network off (DebugPanel) → rejects with MockNetworkError.
 */
import type { VisionQuestion, VisionRequest, VisionResponse } from '../src/core/contracts';
import type { NetworkGate } from './network';
import { MockNetworkError, type SemanticVisionClient } from './types';

export interface VisionFixtureEntry {
  seq: number | '*';
  delayMs?: number;
  timeoutMs?: number;
  malformed?: boolean;
  body?: string;
  response?: Partial<VisionResponse>;
}

export interface VisionFixtureFile {
  question: VisionQuestion | string;
  note?: string;
  entries: VisionFixtureEntry[];
}

export const MAX_IN_FLIGHT = 3;

export function neutralVisionResponse(seq: number): VisionResponse {
  return {
    speech: '',
    cameraRequest: 'none',
    userAction: 'none',
    aisle: { matchedAisleId: null, matchedLandmarkId: null, confidence: 0 },
    storefront: { visible: false, confidence: 0 },
    scan: { vehiclesSeen: 'unclear', confidence: 0 },
    signal: { state: 'UNKNOWN', confidence: 0 },
    hand: { hint: 'not_seen' },
    task: { done: false, confidence: 0 },
    scene: { setting: 'unknown', label: '', confidence: 0 },
    target: { box: null, confidence: 0 },
    confidence: 0,
    seq,
  };
}

/** Merge a partial fixture response onto the neutral base; the fixture's own `seq` wins (stale-seq case). */
export function materialize(seq: number, partial: Partial<VisionResponse> | undefined): VisionResponse {
  const base = neutralVisionResponse(seq);
  if (!partial) return base;
  return {
    ...base,
    ...partial,
    aisle: { ...base.aisle, ...(partial.aisle ?? {}) },
    storefront: { ...base.storefront, ...(partial.storefront ?? {}) },
    scan: { ...base.scan, ...(partial.scan ?? {}) },
    signal: { ...base.signal, ...(partial.signal ?? {}) },
    hand: { ...base.hand, ...(partial.hand ?? {}) },
    seq: partial.seq ?? seq,
  };
}

export function pickEntry(file: VisionFixtureFile | undefined, seq: number): VisionFixtureEntry | null {
  if (!file) return null;
  return file.entries.find((e) => e.seq === seq) ?? file.entries.find((e) => e.seq === '*') ?? null;
}

export interface MockSemanticVisionOptions {
  fixtures: Partial<Record<VisionQuestion, VisionFixtureFile>>;
  network?: NetworkGate;
  /** Scale simulated latency (1 = as recorded, 0 = immediate). Default 1. */
  latencyScale?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  onCall?: (req: VisionRequest, entry: VisionFixtureEntry | null) => void;
}

export interface MockSemanticVision extends SemanticVisionClient {
  inFlight(): number;
  calls(): number;
}

export function createMockSemanticVision(opts: MockSemanticVisionOptions): MockSemanticVision {
  const scale = opts.latencyScale ?? 1;
  const later = opts.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  let inFlight = 0;
  let calls = 0;

  const wait = (ms: number): Promise<void> => new Promise((r) => {
    const d = Math.max(0, Math.round(ms * scale));
    if (d === 0) r();
    else later(r, d);
  });

  return {
    inFlight: () => inFlight,
    calls: () => calls,
    async ask(req) {
      calls += 1;
      if (opts.network && !opts.network.isOnline()) throw new MockNetworkError('vision');
      const entry = pickEntry(opts.fixtures[req.question], req.seq);
      opts.onCall?.(req, entry);
      if (!entry) return neutralVisionResponse(req.seq);
      if (inFlight >= MAX_IN_FLIGHT) return neutralVisionResponse(req.seq);
      inFlight += 1;
      try {
        if (entry.timeoutMs !== undefined) {
          await wait(entry.timeoutMs);
          return neutralVisionResponse(req.seq);
        }
        await wait(entry.delayMs ?? 0);
        if (entry.malformed) {
          // What a real client sees: JSON.parse on a truncated body.
          JSON.parse(entry.body ?? '{');
        }
        return materialize(req.seq, entry.response);
      } finally {
        inFlight -= 1;
      }
    },
  };
}
