/**
 * PerceptionService (01 §7) — the JS side of the native `PerceptionModule`, and
 * the two Tier 0 reflexes it owns (04 Task 1).
 *
 * Three layers, each testable on its own:
 *
 *   1. `createNativePerceptionService(native)` — a thin typed shell over the bridge
 *      in `modules/perception/index.ts`. No policy, no state beyond a cached
 *      tracking state.
 *   2. `createPerceptionService({ native?, mock? })` — the factory the composition
 *      root calls. It never reads env: App.tsx passes D's replayer from `mocks/`
 *      when `EXPO_PUBLIC_MOCK=1` and nothing here knows the difference.
 *   3. `bindPerceptionToApp(...)` — the wiring that is identical for the native
 *      module and the replayer: mode → profile from A's store (nobody passes mode
 *      by hand), the vehicle reflex (STOP + one CRITICAL phrase, synchronously,
 *      before the bus event), the obstacle reflex (STOP-only outdoors, STOP +
 *      `obstacle_ahead` in the indoor profiles), the bus re-broadcast of
 *      SIGNAL_STATE / VEHICLE_APPROACHING / OBSTACLE_AHEAD / HAZARD, and
 *      `setBodyOffsetDeg` from the store.
 *
 * Latency: the reflex handlers do no `await` and no allocation before
 * `haptics.play('STOP')`; 01 §11 gives frame → haptic 150 ms and the module has
 * already spent up to 100 of them.
 */
import type {
  AppMode,
  DepthSummary,
  Detection,
  Direction,
  DistanceClass,
  HapticService,
  HazardKind,
  ModeProfile,
  OcrRead,
  PerceptionService,
  Pose,
  SignalState,
  Snapshot,
  SpeechService,
  TrackingState,
} from '../core/contracts';
import type { AppEventBus } from '../core/bus';
import type { AppStore } from '../core/store';
import {
  isSnapshotWidth,
  requirePerceptionNative,
  subscribePerceptionEvent,
  type PerceptionNativeModule,
} from '../../modules/perception';
import {
  VEHICLE_SPEECH_COOLDOWN_MS,
  obstacleReflexFor,
  profileForMode,
  vehicleCacheKey,
} from './profile';

export type { PerceptionNativeModule } from '../../modules/perception';

// ---------------------------------------------------------------------------
// 1. Native-backed service
// ---------------------------------------------------------------------------

const DEFAULT_STATS = Object.freeze({ detectorFps: 0, depthFps: 0, ocrFps: 0, frameToEventMs: 0, thermalState: 'unknown' });

