/**
 * Mock PerceptionService (01 §7) — replays fixtures/perception/*.jsonl.
 *
 * One line per native event (`{"t": ms, "event": "onX", "payload": ...}`), the same
 * format the Swift module's debug export writes (09 §10), so recordings from the
 * demo phone drop in without touching this file. The replayer re-bases pack time to
 * the shared replay clock, honours the §7 rate limits, skips malformed lines and
 * unknown events (counted in `debug()`), and never opens a camera.
 *
 * `start(profile)` / `setProfile(profile)` arm the pack for that profile (see
 * DEFAULT_PROFILE_PACKS); `selectPack(name, offsetMs)` overrides it (DebugPanel and
 * jump-to-phase). `setCrossingBearing`, `setCourseReference`, `setBodyOffsetDeg`,
 * `setKnownSigns` are recorded for the DebugPanel and do not change playback.
 *
 * `snapshotJPEG(maxWidth)` returns fixtures/frames/<seq>.jpg from the frames index;
 * without a frame for the seq it returns the last one. Re-encoding to the requested
 * width needs a native image library the app does not have, so the returned
 * `width`/`height` are the file's real dimensions (honest, not the requested ones).
 */
import type {
  DepthSummary,
  Detection,
  Direction,
  DistanceClass,
  HazardKind,
  ModeProfile,
  OcrRead,
  PerceptionService,
  Pose,
  SignalState,
  Snapshot,
  TrackingState,
} from '../src/core/contracts';
import type { ReplayClock } from './clock';
import { type ParsedPack, type PerceptionLine, parseJsonl } from './jsonl';
import { createRateLimiter } from './rateLimit';

export const KNOWN_EVENTS = [
  'onSignalState', 'onVehicleApproaching', 'onObstacleAhead', 'onHazard', 'onOcrText',
  'onDetections', 'onPose', 'onLateralOffset', 'onPlanes', 'onDepth', 'onTrackingState',
] as const;
export type KnownEvent = (typeof KNOWN_EVENTS)[number];

export const DEFAULT_PROFILE_PACKS: Readonly<Record<ModeProfile, string | null>> = Object.freeze({
  IDLE: null,
  OUTDOOR_NAV: 'outdoor-leg',
  APPROACH_CROSSING: 'curb-walk-onset',
  CROSSING: 'vehicle-approach',
  INDOOR_NAV: 'indoor-aisle-walk',
  ITEM_PICKUP: 'indoor-aisle-walk',
});

export interface FrameEntry {
  base64: string;
  width: number;
  height: number;
}

export interface PerceptionDebugState {
  running: boolean;
  profile: ModeProfile;
  pack: string | null;
  packTimeMs: number;
  packLines: number;
  skippedLines: number;
  unknownEvents: number;
  emitted: number;
  crossingBearingDeg: number | null;
  courseReference: { bearingDeg: number } | null;
  bodyOffsetDeg: number;
  knownSigns: string[];
  trackingState: TrackingState;
  forcedSignal: { state: SignalState; fresh: boolean } | null;
}

export interface MockPerceptionService extends PerceptionService {
  /** Arm a pack by name at an offset (ms into the pack). Unknown name → throws. */
  selectPack(name: string, offsetMs?: number): void;
  packNames(): string[];
  currentPack(): string | null;
  /** Emit everything due up to the clock's time. Called by the harness at ~20 Hz. */
  tick(): void;
  /** DebugPanel: manual signal state injected through onSignalState (null releases). */
  forceSignalState(state: SignalState | null, fresh?: boolean): void;
  debug(): PerceptionDebugState;
}

export interface MockPerceptionOptions {
  /** pack name → raw jsonl text (fixtures/perception/index.json) or pre-parsed lines. */
  packs: Record<string, string | PerceptionLine[]>;
  clock: ReplayClock;
  frames?: Record<string, FrameEntry>;
  profilePacks?: Partial<Record<ModeProfile, string | null>>;
  stats?: Partial<ReturnType<PerceptionService['getStats']>>;
  wall?: () => number;
}

