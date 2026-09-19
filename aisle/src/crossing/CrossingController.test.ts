import type { AppMode, Crossing } from '../core/contracts';
import { createEventBus } from '../core/bus';
import { findForbiddenTerm } from '../core/phrases';
import { destinationPoint } from '../outdoor/geo';
import { createOutdoorStore } from '../outdoor/store';
import { createFakeHaptics, createFakePerception, createFakeSensors, createFakeSpeech, createFakeVision, fix } from '../outdoor/testing';
import { createCrossingController, SCAN_REPORT_LINE_GAP_MS, type AisleCrossingController } from './CrossingController';

const NEAR = { lat: 40.4419581, lng: -79.9564358 };
const BEARING = 300;
const FAR = destinationPoint(NEAR, BEARING, 18);

function crossing(overrides: Partial<Crossing> = {}): Crossing {
  return { crossingId: 'x1', street: 'Forbes Ave', signalized: true, pushButtonLikely: false, bearingDeg: BEARING, nearCurb: NEAR, farCurb: FAR, roadSide: 'RIGHT', ...overrides };
}

function harness(opts: { vision?: boolean; mode?: AppMode; detector?: boolean } = {}) {
  const bus = createEventBus();
  const haptics = createFakeHaptics();
  const speech = createFakeSpeech();
  const sensors = createFakeSensors();
  const perception = createFakePerception();
  const outdoor = createOutdoorStore();
  // A running detector emits empty frames even when no vehicles are visible.
  if (opts.detector !== false) setInterval(() => perception.emitDetections([]), 100);
  const vision = createFakeVision();
  const events: string[] = [];
  bus.onAny((r) => events.push(r.event.type));
  const released: number[] = [];
  const controller: AisleCrossingController = createCrossingController({
    haptics, speech, sensors, perception, bus, outdoor,
    vision: opts.vision === false ? undefined : vision,
    getMode: () => opts.mode ?? 'AT_CURB',
    onReleased: () => released.push(Date.now()),
  });
  return { bus, haptics, speech, sensors, perception, outdoor, vision, events, released, controller };
}

/** arm → at curb → aligned (heading on the bearing) */
async function toReading(h: ReturnType<typeof harness>, c: Crossing = crossing()) {
  h.controller.arm(c);
  h.sensors.setHeading(BEARING, 3);
  h.controller.curbReached();
  return h;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-19T15:00:00Z'));
});
afterEach(() => {
  jest.useRealTimers();
});

describe('arming and the curb', () => {
  it('arm sets the crossing bearing on the perception module and waits', () => {
    const h = harness();
    h.controller.arm(crossing());
    expect(h.controller.getState()).toBe('ARMED');
    expect(h.perception.calls).toContainEqual({ method: 'setCrossingBearing', args: [BEARING] });
    expect(h.speech.said).toHaveLength(0);
  });

  it('a stop within 12 m of the near curb reaches the curb: CURB_REACHED, TURN, COURSE to the bearing', () => {
    const h = harness();
    h.controller.arm(crossing());
    const here = destinationPoint(NEAR, BEARING + 180, 5);
    h.controller.observeFix(fix(here.lat, here.lng, { speedMps: 1.0 }));
    jest.advanceTimersByTime(2500);
    h.controller.observeFix(fix(here.lat, here.lng, { speedMps: 0.1 }));
    expect(h.controller.getState()).toBe('ARMED');
    jest.advanceTimersByTime(2100);
    h.controller.observeFix(fix(here.lat, here.lng, { speedMps: 0.1 }));
    expect(h.controller.getState()).toBe('ALIGNING');
    expect(h.events).toContain('CURB_REACHED');
    expect(h.haptics.played).toEqual(['TURN']);
    expect(h.haptics.courseTargets).toEqual(['NONE']);
  });

  it('walking straight past the crossing aborts silently with reason walked_past', () => {
    const h = harness();
    h.controller.arm(crossing());
    const past = destinationPoint(NEAR, BEARING, 40);
    h.controller.observeFix(fix(past.lat, past.lng));
    expect(h.controller.getState()).toBe('DONE');
    expect(h.events).toContain('CROSSING_ABORTED');
    expect(h.speech.said).toHaveLength(0);
    expect(h.perception.calls).toContainEqual({ method: 'setCrossingBearing', args: [null] });
    expect(h.released).toHaveLength(1);
  });

  it('alignment times out after 8 s without a compass', () => {
    const h = harness();
    h.controller.arm(crossing());
    h.sensors.setHeading(null);
    h.controller.curbReached();
    expect(h.controller.getState()).toBe('ALIGNING');
    jest.advanceTimersByTime(8000);
    expect(h.controller.getState()).toBe('READING');
  });
});

