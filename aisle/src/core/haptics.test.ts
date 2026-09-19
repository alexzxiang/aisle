import type { CourseError } from './contracts';
import { createEventBus, type AppEventBus } from './bus';
import { createAppStore, type AppStore } from './store';
import {
  COMPASS_UNCERTAIN_COOLDOWN_MS,
  CourseEngine,
  DEAD_ZONE_DEG,
  DRIFT_DEG_CAP,
  ROADWARD_MIN_HEADING_DEG,
  HYSTERESIS_MS,
  MIN_BURST_MS,
  PULSE_INTERVAL_MAX_MS,
  PULSE_INTERVAL_MIN_MS,
  SIDE_HINT_AFTER_MS,
  SIDE_HINT_COOLDOWN_MS,
  STOP_PREEMPT_MS,
  STOP_SEQUENCE_MS,
  TURN_SEQUENCE_MS,
  courseSchedule,
  createHapticService,
  pulseIntervalMs,
  pulseStyleFor,
  type HapticBackend,
  type PulseStyle,
} from './haptics';

const err = (over: Partial<CourseError> = {}): CourseError => ({
  headingErrorDeg: 0, crossTrackM: 0, roadSide: 'NONE', compassAccuracy: 3, ...over,
});

// ---------------------------------------------------------------------------
// Pure mapping: CourseError → pulse schedule
// ---------------------------------------------------------------------------