type Listener<T> = (e: T) => void;

export function createMockPerceptionService(opts: MockPerceptionOptions): MockPerceptionService {
  const { clock } = opts;
  const wall = opts.wall ?? Date.now;
  const profilePacks = { ...DEFAULT_PROFILE_PACKS, ...(opts.profilePacks ?? {}) };
  const parsed = new Map<string, ParsedPack>();
  for (const [name, src] of Object.entries(opts.packs)) {
    parsed.set(name, typeof src === 'string' ? parseJsonl(src) : { lines: [...src].sort((a, b) => a.t - b.t), skipped: [] });
  }
  const frames = opts.frames ?? {};
  const limiter = createRateLimiter();

  const subs = new Map<KnownEvent, Set<Listener<unknown>>>();
  for (const e of KNOWN_EVENTS) subs.set(e, new Set());
  const on = <T,>(event: KnownEvent) => (cb: Listener<T>): (() => void) => {
    const set = subs.get(event)!;
    set.add(cb as Listener<unknown>);
    return () => {
      set.delete(cb as Listener<unknown>);
    };
  };
  const dispatch = (event: KnownEvent, payload: unknown): void => {
    for (const cb of Array.from(subs.get(event)!)) cb(payload);
  };

  let running = false;
  let profile: ModeProfile = 'IDLE';
  let pack: string | null = null;
  let packStartReplayMs = 0;     // replay-clock ms at which pack t=0 sits
  let cursor = 0;                // next line index
  let unknownEvents = 0;
  let emitted = 0;
  let snapshotSeq = 0;
  let trackingState: TrackingState = 'NOT_AVAILABLE';
  let lastSignal: SignalState | null = null;
  let forcedSignal: { state: SignalState; fresh: boolean } | null = null;
  let crossingBearingDeg: number | null = null;
  let courseReference: { bearingDeg: number } | null = null;
  let bodyOffsetDeg = 0;
  let knownSigns: string[] = [];

  const packTimeMs = (): number => clock.nowMs() - packStartReplayMs;

  const cursorTo = (ms: number): void => {
    const lines = pack ? parsed.get(pack)!.lines : [];
    let i = 0;
    while (i < lines.length && lines[i]!.t < ms) i += 1;
    cursor = i;
    limiter.reset();
    lastSignal = null;
  };

  const arm = (name: string | null, offsetMs = 0): void => {
    if (name !== null && !parsed.has(name)) throw new Error(`[mock perception] unknown pack '${name}'`);
    pack = name;
    packStartReplayMs = clock.nowMs() - offsetMs;
    cursorTo(offsetMs);
  };

  // A clock seek keeps the pack's alignment to replay time (the harness re-arms on phase jumps).
  clock.onSeek(() => {
    cursorTo(packTimeMs());
  });

  const emitLine = (line: PerceptionLine): void => {
    if (!(KNOWN_EVENTS as readonly string[]).includes(line.event)) {
      unknownEvents += 1;
      return;
    }
    const event = line.event as KnownEvent;
    if (forcedSignal && event === 'onSignalState') return; // manual override wins
    const at = line.t;
    let key: string | number | undefined;
    let bypass = false;
    if (event === 'onVehicleApproaching') key = (line.payload as { trackId?: number } | null)?.trackId;
    if (event === 'onSignalState') {
      const state = (line.payload as { state?: SignalState } | null)?.state ?? null;
      bypass = state !== lastSignal;
      if (state) lastSignal = state;
    }
    if (event === 'onTrackingState') trackingState = line.payload as TrackingState;
    if (!limiter.allow(event, at, key, bypass)) return;
    emitted += 1;
    dispatch(event, line.payload);
  };

  let forcedHeartbeatAt = 0;
  const tick = (): void => {
    if (!running) return;
    if (forcedSignal) {
      // Manual override still heartbeats at 0.5 Hz so "UNKNOWN for 10 s" logic downstream keeps ticking.
      const now = clock.nowMs();
      if (now - forcedHeartbeatAt >= 2000) {
        forcedHeartbeatAt = now;
        dispatch('onSignalState', { state: forcedSignal.state, fresh: forcedSignal.fresh, confidence: 1, nOfM: 8 });
      }
    }
    if (!pack) return;
    const lines = parsed.get(pack)!.lines;
    const now = packTimeMs();
    while (cursor < lines.length && lines[cursor]!.t <= now) {
      emitLine(lines[cursor]!);
      cursor += 1;
    }
  };

  const stats = {
    detectorFps: 0,
    depthFps: 0,
    ocrFps: 0,
    frameToEventMs: 0,
    thermalState: 'mock (no device)',
    ...(opts.stats ?? {}),
  };

  const service: MockPerceptionService = {
    async start(p) {
      running = true;
      profile = p;
      arm(profilePacks[p] ?? null, 0);
    },
    setProfile(p) {
      profile = p;
      if (running) arm(profilePacks[p] ?? null, 0);
    },
    stop() {
      running = false;
      pack = null;
      trackingState = 'NOT_AVAILABLE';
    },

    setCrossingBearing(b) {
      crossingBearingDeg = b;
    },
    setCourseReference(ref) {
      courseReference = ref;
    },
    setBodyOffsetDeg(d) {
      bodyOffsetDeg = d;
    },
    setKnownSigns(words) {
      knownSigns = [...words];
    },

    onSignalState: on<{ state: SignalState; fresh: boolean; confidence: number; nOfM: number }>('onSignalState'),
    onVehicleApproaching: on<{ direction: Direction; trackId: number; growth: number }>('onVehicleApproaching'),
    onObstacleAhead: on<{ distanceClass: DistanceClass; direction: Direction }>('onObstacleAhead'),
    onHazard: on<{ kind: HazardKind; direction: Direction }>('onHazard'),
    onOcrText: on<OcrRead[]>('onOcrText'),
    onDetections: on<Detection[]>('onDetections'),
    onPose: on<Pose>('onPose'),
    onLateralOffset: on<{ offsetM: number; source: 'pose' | 'ocr_box' | 'shelf' | 'curb' | 'none' }>('onLateralOffset'),
    onPlanes: on<{ floors: number; verticals: number }>('onPlanes'),
    onDepth: on<DepthSummary>('onDepth'),
    onTrackingState: on<TrackingState>('onTrackingState'),

    async snapshotJPEG(): Promise<Snapshot> {
      snapshotSeq += 1;
      const keys = Object.keys(frames);
      const frame = frames[String(snapshotSeq)] ?? (keys.length ? frames[keys[keys.length - 1]!]! : null);
      if (!frame) {
        throw new Error('[mock perception] no frames in fixtures/frames/index.json');
      }
      return { base64: frame.base64, width: frame.width, height: frame.height, seq: snapshotSeq, timestamp: wall() };
    },
    getTrackingState: () => trackingState,
    getStats: () => ({ ...stats }),

    selectPack(name, offsetMs = 0) {
      arm(name, offsetMs);
    },
    packNames: () => Array.from(parsed.keys()),
    currentPack: () => pack,
    tick,
    forceSignalState(state, fresh = false) {
      if (state === null) {
        forcedSignal = null;
        return;
      }
      forcedSignal = { state, fresh };
      lastSignal = state;
      forcedHeartbeatAt = clock.nowMs();
      dispatch('onSignalState', { state, fresh, confidence: 1, nOfM: 8 });
    },
    debug() {
      const p = pack ? parsed.get(pack)! : null;
      return {
        running,
        profile,
        pack,
        packTimeMs: pack ? packTimeMs() : 0,
        packLines: p ? p.lines.length : 0,
        skippedLines: p ? p.skipped.length : 0,
        unknownEvents,
        emitted,
        crossingBearingDeg,
        courseReference,
        bodyOffsetDeg,
        knownSigns: [...knownSigns],
        trackingState,
        forcedSignal,
      };
    },
  };

  return service;
}
