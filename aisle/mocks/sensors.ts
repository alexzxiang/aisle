/**
 * Mock SensorService (01 §4) — replays fixtures/track.json.
 *
 * Every §4 method works. Heading, location and steps come from the track at its
 * `hz`; pose is re-emitted from the perception mock (`attachPoseSource`).
 * `courseErrorFor` computes a real CourseError from the replayed heading and fix
 * against the target bearing and line, so A's COURSE buzz is exercised, not stubbed.
 *
 * Playback: play / pause / scrub / speed / jumpToPhase through `controls`. A phase
 * jump only seeks (and tells `onJump` listeners); the legal event chain that moves
 * A's store and the perception pack are applied by the harness (`mocks/index.ts`).
 *
 * Timers: none. The harness calls `controls.tick()` at ~20 Hz (mocks/index.ts).
 */
import type {
  CompassAccuracy,
  CourseError,
  GeoFix,
  HeadingSample,
  Pose,
  SensorService,
} from '../src/core/contracts';
import { crossTrackM, signedDeltaDeg } from '../src/transition/geo';
import type { ReplayClock } from './clock';
import { type PhaseSpec, type ReplayPhase, type TrackFixture, type TrackSample, sampleIndexAt, trackDurationS } from './track';

export const CALIBRATION_REPLAY_MS = 5000;

export interface TrackControls {
  play(): void;
  pause(): void;
  isPlaying(): boolean;
  /** Seek to a track second. Emits the sample at/just before it immediately. */
  scrub(seconds: number): void;
  setSpeed(x: 1 | 4 | number): void;
  getSpeed(): number;
  getTimeS(): number;
  getDurationS(): number;
  /** Seek to the phase's track time. Returns the PhaseSpec (or null when the track has no entry). */
  jumpToPhase(phase: ReplayPhase): PhaseSpec | null;
  onJump(cb: (phase: ReplayPhase, spec: PhaseSpec) => void): () => void;
  currentSample(): TrackSample | null;
  currentIndex(): number;
  phases(): Partial<Record<ReplayPhase, PhaseSpec>>;
  /** Advance the replayer to the clock's time; emits every sample passed. */
  tick(): void;
}

export interface MockSensorService extends SensorService {
  controls: TrackControls;
  /** Wire the perception mock's onPose so subscribePose re-emits (01 §4). */
  attachPoseSource(subscribe: (cb: (p: Pose) => void) => () => void): () => void;
  setBodyOffsetDeg(deg: number): void;
}

export interface MockSensorOptions {
  track: TrackFixture;
  clock: ReplayClock;
  /** Wall clock for timestamps on emitted samples. Default Date.now. */
  wall?: () => number;
  /** Compass tier below which the heading is not trusted for fusion (01 §2: below 2 → no course buzz). */
  minTrustedAccuracy?: CompassAccuracy;
}

