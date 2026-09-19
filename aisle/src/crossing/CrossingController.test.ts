import type { AppMode, Crossing } from '../core/contracts';
import { createEventBus } from '../core/bus';
import { findForbiddenTerm } from '../core/phrases';
import { destinationPoint } from '../outdoor/geo';
import { createOutdoorStore } from '../outdoor/store';
import { createFakeHaptics, createFakePerception, createFakeSensors, createFakeSpeech, createFakeVision, fix } from '../outdoor/testing';
import { createCrossingController, type AisleCrossingController } from './CrossingController';

const NEAR = { lat: 40.4419581, lng: -79.9564358 };
const BEARING = 300;
const FAR = destinationPoint(NEAR, BEARING, 18);

function crossing(overrides: Partial<Crossing> = {}): Crossing {
  return { crossingId: 'x1', street: 'Forbes Ave', signalized: true, pushButtonLikely: false, bearingDeg: BEARING, nearCurb: NEAR, farCurb: FAR, roadSide: 'RIGHT', ...overrides };
}

function harness(opts: { vision?: boolean; mode?: AppMode } = {}) {
  const bus = createEventBus();
  const haptics = createFakeHaptics();
  const speech = createFakeSpeech();
  const sensors = createFakeSensors();
  const perception = createFakePerception();
  const outdoor = createOutdoorStore();
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
    // Listening pause.
    await jest.advanceTimersByTimeAsync(2100);
  }

  it('left window, right window, 2 s pause, then the clean report as back-to-back CRITICAL clips', async () => {
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