describe('READING: the signal phrase rules', () => {
  it('a stale WALK never speaks walk_signal_on', async () => {
    const h = await toReading(harness());
    expect(h.controller.getState()).toBe('READING');
    h.bus.emit({ type: 'SIGNAL_STATE', state: 'WALK', fresh: false, confidence: 0.9 });
    h.bus.emit({ type: 'SIGNAL_STATE', state: 'WALK', fresh: false, confidence: 0.9 });
    expect(h.speech.keys()).toEqual(['walk_already_on_wait']);
    expect(h.speech.keys()).not.toContain('walk_signal_on');
  });

  it('DONT_WALK → fresh WALK speaks dont_walk then walk_signal_on', async () => {
    const h = await toReading(harness());
    h.controller.signalUpdate({ state: 'DONT_WALK', fresh: false });
    h.controller.signalUpdate({ state: 'WALK', fresh: true });
    h.controller.signalUpdate({ state: 'COUNTDOWN', fresh: true });
    expect(h.speech.keys()).toEqual(['dont_walk', 'walk_signal_on', 'countdown']);
    expect(h.controller.getDebugState().signalSource).toBe('live');
  });

  it('10 s of UNKNOWN says cant_see_signal once and starts rung 2 (sequence-numbered curb crops)', async () => {
    const h = await toReading(harness());
    h.vision.respondWith(() => ({ signal: { state: 'DONT_WALK', confidence: 0.8 }, confidence: 0.8 }));
    for (let t = 0; t < 12; t += 1) {
      h.bus.emit({ type: 'SIGNAL_STATE', state: 'UNKNOWN', fresh: false, confidence: 0 });
      await jest.advanceTimersByTimeAsync(1000);
    }
    expect(h.speech.keys().filter((k) => k === 'cant_see_signal')).toHaveLength(1);
    expect(h.controller.getDebugState().ladderRung).toBe(2);
    expect(h.vision.requests.length).toBeGreaterThan(0);
    expect(h.vision.requests.every((r) => r.question === 'curb_crop')).toBe(true);
    const seqs = h.vision.requests.map((r) => r.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    // The first spoken cloud read is prefaced with "Signal read is delayed".
    const keys = h.speech.keys();
    const delayedAt = keys.indexOf('signal_read_delayed');
    expect(delayedAt).toBeGreaterThan(-1);
    expect(keys[delayedAt + 1]).toBe('dont_walk');
    expect(h.controller.getDebugState().signalSource).toBe('claude');
    // The live stream returning a state ends rung 2.
    h.bus.emit({ type: 'SIGNAL_STATE', state: 'WALK', fresh: true, confidence: 0.9 });
    expect(h.controller.getDebugState().ladderRung).toBe(1);
    expect(h.controller.getDebugState().signalSource).toBe('live');
  });

  it('the UNKNOWN timer fires even without a heartbeat event', async () => {
    const h = await toReading(harness({ vision: false }));
    await jest.advanceTimersByTimeAsync(10_200);
    expect(h.speech.keys()).toEqual(['cant_see_signal']);
    expect(h.controller.getDebugState().ladderRung).toBe(3);
  });

  it('a rung-2 read that returns after the 3 s freshness window is dropped, never spoken', async () => {
    const h = await toReading(harness());
    const original = h.vision.ask.bind(h.vision);
    h.vision.ask = async (req) => {
      await new Promise<void>((r) => setTimeout(r, 3500));   // slower than the freshness window
      return original(req);
    };
    h.vision.respondWith(() => ({ signal: { state: 'DONT_WALK', confidence: 0.9 }, confidence: 0.9 }));
    await jest.advanceTimersByTimeAsync(25_000);
    expect(h.vision.requests.length).toBeGreaterThan(0);
    expect(h.speech.keys()).toEqual(['cant_see_signal']);
    expect(h.controller.getDebugState().curbCropInFlight).toBeLessThanOrEqual(3);
  });

  it('a low-confidence curb crop stays silent', async () => {
    const h = await toReading(harness());
    h.vision.respondWith(() => ({ signal: { state: 'WALK', confidence: 0.3 }, confidence: 0.3 }));
    await jest.advanceTimersByTimeAsync(14_000);
    expect(h.speech.keys()).toEqual(['cant_see_signal']);
  });

  it('manual override (rung 4) speaks and mutes live events until released', async () => {
    const h = await toReading(harness());
    h.controller.setManualSignal('DONT_WALK');
    h.bus.emit({ type: 'SIGNAL_STATE', state: 'WALK', fresh: true, confidence: 0.9 });
    expect(h.speech.keys()).toEqual(['dont_walk']);
    expect(h.controller.getDebugState().signalSource).toBe('manual');
    h.controller.setManualSignal(null);
    h.bus.emit({ type: 'SIGNAL_STATE', state: 'DONT_WALK', fresh: false, confidence: 0.9 });
    h.bus.emit({ type: 'SIGNAL_STATE', state: 'WALK', fresh: true, confidence: 0.9 });
    expect(h.speech.keys().slice(-1)).toEqual(['walk_signal_on']);
  });

  it('a null-signal crossing that reads only UNKNOWN for 10 s goes to SCANNING', async () => {
    const h = await toReading(harness({ vision: false }), crossing({ signalized: null }));
    await jest.advanceTimersByTimeAsync(10_200);
    expect(h.controller.getState()).toBe('SCANNING');
    expect(h.speech.keys()[0]).toBe('cant_see_signal');
    expect(h.speech.keys()[1]).toBe('no_signal_point_left');
  });
});

describe('SCANNING: the unsignalized flow', () => {
  async function runScan(h: ReturnType<typeof harness>, left: () => void = () => {}, right: () => void = () => {}) {
    h.controller.arm(crossing({ signalized: false }));
    h.sensors.setHeading(BEARING, 3);
    h.controller.curbReached();
    expect(h.controller.getState()).toBe('SCANNING');
    // Point left.
    h.sensors.setHeading(BEARING - 90, 3);
    await jest.advanceTimersByTimeAsync(300);
    left();
    await jest.advanceTimersByTimeAsync(2500);
    // Point right.
    h.sensors.setHeading(BEARING + 90, 3);
    await jest.advanceTimersByTimeAsync(300);
    right();
    await jest.advanceTimersByTimeAsync(2500);
    // Listening pause, then the paced report (line gap × 2).
    await jest.advanceTimersByTimeAsync(2100 + 2 * SCAN_REPORT_LINE_GAP_MS + 100);
  }

  it('left window, right window, 2 s pause, then the clean report as paced CRITICAL clips', async () => {
    const h = harness();
    await runScan(h);
    const keys = h.speech.keys();
    expect(keys).toEqual(['no_signal_point_left', 'now_right', 'no_vehicles_left', 'no_vehicles_right', 'listen_then_cross']);
    const report = h.speech.said.slice(2);
    expect(report.every((r) => r.priority === 'CRITICAL' && !r.interrupt)).toBe(true);
    // One still per side, with heading facts; SCAN_RESULT per side and source.
    expect(h.vision.requests.map((r) => r.question)).toEqual(['scan_left', 'scan_right']);
    expect(h.perception.calls.filter((c) => c.method === 'snapshotJPEG').map((c) => c.args[0])).toEqual([512, 512]);
    const scans = h.bus.history().filter((r) => r.event.type === 'SCAN_RESULT').map((r) => r.event as { side: string; vehiclesSeen: string; source: string });
    expect(scans).toEqual([
      { type: 'SCAN_RESULT', side: 'LEFT', vehiclesSeen: 'none', source: 'detector' },
      { type: 'SCAN_RESULT', side: 'LEFT', vehiclesSeen: 'none', source: 'claude' },
      { type: 'SCAN_RESULT', side: 'RIGHT', vehiclesSeen: 'none', source: 'detector' },
      { type: 'SCAN_RESULT', side: 'RIGHT', vehiclesSeen: 'none', source: 'claude' },
    ]);
  });

  it('a detector vehicle event in the right window makes the right side approaching, spoken first', async () => {
    const h = harness();
    await runScan(h, () => {}, () => h.bus.emit({ type: 'VEHICLE_APPROACHING', direction: 'CENTER', trackId: 7 }));
    expect(h.speech.keys().slice(2)).toEqual(['vehicle_approaching_right', 'no_vehicles_left']);
    expect(h.controller.getDebugState().scanVerdicts).toEqual({ left: 'none', right: 'approaching' });
  });

  it('Claude "unclear" on the left gives cant_see_well_left and no listen_then_cross', async () => {
    const h = harness();
    h.vision.respondWith((req) => (req.question === 'scan_left' ? { scan: { vehiclesSeen: 'unclear', confidence: 0.9 } } : {}));
    await runScan(h);
    expect(h.speech.keys().slice(2)).toEqual(['cant_see_well_left', 'no_vehicles_right']);
  });

  it('without a vision client the detector verdict alone is used and no still is taken', async () => {
    const h = harness({ vision: false });
    await runScan(h);
    expect(h.speech.keys().slice(2)).toEqual(['no_vehicles_left', 'no_vehicles_right', 'listen_then_cross']);
    expect(h.perception.calls.filter((c) => c.method === 'snapshotJPEG')).toHaveLength(0);
  });

  it('a hung native snapshot cannot stall the scan: both windows close with unclear inside the freshness budget', async () => {
    const h = harness();
    h.perception.snapshotJPEG = () => new Promise(() => {});   // never resolves
    h.controller.arm(crossing({ signalized: false }));
    h.sensors.setHeading(BEARING, 3);
    h.controller.curbReached();
    h.sensors.setHeading(BEARING - 90, 3);
    await jest.advanceTimersByTimeAsync(300);
    // Left window: 1 s still + 3 s freshness race at most.
    await jest.advanceTimersByTimeAsync(4200);
    expect(h.speech.keys()).toEqual(['no_signal_point_left', 'now_right']);
    h.sensors.setHeading(BEARING + 90, 3);
    await jest.advanceTimersByTimeAsync(300 + 4200 + 2100 + 2 * SCAN_REPORT_LINE_GAP_MS + 100);
    expect(h.speech.keys().slice(2)).toEqual(['cant_see_well_left', 'cant_see_well_right']);
    expect(h.vision.requests).toHaveLength(0);
    const claude = h.bus.history().filter((r) => r.event.type === 'SCAN_RESULT' && (r.event as { source: string }).source === 'claude').map((r) => (r.event as { vehiclesSeen: string }).vehiclesSeen);
    expect(claude).toEqual(['unclear', 'unclear']);
    expect(h.controller.getDebugState().scanVerdicts).toEqual({ left: 'unclear', right: 'unclear' });
  });

  it('pedometer shuffles during the scan never start the crossing; steps after the report do', async () => {
    const h = harness({ vision: false });
    h.controller.arm(crossing({ signalized: false }));
    h.sensors.setHeading(BEARING, 3);
    h.controller.curbReached();
    expect(h.controller.getState()).toBe('SCANNING');
    // Turning to point left registers as steps (a pedometer sample is stamped at or before its callback).
    h.sensors.setHeading(BEARING - 90, 3);
    h.sensors.addSteps(6, Date.now());
    await jest.advanceTimersByTimeAsync(300 + 2500);
    expect(h.controller.getState()).toBe('SCANNING');
    h.sensors.setHeading(BEARING + 90, 3);
    h.sensors.addSteps(3, Date.now());
    await jest.advanceTimersByTimeAsync(300 + 2500 + 2100 + 2 * SCAN_REPORT_LINE_GAP_MS + 100);
    expect(h.controller.getState()).toBe('SCANNING');
    expect(h.speech.keys().slice(2)).toEqual(['no_vehicles_left', 'no_vehicles_right', 'listen_then_cross']);
    // Facing the crossing again: the scan's shuffles were re-based, so three fresh steps are not enough...
    h.sensors.setHeading(BEARING, 3);
    h.sensors.addSteps(3, Date.now() + 1);
    expect(h.controller.getState()).toBe('SCANNING');
    // ...and the fourth starts the crossing.
    h.sensors.addSteps(1, Date.now() + 2);
    expect(h.controller.getState()).toBe('CROSSING');
    expect(h.events).toContain('CROSSING_STARTED');
  });

  it('stepping off while the report is still playing flushes it (clearQueue CRITICAL); long after, nothing is flushed', async () => {
    const h = harness({ vision: false });
    await runScan(h);
    expect(h.speech.keys().slice(-1)).toEqual(['listen_then_cross']);
    h.sensors.setHeading(BEARING, 3);
    h.sensors.addSteps(4, Date.now() + 1);
    expect(h.controller.getState()).toBe('CROSSING');
    expect(h.speech.cleared).toEqual(['CRITICAL']);

    // Same flow, but the user steps off 10 s after the report ended: a vehicle alert must not be collateral.
    const h2 = harness({ vision: false });
    await runScan(h2);
    await jest.advanceTimersByTimeAsync(10_000);
    h2.sensors.setHeading(BEARING, 3);
    h2.sensors.addSteps(4, Date.now() + 1);
    expect(h2.controller.getState()).toBe('CROSSING');
    expect(h2.speech.cleared).toEqual([]);
  });

  it('a user already in the roadway never hears the rest of the report: lines are re-checked per line', async () => {
    const h = harness({ vision: false });
    h.controller.arm(crossing({ signalized: false }));
    h.sensors.setHeading(BEARING, 3);
    h.controller.curbReached();
    h.sensors.setHeading(BEARING - 90, 3);
    await jest.advanceTimersByTimeAsync(300 + 2500);
    h.sensors.setHeading(BEARING + 90, 3);
    await jest.advanceTimersByTimeAsync(300 + 2500 + 2100);
    // First line queued; the user steps into the roadway before the second.
    expect(h.speech.keys().slice(2)).toEqual(['no_vehicles_left']);
    h.controller.crossingStarted();
    await jest.advanceTimersByTimeAsync(2 * SCAN_REPORT_LINE_GAP_MS + 100);
    expect(h.speech.keys().slice(2)).toEqual(['no_vehicles_left']);
    expect(h.speech.keys()).not.toContain('listen_then_cross');
    expect(h.speech.cleared).toEqual(['CRITICAL']);
  });

  it('requestRescan runs the scan again', async () => {
    const h = harness({ vision: false });
    await runScan(h);
    h.outdoor.getState().requestRescan();
    await jest.advanceTimersByTimeAsync(9000);
    expect(h.controller.getDebugState().scanRuns).toBe(2);
    expect(h.speech.keys().filter((k) => k === 'no_signal_point_left')).toHaveLength(2);
  });
});

describe('CROSSING and the far curb', () => {
  it('four steps after the curb start the crossing: beacon to the far curb, COURSE on the crossing line', async () => {
    const h = await toReading(harness());
    const curbAt = Date.now();
    jest.advanceTimersByTime(1000);
    h.sensors.addSteps(3, curbAt + 500);
    expect(h.controller.getState()).toBe('READING');
    h.sensors.addSteps(1, curbAt + 900);
    expect(h.controller.getState()).toBe('CROSSING');
    expect(h.events).toContain('CROSSING_STARTED');
    expect(h.outdoor.getState().beaconTarget).toEqual(FAR);
    expect(h.perception.calls).toContainEqual({ method: 'setCourseReference', args: [{ bearingDeg: BEARING }] });
    expect(h.haptics.courseTargets.slice(-1)).toEqual(['NONE']);
  });

  it('with pose tracking NORMAL, steps alone never start the crossing; only displacement along the bearing does', async () => {
    const h = await toReading(harness());
    const at = (east: number, north: number) => ({ yawDeg: BEARING, x: east, y: 0, z: -north, trackingState: 'NORMAL' as const, timestamp: Date.now() });
    h.sensors.emitPose(at(0, 0));
    expect(h.controller.getState()).toBe('READING');
    h.sensors.addSteps(8, Date.now() + 1);
    expect(h.controller.getState()).toBe('READING');
    // 2 m sideways (perpendicular to the bearing): a shuffle along the curb, not a start.
    const perp = ((BEARING + 90) * Math.PI) / 180;
    h.sensors.emitPose(at(2 * Math.sin(perp), 2 * Math.cos(perp)));
    expect(h.controller.getState()).toBe('READING');
    // 2 m along the bearing: the crossing starts.
    const along = (BEARING * Math.PI) / 180;
    h.sensors.emitPose(at(2 * Math.sin(along), 2 * Math.cos(along)));
    expect(h.controller.getState()).toBe('CROSSING');
  });

  it('the first NORMAL pose after the curb becomes the origin when none was available at curbReached', async () => {
    const h = await toReading(harness());
    const along = (m: number) => ({ yawDeg: BEARING, x: 5 + m * Math.sin((BEARING * Math.PI) / 180), y: 0, z: 3 - m * Math.cos((BEARING * Math.PI) / 180), trackingState: 'NORMAL' as const, timestamp: Date.now() });
    h.sensors.emitPose(along(0));   // origin (arbitrary world offset)
    expect(h.controller.getState()).toBe('READING');
    h.sensors.emitPose(along(1));
    expect(h.controller.getState()).toBe('READING');
    h.sensors.emitPose(along(2));
    expect(h.controller.getState()).toBe('CROSSING');
  });

  it('facing > 45° off the bearing (turning away from the curb) suppresses the step rule and re-bases the count', async () => {
    const h = await toReading(harness());
    h.sensors.setHeading(BEARING + 180, 3);
    h.sensors.addSteps(6, Date.now());
    expect(h.controller.getState()).toBe('READING');
    jest.advanceTimersByTime(500);
    // Back to the bearing: the six suppressed steps do not carry over.
    h.sensors.setHeading(BEARING + 20, 3);
    h.sensors.addSteps(3, Date.now());
    expect(h.controller.getState()).toBe('READING');
    jest.advanceTimersByTime(500);
    h.sensors.addSteps(1, Date.now());
    expect(h.controller.getState()).toBe('CROSSING');
  });

  it('ARKit displacement past the crossing length reaches the far curb: CONFIRM, far_curb, FAR_CURB_REACHED', async () => {
    const h = await toReading(harness());
    h.sensors.emitPose({ yawDeg: BEARING, x: 0, y: 0, z: 0, trackingState: 'NORMAL', timestamp: Date.now() });
    // Re-arm so the curb pose is the origin.
    h.controller.abort('user');
    await toReading(h);
    const along = (m: number) => ({ yawDeg: BEARING, x: m * Math.sin((BEARING * Math.PI) / 180), y: 0, z: -m * Math.cos((BEARING * Math.PI) / 180), trackingState: 'NORMAL' as const, timestamp: Date.now() });
    h.sensors.emitPose(along(2));
    expect(h.controller.getState()).toBe('CROSSING');
    h.sensors.emitPose(along(17.5));
    expect(h.controller.getState()).toBe('DONE');
    expect(h.haptics.played).toContain('CONFIRM');
    expect(h.speech.keys().slice(-1)).toEqual(['far_curb']);
    expect(h.events.slice(-1)).toEqual(['FAR_CURB_REACHED']);
    expect(h.outdoor.getState().beaconTarget).toBeNull();
    expect(h.perception.calls.slice(-2)).toEqual([
      { method: 'setCrossingBearing', args: [null] },
      { method: 'setCourseReference', args: [null] },
    ]);
    expect(h.released.length).toBeGreaterThan(0);
  });

  it('two good fixes near the far curb also finish the crossing', async () => {
    const h = await toReading(harness());
    h.sensors.addSteps(4, Date.now() + 1);
    expect(h.controller.getState()).toBe('CROSSING');
    h.controller.observeFix(fix(FAR.lat, FAR.lng, { accuracyM: 10 }));
    expect(h.controller.getState()).toBe('CROSSING');
    h.controller.observeFix(fix(FAR.lat, FAR.lng, { accuracyM: 10 }));
    expect(h.controller.getState()).toBe('DONE');
  });

  it('abort from any state emits CROSSING_ABORTED and says nothing', async () => {
    const h = await toReading(harness());
    h.controller.abort('user');
    expect(h.events.slice(-1)).toEqual(['CROSSING_ABORTED']);
    expect(h.speech.said).toHaveLength(0);
    expect(h.controller.getState()).toBe('DONE');
  });
});

describe('language', () => {
  it('nothing the controller ever says contains a forbidden word', async () => {
    const h = harness();
    await (async () => {
      h.controller.arm(crossing({ signalized: false }));
      h.sensors.setHeading(BEARING, 3);
      h.controller.curbReached();
      await jest.advanceTimersByTimeAsync(20_000);
    })();
    const h2 = await toReading(harness());
    h2.controller.signalUpdate({ state: 'WALK', fresh: false });
    h2.controller.signalUpdate({ state: 'DONT_WALK', fresh: false });
    h2.controller.signalUpdate({ state: 'WALK', fresh: true });
    h2.controller.signalUpdate({ state: 'COUNTDOWN', fresh: true });
    for (const req of [...h.speech.said, ...h2.speech.said]) {
      expect(findForbiddenTerm(req.text)).toBeNull();
      expect(req.text.split(/\s+/).length).toBeLessThanOrEqual(12);
      expect(/\d/.test(req.text)).toBe(false);
    }
  });
});

it('detector silence cannot become a no-vehicles report', async () => {
  const h = harness({ vision: false, detector: false });
  h.controller.arm(crossing({ signalized: false }));
  h.sensors.setHeading(BEARING, 3);
  h.controller.curbReached();
  h.sensors.setHeading(BEARING - 90, 3);
  await jest.advanceTimersByTimeAsync(2800);
  h.sensors.setHeading(BEARING + 90, 3);
  await jest.advanceTimersByTimeAsync(2800 + 2100 + 2 * SCAN_REPORT_LINE_GAP_MS + 100);
  expect(h.controller.getDebugState().scanVerdicts).toEqual({ left: 'unclear', right: 'unclear' });
  expect(h.speech.keys()).not.toContain('listen_then_cross');
  h.controller.dispose();
});

it('expires a signal state when native heartbeats stop', async () => {
  const h = await toReading(harness({ vision: false }));
  h.bus.emit({ type: 'SIGNAL_STATE', state: 'WALK', fresh: true, confidence: 0.9 });
  await jest.advanceTimersByTimeAsync(4600);
  expect(h.controller.getDebugState().lastSignal?.state).toBe('UNKNOWN');
  await jest.advanceTimersByTimeAsync(10200);
  expect(h.speech.keys()).toContain('cant_see_signal');
  h.controller.dispose();
});

it('does not reach or pass a curb using inaccurate GPS', () => {
  const h = harness();
  h.controller.arm(crossing());
  h.controller.observeFix(fix(FAR.lat, FAR.lng, { accuracyM: 100 }));
  h.controller.observeFix(fix(NEAR.lat, NEAR.lng, { accuracyM: 100, speedMps: 0 }));
  jest.advanceTimersByTime(3000);
  h.controller.observeFix(fix(NEAR.lat, NEAR.lng, { accuracyM: 100, speedMps: 0 }));
  expect(h.controller.getState()).toBe('ARMED');
  h.controller.dispose();
});

it('does not read a pedestrian signal from a camera facing a different crossing', async () => {
  const h = await toReading(harness());
  h.sensors.setHeading(BEARING + 90, 3);
  await jest.advanceTimersByTimeAsync(15000);
  expect(h.vision.requests).toHaveLength(0);
  expect(h.speech.keys()).not.toContain('walk_signal_on');
  h.controller.dispose();
});

it('reports unclear when side-scan heading was never established', async () => {
  const h = harness({ vision: false });
  h.controller.arm(crossing({ signalized: false }));
  h.sensors.setHeading(BEARING, 3);
  h.controller.curbReached();
  await jest.advanceTimersByTimeAsync(40000);
  expect(h.controller.getDebugState().scanVerdicts).toEqual({ left: 'unclear', right: 'unclear' });
  expect(h.speech.keys()).not.toContain('no_vehicles_left');
  expect(h.speech.keys()).not.toContain('no_vehicles_right');
  h.controller.dispose();
});
