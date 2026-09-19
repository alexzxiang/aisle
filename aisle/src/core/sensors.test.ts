import type { GeoFix, HeadingSample, PerceptionService, Pose, TrackingState } from './contracts';
import { createAppStore, type AppStore } from './store';
import {
  CALIBRATION_MAX_SPREAD_DEG,
  CrossTrackEstimator,
  GPS_ANCHOR_MAX_ACCURACY_M,
  HeadingFuser,
  LATERAL_FRESH_MS,
  OFFSET_HOLD_MS,
  STRIDE_M,
  StepRing,
  bodyOffsetFrom,
  createSensorService,
  toCompassAccuracy,
  type SensorSources,
} from './sensors';

const H = (trueHeadingDeg: number, accuracy: 0 | 1 | 2 | 3, timestamp: number): HeadingSample => ({ trueHeadingDeg, accuracy, timestamp });
const P = (yawDeg: number, timestamp: number, trackingState: TrackingState = 'NORMAL'): Pose => ({ yawDeg, x: 0, y: 0, z: 0, trackingState, timestamp });
const FIX = (over: Partial<GeoFix> = {}): GeoFix => ({ lat: 40.4443, lng: -79.9560, accuracyM: 5, courseDeg: null, speedMps: null, timestamp: 0, ...over });

// ---------------------------------------------------------------------------
// HeadingFuser
// ---------------------------------------------------------------------------

describe('HeadingFuser', () => {
  it('is null with nothing, compass-only with a good compass, null with a bad compass alone', () => {
    const f = new HeadingFuser();
    expect(f.fused(0)).toBeNull();
    f.pushHeading(H(90, 3, 0));
    expect(f.fused(0)).toEqual({ deg: 90, accuracy: 3, source: 'compass' });
    f.pushHeading(H(90, 1, 100));
    expect(f.fused(100)).toBeNull();
  });

  it('fuses ARKit yaw with the circular-mean compass offset while tracking is NORMAL', () => {
    const f = new HeadingFuser();
    // Compass reads 100, ARKit yaw reads 95 → offset +5.
    for (let t = 0; t < 3000; t += 100) {
      f.pushPose(P(95, t));
      f.pushHeading(H(100, 3, t));
    }
    const fused = f.fused(3000);
    expect(fused).not.toBeNull();
    expect(fused!.source).toBe('fused');
    expect(fused!.deg).toBeCloseTo(100, 6);
    expect(fused!.accuracy).toBe(3);
    // The pose now turns 40° while the compass lags (no fresh compass sample to pair): fused follows the pose.
    f.pushPose(P(135, 3400));
    expect(f.fused(3400)!.deg).toBeCloseTo(140, 6);
  });

  it('inherits the worst compass tier in the offset window', () => {
    const f = new HeadingFuser();
    for (let t = 0; t < 2000; t += 100) {
      f.pushPose(P(0, t));
      f.pushHeading(H(2, t < 500 ? 2 : 3, t));
    }
    expect(f.fused(2000)!.accuracy).toBe(2);
  });

  it('falls back to gated trueHeading when tracking is not NORMAL', () => {
    const f = new HeadingFuser();
    for (let t = 0; t < 2000; t += 100) {
      f.pushPose(P(10, t));
      f.pushHeading(H(15, 3, t));
    }
    f.pushPose(P(200, 2100, 'LIMITED'));
    f.pushHeading(H(15, 3, 2100));
    expect(f.fused(2100)).toEqual({ deg: 15, accuracy: 3, source: 'compass' });
  });

  it('holds yaw + last offset for ≤ 30 s when the compass drops below tier 2, then null', () => {
    const f = new HeadingFuser();
    for (let t = 0; t < 2000; t += 100) {
      f.pushPose(P(0, t));
      f.pushHeading(H(10, 3, t));
    }
    f.pushHeading(H(300, 1, 2100));            // compass goes bad
    f.pushPose(P(30, 2100));
    const hold = f.fused(2100);
    expect(hold).toEqual({ deg: 40, accuracy: 3, source: 'pose_hold' });
    f.pushPose(P(30, 1900 + OFFSET_HOLD_MS + 200));
    expect(f.fused(1900 + OFFSET_HOLD_MS + 200)).toBeNull();
  });

  it('pose must be fresh (≤ 500 ms) to be used', () => {
    const f = new HeadingFuser();
    for (let t = 0; t < 2000; t += 100) {
      f.pushPose(P(0, t));
      f.pushHeading(H(10, 3, t));
    }
    f.pushHeading(H(50, 3, 5000));
    expect(f.fused(5000)).toEqual({ deg: 50, accuracy: 3, source: 'compass' });
  });

  it('subtracts the body offset in both paths', () => {
    const f = new HeadingFuser();
    f.setBodyOffsetDeg(20);                    // phone points 20° right of travel
    f.pushHeading(H(100, 3, 0));
    expect(f.fused(0)!.deg).toBe(80);
    for (let t = 0; t < 2000; t += 100) {
      f.pushPose(P(95, t));
      f.pushHeading(H(100, 3, t));
    }
    expect(f.fused(2000)!.deg).toBeCloseTo(80, 6);
    expect(f.getBodyOffsetDeg()).toBe(20);
    f.setBodyOffsetDeg(NaN);
    expect(f.getBodyOffsetDeg()).toBe(0);
  });

  it('averages the offset across the north wrap', () => {
    const f = new HeadingFuser();
    for (let t = 0; t < 2000; t += 100) {
      f.pushPose(P(358, t));
      f.pushHeading(H(t % 200 === 0 ? 1 : 359, 3, t));   // compass jitters around north
    }
    expect(f.fused(2000)!.deg).toBeCloseTo(0, 0);
  });
});

