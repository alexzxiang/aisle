/**
 * Two-lane semaphore for ElevenLabs concurrency (05 Part 2): free-plan Flash allows
 * 4 simultaneous requests (10 with the Creator perk). Live speech (the vision → TTS
 * relay, a rare true-live /api/tts) is served before pre-synthesis batches, never
 * the reverse.
 */

export type Lane = 'live' | 'batch';

export interface Semaphore {
  acquire(lane: Lane): Promise<() => void>;
  /** Run `fn` inside a permit. */
  run<T>(lane: Lane, fn: () => Promise<T>): Promise<T>;
  inUse(): number;
  waiting(): { live: number; batch: number };
  setLimit(n: number): void;
  limit(): number;
}

export function createSemaphore(initialLimit = 4): Semaphore {
  let limit = Math.max(1, initialLimit);
  let inUse = 0;
  const live: Array<(release: () => void) => void> = [];
  const batch: Array<(release: () => void) => void> = [];

  const release = (): void => {
    inUse = Math.max(0, inUse - 1);
    pump();
  };

  const pump = (): void => {
    while (inUse < limit) {
      const next = live.shift() ?? batch.shift();
      if (!next) return;
      inUse += 1;
      next(release);
    }
  };

  return {
    acquire(lane) {
      return new Promise((resolve) => {
        (lane === 'live' ? live : batch).push(resolve);
        pump();
      });
    },
    async run(lane, fn) {
      const rel = await this.acquire(lane);
      try {
        return await fn();
      } finally {
        rel();
      }
    },
    inUse: () => inUse,
    waiting: () => ({ live: live.length, batch: batch.length }),
    setLimit(n) {
      limit = Math.max(1, n);
      pump();
    },
    limit: () => limit,
  };
}

/** Process-wide ElevenLabs permit pool. Raise to 10 once the Creator perk is confirmed [verify]. */
export const elevenLabsSlots: Semaphore = createSemaphore(4);
