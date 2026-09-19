/**
 * Typed event bus (01 §5).
 *
 * - Synchronous dispatch: `emit` returns after every listener has run.
 * - Every event is stamped `{ seq, ts }` and kept in a ring buffer for the
 *   DebugPanel and latency measurement.
 * - A throwing listener never prevents the others from running; the error is
 *   reported once through `console.error` (an exceptional path, not the hot one).
 * - Listeners may unsubscribe (or subscribe) during dispatch; the listener list
 *   is snapshotted per emit.
 */
import type { AppEvent, AppEventType, EventBus } from './contracts';

export interface BusRecord<E extends AppEvent = AppEvent> {
  seq: number;
  ts: number;
  event: E;
}

export interface AppEventBus extends EventBus {
  /** Subscribe to every event; receives the stamped record. */
  onAny(cb: (r: BusRecord) => void): () => void;
  /** Oldest → newest, at most `historySize` records. */
  history(): BusRecord[];
  /** Most recent `n` records, oldest → newest. */
  recent(n: number): BusRecord[];
  clearHistory(): void;
  /** Number of events emitted since creation (monotonic, unaffected by clearHistory). */
  seq(): number;
  /** Number of listeners for a type (tests / DebugPanel). */
  listenerCount(type?: AppEventType): number;
}

export interface EventBusOptions {
  /** Ring-buffer capacity. Default 50. */
  historySize?: number;
  /** Clock used for `ts`. Default Date.now. */
  now?: () => number;
}

export const DEFAULT_BUS_HISTORY = 50;

type AnyListener = (e: AppEvent) => void;

/** Minimal fixed-capacity ring buffer (exported for tests / reuse in the store). */
export class RingBuffer<T> {
  private readonly buf: Array<T | undefined>;
  private head = 0;      // next write index
  private count = 0;

  constructor(public readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`RingBuffer capacity must be a positive integer, got ${capacity}`);
    }
    this.buf = new Array<T | undefined>(capacity);
  }

  push(item: T): void {
    this.buf[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count += 1;
  }

  get size(): number {
    return this.count;
  }

  /** Oldest → newest. */
  toArray(): T[] {
    const out: T[] = [];
    const start = (this.head - this.count + this.capacity) % this.capacity;
    for (let i = 0; i < this.count; i += 1) {
      out.push(this.buf[(start + i) % this.capacity] as T);
    }
    return out;
  }

  last(n: number): T[] {
    const all = this.toArray();
    return n >= all.length ? all : all.slice(all.length - n);
  }

  clear(): void {
    this.buf.fill(undefined);
    this.head = 0;
    this.count = 0;
  }
}

export function createEventBus(opts: EventBusOptions = {}): AppEventBus {
  const now = opts.now ?? Date.now;
  const ring = new RingBuffer<BusRecord>(opts.historySize ?? DEFAULT_BUS_HISTORY);
  const listeners = new Map<AppEventType, Set<AnyListener>>();
  const anyListeners = new Set<(r: BusRecord) => void>();
  let seq = 0;

  const report = (where: string, err: unknown): void => {
    // Exceptional path only. Never throws.
    console.error(`[bus] listener for ${where} threw:`, err);
  };

  const emit = (event: AppEvent): void => {
    seq += 1;
    const record: BusRecord = { seq, ts: now(), event };
    ring.push(record);

    const set = listeners.get(event.type);
    if (set && set.size > 0) {
      // Snapshot so (un)subscribing inside a listener is safe.
      for (const cb of Array.from(set)) {
        try {
          cb(event);
        } catch (err) {
          report(event.type, err);
        }
      }
    }
    if (anyListeners.size > 0) {
      for (const cb of Array.from(anyListeners)) {
        try {
          cb(record);
        } catch (err) {
          report(`* (${event.type})`, err);
        }
      }
    }
  };

  const on: EventBus['on'] = (type, cb) => {
    let set = listeners.get(type);
    if (!set) {
      set = new Set();
      listeners.set(type, set);
    }
    // The map is keyed by type, so the narrowing in `cb`'s parameter is sound.
    const listener = cb as unknown as AnyListener;
    set.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      set?.delete(listener);
    };
  };

  const onAny = (cb: (r: BusRecord) => void): (() => void) => {
    anyListeners.add(cb);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      anyListeners.delete(cb);
    };
  };

  return {
    emit,
    on,
    onAny,
    history: () => ring.toArray(),
    recent: (n) => ring.last(n),
    clearHistory: () => ring.clear(),
    seq: () => seq,
    listenerCount: (type) => {
      if (type) return listeners.get(type)?.size ?? 0;
      let total = anyListeners.size;
      for (const s of listeners.values()) total += s.size;
      return total;
    },
  };
}
