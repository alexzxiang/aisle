/**
 * No-op service stubs (02 "Hour-one deliverable" item 2).
 *
 * Every call logs once, at debug level, with a timestamp — so a stub that is
 * still wired in on integration day is visible, never silent. The EventBus is
 * the real one (`createEventBus`); everything else is inert and honest:
 * `calibrateBodyOffset` reports `ok: false`, tracking is `NOT_AVAILABLE`,
 * snapshots are a 1×1 placeholder.
 *
 * Logging is silenced under Jest and can be toggled with `setStubLogging`.
 */
import type {
  CourseError,
  HapticService,
  ModeProfile,
  PerceptionService,
  SensorService,
  Snapshot,
  SpeechService,
  TrackingState,
} from './contracts';
import { createEventBus, type AppEventBus, type EventBusOptions } from './bus';

let logging = typeof process === 'undefined' || !process.env.JEST_WORKER_ID;

export function setStubLogging(enabled: boolean): void {
  logging = enabled;
}

function stubLog(service: string, method: string, ...args: unknown[]): void {
  if (!logging) return;
  console.debug(`[stub ${new Date().toISOString()}] ${service}.${method}`, ...args);
}

/** Records calls so tests can assert what a consumer asked for. */
export interface CallLog {
  calls: Array<{ service: string; method: string; args: unknown[]; ts: number }>;
  clear(): void;
}

export function createCallLog(): CallLog {
  const calls: CallLog['calls'] = [];
  return {
    calls,
    clear: () => {
      calls.length = 0;
    },
  };
}

function record(log: CallLog | undefined, service: string, method: string, args: unknown[]): void {
  stubLog(service, method, ...args);
  log?.calls.push({ service, method, args, ts: Date.now() });
}

// ---------------------------------------------------------------------------

export function createStubHaptics(log?: CallLog): HapticService {
  let courseActive = false;
  return {
    play(pattern) {
      record(log, 'haptics', 'play', [pattern]);
    },
    startCourse(getError: () => CourseError) {
      courseActive = true;
      record(log, 'haptics', 'startCourse', [typeof getError]);
    },
    stopCourse() {
      if (courseActive) record(log, 'haptics', 'stopCourse', []);
      courseActive = false;
    },
  };
}

export function createStubSpeech(log?: CallLog): SpeechService {
  return {
    say(req) {
      record(log, 'speech', 'say', [req]);
    },
    playStream(streamId, priority) {
      record(log, 'speech', 'playStream', [streamId, priority]);
    },
    clearQueue(priority) {
      record(log, 'speech', 'clearQueue', [priority]);
    },
    isSpeaking() {
      return false;
    },
    setRate(rate) {
      record(log, 'speech', 'setRate', [rate]);
    },
  };
}

const noop = (): void => {};

export function createStubSensors(log?: CallLog): SensorService {
  return {
    subscribeHeading(cb) {
      record(log, 'sensors', 'subscribeHeading', [typeof cb]);
      return noop;
    },
    subscribeLocation(cb) {
      record(log, 'sensors', 'subscribeLocation', [typeof cb]);
      return noop;
    },
    subscribeSteps(cb) {
      record(log, 'sensors', 'subscribeSteps', [typeof cb]);
      return noop;
    },
    subscribePose(cb) {
      record(log, 'sensors', 'subscribePose', [typeof cb]);
      return noop;
    },
    getHeading() {
      return null;
    },
    getFusedHeadingDeg() {
      return null;
    },
    getLastFix() {
      return null;
    },
    getStepsSince() {
      return 0;
    },
    async calibrateBodyOffset() {
      record(log, 'sensors', 'calibrateBodyOffset', []);
      return { offsetDeg: 0, ok: false };
    },
    courseErrorFor(target) {
      record(log, 'sensors', 'courseErrorFor', [target]);
      const err: CourseError = {
        headingErrorDeg: 0,
        crossTrackM: 0,
        roadSide: target.roadSide,
        compassAccuracy: 0,
      };
      return () => err;
    },
  };
}

/** 1×1 transparent PNG; real snapshots are JPEG but callers only look at base64/size/seq. */
const PLACEHOLDER_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

export function createStubPerception(log?: CallLog): PerceptionService {
  let profile: ModeProfile = 'IDLE';
  let running = false;
  let seq = 0;
  const tracking: TrackingState = 'NOT_AVAILABLE';
  const sub = (name: string) => (cb: unknown) => {
    record(log, 'perception', name, [typeof cb]);
    return noop;
  };
  return {
    async start(p) {
      profile = p;
      running = true;
      record(log, 'perception', 'start', [p]);
    },
    setProfile(p) {
      profile = p;
      record(log, 'perception', 'setProfile', [p]);
    },
    stop() {
      if (running) record(log, 'perception', 'stop', [profile]);
      running = false;
    },
    setCrossingBearing(b) {
      record(log, 'perception', 'setCrossingBearing', [b]);
    },
    setCourseReference(ref) {
      record(log, 'perception', 'setCourseReference', [ref]);
    },
    setBodyOffsetDeg(d) {
      record(log, 'perception', 'setBodyOffsetDeg', [d]);
    },
    setKnownSigns(words) {
      record(log, 'perception', 'setKnownSigns', [words]);
    },
    onSignalState: sub('onSignalState'),
    onVehicleApproaching: sub('onVehicleApproaching'),
    onObstacleAhead: sub('onObstacleAhead'),
    onHazard: sub('onHazard'),
    onOcrText: sub('onOcrText'),
    onDetections: sub('onDetections'),
    onPose: sub('onPose'),
    onLateralOffset: sub('onLateralOffset'),
    onPlanes: sub('onPlanes'),
    onDepth: sub('onDepth'),
    onTrackingState: sub('onTrackingState'),
    onSceneClass: sub('onSceneClass'),
    onHandPose: sub('onHandPose'),
    async snapshotJPEG(maxWidth) {
      seq += 1;
      record(log, 'perception', 'snapshotJPEG', [maxWidth]);
      const snap: Snapshot = { base64: PLACEHOLDER_BASE64, width: 1, height: 1, seq, timestamp: Date.now() };
      return snap;
    },
    getTrackingState() {
      return tracking;
    },
    getStats() {
      return { detectorFps: 0, depthFps: 0, ocrFps: 0, frameToEventMs: 0, thermalState: 'nominal' };
    },
  };
}

/** The bus is never stubbed: everyone needs a working one on hour one. */
export function createStubBus(opts?: EventBusOptions): AppEventBus {
  return createEventBus(opts);
}

export interface StubServices {
  haptics: HapticService;
  speech: SpeechService;
  sensors: SensorService;
  perception: PerceptionService;
  bus: AppEventBus;
  log: CallLog;
}

/** Everything at once, sharing one call log — handy for tests and the pre-integration shell. */
export function createStubServices(): StubServices {
  const log = createCallLog();
  return {
    haptics: createStubHaptics(log),
    speech: createStubSpeech(log),
    sensors: createStubSensors(log),
    perception: createStubPerception(log),
    bus: createStubBus(),
    log,
  };
}
