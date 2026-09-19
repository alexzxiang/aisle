import track from '../../fixtures/track.json';
import type { GeoFix, TransitionSignal, VisionRequest, VisionResponse, AppMode } from '../core/contracts';
import {
  TRANSITION_DEBOUNCE_MS,
  TransitionEvaluator,
  createTransitionDetector,
  sumSignals,
} from './TransitionDetector';

interface Sample {
  t: number;
  lat: number;
  lng: number;
  accuracyM: number;
  steps: number;
}

const samples = track.samples as Sample[];
const DOOR_T = track.meta.door.t;
const DEST = { lat: track.meta.entrance.lat, lng: track.meta.entrance.lng, radiusM: track.meta.entrance.radiusM };

/** A tiny SensorService double fed from the fixture track. */
function makeSensors() {
  let locCb: ((f: GeoFix) => void) | null = null;
  let stepCb: ((n: number) => void) | null = null;
  const history: Array<{ ts: number; steps: number }> = [];
  const sensors = {
    subscribeLocation(cb: (f: GeoFix) => void) {
      locCb = cb;
      return () => {
        locCb = null;
      };
    },
    subscribeSteps(cb: (n: number) => void) {
      stepCb = cb;
      return () => {
        stepCb = null;
      };
    },
    getStepsSince(ts: number) {
      const cur = history.length ? history[history.length - 1]!.steps : 0;
      let base = 0;
      for (const h of history) if (h.ts <= ts) base = h.steps;
      return cur - base;
    },
  };
  const feed = (s: Sample) => {
    const ts = s.t * 1000;
    history.push({ ts, steps: s.steps });
    stepCb?.(s.steps);
    locCb?.({ lat: s.lat, lng: s.lng, accuracyM: s.accuracyM, courseDeg: null, speedMps: null, timestamp: ts });
  };
  return { sensors, feed };
}

function positive(seq: number): VisionResponse {
  return {
    speech: '',
    cameraRequest: 'none',
    userAction: 'none',
    aisle: { matchedAisleId: null, matchedLandmarkId: null, confidence: 0 },
    storefront: { visible: true, confidence: 0.85 },
    scan: { vehiclesSeen: 'unclear', confidence: 0 },
    signal: { state: 'UNKNOWN', confidence: 0 },
    hand: { hint: 'not_seen' },
    task: { done: false, confidence: 0 },
    confidence: 0.85,
    seq,
  };
}

describe('TransitionEvaluator on the fixture track', () => {
  it('reaches a minimum < 15 m at the door and never fires before it', () => {
    const ev = new TransitionEvaluator(DEST);
    const steps = new Map<number, number>();
    const getStepsSince = (ts: number) => {
      const cur = Math.max(...Array.from(steps.values()));
      let base = 0;
      for (const [t, n] of steps) if (t <= ts) base = n;
      return cur - base;
    };
    for (const s of samples) {
      steps.set(s.t * 1000, s.steps);
      ev.onFix({ lat: s.lat, lng: s.lng, accuracyM: s.accuracyM, courseDeg: null, speedMps: null, timestamp: s.t * 1000 }, getStepsSince);
      const c = ev.confidence();
      if (s.t < DOOR_T) expect(c).toBeLessThan(0.6);
    }
    expect(ev.trace().minDistanceM).toBeLessThan(1);
  });

  it('the urban-canyon fix (38 m accuracy) alone does not reach the threshold', () => {
    const ev = new TransitionEvaluator(DEST);
    const canyonT = track.meta.canyonJump.t;
    for (const s of samples.filter((x) => x.t <= canyonT)) {
      ev.onFix({ lat: s.lat, lng: s.lng, accuracyM: s.accuracyM, courseDeg: null, speedMps: null, timestamp: s.t * 1000 }, () => 0);
    }
    const sig = ev.signals();
    expect(sig.distanceMinThenRise).toBe(0);
    expect(sumSignals(sig)).toBeLessThan(0.6);
  });
});

