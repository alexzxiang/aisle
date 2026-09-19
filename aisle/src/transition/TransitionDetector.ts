/**
 * TransitionDetector — the store-entry handoff (01 §10, 05 Part 3).
 *
 * Five-signal fusion, fixed weights, fire once per start() at confidence ≥ 0.6,
 * 10 s debounce during which a racing forceEnter() is a no-op. The detector emits
 * `STORE_ENTERED { reason, confidence }` on the bus and nothing else; A's store
 * moves the mode to TRANSITION and everything downstream follows the store.
 *
 * | signal              | condition                                                                 | weight |
 * | distanceMinThenRise | min distance < 15 m, then risen ≥ 5 m or frozen (no fix moved > 3 m, 6 s) | 0.3    |
 * | accuracyStepUp      | accuracyM ≥ 2× the min-distance fix's accuracy, or > 30 m, after the min  | 0.3    |
 * | stepsSinceMin       | getStepsSince(minFixTimestamp) ≥ 15                                        | 0.2    |
 * | storefrontFrame     | one Tier-1 storefront positive, ≤ 1 call / 5 s, only inside radiusM + 15  | 0.2    |
 * | ambientLight        | Android only; iOS has no sensor → 0                                        | bonus  |
 *
 * iOS holds 5–10 m for seconds after the door and then snaps to ~65 m, so the live
 * announcement lands 5–15 s after entry. The weights are not tuned to make the
 * fixture feel snappy (05 Part 3).
 *
 * The pure evaluator (`TransitionEvaluator`) is separated from the wiring
 * (`createTransitionDetector`) so the fusion is unit-tested on the fixture track
 * without timers or services.
 */
import type {
  AppMode,
  Detection,
  EventBus,
  GeoFix,
  PerceptionService,
  SensorService,
  TransitionDetector,
  TransitionSignal,
  TransitionSignals,
  VisionRequest,
  VisionResponse,
} from '../core/contracts';
import { haversineM, type LatLng } from './geo';

export const TRANSITION_WEIGHTS = Object.freeze({
  distanceMinThenRise: 0.3,
  accuracyStepUp: 0.3,
  stepsSinceMin: 0.2,
  storefrontFrame: 0.2,
});

export const TRANSITION_FIRE_AT = 0.6;
export const TRANSITION_DEBOUNCE_MS = 10_000;
export const MIN_DISTANCE_M = 15;
export const RISE_M = 5;
export const FREEZE_MOVE_M = 3;
export const FREEZE_MS = 6_000;
export const ACCURACY_FACTOR = 2;
export const ACCURACY_ABS_M = 30;
export const STEPS_SINCE_MIN = 15;
export const STOREFRONT_MIN_CONFIDENCE = 0.6;
export const STOREFRONT_CALL_INTERVAL_MS = 5_000;
export const STOREFRONT_CALL_MARGIN_M = 15;

export interface TransitionDest extends LatLng {
  radiusM: number;
}

export const ZERO_SIGNALS: Readonly<TransitionSignals> = Object.freeze({
  distanceMinThenRise: 0,
  accuracyStepUp: 0,
  stepsSinceMin: 0,
  storefrontFrame: 0,
  ambientLight: 0,
});

export function sumSignals(s: TransitionSignals): number {
  const sum = s.distanceMinThenRise + s.accuracyStepUp + s.stepsSinceMin + s.storefrontFrame + s.ambientLight;
  return Math.round(sum * 1000) / 1000;
}

/** Fix-derived facts the evaluator keeps between updates (exposed for DebugPanel). */
export interface TransitionTrace {
  distanceM: number | null;
  minDistanceM: number;
  minFixTimestamp: number | null;
  minFixAccuracyM: number | null;
  frozenForMs: number;
  stepsSinceMin: number;
  storefrontPositive: boolean;
  signals: TransitionSignals;
  confidence: number;
}

/**
 * Pure fusion. Feed it fixes, steps and storefront verdicts; read `signals()`.
 * It never fires by itself — the detector decides when to fire.
 */
export class TransitionEvaluator {
  private minDistanceM = Number.POSITIVE_INFINITY;
  private minFix: GeoFix | null = null;
  private freezeAnchor: GeoFix | null = null;
  private lastFix: GeoFix | null = null;
  private stepsSince = 0;
  private accuracyStepUp = false;
  private storefront = false;

  constructor(private readonly dest: TransitionDest) {}

  distanceTo(fix: LatLng): number {
    return haversineM(fix, this.dest);
  }

