/**
 * Mock PerceptionService (01 §7) — replays fixtures/perception/*.jsonl.
 *
 * One line per native event (`{"t": ms, "event": "onX", "payload": ...}`), the same
 * format the Swift module's debug export writes (09 §10), so recordings from the
 * demo phone drop in without touching this file. The replayer re-bases pack time to
 * the shared replay clock, honours the §7 rate limits, skips malformed lines and
 * unknown events (counted in `debug()`), and never opens a camera.
 *
 * Pack selection has two sources, so the same replayer serves a bare unit test and
 * the composed app:
 *  - profile-driven (default): `start(profile)` / `setProfile(profile)` arm the pack
 *    for that ModeProfile (DEFAULT_PROFILE_PACKS);
 *  - mode-driven: once the harness calls `setAppMode(mode)` (it does when A's store is
 *    bridged), packs are keyed by AppMode (DEFAULT_MODE_PACKS) and `setProfile` only
 *    records the profile. AT_CURB shares the APPROACH_CROSSING profile (01 §7), so
 *    only a mode edge can arm the curb pack at the curb instead of 25 m out.
 * `selectPack(name, offsetMs)` (DebugPanel, jump-to-phase) pins its choice until the
 * next mode / profile change, so the edges a jump's own event chain produces cannot
 * clobber the phase's pack and offset. `setCrossingBearing`, `setCourseReference`,
 * `setBodyOffsetDeg`, `setKnownSigns` are recorded for the DebugPanel and do not
 * change playback.
 *
 * `snapshotJPEG(maxWidth)` returns fixtures/frames/<seq>.jpg from the frames index;
 * without a frame for the seq it returns the last one. Re-encoding to the requested
 * width needs a native image library the app does not have, so the returned
 * `width`/`height` are the file's real dimensions (honest, not the requested ones).
 */