/** The 01 §7 interface over the bridge. Pure forwarding; nothing is cached but tracking state. */
export function createNativePerceptionService(native: PerceptionNativeModule): PerceptionService {
  let tracking: TrackingState = 'NOT_AVAILABLE';
  // Keep the cached tracking state honest even when nobody else subscribes.
  subscribePerceptionEvent(native, 'onTrackingState', (s) => {
    tracking = s;
  });

  return {
    async start(profile) {
      await native.start(profile);
    },
    setProfile(profile) {
      native.setProfile(profile);
    },
    stop() {
      native.stop();
    },
    setCrossingBearing(bearingDeg) {
      native.setCrossingBearing(bearingDeg);
    },
    setCourseReference(ref) {
      native.setCourseReference(ref ? ref.bearingDeg : null);
    },
    setBodyOffsetDeg(offsetDeg) {
      native.setBodyOffsetDeg(offsetDeg);
    },
    setKnownSigns(words) {
      native.setKnownSigns(Array.from(new Set(words.filter((w) => w.length > 0))));
    },

    onSignalState: (cb) => subscribePerceptionEvent(native, 'onSignalState', cb),
    onVehicleApproaching: (cb) => subscribePerceptionEvent(native, 'onVehicleApproaching', cb),
    onObstacleAhead: (cb) => subscribePerceptionEvent(native, 'onObstacleAhead', cb),
    onHazard: (cb) => subscribePerceptionEvent(native, 'onHazard', cb),
    onOcrText: (cb) => subscribePerceptionEvent(native, 'onOcrText', cb),
    onDetections: (cb) => subscribePerceptionEvent(native, 'onDetections', cb),
    onPose: (cb) => subscribePerceptionEvent(native, 'onPose', cb),
    onLateralOffset: (cb) => subscribePerceptionEvent(native, 'onLateralOffset', cb),
    onPlanes: (cb) => subscribePerceptionEvent(native, 'onPlanes', cb),
    onDepth: (cb) => subscribePerceptionEvent(native, 'onDepth', cb),
    onTrackingState: (cb) => subscribePerceptionEvent(native, 'onTrackingState', cb),
    onSceneClass: (cb) => subscribePerceptionEvent(native, 'onSceneClass', cb),
    onHandPose: (cb) => subscribePerceptionEvent(native, 'onHandPose', cb),

    debugLog: () => {
      try {
        return native.nativeLog();
      } catch {
        return [];
      }
    },
    async snapshotJPEG(maxWidth): Promise<Snapshot> {
      if (!isSnapshotWidth(maxWidth)) {
        throw new Error(`[perception] snapshotJPEG width must be 512 | 640 | 768 | 1024, got ${String(maxWidth)}`);
      }
      return native.snapshotJPEG(maxWidth);
    },
    getTrackingState() {
      try {
        return native.getTrackingState() ?? tracking;
      } catch {
        return tracking;
      }
    },
    getStats() {
      try {
        return { ...DEFAULT_STATS, ...native.getStats() };
      } catch {
        return { ...DEFAULT_STATS };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 2. Factory for the composition root
// ---------------------------------------------------------------------------

export interface CreatePerceptionServiceOptions {
  /**
   * D's replayer (`createMockServices().perception`) when `EXPO_PUBLIC_MOCK=1`.
   * The composition root reads the flag; this factory only takes the result.
   */
  mock?: PerceptionService;
  /** An already-resolved native module (tests inject a fake). Default: `requirePerceptionNative()`. */
  native?: PerceptionNativeModule | null;
}

export function createPerceptionService(opts: CreatePerceptionServiceOptions = {}): PerceptionService {
  if (opts.mock) return opts.mock;
  // `native: null` means "explicitly none" (tests, a JS-only build); undefined means resolve it.
  const native = opts.native !== undefined ? opts.native : requirePerceptionNative();
  if (!native) {
    throw new Error('[perception] no native module and no mock: set EXPO_PUBLIC_MOCK=1 or build the dev client (09 §8).');
  }
  return createNativePerceptionService(native);
}

// ---------------------------------------------------------------------------
// 3. App wiring: mode → profile, reflexes, bus re-broadcast
// ---------------------------------------------------------------------------

export interface BindPerceptionOptions {
  perception: PerceptionService;
  bus: AppEventBus;
  store: AppStore;
  haptics: HapticService;
  speech: SpeechService;
  /** Reported (not thrown) when `start`/`setProfile` reject. Default: ERROR on the bus. */
  onError?: (scope: string, err: unknown) => void;
  /** Enable in the live app; no background camera recovery. */
  isForeground?: () => boolean;
  healthIntervalMs?: number;
  onHealth?: (health: Record<string, unknown>) => void;
  /** Round 13: the words for an obstacle — what, where, how far, the open side — or null for the plain phrase. */
  describeObstacle?: (e: { distanceClass: DistanceClass; direction: Direction }) => string | null;
  /**
   * Round 14: true when an indoor obstacle line would be noise — the person is standing still,
   * is deliberately at a surface (scanning a table, reaching into the fridge), or is walking up
   * to the very thing the reflex sees. The haptic and the line are skipped; the event still goes out.
   */
  suppressObstacle?: (e: { distanceClass: DistanceClass; direction: Direction }) => boolean;
}

/** The `models: detector=… depth=…` line the engine prints at start. */
export const MODELS_LOG_PREFIX = 'models:';
/** Stages whose absence leaves the app unable to see objects or judge distance. */
export const REQUIRED_MODEL_STAGES: readonly string[] = ['detector', 'depth'];

/**
 * Which required model stages the engine reported as absent from the bundle.
 * `null` when the engine said nothing about models (an older build, or mock mode).
 */
export function missingRequiredModels(lines: readonly string[]): string[] | null {
  const line = lines.find((l) => l.trim().startsWith(MODELS_LOG_PREFIX));
  if (line === undefined) return null;
  const missing: string[] = [];
  for (const stage of REQUIRED_MODEL_STAGES) {
    if (new RegExp(`\\b${stage}=MISSING\\b`).test(line)) missing.push(stage);
  }
  return missing;
}

/**
 * Says so when the phone has no detector or depth model.
 *
 * Weights are git-ignored and exported per machine (`npm run models:coco`), so
 * a checkout builds, installs and runs perfectly with nothing inside: the
 * detector never fires, the "Sees:" strip stays empty, and every cloud question
 * goes out with zero on-device facts. That reads as "the camera is bad at
 * recognising things" and sent one of us hunting through the camera pipeline
 * for hours. One loud line instead.
 */
export function reportMissingModels(lines: readonly string[], report: (scope: string, err: unknown) => void): void {
  const missing = missingRequiredModels(lines);
  if (missing === null || missing.length === 0) return;
  const message = `No ${missing.join(' or ')} model in this build — the camera cannot recognise objects. Run npm run models:coco && npm run models:depth, then rebuild.`;
  console.warn(`[perception] ${message}`);
  report('perception.models', new Error(message));
}

export interface PerceptionBinding {
  /** The profile last applied to the module. */
  getProfile(): ModeProfile;
  /** Last depth summary (the obstacle reflex's closing-rate source). */
  getLastDepth(): DepthSummary | null;
  dispose(): void;
}

/**
 * Wire the service into the app. Idempotent per call; returns a disposer.
 *
 * Start/stop policy: the session starts with the first non-IDLE profile and is
 * paused (`setProfile('IDLE')`) rather than torn down on IDLE / DONE, so a
 * re-run does not pay the ARKit warm-up again. `stop()` runs on dispose.
 */
export function bindPerceptionToApp(opts: BindPerceptionOptions): PerceptionBinding {
  const { perception, bus, store, haptics, speech } = opts;
  const report = opts.onError ?? ((scope: string, err: unknown) => {
    bus.emit({ type: 'ERROR', scope, message: err instanceof Error ? err.message : String(err) });
  });

  let profile: ModeProfile = 'IDLE';
  let started = false;
  let disposed = false;
  let lastDetectionsAt = Date.now();
  let recoveries = 0;
  let recovering = false;
  let lastDepth: DepthSummary | null = null;
  const unsubs: Array<() => void> = [];

  const applyMode = (mode: AppMode): void => {
    const next = profileForMode(mode);
    if (next === profile && (started || next === 'IDLE')) return;
    profile = next;
    if (!started) {
      if (next === 'IDLE') return;
      started = true;
      perception.start(next)
        .then(() => {
          // One Metro line with the lens the phone chose (round 6: it decides how much of the room we see).
          const lines = perception.debugLog?.() ?? [];
          const format = lines.find((l) => l.includes('videoFormat'));
          if (format) console.log(`[perception] ${format}`);
          reportMissingModels(lines, report);
        })
        .catch((err: unknown) => { started = false; report('perception.start', err); });
      return;
    }
    try {
      perception.setProfile(next);
    } catch (err) {
      report('perception.setProfile', err);
    }
  };

  // Mode → profile. Nobody passes mode by hand (01 §1).
  applyMode(store.getState().mode);
  unsubs.push(store.subscribe((s, prev) => {
    if (s.mode !== prev.mode) applyMode(s.mode);
    if (s.bodyOffsetDeg !== prev.bodyOffsetDeg) {
      try {
        perception.setBodyOffsetDeg(s.bodyOffsetDeg);
      } catch (err) {
        report('perception.setBodyOffsetDeg', err);
      }
    }
  }));
  try {
    perception.setBodyOffsetDeg(store.getState().bodyOffsetDeg);
  } catch (err) {
    report('perception.setBodyOffsetDeg', err);
  }

  // --- Reflex 1: vehicle. STOP, then one CRITICAL phrase, then the bus. No await.
  unsubs.push(perception.onVehicleApproaching((e: { direction: Direction; trackId: number; growth: number }) => {
    haptics.play('STOP');
    speech.say({
      text: vehicleText(e.direction),
      priority: 'CRITICAL',
      cacheKey: vehicleCacheKey(e.direction),
      interrupt: true,
      dedupeKey: `vehicle-${e.direction}`,
      cooldownMs: VEHICLE_SPEECH_COOLDOWN_MS,
    });
    bus.emit({ type: 'VEHICLE_APPROACHING', direction: e.direction, trackId: e.trackId });
  }));

  // --- Reflex 2: obstacle. NEAR + closing → STOP; phrase only where policy allows it.
  let lastObstacleLine: string | null = null;
  unsubs.push(perception.onDepth((d: DepthSummary) => {
    lastDepth = d;
  }));
  unsubs.push(perception.onObstacleAhead((e: { distanceClass: DistanceClass; direction: Direction }) => {
    let reflex = obstacleReflexFor(profile, e, lastDepth, store.getState().mode);
    if (reflex === 'STOP_AND_SPEAK' && opts.suppressObstacle?.(e)) reflex = 'NONE';
    if (reflex !== 'NONE') haptics.play('STOP');
    if (reflex === 'STOP_AND_SPEAK') {
      const described = opts.describeObstacle?.(e) ?? null;
      // The same words again within eight seconds are noise; a different thing in the way is news.
      const cooldownMs = described && described === lastObstacleLine ? 8000 : 4000;
      lastObstacleLine = described;
      speech.say(described
        ? { text: described, priority: 'CRITICAL', hazardClass: 'obstacle', interrupt: true, dedupeKey: 'obstacle-near', cooldownMs }
        : { text: 'Obstacle ahead.', priority: 'CRITICAL', cacheKey: 'obstacle_ahead', interrupt: true, dedupeKey: 'obstacle-near', cooldownMs });
    }
    bus.emit({ type: 'OBSTACLE_AHEAD', distanceClass: e.distanceClass, direction: e.direction });
  }));

  // --- Bookkeeping re-broadcasts (B's CrossingController reads SIGNAL_STATE; DebugPanel reads all).
  unsubs.push(perception.onSignalState((e: { state: SignalState; fresh: boolean; confidence: number; nOfM: number }) => {
    bus.emit({ type: 'SIGNAL_STATE', state: e.state, fresh: e.fresh, confidence: e.confidence });
  }));
  unsubs.push(perception.onHazard((e: { kind: HazardKind; direction: Direction }) => {
    bus.emit({ type: 'HAZARD', kind: e.kind, direction: e.direction });
  }));

  // Empty arrays are heartbeats too: no objects is not a failed detector.
  unsubs.push(perception.onDetections(() => { lastDetectionsAt = Date.now(); recoveries = 0; }));
  const healthTimer = opts.healthIntervalMs ? setInterval(() => {
    if (disposed || recovering || profile === 'IDLE') return;
    if (opts.isForeground?.() === false) { lastDetectionsAt = Date.now(); return; }
    const age = Date.now() - lastDetectionsAt;
    opts.onHealth?.({ detectionAgeMs: age, recoveries, profile, stats: perception.getStats(), native: perception.debugLog?.() ?? [] });
    if (age < 15_000 || recoveries >= 2) return;
    recoveries += 1;
    recovering = true;
    lastDetectionsAt = Date.now();
    report('perception.recovery', new Error('Detector events stopped. Restarting the camera pipeline.'));
    try {
      perception.stop();
      void perception.start(profile).then(() => { started = true; })
        .catch((err: unknown) => { started = false; report('perception.restart', err); })
        .finally(() => { recovering = false; if (disposed) perception.stop(); });
    } catch (err) { recovering = false; report('perception.restart', err); }
  }, opts.healthIntervalMs) : null;

  return {
    getProfile: () => profile,
    getLastDepth: () => lastDepth,
    dispose() {
      disposed = true;
      if (healthTimer !== null) clearInterval(healthTimer);
      for (const u of unsubs.splice(0)) u();
      if (started) {
        started = false;
        try {
          perception.stop();
        } catch (err) {
          report('perception.stop', err);
        }
      }
    },
  };
}

/** Canonical text for the three vehicle cache keys (07 §2 wording; the file is what plays). */
export function vehicleText(direction: Direction): string {
  switch (direction) {
    case 'LEFT': return 'Vehicle left.';
    case 'RIGHT': return 'Vehicle right.';
    default: return 'Vehicle ahead.';
  }
}

// Re-exported for consumers that only want the facts feed shapes.
export type { Detection, OcrRead, Pose };