  /** `stepsSinceMinFix` is the caller's getStepsSince(minFixTimestamp) after this fix. */
  onFix(fix: GeoFix, getStepsSince: (ts: number) => number): void {
    const d = this.distanceTo(fix);

    // Freeze tracking: anchor moves whenever a fix lands > 3 m from it.
    if (!this.freezeAnchor || haversineM(fix, this.freezeAnchor) > FREEZE_MOVE_M) {
      this.freezeAnchor = fix;
    }

    if (d < this.minDistanceM) {
      this.minDistanceM = d;
      this.minFix = fix;
      // A new minimum restarts "after the minimum" bookkeeping.
      this.accuracyStepUp = false;
    } else if (this.minFix) {
      if (fix.accuracyM >= ACCURACY_FACTOR * this.minFix.accuracyM || fix.accuracyM > ACCURACY_ABS_M) {
        this.accuracyStepUp = true;
      }
    }

    this.lastFix = fix;
    this.stepsSince = this.minFix ? Math.max(0, getStepsSince(this.minFix.timestamp)) : 0;
  }

  /** Steps changed without a new fix (pedometer ticks faster than GPS indoors). */
  onSteps(getStepsSince: (ts: number) => number): void {
    if (this.minFix) this.stepsSince = Math.max(0, getStepsSince(this.minFix.timestamp));
  }

  onStorefront(positive: boolean): void {
    if (positive) this.storefront = true;
  }

  /** Whether the Tier-1 storefront question may be asked at this distance. */
  withinStorefrontRange(): boolean {
    if (!this.lastFix) return false;
    return this.distanceTo(this.lastFix) < this.dest.radiusM + STOREFRONT_CALL_MARGIN_M;
  }

  storefrontSeen(): boolean {
    return this.storefront;
  }

  private frozenForMs(): number {
    if (!this.lastFix || !this.freezeAnchor) return 0;
    return Math.max(0, this.lastFix.timestamp - this.freezeAnchor.timestamp);
  }

  signals(): TransitionSignals {
    const s: TransitionSignals = { ...ZERO_SIGNALS };
    if (!this.lastFix || !this.minFix) return s;

    const d = this.distanceTo(this.lastFix);
    const minReached = this.minDistanceM < MIN_DISTANCE_M;
    const risen = d - this.minDistanceM >= RISE_M;
    const frozen = this.frozenForMs() >= FREEZE_MS;
    if (minReached && (risen || frozen)) s.distanceMinThenRise = TRANSITION_WEIGHTS.distanceMinThenRise;
    if (this.accuracyStepUp) s.accuracyStepUp = TRANSITION_WEIGHTS.accuracyStepUp;
    if (this.stepsSince >= STEPS_SINCE_MIN) s.stepsSinceMin = TRANSITION_WEIGHTS.stepsSinceMin;
    if (this.storefront) s.storefrontFrame = TRANSITION_WEIGHTS.storefrontFrame;
    return s;
  }

  confidence(): number {
    return sumSignals(this.signals());
  }

