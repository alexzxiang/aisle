/**
 * The §7 event rate limits, applied by the perception replayer so a fixture pack
 * recorded before a native rate-limit fix (or hand-authored too densely) still
 * reaches JS at the contractual rate. Pure; time is passed in.
 */
export const RATE_LIMITS_MS: Readonly<Record<string, number>> = Object.freeze({
  onSignalState: 2000,        // on change + 0.5 Hz heartbeat (change bypasses, see below)
  onVehicleApproaching: 4000, // per track
  onObstacleAhead: 2000,
  onHazard: 3000,
  onOcrText: 333,             // ≤ 3 Hz
  onDetections: 200,          // ≤ 5 Hz
  onPose: 100,                // 10 Hz
  onLateralOffset: 200,       // 5 Hz
  onPlanes: 1000,             // 1 Hz
  onDepth: 200,               // ≤ 5 Hz
  onTrackingState: 0,         // every change
});

export interface RateLimiter {
  /** Returns true when the event may pass; `key` scopes per-track limits. `bypass` marks a state change. */
  allow(event: string, atMs: number, key?: string | number, bypass?: boolean): boolean;
  reset(): void;
}

export function createRateLimiter(limits: Readonly<Record<string, number>> = RATE_LIMITS_MS): RateLimiter {
  const last = new Map<string, number>();
  return {
    allow(event, atMs, key, bypass = false) {
      const min = limits[event] ?? 0;
      if (min <= 0) return true;
      const k = key === undefined ? event : `${event}:${key}`;
      const prev = last.get(k);
      if (bypass || prev === undefined || atMs - prev >= min || atMs < prev) {
        last.set(k, atMs);
        return true;
      }
      return false;
    },
    reset() {
      last.clear();
    },
  };
}
