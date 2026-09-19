/**
 * Routes are built synchronously (`export default router`) but the real deps are
 * assembled asynchronously (B's schemas load with a dynamic import). A DepsSource
 * is either a ready container (tests) or a thunk the handler awaits (production).
 */
import type { AppDeps } from '../deps';

export type DepsSource = AppDeps | (() => Promise<AppDeps>);

export function resolveDeps(src: DepsSource): Promise<AppDeps> {
  return typeof src === 'function' ? src() : Promise.resolve(src);
}

/** Per-client bookkeeping for HTTP /api/vision: monotonic seq and ≤ 3 in flight. */
export interface ClientSeqState {
  lastSeq: number;
  inFlight: number;
}

export function createClientRegistry(): { get(key: string): ClientSeqState; size(): number } {
  const m = new Map<string, ClientSeqState>();
  return {
    get(key) {
      let s = m.get(key);
      if (!s) {
        s = { lastSeq: -1, inFlight: 0 };
        m.set(key, s);
        if (m.size > 1000) {
          const first = m.keys().next().value;
          if (first !== undefined) m.delete(first);
        }
      }
      return s;
    },
    size: () => m.size,
  };
}

export const MAX_VISION_IN_FLIGHT = 3;