  trace(): TransitionTrace {
    const signals = this.signals();
    return {
      distanceM: this.lastFix ? this.distanceTo(this.lastFix) : null,
      minDistanceM: this.minDistanceM,
      minFixTimestamp: this.minFix?.timestamp ?? null,
      minFixAccuracyM: this.minFix?.accuracyM ?? null,
      frozenForMs: this.frozenForMs(),
      stepsSinceMin: this.stepsSince,
      storefrontPositive: this.storefront,
      signals,
      confidence: sumSignals(signals),
    };
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export interface VisionAsk {
  ask(req: VisionRequest): Promise<VisionResponse>;
}

export interface TransitionDetectorDeps {
  sensors: Pick<SensorService, 'subscribeLocation' | 'getStepsSince'> & Partial<Pick<SensorService, 'subscribeSteps'>>;
  /** Snapshot + detections for the storefront question. Optional: without it the signal stays 0. */
  perception?: Pick<PerceptionService, 'snapshotJPEG'> & Partial<Pick<PerceptionService, 'onDetections'>>;
  /** Tier-1 client (C's SemanticVision or D's mock). Optional: fail closed to 0. */
  vision?: VisionAsk;
  /** When given, every fire emits STORE_ENTERED here — and nothing else. */
  bus?: Pick<EventBus, 'emit'>;
  /** Mode for the VisionRequest; defaults to OUTDOOR_NAV. */
  getMode?: () => AppMode;
  /** Seq source for VisionRequest (C's client may own the counter). */
  nextSeq?: () => number;
  now?: () => number;
  /** Debug hook: every evaluation, with the running trace. */
  onTrace?: (t: TransitionTrace) => void;
}

export interface TransitionDetectorDebug extends TransitionDetector {
  /** Last evaluator trace (DebugPanel: "last TransitionSignals with the running sum"). */
  trace(): TransitionTrace | null;
  isStarted(): boolean;
  hasFired(): boolean;
}

export function createTransitionDetector(deps: TransitionDetectorDeps): TransitionDetectorDebug {
  const now = deps.now ?? Date.now;
  let seqCounter = 0;
  const nextSeq = deps.nextSeq ?? (() => { seqCounter += 1; return seqCounter; });

  const listeners = new Set<(s: TransitionSignal) => void>();
  let evaluator: TransitionEvaluator | null = null;
  let started = false;
  let fired = false;
  let lastFireAt = Number.NEGATIVE_INFINITY;
  let lastVisionCallAt = Number.NEGATIVE_INFINITY;
  let visionInFlight = false;
  let lastDetections: Detection[] = [];
  const unsubs: Array<() => void> = [];

  const fire = (signal: TransitionSignal): void => {
    fired = true;
    lastFireAt = signal.detectedAt;
    deps.bus?.emit({ type: 'STORE_ENTERED', reason: signal.reason, confidence: signal.confidence });
    for (const cb of Array.from(listeners)) {
      try {
        cb(signal);
      } catch {
        // A throwing listener must not stop the handoff; nothing else to do here.
      }
    }
  };

  const withinDebounce = (): boolean => now() - lastFireAt < TRANSITION_DEBOUNCE_MS;

  const evaluate = (): void => {
    if (!evaluator || !started) return;
    const trace = evaluator.trace();
    deps.onTrace?.(trace);
    if (fired || withinDebounce()) return;
    if (trace.confidence >= TRANSITION_FIRE_AT) {
      fire({ reason: 'FUSED', confidence: trace.confidence, signals: trace.signals, detectedAt: now() });
    }
  };

  const maybeAskStorefront = (): void => {
    if (!evaluator || !started || fired) return;
    if (!deps.vision || !deps.perception) return;
    if (evaluator.storefrontSeen() || visionInFlight) return;
    if (!evaluator.withinStorefrontRange()) return;
    const t = now();
    if (t - lastVisionCallAt < STOREFRONT_CALL_INTERVAL_MS) return;
    lastVisionCallAt = t;
    visionInFlight = true;
    const ev = evaluator;
    const perception = deps.perception;
    const vision = deps.vision;
    void (async () => {
      try {
        const snap = await perception.snapshotJPEG(512);
        const res = await vision.ask({
          seq: nextSeq(),
          question: 'storefront',
          mode: deps.getMode?.() ?? 'OUTDOOR_NAV',
          image: { base64: snap.base64, width: snap.width, height: snap.height },
          facts: { detections: lastDetections, ocr: [] },
        });
        const positive = res.storefront.visible && res.storefront.confidence >= STOREFRONT_MIN_CONFIDENCE && res.confidence >= 0.5;
        if (ev === evaluator && started) {
          ev.onStorefront(positive);
          evaluate();
        }
      } catch {
        // Tier 1 fails closed: the signal simply stays 0.
      } finally {
        visionInFlight = false;
      }
    })();
  };

  const teardown = (): void => {
    for (const u of unsubs.splice(0)) u();
    evaluator = null;
    started = false;
    visionInFlight = false;
    lastDetections = [];
  };

  return {
    start(dest) {
      teardown();
      evaluator = new TransitionEvaluator(dest);
      started = true;
      fired = false;
      lastVisionCallAt = Number.NEGATIVE_INFINITY;

      unsubs.push(deps.sensors.subscribeLocation((fix) => {
        if (!evaluator) return;
        evaluator.onFix(fix, (ts) => deps.sensors.getStepsSince(ts));
        evaluate();
        maybeAskStorefront();
      }));
      if (deps.sensors.subscribeSteps) {
        unsubs.push(deps.sensors.subscribeSteps(() => {
          if (!evaluator) return;
          evaluator.onSteps((ts) => deps.sensors.getStepsSince(ts));
          evaluate();
        }));
      }
      if (deps.perception?.onDetections) {
        unsubs.push(deps.perception.onDetections((d) => {
          lastDetections = d;
        }));
      }
    },

    stop() {
      teardown();
    },

    onEnter(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },

    /** Manual override — always wired. A no-op inside the debounce window or after this start() fired. */
    forceEnter() {
      if (withinDebounce()) return;
      if (started && fired) return;
      const signals: TransitionSignals = { ...ZERO_SIGNALS };
      fire({ reason: 'MANUAL', confidence: 1, signals, detectedAt: now() });
    },

    trace() {
      return evaluator ? evaluator.trace() : null;
    },
    isStarted() {
      return started;
    },
    hasFired() {
      return fired;
    },
  };
}
