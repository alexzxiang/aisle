/**
 * Replay clock shared by the sensor and perception replayers.
 *
 * Replay time advances from an injectable wall clock while playing, scaled by
 * `speed`; `seek` moves it and notifies listeners so every replayer re-cursors.
 * No timers live here — the harness ticks the replayers (mocks/index.ts).
 */
export interface ReplayClock {
  /** Replay time in ms from fixture start. */
  nowMs(): number;
  play(): void;
  pause(): void;
  isPlaying(): boolean;
  seek(ms: number): void;
  setSpeed(x: number): void;
  speed(): number;
  onSeek(cb: (ms: number) => void): () => void;
}

export interface ReplayClockOptions {
  wall?: () => number;
  startMs?: number;
  speed?: number;
  playing?: boolean;
}

export function createReplayClock(opts: ReplayClockOptions = {}): ReplayClock {
  const wall = opts.wall ?? Date.now;
  let base = opts.startMs ?? 0;        // replay ms at `anchor`
  let anchor = wall();                 // wall ms when `base` was set
  let speed = opts.speed ?? 1;
  let playing = opts.playing ?? false;
  const seekListeners = new Set<(ms: number) => void>();

  const nowMs = (): number => (playing ? base + (wall() - anchor) * speed : base);
  const freeze = (): void => {
    base = nowMs();
    anchor = wall();
  };

  return {
    nowMs,
    play() {
      if (playing) return;
      anchor = wall();
      playing = true;
    },
    pause() {
      if (!playing) return;
      freeze();
      playing = false;
    },
    isPlaying: () => playing,
    seek(ms) {
      base = Math.max(0, ms);
      anchor = wall();
      for (const cb of Array.from(seekListeners)) cb(base);
    },
    setSpeed(x) {
      if (!(x > 0)) return;
      freeze();
      speed = x;
    },
    speed: () => speed,
    onSeek(cb) {
      seekListeners.add(cb);
      return () => {
        seekListeners.delete(cb);
      };
    },
  };
}