// ---------------------------------------------------------------------------
// bodyOffsetFrom, StepRing, toCompassAccuracy
// ---------------------------------------------------------------------------

describe('bodyOffsetFrom', () => {
  it('returns the mean phone-minus-course offset with ok on a tight walk', () => {
    const r = bodyOffsetFrom([
      { trueHeadingDeg: 105, courseDeg: 90 }, { trueHeadingDeg: 103, courseDeg: 90 },
      { trueHeadingDeg: 107, courseDeg: 92 }, { trueHeadingDeg: 104, courseDeg: 89 },
    ]);
    expect(r.ok).toBe(true);
    expect(r.offsetDeg).toBeCloseTo(14.5, 0);
    expect(r.spreadDeg).toBeLessThan(CALIBRATION_MAX_SPREAD_DEG);
  });

  it('is not ok with too few samples or a wide spread', () => {
    expect(bodyOffsetFrom([{ trueHeadingDeg: 100, courseDeg: 90 }, { trueHeadingDeg: 100, courseDeg: 90 }]).ok).toBe(false);
    const wide = bodyOffsetFrom([
      { trueHeadingDeg: 130, courseDeg: 90 }, { trueHeadingDeg: 60, courseDeg: 90 },
      { trueHeadingDeg: 120, courseDeg: 90 }, { trueHeadingDeg: 70, courseDeg: 90 },
    ]);
    expect(wide.ok).toBe(false);
    expect(bodyOffsetFrom([]).ok).toBe(false);
  });

  it('wraps: heading 5, course 355 is +10, not −350', () => {
    const r = bodyOffsetFrom([{ trueHeadingDeg: 5, courseDeg: 355 }, { trueHeadingDeg: 6, courseDeg: 356 }, { trueHeadingDeg: 4, courseDeg: 354 }]);
    expect(r.offsetDeg).toBeCloseTo(10, 6);
  });
});

