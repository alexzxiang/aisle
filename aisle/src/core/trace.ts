/**
 * Trace — the phone tells the proxy what it decided and why (round 7b, Stream A item 4).
 *
 * "The AI is confused about the path" is undebuggable from a Mac without seeing what the
 * phone saw: which boxes, what the guide computed, what was spoken. Every guided-task tick,
 * guide decision, hand word and parsed utterance goes here as one JSON line; the proxy
 * appends them to `server/data/cache/trace.jsonl` (git-ignored). No images — the stills
 * already travel with the vision requests. Batched every second, fire-and-forget, silent
 * on failure; off entirely when no proxy URL is known.
 */
export interface TraceLine {
  at: number;
  kind: string;
  [key: string]: unknown;
}

export interface Tracer {
  (kind: string, payload: Record<string, unknown>): void;
  flush(): Promise<void>;
  dispose(): void;
}

export const TRACE_FLUSH_MS = 1000;
export const TRACE_MAX_PENDING = 200;

export function createTracer(opts: { proxyUrl: string; fetchImpl?: typeof fetch; now?: () => number; enabled?: () => boolean }): Tracer {
  const now = opts.now ?? Date.now;
  const fetchImpl = opts.fetchImpl ?? fetch;
  let pending: TraceLine[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const flush = async (): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending.length === 0 || !opts.proxyUrl) return;
    const batch = pending;
    pending = [];
    try {
      await fetchImpl(`${opts.proxyUrl.replace(/\/+$/, '')}/api/trace`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lines: batch }),
      });
    } catch {
      // a trace is a courtesy
    }
  };

  const tracer = ((kind: string, payload: Record<string, unknown>): void => {
    if (disposed || (opts.enabled && !opts.enabled())) return;
    pending.push({ at: now(), kind, ...payload });
    if (pending.length > TRACE_MAX_PENDING) pending.splice(0, pending.length - TRACE_MAX_PENDING);
    if (timer === null) timer = setTimeout(() => { void flush(); }, TRACE_FLUSH_MS);
  }) as Tracer;
  tracer.flush = flush;
  tracer.dispose = () => {
    disposed = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending = [];
  };
  return tracer;
}