import type {
  AppMode,
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

/** `{ keep: true }` leaves whatever is armed running across the edge (the curb pack keeps playing while crossing). */
export type ModePackRule = string | null | { readonly keep: true };
export const KEEP_PACK: ModePackRule = Object.freeze({ keep: true });

/**
 * Default packs by AppMode (used once the harness reports modes). The approach plays
 * the vehicle pack; the curb pack starts on the AT_CURB edge so its WALK onset (12 s in)
 * lands while the controller is READING; CROSSING keeps it (COUNTDOWN, DONT_WALK) and
 * the indoor modes keep the aisle walk that INDOOR_NAV started.
 */
export const DEFAULT_MODE_PACKS: Readonly<Record<AppMode, ModePackRule>> = Object.freeze({
  IDLE: null,
  ONBOARDING: null,
  OUTDOOR_NAV: 'outdoor-leg',
  APPROACH_CROSSING: 'vehicle-approach',
  AT_CURB: 'curb-walk-onset',
  CROSSING: KEEP_PACK,
  TRANSITION: 'outdoor-leg',
  INDOOR_NAV: 'indoor-aisle-walk',
  AT_ITEM: KEEP_PACK,
  ITEM_PICKUP: KEEP_PACK,
  CHECKOUT_NAV: KEEP_PACK,
  DONE: null,
  GUIDED_TASK: 'indoor-aisle-walk',   // any indoor-ish frames: the guided loop only needs detections + a snapshot
});

/** 01 §7: AppMode → ModeProfile (AT_CURB shares the approach profile; TRANSITION uses OUTDOOR_NAV). */
export const MODE_PROFILE: Readonly<Record<AppMode, ModeProfile>> = Object.freeze({
  IDLE: 'IDLE',
  ONBOARDING: 'IDLE',
  OUTDOOR_NAV: 'OUTDOOR_NAV',
  APPROACH_CROSSING: 'APPROACH_CROSSING',
  AT_CURB: 'APPROACH_CROSSING',
  CROSSING: 'CROSSING',
  TRANSITION: 'OUTDOOR_NAV',
  INDOOR_NAV: 'INDOOR_NAV',
  AT_ITEM: 'INDOOR_NAV',
  ITEM_PICKUP: 'ITEM_PICKUP',
  CHECKOUT_NAV: 'INDOOR_NAV',
  DONE: 'IDLE',
  GUIDED_TASK: 'INDOOR_NAV',   // detector + depth + OCR; no signal model
});

/**
 * How long an explicit selectPack() holds against mode/profile re-arms:
 *  - 'mode' (jump-to-phase): until the next mode change, so continuous replay after a
 *    jump goes back to the mode-keyed packs;
 *  - 'profile' (DebugPanel operator): until the profile changes, so a pack picked on the
 *    approach (e.g. curb-walk-already-on) still plays at the curb, which shares its profile.
 */
export type PinHold = 'mode' | 'profile';

export interface FrameEntry {
  base64: string;
  width: number;
  height: number;
}

export interface PerceptionDebugState {
  running: boolean;
  profile: ModeProfile;
  /** Last AppMode reported by the harness; null while profile-driven. */
  mode: AppMode | null;
  modeDriven: boolean;
  pack: string | null;
  /** True while an explicit selectPack() holds against profile/mode re-arms. */
  pinned: boolean;
  pinHold: PinHold;
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
  /** Offset added to the current pack's poses to keep one world frame across pack switches. */
  poseOffset: { x: number; y: number; z: number };
}

export interface MockPerceptionService extends PerceptionService {
  /** Arm a pack by name at an offset (ms into the pack) and pin it (see PinHold; default 'mode'). Unknown name → throws. */
  selectPack(name: string, offsetMs?: number, opts?: { holdUntil?: PinHold }): void;
  /**
   * Mode-driven pack selection (harness, from the bridged store). The first call switches
   * the replayer to mode-driven; each mode change clears a pin and applies DEFAULT_MODE_PACKS.
   */
  setAppMode(mode: AppMode): void;
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
  modePacks?: Partial<Record<AppMode, ModePackRule>>;
  stats?: Partial<ReturnType<PerceptionService['getStats']>>;
  wall?: () => number;
}

type Listener<T> = (e: T) => void;

export function createMockPerceptionService(opts: MockPerceptionOptions): MockPerceptionService {
  const { clock } = opts;
  const wall = opts.wall ?? Date.now;
  const profilePacks = { ...DEFAULT_PROFILE_PACKS, ...(opts.profilePacks ?? {}) };
  const modePacks = { ...DEFAULT_MODE_PACKS, ...(opts.modePacks ?? {}) };
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
  let mode: AppMode | null = null;
  let modeDriven = false;
  let pinned = false;
  let pinHold: PinHold = 'mode';
  let pack: string | null = null;
  let packStartReplayMs = 0;     // replay-clock ms at which pack t=0 sits
  let cursor = 0;                // next line index
  let unknownEvents = 0;
  let emitted = 0;
  let snapshotSeq = 0;
  let trackingState: TrackingState = 'NOT_AVAILABLE';
  let lastSignal: SignalState | null = null;
  let forcedSignal: { state: SignalState; fresh: boolean } | null = null;
  // ARKit keeps one world frame per session; packs are separate recordings with their own
  // origins. Re-base each newly armed pack's poses onto the last pose emitted, so pose
  // displacement across a pack switch (B's crossing start / far-curb rules) stays continuous.
  let lastPoseOut: Pose | null = null;
  let poseOffset = { x: 0, y: 0, z: 0 };
  let poseRebasePending = false;
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
    poseRebasePending = lastPoseOut !== null;
  };

  const rebasePose = (p: Pose): Pose => {
    if (poseRebasePending && lastPoseOut) {
      poseOffset = { x: lastPoseOut.x - p.x, y: lastPoseOut.y - p.y, z: lastPoseOut.z - p.z };
      poseRebasePending = false;
    }
    const out: Pose = { ...p, x: p.x + poseOffset.x, y: p.y + poseOffset.y, z: p.z + poseOffset.z };
    lastPoseOut = out;
    return out;
  };

  // A clock seek keeps the pack's alignment to replay time (the harness re-arms on phase jumps).
  clock.onSeek(() => {
    cursorTo(packTimeMs());
  });

  const applyModeRule = (m: AppMode): void => {
    const rule = modePacks[m];
    if (rule === null) arm(null);
    else if (typeof rule === 'string') arm(rule, 0);
    // { keep: true }: leave the current pack running across the edge.
  };

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
    dispatch(event, event === 'onPose' ? rebasePose(line.payload as Pose) : line.payload);
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
      if (!modeDriven) {
        pinned = false;
        arm(profilePacks[p] ?? null, 0);
      } else if (pack === null && !pinned && mode !== null) {
        // The harness may have reported the mode before the binding started the session.
        applyModeRule(mode);
      }
    },
    setProfile(p) {
      const changed = p !== profile;
      profile = p;
      if (modeDriven || !running) return;   // mode edges own the packs; the profile is bookkeeping
      if (changed) pinned = false;
      if (!pinned) arm(profilePacks[p] ?? null, 0);
    },
    stop() {
      running = false;
      pack = null;
      pinned = false;
      trackingState = 'NOT_AVAILABLE';
      lastPoseOut = null;               // a new session is a new world frame
      poseOffset = { x: 0, y: 0, z: 0 };
      poseRebasePending = false;
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

    selectPack(name, offsetMs = 0, opts = {}) {
      arm(name, offsetMs);
      pinned = true;
      pinHold = opts.holdUntil ?? 'mode';
    },
    setAppMode(m) {
      modeDriven = true;
      if (m === mode) return;
      const sameProfile = mode !== null && MODE_PROFILE[m] === MODE_PROFILE[mode];
      mode = m;
      if (pinned && pinHold === 'profile' && sameProfile) return;   // the operator's pick outlives an intra-profile edge
      pinned = false;
      applyModeRule(m);
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
        mode,
        modeDriven,
        pack,
        pinned,
        pinHold,
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
        poseOffset: { ...poseOffset },
      };
    },
  };

  return service;
}