describe('StepRing', () => {
  it('counts steps since a timestamp from a cumulative series', () => {
    const r = new StepRing(5);
    r.push(1000, 10); r.push(2000, 14); r.push(3000, 20); r.push(4000, 25);
    expect(r.latest()).toBe(25);
    expect(r.since(2000)).toBe(11);
    expect(r.since(2500)).toBe(11);
    expect(r.since(0)).toBe(15);        // before the ring: since the first sample
    expect(r.since(9000)).toBe(0);
    expect(new StepRing().since(0)).toBe(0);
  });

  it('is bounded', () => {
    const r = new StepRing(3);
    for (let i = 0; i < 10; i += 1) r.push(i * 1000, i);
    expect(r.since(0)).toBe(2);         // only the last three samples survive
  });
});

describe('toCompassAccuracy', () => {
  it('clamps expo-location tiers into 0..3', () => {
    expect(toCompassAccuracy(3)).toBe(3);
    expect(toCompassAccuracy(2.5)).toBe(2);
    expect(toCompassAccuracy(1)).toBe(1);
    expect(toCompassAccuracy(0)).toBe(0);
    expect(toCompassAccuracy(-1)).toBe(0);
    expect(toCompassAccuracy(7)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// CrossTrackEstimator
// ---------------------------------------------------------------------------

describe('CrossTrackEstimator', () => {
  const line = [{ lat: 40.4443, lng: -79.9560 }, { lat: 40.4443, lng: -79.9500 }]; // east

  it('prefers a fresh perception lateral offset (pose or curb) over everything', () => {
    const e = new CrossTrackEstimator(line);
    e.steps(0, 0); e.steps(10, 30);
    expect(e.estimate(1000, { offsetM: 0.3, source: 'pose', timestamp: 800 })).toEqual({ crossTrackM: 0.3, source: 'perception' });
    expect(e.estimate(1000, { offsetM: 0.3, source: 'curb', timestamp: 800 }).source).toBe('perception');
    expect(e.estimate(1000, { offsetM: 0.3, source: 'ocr_box', timestamp: 800 }).source).toBe('dr');
    expect(e.estimate(800 + LATERAL_FRESH_MS + 1, { offsetM: 0.3, source: 'pose', timestamp: 800 }).source).toBe('dr');
  });

  it('dead-reckons Σ sin(headingError) × stride per step', () => {
    const e = new CrossTrackEstimator(line);
    e.steps(100, 0);                     // first sample only sets the baseline
    e.steps(110, 30);                    // 10 steps at 30° right → 10 × 0.7 × 0.5 = 3.5 m right
    expect(e.estimate(0, null)).toEqual({ crossTrackM: expect.closeTo(10 * STRIDE_M * 0.5, 6), source: 'dr' });
    e.steps(120, -30);                   // walk back
    expect(e.estimate(0, null).crossTrackM).toBeCloseTo(0, 6);
    e.steps(115, 90);                    // a decreasing count is ignored
    expect(e.estimate(0, null).crossTrackM).toBeCloseTo(0, 6);
  });

  it('re-anchors on GPS only when accuracy ≤ 10 m, and only with a line', () => {
    const e = new CrossTrackEstimator(line);
    e.steps(0, 0); e.steps(10, 30);
    const south = FIX({ lat: 40.4443 - 0.00002, lng: -79.9530, accuracyM: 20, timestamp: 1000 }); // ~2.2 m right of the line
    e.fix(south);
    expect(e.estimate(0, null).source).toBe('dr');
    e.fix({ ...south, accuracyM: GPS_ANCHOR_MAX_ACCURACY_M, timestamp: 2000 });
    const anchored = e.estimate(0, null);
    expect(anchored.source).toBe('gps');
    expect(anchored.crossTrackM).toBeGreaterThan(2);
    expect(anchored.crossTrackM).toBeLessThan(2.5);
    // Steps keep accumulating from the anchor.
    e.steps(20, 30);
    expect(e.estimate(0, null).crossTrackM).toBeCloseTo(anchored.crossTrackM + 3.5, 6);
    // Same fix again (same timestamp) is not re-applied.
    e.fix({ ...south, accuracyM: 5, timestamp: 2000 });
    expect(e.estimate(0, null).crossTrackM).toBeCloseTo(anchored.crossTrackM + 3.5, 6);

    const noLine = new CrossTrackEstimator(undefined);
    noLine.fix({ ...south, accuracyM: 3 });
    expect(noLine.estimate(0, null).source).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// Service with scripted sources
// ---------------------------------------------------------------------------

function scriptedSources() {
  const sinks: { heading?: (h: HeadingSample) => void; fix?: (f: GeoFix) => void; steps?: (n: number) => void } = {};
  const unsub = { heading: 0, fix: 0, steps: 0 };
  const sources: SensorSources = {
    requestPermissions: async () => ({ location: true, motion: true }),
    watchHeading: async (cb) => { sinks.heading = cb; return () => { unsub.heading += 1; }; },
    watchPosition: async (cb) => { sinks.fix = cb; return () => { unsub.fix += 1; }; },
    watchSteps: async (cb) => { sinks.steps = cb; return () => { unsub.steps += 1; }; },
  };
  return { sources, sinks, unsub };
}

function fakePerception() {
  const poseCbs = new Set<(p: Pose) => void>();
  const trackCbs = new Set<(t: TrackingState) => void>();
  const latCbs = new Set<(e: { offsetM: number; source: 'pose' | 'ocr_box' | 'shelf' | 'curb' | 'none' }) => void>();
  const calls: string[] = [];
  const p = {
    onPose: (cb: (p: Pose) => void) => { poseCbs.add(cb); return () => poseCbs.delete(cb); },
    onTrackingState: (cb: (t: TrackingState) => void) => { trackCbs.add(cb); return () => trackCbs.delete(cb); },
    onLateralOffset: (cb: (e: { offsetM: number; source: 'pose' | 'ocr_box' | 'shelf' | 'curb' | 'none' }) => void) => { latCbs.add(cb); return () => latCbs.delete(cb); },
    setBodyOffsetDeg: (d: number) => { calls.push(`body:${d}`); },
    setCourseReference: (r: { bearingDeg: number } | null) => { calls.push(`ref:${r ? r.bearingDeg : 'null'}`); },
  } as unknown as PerceptionService;
  return {
    p, calls,
    emitPose: (pose: Pose) => poseCbs.forEach((cb) => cb(pose)),
    emitLateral: (offsetM: number, source: 'pose' | 'curb' | 'ocr_box') => latCbs.forEach((cb) => cb({ offsetM, source })),
  };
}

describe('createSensorService', () => {
  let store: AppStore;
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(100_000);
    store = createAppStore({ warn: () => {} });
  });
  afterEach(() => jest.useRealTimers());

  it('starts the watchers once, republishes samples, and mirrors heading/fix into the store', async () => {
    const { sources, sinks, unsub } = scriptedSources();
    const svc = createSensorService({ sources, store });
    await svc.start();
    await svc.start();
    const headings: HeadingSample[] = [];
    const fixes: GeoFix[] = [];
    const steps: number[] = [];
    svc.subscribeHeading((h) => headings.push(h));
    svc.subscribeLocation((f) => fixes.push(f));
    svc.subscribeSteps((n) => steps.push(n));

    sinks.heading!(H(45, 3, Date.now()));
    sinks.fix!(FIX({ timestamp: Date.now() }));
    sinks.steps!(12);
    expect(headings).toHaveLength(1);
    expect(fixes).toHaveLength(1);
    expect(steps).toEqual([12]);
    expect(svc.getHeading()!.trueHeadingDeg).toBe(45);
    expect(svc.getFusedHeadingDeg()).toBe(45);
    expect(svc.getLastFix()!.accuracyM).toBe(5);
    expect(store.getState().heading!.trueHeadingDeg).toBe(45);
    expect(store.getState().lastFix!.lat).toBe(40.4443);
    expect(svc.getStepsSince(0)).toBe(0);           // first sample is the baseline
    jest.setSystemTime(101_000);
    sinks.steps!(20);
    expect(svc.getStepsSince(100_500)).toBe(8);
    svc.stop();
    expect(unsub).toEqual({ heading: 1, fix: 1, steps: 1 });
  });

  it('courseErrorFor: heading error from the fused heading, compass tier passed through, roadSide passed through', async () => {
    const { sources, sinks } = scriptedSources();
    const svc = createSensorService({ sources, store });
    await svc.start();
    sinks.heading!(H(120, 3, Date.now()));
    const get = svc.courseErrorFor({ bearingDeg: 90, roadSide: 'RIGHT' });
    expect(get()).toEqual({ headingErrorDeg: 30, crossTrackM: 0, roadSide: 'RIGHT', compassAccuracy: 3 });
    sinks.heading!(H(70, 2, Date.now()));
    expect(get()).toMatchObject({ headingErrorDeg: -20, compassAccuracy: 2 });
    sinks.heading!(H(70, 1, Date.now()));
    expect(get().compassAccuracy).toBe(1);          // the COURSE rule then stays silent
    expect(svc.getDebugState().lastCourseError!.crossTrackSource).toBe('none');
  });

  it('courseErrorFor uses C’s lateral offset when fresh, dead reckoning otherwise, and sets C’s course reference', async () => {
    const { sources, sinks } = scriptedSources();
    const per = fakePerception();
    const svc = createSensorService({ sources, store, perception: per.p });
    await svc.start();
    expect(per.calls).toContain('body:0');
    sinks.heading!(H(120, 3, Date.now()));
    sinks.steps!(0);
    const get = svc.courseErrorFor({ bearingDeg: 90, roadSide: 'NONE' });
    expect(per.calls).toContain('ref:90');
    get();                                                             // baseline steps
    sinks.steps!(10);                                                  // 10 steps at +30°
    // Dead reckoning is tracked for the DebugPanel but never fed to the roadward rule (01 §2: buzz fatigue).
    expect(get().crossTrackM).toBe(0);
    expect(svc.getDebugState().lastCourseError!.crossTrackSource).toBe('dr');
    expect(svc.getDebugState().lastCourseError!.rawCrossTrackM).toBeCloseTo(10 * STRIDE_M * 0.5, 6);
    per.emitLateral(-0.4, 'pose');
    expect(get()).toMatchObject({ crossTrackM: -0.4 });
    expect(svc.getDebugState().lastCourseError!.crossTrackSource).toBe('perception');
    jest.setSystemTime(Date.now() + LATERAL_FRESH_MS + 1);
    expect(svc.getDebugState().lastCourseError!.crossTrackSource).toBe('perception'); // debug state is from the last call
    expect(get().crossTrackM).toBe(0);                                 // stale → back to dead reckoning → not trusted
    expect(svc.getDebugState().lastCourseError!.crossTrackSource).toBe('dr');
    expect(svc.getDebugState().lastCourseError!.rawCrossTrackM).toBeCloseTo(3.5, 6);
  });

  it('re-emits pose from the perception service and fuses it', async () => {
    const { sources, sinks } = scriptedSources();
    const per = fakePerception();
    const svc = createSensorService({ sources, store });
    svc.attachPerception(per.p);
    svc.attachPerception(per.p);                                        // idempotent
    await svc.start();
    const poses: Pose[] = [];
    svc.subscribePose((p) => poses.push(p));
    for (let i = 0; i < 20; i += 1) {
      const t = Date.now();
      sinks.heading!(H(100, 3, t));
      per.emitPose(P(95, t));
      jest.setSystemTime(t + 100);
    }
    expect(poses).toHaveLength(20);
    expect(svc.getTrackingState()).toBe('NORMAL');
    const fused = svc.getFusedHeading();
    expect(fused!.source).toBe('fused');
    expect(fused!.deg).toBeCloseTo(100, 6);
  });

  it('calibrateBodyOffset: walk straight for five seconds → offset applied to store, fuser and C', async () => {
    const { sources, sinks } = scriptedSources();
    const per = fakePerception();
    const svc = createSensorService({ sources, store, perception: per.p, calibrationWindowMs: 5000 });
    await svc.start();
    const done = svc.calibrateBodyOffset();
    // Phone points 12° right of the direction of travel; walking east at 1.2 m/s.
    for (let i = 0; i < 5; i += 1) {
      const t = Date.now();
      sinks.heading!(H(102 + (i % 2), 3, t));
      sinks.fix!(FIX({ courseDeg: 90, speedMps: 1.2, timestamp: t }));
      jest.advanceTimersByTime(1000);
    }
    const r = await done;
    expect(r.ok).toBe(true);
    expect(r.offsetDeg).toBeCloseTo(12.4, 0);
    expect(store.getState().bodyOffsetDeg).toBeCloseTo(r.offsetDeg, 6);
    expect(svc.getBodyOffsetDeg()).toBeCloseTo(r.offsetDeg, 6);
    expect(per.calls[per.calls.length - 1]).toBe(`body:${r.offsetDeg}`);
    // Now the fused heading is body-frame.
    sinks.heading!(H(102, 3, Date.now()));
    expect(svc.getFusedHeadingDeg()).toBeCloseTo(102 - r.offsetDeg, 6);
  });

  it('calibrateBodyOffset is not ok while standing still or with a bad compass, and leaves the offset alone', async () => {
    const { sources, sinks } = scriptedSources();
    const svc = createSensorService({ sources, store, calibrationWindowMs: 2000 });
    await svc.start();
    store.getState().setBodyOffsetDeg(7);
    const done = svc.calibrateBodyOffset();
    sinks.heading!(H(100, 3, Date.now()));
    sinks.fix!(FIX({ courseDeg: null, speedMps: 0.1, timestamp: Date.now() }));
    sinks.heading!(H(100, 1, Date.now()));
    sinks.fix!(FIX({ courseDeg: 90, speedMps: 1.2, timestamp: Date.now() }));
    jest.advanceTimersByTime(2000);
    const r = await done;
    expect(r.ok).toBe(false);
    expect(store.getState().bodyOffsetDeg).toBe(7);
  });

  it('flags re-calibration when GPS course and fused heading disagree > 10° for > 10 s while walking', async () => {
    const { sources, sinks } = scriptedSources();
    const svc = createSensorService({ sources, store });
    await svc.start();
    let t = Date.now();
    for (let i = 0; i <= 12; i += 1) {
      sinks.heading!(H(120, 3, t));
      sinks.fix!(FIX({ courseDeg: 90, speedMps: 1.2, timestamp: t }));
      t += 1000;
      jest.setSystemTime(t);
    }
    expect(svc.needsRecalibration()).toBe(true);
    // Agreement resets the watch on the next fix; calibration clears the flag.
    sinks.heading!(H(92, 3, t));
    sinks.fix!(FIX({ courseDeg: 90, speedMps: 1.2, timestamp: t }));
    expect(svc.needsRecalibration()).toBe(true);
    const done = svc.calibrateBodyOffset();
    for (let i = 0; i < 5; i += 1) {
      sinks.heading!(H(92, 3, Date.now()));
      sinks.fix!(FIX({ courseDeg: 90, speedMps: 1.2, timestamp: Date.now() }));
      jest.advanceTimersByTime(1000);
    }
    await done;
    expect(svc.needsRecalibration()).toBe(false);
  });

  it('survives denied permissions and a throwing subscriber', async () => {
    const { sources, sinks } = scriptedSources();
    sources.requestPermissions = async () => ({ location: true, motion: false });
    const svc = createSensorService({ sources, store });
    await svc.start();
    expect(sinks.steps).toBeUndefined();
    const seen: number[] = [];
    svc.subscribeHeading(() => { throw new Error('boom'); });
    svc.subscribeHeading((h) => seen.push(h.trueHeadingDeg));
    sinks.heading!(H(10, 3, Date.now()));
    expect(seen).toEqual([10]);
  });
});