describe('courseSchedule (pure)', () => {
  it('is silent inside the dead zone and the dead zone follows the compass tier', () => {
    expect(DEAD_ZONE_DEG).toEqual({ 3: 12, 2: 18 });
    expect(courseSchedule(err({ headingErrorDeg: 11.9 })).active).toBe(false);
    expect(courseSchedule(err({ headingErrorDeg: 12.1 })).active).toBe(true);
    expect(courseSchedule(err({ headingErrorDeg: -12.1 })).active).toBe(true);
    expect(courseSchedule(err({ headingErrorDeg: 15, compassAccuracy: 2 })).active).toBe(false);
    expect(courseSchedule(err({ headingErrorDeg: 19, compassAccuracy: 2 })).active).toBe(true);
  });

  it('never buzzes below compass tier 2', () => {
    for (const acc of [0, 1] as const) {
      const s = courseSchedule(err({ headingErrorDeg: 90, crossTrackM: 3, roadSide: 'RIGHT', compassAccuracy: acc }));
      expect(s.compassOk).toBe(false);
      expect(s.active).toBe(false);
      expect(s.intervalMs).toBeNull();
      expect(s.style).toBeNull();
    }
  });

  it('ramps interval and style with the excess error', () => {
    expect(pulseIntervalMs(0)).toBe(PULSE_INTERVAL_MAX_MS);
    expect(pulseIntervalMs(10)).toBe(520);
    expect(pulseIntervalMs(56.25)).toBe(PULSE_INTERVAL_MIN_MS);
    expect(pulseIntervalMs(200)).toBe(PULSE_INTERVAL_MIN_MS);
    expect(pulseStyleFor(0)).toBe('Light');
    expect(pulseStyleFor(14.9)).toBe('Light');
    expect(pulseStyleFor(15)).toBe('Medium');
    expect(pulseStyleFor(40)).toBe('Medium');
    expect(pulseStyleFor(40.1)).toBe('Heavy');

    const s = courseSchedule(err({ headingErrorDeg: 42 }));   // e = 30
    expect(s.headingExcessDeg).toBe(30);
    expect(s.intervalMs).toBe(600 - 8 * 30);
    expect(s.style).toBe('Medium');
    expect(courseSchedule(err({ headingErrorDeg: 60 })).style).toBe('Heavy');
    expect(courseSchedule(err({ headingErrorDeg: 13 })).style).toBe('Light');
  });

  it('a larger error is a faster, harder buzz (monotonic)', () => {
    let lastInterval = Infinity;
    const rank: Record<PulseStyle, number> = { Light: 0, Medium: 1, Heavy: 2 };
    let lastRank = -1;
    for (let h = 13; h <= 120; h += 1) {
      const s = courseSchedule(err({ headingErrorDeg: h }));
      expect(s.intervalMs as number).toBeLessThanOrEqual(lastInterval);
      expect(rank[s.style as PulseStyle]).toBeGreaterThanOrEqual(lastRank);
      lastInterval = s.intervalMs as number;
      lastRank = rank[s.style as PulseStyle];
    }
  });

  it('roadward drift needs two agreeing signals (drift toward the road AND a heading meaningfully toward it)', () => {
    // Road on the right, drifting right, heading 8° right (inside the dead zone): both agree → buzz.
    const both = courseSchedule(err({ crossTrackM: 0.6, headingErrorDeg: 8, roadSide: 'RIGHT' }));
    expect(both.roadward).toBe(true);
    expect(both.driftSide).toBe('RIGHT');
    expect(both.driftDeg).toBeCloseTo(24, 6);   // 20° per 0.5 m
    expect(both.active).toBe(true);
    expect(both.style).toBe('Medium');

    // Drifting right but heading left: only one signal → no buzz.
    expect(courseSchedule(err({ crossTrackM: 0.6, headingErrorDeg: -8, roadSide: 'RIGHT' })).active).toBe(false);
    // Heading right but not yet 0.5 m over: no buzz.
    expect(courseSchedule(err({ crossTrackM: 0.4, headingErrorDeg: 8, roadSide: 'RIGHT' })).active).toBe(false);
    // Mirror image for a road on the left.
    expect(courseSchedule(err({ crossTrackM: -0.6, headingErrorDeg: -8, roadSide: 'LEFT' })).roadward).toBe(true);
    expect(courseSchedule(err({ crossTrackM: -0.6, headingErrorDeg: 8, roadSide: 'LEFT' })).roadward).toBe(false);
  });

  it('GPS noise never buzzes: 3 m of cross-track with the user pointed straight ahead is silent', () => {
    expect(ROADWARD_MIN_HEADING_DEG).toBe(5);
    for (const roadSide of ['RIGHT', 'LEFT', 'NONE'] as const) {
      for (const ct of [3, -3]) {
        for (const h of [2, -2, 0, 4.9, -4.9]) {
          const s = courseSchedule(err({ crossTrackM: ct, headingErrorDeg: h, roadSide }));
          expect(s.roadward).toBe(false);
          expect(s.active).toBe(false);
          expect(s.intervalMs).toBeNull();
        }
      }
    }
    // The same 3 m with a heading that means it (≥ 5° toward the road) does count.
    expect(courseSchedule(err({ crossTrackM: 3, headingErrorDeg: 5, roadSide: 'RIGHT' })).roadward).toBe(true);
    expect(courseSchedule(err({ crossTrackM: 3, headingErrorDeg: 4.99, roadSide: 'RIGHT' })).roadward).toBe(false);
  });

  it('the CourseEngine stays silent for the whole GPS-noise episode (ct = 3 m, h = +2°)', () => {
    const eng = new CourseEngine();
    for (const roadSide of ['RIGHT', 'NONE'] as const) {
      const r = run(eng, 0, 10_000, 50, err({ crossTrackM: 3, headingErrorDeg: 2, roadSide }));
      expect(r.pulses).toEqual([]);
      expect(r.deviations).toEqual([]);
      expect(r.buzzingAt).toBeNull();
      expect(eng.isBuzzing()).toBe(false);
    }
  });

  it('drift away from the road relies on heading alone', () => {
    const away = courseSchedule(err({ crossTrackM: -3, headingErrorDeg: -5, roadSide: 'RIGHT' }));
    expect(away.roadward).toBe(false);
    expect(away.active).toBe(false);
    const awayButTurned = courseSchedule(err({ crossTrackM: -3, headingErrorDeg: -20, roadSide: 'RIGHT' }));
    expect(awayButTurned.active).toBe(true);
    expect(awayButTurned.driftDeg).toBe(0);
    expect(awayButTurned.e).toBe(8);
  });

  it('with no road (roadSide NONE) the drift side is the road: |crossTrack| > 0.5 m AND heading ≥ 5° that way', () => {
    expect(courseSchedule(err({ crossTrackM: 0.6, headingErrorDeg: 8 })).roadward).toBe(true);
    expect(courseSchedule(err({ crossTrackM: 0.6, headingErrorDeg: 8 })).driftSide).toBe('RIGHT');
    expect(courseSchedule(err({ crossTrackM: -0.6, headingErrorDeg: -8 })).driftSide).toBe('LEFT');
    // Cross-track alone (heading straight, or turned back toward the line) is not a drift.
    expect(courseSchedule(err({ crossTrackM: 0.6, headingErrorDeg: 0 })).roadward).toBe(false);
    expect(courseSchedule(err({ crossTrackM: 0.6, headingErrorDeg: -8 })).roadward).toBe(false);
    expect(courseSchedule(err({ crossTrackM: -0.6, headingErrorDeg: 8 })).roadward).toBe(false);
    expect(courseSchedule(err({ crossTrackM: 0.5, headingErrorDeg: 8 })).roadward).toBe(false);
  });

  it('caps the drift contribution at 30°, so one metre of drift is never a Heavy train by itself', () => {
    expect(DRIFT_DEG_CAP).toBe(30);
    const one = courseSchedule(err({ crossTrackM: 1.0, headingErrorDeg: 8, roadSide: 'RIGHT' }));
    expect(one.driftDeg).toBe(30);
    expect(one.e).toBe(30);
    expect(one.style).toBe('Medium');
    const five = courseSchedule(err({ crossTrackM: 5, headingErrorDeg: 8, roadSide: 'RIGHT' }));
    expect(five.driftDeg).toBe(30);
    expect(five.e).toBe(30);
    // Below the cap the slope is unchanged.
    expect(courseSchedule(err({ crossTrackM: 0.6, headingErrorDeg: 8, roadSide: 'RIGHT' })).driftDeg).toBeCloseTo(24, 6);
  });

  it('adds drift degrees to heading excess and reports the correction side', () => {
    const s = courseSchedule(err({ headingErrorDeg: 22, crossTrackM: 1.0, roadSide: 'RIGHT' }));
    expect(s.e).toBeCloseTo(10 + DRIFT_DEG_CAP, 6);
    expect(s.style).toBe('Medium');
    expect(courseSchedule(err({ headingErrorDeg: 40, crossTrackM: 1.0, roadSide: 'RIGHT' })).style).toBe('Heavy');
    expect(s.correction).toBe('LEFT');
    expect(courseSchedule(err({ headingErrorDeg: -30 })).correction).toBe('RIGHT');
    expect(courseSchedule(err({ headingErrorDeg: 5 })).correction).toBeNull();
  });

  it('treats NaN samples as zero rather than buzzing', () => {
    expect(courseSchedule(err({ headingErrorDeg: NaN, crossTrackM: NaN })).active).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Timed engine
// ---------------------------------------------------------------------------

function run(engine: CourseEngine, from: number, to: number, stepMs: number, e: CourseError) {
  const pulses: Array<{ t: number; style: PulseStyle }> = [];
  const confirms: number[] = [];
  const speaks: Array<{ t: number; key: string }> = [];
  const deviations: Array<{ t: number; side: string; meters: number }> = [];
  let buzzingAt: number | null = null;
  for (let t = from; t <= to; t += stepMs) {
    const tick = engine.step(t, e);
    if (tick.pulse) pulses.push({ t, style: tick.pulse });
    if (tick.confirm) confirms.push(t);
    if (tick.speak) speaks.push({ t, key: tick.speak });
    if (tick.deviation) deviations.push({ t, ...tick.deviation });
    if (tick.buzzing && buzzingAt === null) buzzingAt = t;
  }
  return { pulses, confirms, speaks, deviations, buzzingAt };
}

describe('CourseEngine (hysteresis, pre-emption, CONFIRM)', () => {
  it('needs the error to persist 0.5 s before the first pulse, then pulses on schedule', () => {
    const eng = new CourseEngine();
    const r = run(eng, 0, 2000, 50, err({ headingErrorDeg: 42 })); // e = 30 → 360 ms interval
    expect(r.buzzingAt).toBe(HYSTERESIS_MS);
    expect(r.pulses[0]).toEqual({ t: 500, style: 'Medium' });
    const gaps = r.pulses.slice(1).map((p, i) => p.t - r.pulses[i].t);
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(360);
    for (const g of gaps) expect(g).toBeLessThan(360 + 50);
  });

  it('does not flutter: a brief excursion shorter than 0.5 s never buzzes', () => {
    const eng = new CourseEngine();
    const a = run(eng, 0, 400, 50, err({ headingErrorDeg: 30 }));
    const b = run(eng, 450, 1000, 50, err({ headingErrorDeg: 0 }));
    expect(a.pulses).toEqual([]);
    expect(b.pulses).toEqual([]);
    expect(eng.isBuzzing()).toBe(false);
  });

  it('keeps buzzing 0.5 s after re-entering the dead zone, then stops', () => {
    const eng = new CourseEngine();
    run(eng, 0, 1000, 50, err({ headingErrorDeg: 30 }));
    expect(eng.isBuzzing()).toBe(true);
    eng.step(1050, err({ headingErrorDeg: 0 }));
    expect(eng.isBuzzing()).toBe(true);
    eng.step(1050 + HYSTERESIS_MS - 50, err({ headingErrorDeg: 0 }));
    expect(eng.isBuzzing()).toBe(true);
    eng.step(1050 + HYSTERESIS_MS, err({ headingErrorDeg: 0 }));
    expect(eng.isBuzzing()).toBe(false);
  });

  it('honours the minimum burst', () => {
    expect(MIN_BURST_MS).toBe(150);
    const eng = new CourseEngine();
    run(eng, 0, 500, 50, err({ headingErrorDeg: 30 }));   // buzz starts at 500
    // In the dead zone at 501; stop requires ≥ 0.5 s inside AND ≥ 150 ms of burst → 1001.
    for (let t = 501; t < 1001; t += 50) eng.step(t, err());
    expect(eng.isBuzzing()).toBe(true);
    eng.step(1001, err());
    expect(eng.isBuzzing()).toBe(false);
  });

  it('a change in error is audible on the next pulse (< 200 ms at the fast end)', () => {
    const eng = new CourseEngine();
    run(eng, 0, 1000, 50, err({ headingErrorDeg: 13 }));   // slow Light
    const fast = run(eng, 1050, 1600, 50, err({ headingErrorDeg: 90 }));
    expect(fast.pulses.length).toBeGreaterThanOrEqual(3);
    expect(fast.pulses.every((p) => p.style === 'Heavy')).toBe(true);
    const gaps = fast.pulses.slice(1).map((p, i) => p.t - fast.pulses[i].t);
    for (const g of gaps) expect(g).toBeLessThan(200);
  });

  it('below compass tier 2: no buzz, compass_uncertain once per 30 s, keeps polling', () => {
    const eng = new CourseEngine();
    const r = run(eng, 0, COMPASS_UNCERTAIN_COOLDOWN_MS + 1000, 500, err({ headingErrorDeg: 90, compassAccuracy: 1 }));
    expect(r.pulses).toEqual([]);
    expect(r.speaks.map((s) => s.key)).toEqual(['compass_uncertain', 'compass_uncertain']);
    expect(r.speaks[1].t - r.speaks[0].t).toBeGreaterThanOrEqual(COMPASS_UNCERTAIN_COOLDOWN_MS);
    // Tier comes back → the rule resumes with a fresh hysteresis window.
    const back = run(eng, 40_000, 41_000, 50, err({ headingErrorDeg: 30 }));
    expect(back.buzzingAt).toBe(40_500);
  });

  it('after TURN, one CONFIRM on the first re-entry to the dead zone and never again', () => {
    const eng = new CourseEngine();
    eng.noteTurn(0);
    run(eng, 0, 1500, 50, err({ headingErrorDeg: 80 }));      // turning, still outside
    const realign = run(eng, 1550, 2500, 50, err({ headingErrorDeg: 3 }));
    expect(realign.confirms).toEqual([1550]);
    expect(eng.isBuzzing()).toBe(false);                       // silence is the reward, at once
    // Wander out and back again: no second CONFIRM.
    run(eng, 2550, 4000, 50, err({ headingErrorDeg: 80 }));
    const again = run(eng, 4050, 5000, 50, err({ headingErrorDeg: 0 }));
    expect(again.confirms).toEqual([]);
  });

  it('after TURN with no excursion, confirms once the heading has sat inside for 1 s', () => {
    const eng = new CourseEngine();
    eng.noteTurn(1000);
    const r = run(eng, 1000, 3000, 100, err({ headingErrorDeg: 2 }));
    expect(r.confirms).toEqual([2000]);
  });

  it('a new target (resetCourse) keeps the pending post-TURN CONFIRM', () => {
    const eng = new CourseEngine();
    eng.noteTurn(0);
    run(eng, 0, 700, 50, err({ headingErrorDeg: 90 }));
    eng.resetCourse();                                         // B calls stopCourse/startCourse with the new leg bearing
    const r = run(eng, 750, 1200, 50, err({ headingErrorDeg: 1 }));
    expect(r.confirms).toEqual([750]);
  });

  it('STOP pre-empts the pulses for 1 s and COURSE resumes without a CONFIRM', () => {
    const eng = new CourseEngine();
    run(eng, 0, 1500, 50, err({ headingErrorDeg: 90 }));
    eng.noteStop(1500);
    const quiet = run(eng, 1500, 1500 + STOP_PREEMPT_MS - 50, 50, err({ headingErrorDeg: 90 }));
    expect(quiet.pulses).toEqual([]);
    expect(eng.isBuzzing()).toBe(true);                        // state kept, only the motor is quiet
    const resumed = run(eng, 1500 + STOP_PREEMPT_MS, 3000, 50, err({ headingErrorDeg: 90 }));
    expect(resumed.pulses.length).toBeGreaterThan(0);
    expect(resumed.confirms).toEqual([]);
  });

  it('emits COURSE_DEVIATION once per roadward episode', () => {
    const eng = new CourseEngine();
    const drift = err({ crossTrackM: 0.8, headingErrorDeg: 8, roadSide: 'RIGHT' });
    const first = run(eng, 0, 3000, 50, drift);
    expect(first.deviations).toHaveLength(1);
    expect(first.deviations[0]).toMatchObject({ side: 'RIGHT', meters: 0.8 });
    run(eng, 3050, 5000, 50, err());                            // episode ends
    const second = run(eng, 5050, 8000, 50, drift);
    expect(second.deviations).toHaveLength(1);
  });

  it('speaks a side hint after 5 s of buzzing, once per 8 s, and not while the beacon is active', () => {
    const eng = new CourseEngine();
    const r = run(eng, 0, 20_000, 100, err({ headingErrorDeg: 40 }));
    const hints = r.speaks.filter((s) => s.key.startsWith('course_hint'));
    expect(hints.length).toBeGreaterThanOrEqual(2);
    expect(hints[0].key).toBe('course_hint_left');              // pointed right of target → bear left
    expect(hints[0].t).toBeGreaterThan(HYSTERESIS_MS + SIDE_HINT_AFTER_MS);
    expect(hints[1].t - hints[0].t).toBeGreaterThanOrEqual(SIDE_HINT_COOLDOWN_MS);

    const withBeacon = new CourseEngine({ beaconActive: () => true });
    const b = run(withBeacon, 0, 20_000, 100, err({ headingErrorDeg: -40 }));
    expect(b.speaks.filter((s) => s.key.startsWith('course_hint'))).toEqual([]);

    const right = new CourseEngine();
    const rr = run(right, 0, 8000, 100, err({ headingErrorDeg: -40 }));
    expect(rr.speaks[0]?.key).toBe('course_hint_right');
  });
});

// ---------------------------------------------------------------------------
// Service: discrete patterns and the poll loop, fake backend + fake timers
// ---------------------------------------------------------------------------

interface Recorded { t: number; kind: 'impact' | 'error'; style?: PulseStyle }

function fakeBackend(): HapticBackend & { log: Recorded[] } {
  const log: Recorded[] = [];
  return {
    log,
    impact(style) { log.push({ t: Date.now(), kind: 'impact', style }); },
    notificationError() { log.push({ t: Date.now(), kind: 'error' }); },
  };
}

describe('createHapticService', () => {
  let bus: AppEventBus;
  let store: AppStore;
  let said: Array<{ text: string; cacheKey?: string; priority: string }>;
  const speech = () => ({
    say: (r: { text: string; cacheKey?: string; priority: string }) => { said.push(r); },
    playStream: () => {}, clearQueue: () => {}, isSpeaking: () => false, setRate: () => {},
  });

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    bus = createEventBus();
    store = createAppStore({ bus, warn: () => {} });
    said = [];
  });
  afterEach(() => jest.useRealTimers());

  it('TURN is Light → Medium → Heavy 110 ms apart', () => {
    const be = fakeBackend();
    const h = createHapticService({ backend: be, store });
    store.getState().setTrainingMode(false);
    h.play('TURN');
    jest.advanceTimersByTime(300);
    expect(be.log).toEqual([
      { t: 0, kind: 'impact', style: 'Light' },
      { t: TURN_SEQUENCE_MS[1], kind: 'impact', style: 'Medium' },
      { t: TURN_SEQUENCE_MS[2], kind: 'impact', style: 'Heavy' },
    ]);
    h.dispose();
  });

  it('STOP is notification(Error) + three Heavy 70 ms apart; CONFIRM is one Light', () => {
    const be = fakeBackend();
    const h = createHapticService({ backend: be, store });
    store.getState().setTrainingMode(false);
    h.play('STOP');
    jest.advanceTimersByTime(200);
    expect(be.log).toEqual([
      { t: 0, kind: 'error' },
      { t: 0, kind: 'impact', style: 'Heavy' },
      { t: STOP_SEQUENCE_MS[1], kind: 'impact', style: 'Heavy' },
      { t: STOP_SEQUENCE_MS[2], kind: 'impact', style: 'Heavy' },
    ]);
    be.log.length = 0;
    h.play('CONFIRM');
    expect(be.log).toEqual([{ t: 200, kind: 'impact', style: 'Light' }]);
    h.dispose();
  });

  it('play() is synchronous: the first impact fires in the same tick (< 100 ms budget)', () => {
    const be = fakeBackend();
    const h = createHapticService({ backend: be, store });
    h.play('TURN');
    expect(be.log[0]).toEqual({ t: 0, kind: 'impact', style: 'Light' });
    h.dispose();
  });

  it('training mode pairs each pattern with its one-word label at INFO', () => {
    const be = fakeBackend();
    const h = createHapticService({ backend: be, store, speech });
    expect(store.getState().trainingMode).toBe(true);
    h.play('TURN'); h.play('STOP'); h.play('CONFIRM');
    expect(said.map((s) => s.cacheKey)).toEqual(['label_turn', 'label_stop', 'label_okay']);
    expect(said.every((s) => s.priority === 'INFO')).toBe(true);
    said = [];
    store.getState().setTrainingMode(false);
    h.play('TURN');
    expect(said).toEqual([]);
    h.dispose();
  });

  it('COURSE polls at ≥ 10 Hz, stays silent on course, buzzes after 0.5 s off course', () => {
    const be = fakeBackend();
    const h = createHapticService({ backend: be, store, bus });
    store.getState().setTrainingMode(false);
    let e = err({ headingErrorDeg: 0 });
    h.startCourse(() => e);
    jest.advanceTimersByTime(3000);
    expect(be.log).toEqual([]);
    expect(h.isCourseRunning()).toBe(true);
    expect(h.isCourseBuzzing()).toBe(false);

    e = err({ headingErrorDeg: 60 });
    jest.advanceTimersByTime(HYSTERESIS_MS - 50);
    expect(be.log).toEqual([]);
    jest.advanceTimersByTime(100);
    expect(be.log.length).toBeGreaterThanOrEqual(1);
    expect(h.isCourseBuzzing()).toBe(true);
    expect(be.log[0].style).toBe('Heavy');

    // Back on course: buzz ends after the 0.5 s hysteresis.
    e = err({ headingErrorDeg: 0 });
    jest.advanceTimersByTime(HYSTERESIS_MS + 100);
    expect(h.isCourseBuzzing()).toBe(false);
    const n = be.log.length;
    jest.advanceTimersByTime(2000);
    expect(be.log.length).toBe(n);
    h.stopCourse();
    expect(h.isCourseRunning()).toBe(false);
    h.dispose();
  });

  it('STOP during COURSE pre-empts the pulses for 1 s', () => {
    const be = fakeBackend();
    const h = createHapticService({ backend: be, store });
    store.getState().setTrainingMode(false);
    h.startCourse(() => err({ headingErrorDeg: 60 }));
    jest.advanceTimersByTime(1500);
    be.log.length = 0;
    h.play('STOP');
    jest.advanceTimersByTime(STOP_PREEMPT_MS - 100);
    // Only the STOP burst itself, no course pulses.
    expect(be.log.filter((r) => r.kind === 'error')).toHaveLength(1);
    expect(be.log.filter((r) => r.kind === 'impact')).toHaveLength(3);
    jest.advanceTimersByTime(600);
    expect(be.log.filter((r) => r.kind === 'impact').length).toBeGreaterThan(3);
    h.dispose();
  });

  it('speaks compass_uncertain through the speech service and emits COURSE_DEVIATION on the bus', () => {
    const be = fakeBackend();
    const h = createHapticService({ backend: be, store, bus, speech });
    store.getState().setTrainingMode(false);
    const events: string[] = [];
    bus.on('COURSE_DEVIATION', (ev) => events.push(`${ev.side}:${ev.meters}`));
    let e = err({ headingErrorDeg: 50, compassAccuracy: 1 });
    h.startCourse(() => e);
    jest.advanceTimersByTime(200);
    expect(said.map((s) => s.cacheKey)).toEqual(['compass_uncertain']);
    expect(be.log).toEqual([]);
    e = err({ crossTrackM: 1, headingErrorDeg: 8, roadSide: 'LEFT' });   // drifting right, road on the left → no
    jest.advanceTimersByTime(1500);
    expect(events).toEqual([]);
    e = err({ crossTrackM: -1, headingErrorDeg: -2, roadSide: 'LEFT' });  // toward the road but pointed straight: GPS noise → no
    jest.advanceTimersByTime(1500);
    expect(events).toEqual([]);
    e = err({ crossTrackM: -1, headingErrorDeg: -8, roadSide: 'LEFT' }); // drifting left toward the road, heading left → yes
    jest.advanceTimersByTime(1500);
    expect(events).toEqual(['LEFT:1']);
    h.dispose();
  });

  it('suspends the poll during push-to-talk and keeps state', () => {
    const be = fakeBackend();
    const h = createHapticService({ backend: be, store });
    store.getState().setTrainingMode(false);
    h.startCourse(() => err({ headingErrorDeg: 60 }));
    jest.advanceTimersByTime(1500);
    h.setSuspended(true);
    const n = be.log.length;
    jest.advanceTimersByTime(2000);
    expect(be.log.length).toBe(n);
    expect(h.isCourseBuzzing()).toBe(false);
    expect(h.getDebugState().suspended).toBe(true);
    h.setSuspended(false);
    jest.advanceTimersByTime(500);
    expect(be.log.length).toBeGreaterThan(n);
    h.dispose();
  });

  it('a throwing producer never kills the loop', () => {
    const be = fakeBackend();
    const h = createHapticService({ backend: be, store });
    store.getState().setTrainingMode(false);
    let calls = 0;
    h.startCourse(() => {
      calls += 1;
      if (calls < 5) throw new Error('sensor not ready');
      return err({ headingErrorDeg: 60 });
    });
    jest.advanceTimersByTime(1500);
    expect(calls).toBeGreaterThan(5);
    expect(be.log.length).toBeGreaterThan(0);
    h.dispose();
  });
});
