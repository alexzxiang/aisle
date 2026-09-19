/**
 * The two replayers against the real fixtures: sensors on fixtures/track.json,
 * perception on fixtures/perception/*.jsonl (including the hard cases), plus the
 * vision/planner replayers and the harness that ties them together.
 */
import type { AppEvent, Pose, SignalState } from '../src/core/contracts';
import { createReplayClock } from './clock';
import * as fx from './fixtures';
import { createMockServices } from './index';
import { createMockPerceptionService } from './perception';
import { createMockPlanner, emptyOutput } from './planner';
import { MAX_IN_FLIGHT, createMockSemanticVision } from './semanticVision';
import { CALIBRATION_REPLAY_MS, createMockSensorService } from './sensors';
import { MockNetworkError } from './types';
import { createNetworkGate } from './network';

// ---------------------------------------------------------------------------
// Sensors
// ---------------------------------------------------------------------------

function sensorsAt() {
  let wall = 0;
  const clock = createReplayClock({ wall: () => wall, playing: true });
  const s = createMockSensorService({ track: fx.track, clock, wall: () => wall });
  const advance = (ms: number) => {
    wall += ms;
    s.controls.tick();
  };
  return { s, clock, advance, wallNow: () => wall };
}

describe('mock SensorService on fixtures/track.json', () => {
  it('emits heading, location and steps in track order and exposes the last values', () => {
    const { s, advance } = sensorsAt();
    const fixes: number[] = [];
    const headings: number[] = [];
    let steps = -1;
    s.subscribeLocation((f) => fixes.push(f.lat));
    s.subscribeHeading((h) => headings.push(h.trueHeadingDeg));
    s.subscribeSteps((n) => { steps = n; });
    advance(0);
    advance(3000);
    expect(fixes.length).toBe(4);   // t=0,1,2,3
    expect(headings.length).toBe(4);
    expect(s.getLastFix()?.lat).toBe(fx.track.samples[3]!.lat);
    expect(s.getHeading()?.accuracy).toBe(3);
    expect(steps).toBe(fx.track.samples[3]!.steps);
    expect(s.controls.currentIndex()).toBe(3);
  });

  it('getStepsSince counts from the sample at or before the timestamp', () => {
    const { s, advance, wallNow } = sensorsAt();
    advance(0);
    advance(10_000);
    const mark = wallNow();
    const before = s.getStepsSince(mark);
    expect(before).toBe(0);
    advance(20_000);
    expect(s.getStepsSince(mark)).toBe(fx.track.samples[30]!.steps - fx.track.samples[10]!.steps);
  });

  it('reproduces the entry profile: min distance < 15 m at the door, then an accuracy step to ~65 m with compass accuracy 1', () => {
    const door = fx.track.meta!.door.t;
    const snapT = (fx.track.meta as { accuracySnap: { t: number } }).accuracySnap.t;
    const at = (t: number) => fx.track.samples.find((x) => x.t === t)!;
    expect(at(door).accuracyM).toBeLessThan(12);
    expect(at(snapT).accuracyM).toBeGreaterThanOrEqual(60);
    expect(at(snapT).heading.accuracy).toBeLessThanOrEqual(1);
    expect(at(snapT + 10).steps).toBeGreaterThan(at(door).steps + 15);
  });

  it('has the urban-canyon jump and the compass-accuracy-2 stretch', () => {
    const meta = fx.track.meta as { canyonJump: { t: number; accuracyM: number }; compassAccuracy2: { fromT: number; toT: number } };
    const jump = fx.track.samples.find((x) => x.t === meta.canyonJump.t)!;
    expect(jump.accuracyM).toBeGreaterThanOrEqual(35);
    const mid = fx.track.samples.find((x) => x.t === Math.round((meta.compassAccuracy2.fromT + meta.compassAccuracy2.toT) / 2))!;
    expect(mid.heading.accuracy).toBe(2);
  });

  it('courseErrorFor computes a real heading error and cross-track against the leg', () => {
    const { s, advance } = sensorsAt();
    advance(0);
    advance(5000);
    const leg = fx.track.meta!.legs![0]!;
    const get = s.courseErrorFor({ bearingDeg: leg.bearingDeg, line: [leg.from, leg.to], roadSide: leg.roadSide });
    const e = get();
    expect(Math.abs(e.headingErrorDeg)).toBeLessThan(15);
    expect(Math.abs(e.crossTrackM)).toBeLessThan(6);
    expect(e.roadSide).toBe(leg.roadSide);
    expect(e.compassAccuracy).toBe(3);
    // 90° off the leg bearing reads as a large signed error
    const off = s.courseErrorFor({ bearingDeg: (leg.bearingDeg + 90) % 360, roadSide: 'NONE' })();
    expect(off.headingErrorDeg).toBeLessThan(-60);
  });

  it('calibrateBodyOffset resolves {0, ok} after 5 s of replay', async () => {
    const { s, advance } = sensorsAt();
    advance(0);
    const p = s.calibrateBodyOffset();
    let settled = false;
    void p.then(() => { settled = true; });
    advance(CALIBRATION_REPLAY_MS - 100);
    await Promise.resolve();
    expect(settled).toBe(false);
    advance(200);
    await expect(p).resolves.toEqual({ offsetDeg: 0, ok: true });
  });

  it('scrub seeks and re-emits the sample at that second; jumpToPhase seeks to the phase spec', () => {
    const { s, advance } = sensorsAt();
    advance(0);
    const fixes: number[] = [];
    s.subscribeLocation((f) => fixes.push(f.lat));
    s.controls.scrub(100);
    expect(s.controls.currentIndex()).toBe(100);
    expect(fixes.at(-1)).toBe(fx.track.samples[100]!.lat);
    const seen: string[] = [];
    s.controls.onJump((phase, spec) => seen.push(`${phase}:${spec.pack}`));
    const spec = s.controls.jumpToPhase('AT_CURB');
    expect(spec?.t).toBe(fx.track.phases!.AT_CURB!.t);
    expect(seen).toEqual(['AT_CURB:curb-walk-onset']);
    expect(s.controls.getTimeS()).toBe(spec!.t);
  });

  it('re-emits pose from an attached source and fuses heading → pose when the compass is untrusted', () => {
    const { s, advance } = sensorsAt();
    let poseCb: ((p: Pose) => void) | null = null;
    s.attachPoseSource((cb) => { poseCb = cb; return () => undefined; });
    const poses: number[] = [];
    s.subscribePose((p) => poses.push(p.yawDeg));
    poseCb!({ yawDeg: 42, x: 0, y: 0, z: 0, trackingState: 'NORMAL', timestamp: 0 });
    expect(poses).toEqual([42]);
    s.controls.scrub(fx.track.meta!.door.t + 9); // compass accuracy 1 near the storefront
    advance(0);
    expect(s.getHeading()?.accuracy).toBeLessThan(2);
    expect(s.getFusedHeadingDeg()).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// Perception
// ---------------------------------------------------------------------------

function perceptionOn(pack: string) {
  let wall = 0;
  const clock = createReplayClock({ wall: () => wall, playing: true });
  const p = createMockPerceptionService({ packs: fx.perceptionPacks, clock, frames: fx.frames, wall: () => wall });
  const advance = (ms: number) => {
    wall += ms;
    p.tick();
  };
  return { p, clock, advance, arm: () => p.selectPack(pack, 0) };
}

describe('mock PerceptionService on fixtures/perception/*.jsonl', () => {
  it('lists the eight packs (plus the scan variant) and maps profiles to packs', async () => {
    const { p } = perceptionOn('outdoor-leg');
    expect(p.packNames().sort()).toEqual([
      'curb-flicker', 'curb-walk-already-on', 'curb-walk-onset', 'indoor-aisle-walk', 'indoor-hard-cases',
      'outdoor-leg', 'scan-unsignalized', 'scan-unsignalized-approach', 'vehicle-approach',
    ]);
    await p.start('INDOOR_NAV');
    expect(p.currentPack()).toBe('indoor-aisle-walk');
    p.setProfile('APPROACH_CROSSING');
    expect(p.currentPack()).toBe('curb-walk-onset');
    p.stop();
    expect(p.currentPack()).toBeNull();
    expect(p.getTrackingState()).toBe('NOT_AVAILABLE');
  });

  it('curb-walk-onset: UNKNOWN for 6 s, DONT_WALK, then exactly one WALK fresh:true, then COUNTDOWN and DONT_WALK', async () => {
    const { p, advance } = perceptionOn('curb-walk-onset');
    await p.start('APPROACH_CROSSING');
    const states: Array<{ t: number; state: SignalState; fresh: boolean }> = [];
    let now = 0;
    p.onSignalState((e) => states.push({ t: now, state: e.state, fresh: e.fresh }));
    for (let i = 0; i < 40; i += 1) { now += 1000; advance(1000); }
    const seq = states.map((s) => s.state).filter((s, i, a) => i === 0 || s !== a[i - 1]);
    expect(seq).toEqual(['UNKNOWN', 'DONT_WALK', 'WALK', 'COUNTDOWN', 'DONT_WALK']);
    expect(states.filter((s) => s.fresh)).toHaveLength(1);
    expect(states.find((s) => s.state === 'DONT_WALK')!.t).toBeGreaterThanOrEqual(6000);
    // heartbeats: never two identical states closer than 2 s
    for (let i = 1; i < states.length; i += 1) {
      if (states[i]!.state === states[i - 1]!.state) expect(states[i]!.t - states[i - 1]!.t).toBeGreaterThanOrEqual(2000);
    }
  });

  it('curb-walk-already-on: the first non-UNKNOWN state is WALK with fresh:false', async () => {
    const { p, advance } = perceptionOn('curb-walk-already-on');
    await p.start('APPROACH_CROSSING');
    p.selectPack('curb-walk-already-on', 0);
    const states: Array<{ state: SignalState; fresh: boolean }> = [];
    p.onSignalState((e) => states.push({ state: e.state, fresh: e.fresh }));
    for (let i = 0; i < 30; i += 1) advance(1000);
    const first = states.find((s) => s.state !== 'UNKNOWN');
    expect(first).toEqual({ state: 'WALK', fresh: false });
  });

  it('curb-flicker stays UNKNOWN for ≥ 10 s and reports a LIMITED tracking gap', async () => {
    const { p, advance } = perceptionOn('curb-flicker');
    await p.start('APPROACH_CROSSING');
    p.selectPack('curb-flicker', 0);
    const states: SignalState[] = [];
    const tracking: string[] = [];
    p.onSignalState((e) => states.push(e.state));
    p.onTrackingState((s) => tracking.push(s));
    for (let i = 0; i < 12; i += 1) advance(1000);
    expect(new Set(states)).toEqual(new Set(['UNKNOWN']));
    for (let i = 0; i < 40; i += 1) advance(1000);
    expect(tracking).toContain('LIMITED');
  });

  it('vehicle-approach: the parked track never fires; one RIGHT approach, then silence on that track for 4 s', async () => {
    const { p, advance } = perceptionOn('vehicle-approach');
    await p.start('CROSSING');
    const fires: Array<{ t: number; direction: string; trackId: number }> = [];
    let dets = 0;
    let now = 0;
    p.onVehicleApproaching((e) => fires.push({ t: now, direction: e.direction, trackId: e.trackId }));
    p.onDetections(() => { dets += 1; });
    for (let i = 0; i < 300; i += 1) { now += 100; advance(100); }
    expect(fires.length).toBeGreaterThanOrEqual(1);
    expect(fires[0]!.direction).toBe('RIGHT');
    expect(fires.some((f) => f.trackId === 7)).toBe(false);     // parked car, constant area
    for (let i = 1; i < fires.length; i += 1) {
      if (fires[i]!.trackId === fires[i - 1]!.trackId) expect(fires[i]!.t - fires[i - 1]!.t).toBeGreaterThanOrEqual(4000);
    }
    expect(dets).toBeLessThanOrEqual(5 * 30 + 1);                // ≤ 5 Hz
  });

  it('scan-unsignalized has no onVehicleApproaching; the variant fires during the right scan', async () => {
    for (const [pack, expectFire] of [['scan-unsignalized', false], ['scan-unsignalized-approach', true]] as const) {
      const { p, advance } = perceptionOn(pack);
      await p.start('APPROACH_CROSSING');
      p.selectPack(pack, 0);
      let fired = false;
      p.onVehicleApproaching(() => { fired = true; });
      for (let i = 0; i < 40; i += 1) advance(500);
      expect(fired).toBe(expectFire);
    }
  });

  it('indoor-aisle-walk: OCR reads at ≤ 3 Hz for aisles 1→3, one PERSON_AHEAD hazard, depth closing at the end', async () => {
    const { p, advance } = perceptionOn('indoor-aisle-walk');
    await p.start('INDOOR_NAV');
    const reads: string[] = [];
    const ocrTimes: number[] = [];
    let hazards = 0;
    let maxClosing = -1;
    let now = 0;
    p.onOcrText((r) => { ocrTimes.push(now); for (const x of r) reads.push(x.text); });
    p.onHazard((h) => { if (h.kind === 'PERSON_AHEAD') hazards += 1; });
    p.onDepth((d) => { maxClosing = Math.max(maxClosing, d.closingRate); });
    for (let i = 0; i < 600; i += 1) { now += 100; advance(100); }
    expect(reads.some((r) => /1 PRODUCE/.test(r))).toBe(true);
    expect(reads.some((r) => /3 DAIRY/.test(r))).toBe(true);
    expect(hazards).toBeGreaterThanOrEqual(1);
    expect(maxClosing).toBeGreaterThan(0);
    for (let i = 1; i < ocrTimes.length; i += 1) expect(ocrTimes[i]! - ocrTimes[i - 1]!).toBeGreaterThanOrEqual(300);
  });

  it('indoor-hard-cases: the near-miss read and the malformed line are both present; the malformed line is skipped, not fatal', async () => {
    const { p, advance } = perceptionOn('indoor-hard-cases');
    await p.start('INDOOR_NAV');
    p.selectPack('indoor-hard-cases', 0);
    const reads: string[] = [];
    p.onOcrText((r) => { for (const x of r) reads.push(x.text); });
    for (let i = 0; i < 80; i += 1) advance(1000);
    expect(reads).toContain('A1SLE 7Z');
    expect(reads.some((r) => r.includes('BROKEN'))).toBe(false);
    expect(p.debug().skippedLines).toBeGreaterThanOrEqual(1);
  });

  it('records the context setters for the DebugPanel without changing playback', async () => {
    const { p } = perceptionOn('outdoor-leg');
    await p.start('OUTDOOR_NAV');
    p.setCrossingBearing(180);
    p.setCourseReference({ bearingDeg: 117 });
    p.setBodyOffsetDeg(-4);
    p.setKnownSigns(['3', 'DAIRY']);
    const d = p.debug();
    expect(d.crossingBearingDeg).toBe(180);
    expect(d.courseReference).toEqual({ bearingDeg: 117 });
    expect(d.bodyOffsetDeg).toBe(-4);
    expect(d.knownSigns).toEqual(['3', 'DAIRY']);
    expect(d.pack).toBe('outdoor-leg');
  });

  it('forceSignalState overrides the pack, heartbeats at 0.5 Hz, and releases', async () => {
    const { p, advance } = perceptionOn('curb-walk-onset');
    await p.start('APPROACH_CROSSING');
    const states: SignalState[] = [];
    p.onSignalState((e) => states.push(e.state));
    p.forceSignalState('WALK', true);
    expect(states).toEqual(['WALK']);
    for (let i = 0; i < 5; i += 1) advance(1000);
    expect(new Set(states)).toEqual(new Set(['WALK']));
    expect(states.length).toBeGreaterThanOrEqual(3);
    p.forceSignalState(null);
    expect(p.debug().forcedSignal).toBeNull();
  });

  it('snapshotJPEG returns a fixture frame with a monotonic seq and real dimensions', async () => {
    const { p } = perceptionOn('outdoor-leg');
    const a = await p.snapshotJPEG(512);
    const b = await p.snapshotJPEG(512);
    expect(b.seq).toBe(a.seq + 1);
    expect(a.base64.length).toBeGreaterThan(100);
    expect(a.width).toBeGreaterThan(0);
    expect(p.getStats().thermalState).toMatch(/mock/);
  });
});

// ---------------------------------------------------------------------------
// Vision + planner replayers
// ---------------------------------------------------------------------------

describe('mock SemanticVision on fixtures/vision', () => {
  const make = () => createMockSemanticVision({ fixtures: fx.visionFixtures, latencyScale: 0 });
  const req = (question: Parameters<ReturnType<typeof make>['ask']>[0]['question'], seq: number) => ({
    seq, question, mode: 'OUTDOOR_NAV' as const, facts: { detections: [], ocr: [] },
  });

  it('carries the hard cases: low-confidence storefront, unclear scan, malformed body, stale seq, timeout', async () => {
    const v = make();
    const entries = fx.visionFixtures.storefront.entries;
    const low = entries.find((e) => e.response?.storefront && e.response.storefront.confidence <= 0.3);
    expect(low).toBeDefined();
    const unclear = fx.visionFixtures.scan_left.entries.find((e) => e.response?.scan?.vehiclesSeen === 'unclear');
    expect(unclear).toBeDefined();
    const malformed = Object.values(fx.visionFixtures).flatMap((f) => f.entries).find((e) => e.malformed);
    expect(malformed).toBeDefined();
    const stale = Object.values(fx.visionFixtures).flatMap((f) => f.entries).find((e) => typeof e.seq === 'number' && e.response?.seq !== undefined && e.response.seq < e.seq);
    expect(stale).toBeDefined();
    const timeout = Object.values(fx.visionFixtures).flatMap((f) => f.entries).find((e) => e.timeoutMs !== undefined);
    expect(timeout).toBeDefined();

    // Malformed → rejects like JSON.parse; stale → the fixture's lower seq comes back (caller must drop it).
    const malformedFile = Object.entries(fx.visionFixtures).find(([, f]) => f.entries.some((e) => e.malformed))!;
    await expect(v.ask(req(malformedFile[0] as never, malformed!.seq as number))).rejects.toThrow();
    const staleFile = Object.entries(fx.visionFixtures).find(([, f]) => f.entries.some((e) => e === stale))!;
    const r = await v.ask(req(staleFile[0] as never, stale!.seq as number));
    expect(r.seq).toBeLessThan(stale!.seq as number);
  });

  it('unknown seqs fall to "*" or { confidence: 0 }, the fourth in flight answers immediately, network-off rejects', async () => {
    const v = createMockSemanticVision({ fixtures: fx.visionFixtures, latencyScale: 1, network: createNetworkGate(true) });
    const none = await make().ask(req('free', 99_999));
    expect(none.confidence).toBeGreaterThanOrEqual(0);
    const slow = createMockSemanticVision({ fixtures: { storefront: { question: 'storefront', entries: [{ seq: '*', delayMs: 50, response: { confidence: 0.9 } }] } } });
    const inflight = [1, 2, 3].map((seq) => slow.ask(req('storefront', seq)));
    expect(slow.inFlight()).toBe(MAX_IN_FLIGHT);
    const fourth = await slow.ask(req('storefront', 4));
    expect(fourth.confidence).toBe(0);
    await Promise.all(inflight);
    const gate = createNetworkGate(false);
    const offline = createMockSemanticVision({ fixtures: fx.visionFixtures, network: gate, latencyScale: 0 });
    await expect(offline.ask(req('storefront', 1))).rejects.toBeInstanceOf(MockNetworkError);
    expect(v.calls()).toBe(0);
  });
});

describe('mock Planner on fixtures/plan', () => {
  it('parses clean and ASR-noisy transcripts, has one fallback:true reply, and answers unknown jobs with the template', async () => {
    const p = createMockPlanner({ fixtures: fx.planFixtures, latencyScale: 0 });
    const clean = await p.run('parseIntent', { transcript: 'I need eggs', mode: 'IDLE', knownItems: ['eggs', 'milk'] });
    expect(clean.output.intent).toBe('find_item');
    expect(clean.output.item).toBe('eggs');
    const noisy = await p.run('parseIntent', { transcript: 'eggs please uh', mode: 'IDLE', knownItems: ['eggs', 'milk'] });
    expect(noisy.output.item).toBe('eggs');
    const anyFallback = Object.values(fx.planFixtures).some((f) => f.entries.some((e) => e.result.fallback));
    expect(anyFallback).toBe(true);
    const none = await p.run('answer', { question: 'replan', context: { nothing: 'matches-this' } });
    expect(none.job).toBe('answer');
    expect(none.fallback === true || typeof none.output.reply === 'string').toBe(true);
    expect(emptyOutput('disambiguate')).toEqual({ aisleId: null, confidence: 0, askBack: 'Say the item again.' });
    expect(p.callCount('parseIntent')).toBe(2);
  });

  it('rejects with MockNetworkError when the DebugPanel network toggle is off', async () => {
    const p = createMockPlanner({ fixtures: fx.planFixtures, latencyScale: 0, network: createNetworkGate(false) });
    await expect(p.run('answer', { question: 'repeat', context: {} })).rejects.toBeInstanceOf(MockNetworkError);
  });
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

describe('createMockServices harness', () => {
  it('ticks both replayers from one clock, jumps phases with the legal chain, and forces signal state', async () => {
    let wall = 0;
    const emitted: AppEvent[] = [];
    let interval: (() => void) | null = null;
    const m = createMockServices({
      bus: { emit: (e) => emitted.push(e) },
      wall: () => wall,
      latencyScale: 0,
      setIntervalFn: (fn) => { interval = fn; return 1; },
      clearIntervalFn: () => { interval = null; },
    });
    m.harness.start();
    expect(m.harness.isRunning()).toBe(true);
    expect(m.harness.isPlaying()).toBe(true);
    await m.perception.start('OUTDOOR_NAV');
    const poses: number[] = [];
    m.sensors.subscribePose((p) => poses.push(p.yawDeg));
    wall += 2000;
    interval!();
    expect(m.sensors.getLastFix()).not.toBeNull();
    expect(poses.length).toBeGreaterThan(0);          // pose re-emitted from the perception mock

    const spec = m.harness.jumpToPhase('AT_CURB');
    expect(spec?.pack).toBe('curb-walk-onset');
    expect(m.perception.currentPack()).toBe('curb-walk-onset');
    expect(emitted.map((e) => e.type)).toEqual(['ITEM_REQUESTED', 'ROUTE_READY', 'CROSSING_AHEAD', 'CURB_REACHED']);
    expect(m.harness.getTimeS()).toBe(spec!.t);

    const states: SignalState[] = [];
    m.perception.onSignalState((e) => states.push(e.state));
    m.harness.forceSignalState('DONT_WALK');
    expect(states).toEqual(['DONT_WALK']);
    m.harness.forceSignalState(null);

    m.harness.setSpeed(4);
    expect(m.harness.getSpeed()).toBe(4);
    m.harness.pause();
    expect(m.harness.isPlaying()).toBe(false);
    m.harness.stop();
    expect(m.harness.isRunning()).toBe(false);
    expect(m.harness.getDurationS()).toBeGreaterThan(150);
    expect(m.network.isOnline()).toBe(true);
  });
});