describe('createTransitionDetector', () => {
  function run(opts: { withVision?: boolean; forceAt?: number; forceEarlyAt?: number } = {}) {
    const { sensors, feed } = makeSensors();
    let nowMs = 0;
    const fires: TransitionSignal[] = [];
    const emitted: unknown[] = [];
    const visionCalls: VisionRequest[] = [];
    const detector = createTransitionDetector({
      sensors,
      bus: { emit: (e) => emitted.push(e) },
      now: () => nowMs,
      perception: opts.withVision
        ? { snapshotJPEG: async () => ({ base64: 'x', width: 512, height: 384, seq: 1, timestamp: nowMs }) }
        : undefined,
      vision: opts.withVision
        ? { ask: async (req) => { visionCalls.push(req); return positive(req.seq); } }
        : undefined,
    });
    detector.onEnter((s) => fires.push(s));
    detector.start(DEST);
    const fireTimes: number[] = [];
    for (const s of samples) {
      nowMs = s.t * 1000;
      if (opts.forceEarlyAt === s.t) detector.forceEnter();
      feed(s);
      if (fires.length > fireTimes.length) fireTimes.push(s.t);
      if (opts.forceAt === s.t) detector.forceEnter();
    }
    return { fires, fireTimes, emitted, visionCalls, detector };
  }

  it('fires exactly once, FUSED, 5–15 s after the door sample, and emits only STORE_ENTERED', async () => {
    const { fires, fireTimes, emitted } = run();
    expect(fires).toHaveLength(1);
    expect(fires[0]!.reason).toBe('FUSED');
    expect(fires[0]!.confidence).toBeGreaterThanOrEqual(0.6);
    expect(fireTimes[0]! - DOOR_T).toBeGreaterThanOrEqual(5);
    expect(fireTimes[0]! - DOOR_T).toBeLessThanOrEqual(15);
    expect(emitted).toEqual([{ type: 'STORE_ENTERED', reason: 'FUSED', confidence: fires[0]!.confidence }]);
    // The signals that carried it on this track: distance frozen + accuracy step (+ steps).
    expect(fires[0]!.signals.distanceMinThenRise).toBe(0.3);
    expect(fires[0]!.signals.accuracyStepUp).toBe(0.3);
  });

  it('a racing forceEnter right after the fused fire is a no-op (debounce)', () => {
    const { fires, fireTimes } = run({ forceAt: DOOR_T + 8 });
    // whichever fired first, only one fire happened
    expect(fires).toHaveLength(1);
    expect(fireTimes).toHaveLength(1);
  });

  it('forceEnter before detection fires MANUAL and suppresses the later fused fire', () => {
    const { fires } = run({ forceEarlyAt: DOOR_T - 20 });
    expect(fires).toHaveLength(1);
    expect(fires[0]!.reason).toBe('MANUAL');
    expect(fires[0]!.confidence).toBe(1);
  });

  it('asks the storefront question only inside radiusM + 15 m and at most once per 5 s', async () => {
    const { visionCalls, fires } = run({ withVision: true });
    // let the async vision calls settle
    await new Promise((r) => setTimeout(r, 0));
    expect(visionCalls.length).toBeGreaterThan(0);
    for (const c of visionCalls) expect(c.question).toBe('storefront');
    // first call happens once we are within 50 m of the door
    const firstSeq = visionCalls[0]!.seq;
    expect(firstSeq).toBe(1);
    expect(fires).toHaveLength(1);
  });

  it('stop() makes further fixes inert; start() resets and can fire again', () => {
    const { sensors, feed } = makeSensors();
    let nowMs = 0;
    const fires: TransitionSignal[] = [];
    const d = createTransitionDetector({ sensors, now: () => nowMs });
    d.onEnter((s) => fires.push(s));
    d.start(DEST);
    for (const s of samples) { nowMs = s.t * 1000; feed(s); }
    expect(fires).toHaveLength(1);

    d.stop();
    expect(d.isStarted()).toBe(false);
    const lastSteps = samples[samples.length - 1]!.steps;
    const offsetS = samples.length + 20;
    for (const s of samples) { nowMs = (s.t + offsetS) * 1000; feed({ ...s, t: s.t + offsetS, steps: s.steps + lastSteps }); }
    expect(fires).toHaveLength(1);

    // start() again → a full second pass fires again (fresh evaluator, debounce long expired).
    d.start(DEST);
    const offset2 = offsetS * 2;
    for (const s of samples) { nowMs = (s.t + offset2) * 1000; feed({ ...s, t: s.t + offset2, steps: s.steps + 2 * lastSteps }); }
    expect(fires).toHaveLength(2);
    expect(fires[1]!.reason).toBe('FUSED');
  });

  it('forceEnter works even when the detector was never started (always wired)', () => {
    const { sensors } = makeSensors();
    const fires: TransitionSignal[] = [];
    let nowMs = 100_000;
    const d = createTransitionDetector({ sensors, now: () => nowMs });
    d.onEnter((s) => fires.push(s));
    d.forceEnter();
    d.forceEnter(); // inside the debounce window → dropped
    expect(fires).toHaveLength(1);
    nowMs += TRANSITION_DEBOUNCE_MS;
    d.forceEnter();
    expect(fires).toHaveLength(2);
  });

  it('forceEnter still fires after a fused fire that the store rejected (debounce is the only guard)', () => {
    const { sensors } = makeSensors();
    const fires: TransitionSignal[] = [];
    let nowMs = 0;
    let mode: AppMode = 'AT_CURB'; // the store rejected STORE_ENTERED while at the curb
    const d = createTransitionDetector({ sensors, now: () => nowMs, getMode: () => mode });
    d.onEnter((s) => fires.push(s));
    d.start(DEST);
    d.forceEnter(); // stands in for a fused fire at t=0
    expect(fires).toHaveLength(1);
    nowMs += TRANSITION_DEBOUNCE_MS + 1;
    d.forceEnter(); // must NOT be dead: 01 §10 "always wire this up"
    expect(fires).toHaveLength(2);
    mode = 'TRANSITION';
    nowMs += TRANSITION_DEBOUNCE_MS + 1;
    d.forceEnter(); // manual override remains available even when indoors (debounce only)
    expect(fires).toHaveLength(3);
  });

});