export function createMockSensorService(opts: MockSensorOptions): MockSensorService {
  const { track, clock } = opts;
  const wall = opts.wall ?? Date.now;
  const minTrusted: CompassAccuracy = opts.minTrustedAccuracy ?? 2;

  const headingSubs = new Set<(h: HeadingSample) => void>();
  const locationSubs = new Set<(f: GeoFix) => void>();
  const stepSubs = new Set<(n: number) => void>();
  const poseSubs = new Set<(p: Pose) => void>();
  const jumpSubs = new Set<(phase: ReplayPhase, spec: PhaseSpec) => void>();

  let cursor = -1;                       // index of the last emitted sample
  let lastHeading: HeadingSample | null = null;
  let lastFix: GeoFix | null = null;
  let lastSteps = 0;
  let lastPose: Pose | null = null;
  let bodyOffsetDeg = 0;
  const stepHistory: Array<{ ts: number; steps: number }> = [];
  const pendingCalibrations: Array<{ dueMs: number; resolve: (r: { offsetDeg: number; ok: boolean }) => void }> = [];

  const emitSample = (s: TrackSample): void => {
    const ts = wall();
    lastHeading = { trueHeadingDeg: s.heading.trueHeadingDeg, accuracy: s.heading.accuracy, timestamp: ts };
    lastFix = { lat: s.lat, lng: s.lng, accuracyM: s.accuracyM, courseDeg: s.courseDeg, speedMps: s.speedMps, timestamp: ts };
    const stepsChanged = s.steps !== lastSteps || cursor < 0;
    lastSteps = s.steps;
    stepHistory.push({ ts, steps: s.steps });
    if (stepHistory.length > 4096) stepHistory.splice(0, stepHistory.length - 4096);
    for (const cb of Array.from(headingSubs)) cb(lastHeading);
    for (const cb of Array.from(locationSubs)) cb(lastFix);
    // Like Pedometer.watchStepCount, steps fire only when the count changes: a standing user
    // produces no step callbacks, which is what B's curb-stillness rule (2 s, no step) needs.
    if (stepsChanged) for (const cb of Array.from(stepSubs)) cb(lastSteps);
  };

  const tick = (): void => {
    const nowS = clock.nowMs() / 1000;
    const target = sampleIndexAt(track, nowS);
    while (cursor < target) {
      cursor += 1;
      emitSample(track.samples[cursor]!);
    }
    const nowMs = clock.nowMs();
    for (let i = pendingCalibrations.length - 1; i >= 0; i -= 1) {
      if (nowMs >= pendingCalibrations[i]!.dueMs) {
        pendingCalibrations[i]!.resolve({ offsetDeg: 0, ok: true });
        pendingCalibrations.splice(i, 1);
      }
    }
  };

  const resetCursorTo = (seconds: number): void => {
    const idx = sampleIndexAt(track, seconds);
    cursor = idx;
    if (idx >= 0) emitSample(track.samples[idx]!);
  };

  clock.onSeek((ms) => resetCursorTo(ms / 1000));

  const fusedHeading = (): number | null => {
    const h = lastHeading;
    if (h && h.accuracy >= minTrusted) return (h.trueHeadingDeg + bodyOffsetDeg + 360) % 360;
    if (lastPose && lastPose.trackingState === 'NORMAL') return (lastPose.yawDeg + 360) % 360;
    return null;
  };

  const controls: TrackControls = {
    play: () => clock.play(),
    pause: () => clock.pause(),
    isPlaying: () => clock.isPlaying(),
    scrub: (seconds) => clock.seek(Math.max(0, Math.min(trackDurationS(track), seconds)) * 1000),
    setSpeed: (x) => clock.setSpeed(x),
    getSpeed: () => clock.speed(),
    getTimeS: () => clock.nowMs() / 1000,
    getDurationS: () => trackDurationS(track),
    jumpToPhase(phase) {
      const spec = track.phases?.[phase];
      if (!spec) return null;
      clock.seek(spec.t * 1000);
      for (const cb of Array.from(jumpSubs)) cb(phase, spec);
      return spec;
    },
    onJump(cb) {
      jumpSubs.add(cb);
      return () => {
        jumpSubs.delete(cb);
      };
    },
    currentSample: () => (cursor >= 0 ? track.samples[cursor]! : null),
    currentIndex: () => cursor,
    phases: () => track.phases ?? {},
    tick,
  };

  const service: MockSensorService = {
    controls,

    subscribeHeading(cb) {
      headingSubs.add(cb);
      if (lastHeading) cb(lastHeading);
      return () => {
        headingSubs.delete(cb);
      };
    },
    subscribeLocation(cb) {
      locationSubs.add(cb);
      if (lastFix) cb(lastFix);
      return () => {
        locationSubs.delete(cb);
      };
    },
    subscribeSteps(cb) {
      stepSubs.add(cb);
      cb(lastSteps);
      return () => {
        stepSubs.delete(cb);
      };
    },
    subscribePose(cb) {
      poseSubs.add(cb);
      if (lastPose) cb(lastPose);
      return () => {
        poseSubs.delete(cb);
      };
    },
    getHeading: () => lastHeading,
    getFusedHeadingDeg: fusedHeading,
    getLastFix: () => lastFix,
    getStepsSince(timestamp) {
      let base: number | null = null;
      for (const h of stepHistory) {
        if (h.ts <= timestamp) base = h.steps;
        else break;
      }
      if (base === null) base = stepHistory.length ? stepHistory[0]!.steps : lastSteps;
      return Math.max(0, lastSteps - base);
    },
    calibrateBodyOffset() {
      return new Promise((resolve) => {
        pendingCalibrations.push({ dueMs: clock.nowMs() + CALIBRATION_REPLAY_MS, resolve });
      });
    },
    courseErrorFor(target) {
      let readBearing: () => number;
      if (typeof target.bearingDeg === 'function') {
        readBearing = target.bearingDeg;
      } else {
        const bearing = target.bearingDeg;
        readBearing = () => bearing;
      }
      return (): CourseError => {
        const h = lastHeading;
        const heading = h ? (h.trueHeadingDeg + bodyOffsetDeg + 360) % 360 : null;
        const headingErrorDeg = heading === null ? 0 : signedDeltaDeg(heading, readBearing());
        const ct = lastFix && target.line && target.line.length >= 2 ? crossTrackM(lastFix, target.line) : 0;
        return {
          headingErrorDeg: Math.round(headingErrorDeg * 10) / 10,
          crossTrackM: Math.round(ct * 100) / 100,
          roadSide: target.roadSide,
          compassAccuracy: h ? h.accuracy : 0,
        };
      };
    },

    attachPoseSource(subscribe) {
      return subscribe((p) => {
        lastPose = p;
        for (const cb of Array.from(poseSubs)) cb(p);
      });
    },
    setBodyOffsetDeg(deg) {
      bodyOffsetDeg = deg;
    },
  };

  return service;
}
