/**
 * Controllable fakes for B's runtime tests (not used by the app). A's
 * `src/core/stubs.ts` stubs record calls but cannot emit; these can.
 */
import type {
  CourseError,
  Detection,
  GeoFix,
  HapticService,
  HeadingSample,
  PerceptionService,
  Pose,
  SensorService,
  SpeechPriority,
  SpeechRequest,
  SpeechService,
  VisionRequest,
  VisionResponse,
} from '../core/contracts';
import { createStubPerception } from '../core/stubs';

export interface FakeSensors extends SensorService {
  emitFix(fix: GeoFix): void;
  emitHeading(h: HeadingSample): void;
  emitSteps(total: number): void;
  emitPose(p: Pose): void;
  setHeading(deg: number | null, accuracy?: 0 | 1 | 2 | 3): void;
  /** Steps counter used by getStepsSince: steps recorded after `timestamp`. */
  addSteps(n: number, at: number): void;
}

export function createFakeSensors(): FakeSensors {
  const fixCbs = new Set<(f: GeoFix) => void>();
  const headingCbs = new Set<(h: HeadingSample) => void>();
  const stepCbs = new Set<(n: number) => void>();
  const poseCbs = new Set<(p: Pose) => void>();
  let heading: HeadingSample | null = null;
  let lastFix: GeoFix | null = null;
  const stepLog: number[] = [];
  return {
    subscribeHeading(cb) {
      headingCbs.add(cb);
      return () => headingCbs.delete(cb);
    },
    subscribeLocation(cb) {
      fixCbs.add(cb);
      return () => fixCbs.delete(cb);
    },
    subscribeSteps(cb) {
      stepCbs.add(cb);
      return () => stepCbs.delete(cb);
    },
    subscribePose(cb) {
      poseCbs.add(cb);
      return () => poseCbs.delete(cb);
    },
    getHeading: () => heading,
    getFusedHeadingDeg: () => heading?.trueHeadingDeg ?? null,
    getLastFix: () => lastFix,
    // Same semantics as core/sensors StepLog.since: a step sampled at exactly `ts` is the base, not counted.
    getStepsSince: (ts) => stepLog.filter((t) => t > ts).length,
    async calibrateBodyOffset() {
      return { offsetDeg: 0, ok: true };
    },
    courseErrorFor(target) {
      const err: CourseError = { headingErrorDeg: 0, crossTrackM: 0, roadSide: target.roadSide, compassAccuracy: 3 };
      return () => err;
    },
    emitFix(fix) {
      lastFix = fix;
      for (const cb of fixCbs) cb(fix);
    },
    emitHeading(h) {
      heading = h;
      for (const cb of headingCbs) cb(h);
    },
    emitSteps(total) {
      for (const cb of stepCbs) cb(total);
    },
    emitPose(p) {
      for (const cb of poseCbs) cb(p);
    },
    setHeading(deg, accuracy = 3) {
      heading = deg === null ? null : { trueHeadingDeg: deg, accuracy, timestamp: Date.now() };
    },
    addSteps(n, at) {
      for (let i = 0; i < n; i += 1) stepLog.push(at);
      for (const cb of stepCbs) cb(stepLog.length);
    },
  };
}

export interface FakePerception extends PerceptionService {
  calls: Array<{ method: string; args: unknown[] }>;
  emitDetections(d: Detection[]): void;
}

export function createFakePerception(): FakePerception {
  const base = createStubPerception();
  const calls: FakePerception['calls'] = [];
  const detCbs = new Set<(d: Detection[]) => void>();
  return {
    ...base,
    calls,
    setCrossingBearing(b) {
      calls.push({ method: 'setCrossingBearing', args: [b] });
    },
    setCourseReference(ref) {
      calls.push({ method: 'setCourseReference', args: [ref] });
    },
    onDetections(cb) {
      detCbs.add(cb);
      return () => detCbs.delete(cb);
    },
    async snapshotJPEG(maxWidth) {
      calls.push({ method: 'snapshotJPEG', args: [maxWidth] });
      return { base64: 'AAAA', width: maxWidth, height: Math.round(maxWidth * 0.75), seq: calls.length, timestamp: Date.now() };
    },
    emitDetections(d) {
      for (const cb of detCbs) cb(d);
    },
  };
}

export interface FakeSpeech extends SpeechService {
  said: SpeechRequest[];
  /** Every clearQueue(priority) call, in order. */
  cleared: Array<SpeechPriority | undefined>;
  texts(): string[];
  keys(): string[];
}

export function createFakeSpeech(): FakeSpeech {
  const said: SpeechRequest[] = [];
  const cleared: Array<SpeechPriority | undefined> = [];
  return {
    said,
    cleared,
    say(req) {
      said.push(req);
    },
    playStream() {},
    clearQueue(priority) {
      cleared.push(priority);
    },
    isSpeaking: () => false,
    setRate() {},
    texts: () => said.map((s) => s.text),
    keys: () => said.map((s) => s.cacheKey ?? `text:${s.text}`),
  };
}

export interface FakeHaptics extends HapticService {
  played: string[];
  courseTargets: Array<CourseError['roadSide']>;
  courseActive: boolean;
}

export function createFakeHaptics(): FakeHaptics {
  const h: FakeHaptics = {
    played: [],
    courseTargets: [],
    courseActive: false,
    play(p) {
      h.played.push(p);
    },
    startCourse(getError) {
      h.courseActive = true;
      h.courseTargets.push(getError().roadSide);
    },
    stopCourse() {
      h.courseActive = false;
    },
  };
  return h;
}

export interface FakeVision {
  requests: VisionRequest[];
  ask(req: VisionRequest): Promise<VisionResponse>;
  respondWith(fn: (req: VisionRequest) => Partial<VisionResponse>): void;
}

export function createFakeVision(): FakeVision {
  let responder: (req: VisionRequest) => Partial<VisionResponse> = () => ({});
  const requests: VisionRequest[] = [];
  return {
    requests,
    async ask(req) {
      requests.push(req);
      const partial = responder(req);
      return {
        speech: '',
        cameraRequest: 'none',
        userAction: 'none',
        aisle: { matchedAisleId: null, matchedLandmarkId: null, confidence: 0 },
        storefront: { visible: false, confidence: 0 },
        scan: { vehiclesSeen: 'none', confidence: 0.9 },
        signal: { state: 'UNKNOWN', confidence: 0 },
        hand: { hint: 'not_seen' },
        task: { done: false, confidence: 0 },
        confidence: 0.9,
        seq: req.seq,
        ...partial,
      };
    },
    respondWith(fn) {
      responder = fn;
    },
  };
}

export function fix(lat: number, lng: number, opts: Partial<GeoFix> = {}): GeoFix {
  return { lat, lng, accuracyM: 8, courseDeg: null, speedMps: 1.2, timestamp: Date.now(), ...opts };
}
