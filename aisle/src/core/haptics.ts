/**
 * HapticService (01 §2, 02 Task 3). Four patterns, not five.
 *
 * - `play('TURN' | 'STOP' | 'CONFIRM')` are transient sequences on
 *   `expo-haptics` (UIFeedbackGenerator; no continuous event on iOS).
 * - COURSE is the fourth pattern, a continuous service: silence on course, a
 *   pulse train whose rate and intensity grow with the error beyond the dead
 *   zone. The rule is a pure state machine (`CourseEngine`) fed by a 20 Hz
 *   poll so it can be tested without a phone; the service around it does the
 *   timers, the impacts, the bus emit and the spoken hints.
 *
 * Rules enforced here, verbatim from 01 §2 / 02 Task 3:
 *   dead zone 12° at compass tier 3, 18° at tier 2, no buzz below tier 2
 *   (say `compass_uncertain` once per 30 s, keep polling); roadward drift needs
 *   two agreeing signals, and the heading one must be meaningful (≥ 5° toward
 *   the road: GPS noise plus a heading inside the dead zone never buzzes);
 *   drift adds at most 30° of equivalent error; cross-track reaches this rule
 *   only from the perception module (sensors.courseErrorFor zeroes GPS / dead
 *   reckoning cross-track, which routinely exceeds 0.5 m); 0.5 s hysteresis
 *   both ways; minimum burst 150 ms;
 *   one CONFIRM on the first re-entry to the dead zone after TURN; STOP
 *   pre-empts COURSE for 1 s and COURSE resumes without a CONFIRM.
 */
import type { CourseError, HapticPattern, HapticService, Side, SpeechService } from './contracts';
import type { AppEventBus } from './bus';
import type { AppStore } from './store';
import type { PhraseKey } from './phrases';
import { PHRASES } from './phrases';
import { clamp } from './angles';

// ---------------------------------------------------------------------------
// Pure rule: CourseError → pulse schedule
// ---------------------------------------------------------------------------

export type PulseStyle = 'Light' | 'Medium' | 'Heavy';

export const DEAD_ZONE_DEG: Readonly<Record<3 | 2, number>> = { 3: 12, 2: 18 };
export const DRIFT_THRESHOLD_M = 0.5;
/** 20° of equivalent error per 0.5 m of qualifying drift. */
export const DRIFT_DEG_PER_M = 20 / 0.5;
/**
 * Drift can add at most this much equivalent error: 1 m of cross-track must
 * never become a Heavy / 150 ms train on its own (01 §2: buzz fatigue is a
 * safety failure).
 */
export const DRIFT_DEG_CAP = 30;
/**
 * The heading half of the two-signal roadward rule: the user must be pointed
 * at least this far toward the road (or, with no road, toward the drift side).
 * A heading inside ±5° is straight ahead for every practical purpose, so a
 * cross-track reading alone can never start the buzz.
 */
export const ROADWARD_MIN_HEADING_DEG = 5;
export const PULSE_INTERVAL_MAX_MS = 600;
export const PULSE_INTERVAL_MIN_MS = 150;
export const PULSE_INTERVAL_SLOPE_MS_PER_DEG = 8;
export const HYSTERESIS_MS = 500;
export const MIN_BURST_MS = 150;
export const STOP_PREEMPT_MS = 1000;
export const COMPASS_UNCERTAIN_COOLDOWN_MS = 30_000;
export const SIDE_HINT_AFTER_MS = 5000;
export const SIDE_HINT_COOLDOWN_MS = 8000;
/** After TURN with no excursion out of the dead zone, confirm once the error has sat inside this long. */
export const REALIGN_STABLE_MS = 1000;

export interface CourseSchedule {
  /** Compass tier ≥ 2: the rule may buzz at all. */
  compassOk: boolean;
  deadZoneDeg: number | null;
  /** |headingErrorDeg| beyond the dead zone, ≥ 0. */
  headingExcessDeg: number;
  /**
   * The two-signal roadward rule tripped: > 0.5 m of cross-track toward the
   * road (with roadSide NONE, toward either side) AND a heading ≥ 5° the same way.
   */
  roadward: boolean;
  /** Which side the drift is on when `roadward`. */
  driftSide: Side | null;
  /** Equivalent degrees added by qualifying drift. */
  driftDeg: number;
  /** Total error magnitude `e` in degrees (0 when nothing qualifies). */
  e: number;
  /** An error exists (before hysteresis). */
  active: boolean;
  intervalMs: number | null;
  style: PulseStyle | null;
  /** Direction the user should turn to reduce heading error (null inside the dead zone). */
  correction: Side | null;
}

export function pulseIntervalMs(e: number): number {
  return clamp(PULSE_INTERVAL_MAX_MS - PULSE_INTERVAL_SLOPE_MS_PER_DEG * e, PULSE_INTERVAL_MIN_MS, PULSE_INTERVAL_MAX_MS);
}

export function pulseStyleFor(e: number): PulseStyle {
  if (e < 15) return 'Light';
  if (e <= 40) return 'Medium';
  return 'Heavy';
}

/**
 * The COURSE rule as a pure function of one error sample. Time-dependent parts
 * (hysteresis, STOP pre-emption, the CONFIRM after TURN) live in CourseEngine.
 */
export function courseSchedule(err: CourseError): CourseSchedule {
  const acc = err.compassAccuracy;
  if (acc !== 3 && acc !== 2) {
    return {
      compassOk: false, deadZoneDeg: null, headingExcessDeg: 0, roadward: false, driftSide: null,
      driftDeg: 0, e: 0, active: false, intervalMs: null, style: null, correction: null,
    };
  }
  const deadZoneDeg = DEAD_ZONE_DEG[acc];
  const h = Number.isFinite(err.headingErrorDeg) ? err.headingErrorDeg : 0;
  const ct = Number.isFinite(err.crossTrackM) ? err.crossTrackM : 0;
  const headingExcessDeg = Math.max(0, Math.abs(h) - deadZoneDeg);

  // Two agreeing signals, and the heading one has to be meaningful: a
  // cross-track reading (GPS, dead reckoning, or even a perception pose) with
  // the user pointed straight down the line is noise, not a drift toward the
  // road. With no road on this leg the "road" is whichever side the drift is on.
  let roadward = false;
  let driftSide: Side | null = null;
  const towardSide: Side | null = err.roadSide === 'NONE' ? (ct > 0 ? 'RIGHT' : ct < 0 ? 'LEFT' : null) : err.roadSide;
  if (towardSide !== null) {
    const towardRoadM = towardSide === 'RIGHT' ? ct : -ct;
    const headingTowardRoadDeg = towardSide === 'RIGHT' ? h : -h;
    if (towardRoadM > DRIFT_THRESHOLD_M && headingTowardRoadDeg >= ROADWARD_MIN_HEADING_DEG) {
      roadward = true;
      driftSide = towardSide;
    }
  }
  const driftDeg = roadward ? Math.min(DRIFT_DEG_CAP, Math.abs(ct) * DRIFT_DEG_PER_M) : 0;
  const e = headingExcessDeg + driftDeg;
  const active = headingExcessDeg > 0 || roadward;
  const correction: Side | null = headingExcessDeg > 0 ? (h > 0 ? 'LEFT' : 'RIGHT') : null;
  return {
    compassOk: true, deadZoneDeg, headingExcessDeg, roadward, driftSide, driftDeg, e, active,
    intervalMs: active ? pulseIntervalMs(e) : null,
    style: active ? pulseStyleFor(e) : null,
    correction,
  };
}

// ---------------------------------------------------------------------------
// Pure state machine over time
// ---------------------------------------------------------------------------

export interface CourseTick {
  schedule: CourseSchedule;
  /** Buzz is on (after hysteresis, pre-emption applied to `pulse` only). */
  buzzing: boolean;
  /** Fire one impact now. */
  pulse: PulseStyle | null;
  /** Fire one CONFIRM now (re-alignment after TURN). */
  confirm: boolean;
  /** Say this (compass_uncertain / course_hint_*), already rate-limited. */
  speak: PhraseKey | null;
  /** Emit COURSE_DEVIATION (once per roadward episode). */
  deviation: { meters: number; side: Side } | null;
}

export interface CourseEngineOptions {
  /** True while the direction beacon is playing; then the side hint is not spoken. */
  beaconActive?: () => boolean;
}

/** Deterministic; every method takes `now` so tests need no timers. */
export class CourseEngine {
  private errorSince: number | null = null;
  private okSince: number | null = null;
  private buzzing = false;
  private buzzStart = 0;
  private lastPulse = -Infinity;
  private suppressUntil = -Infinity;
  private awaitingRealign = false;
  private turnAt = 0;
  private wasOutsideSinceTurn = false;
  private compassSpokenAt = -Infinity;
  private hintSpokenAt = -Infinity;
  private inDeviationEpisode = false;
  private lastSchedule: CourseSchedule | null = null;

  constructor(private readonly opts: CourseEngineOptions = {}) {}

  /** `play('TURN')` happened: arm the one-shot CONFIRM. */
  noteTurn(now: number): void {
    this.awaitingRealign = true;
    this.turnAt = now;
    this.wasOutsideSinceTurn = false;
  }

  /** `play('STOP')` happened: no pulses for 1 s; resume without CONFIRM. */
  noteStop(now: number): void {
    this.suppressUntil = now + STOP_PREEMPT_MS;
  }

  /** New target (stopCourse/startCourse). The pending post-TURN CONFIRM survives. */
  resetCourse(): void {
    this.errorSince = null;
    this.okSince = null;
    this.buzzing = false;
    this.lastPulse = -Infinity;
    this.inDeviationEpisode = false;
    this.lastSchedule = null;
  }

  isBuzzing(): boolean {
    return this.buzzing;
  }

  lastScheduleSeen(): CourseSchedule | null {
    return this.lastSchedule;
  }

  step(now: number, err: CourseError): CourseTick {
    const schedule = courseSchedule(err);
    this.lastSchedule = schedule;
    let speak: PhraseKey | null = null;
    let confirm = false;
    let deviation: CourseTick['deviation'] = null;

    if (!schedule.compassOk) {
      // No course buzz below tier 2; say it once per 30 s; keep polling.
      this.buzzing = false;
      this.errorSince = null;
      this.okSince = null;
      if (now - this.compassSpokenAt >= COMPASS_UNCERTAIN_COOLDOWN_MS) {
        this.compassSpokenAt = now;
        speak = 'compass_uncertain';
      }
      return { schedule, buzzing: false, pulse: null, confirm: false, speak, deviation: null };
    }

    // Hysteresis: 0.5 s to start, 0.5 s inside the dead zone to stop, min burst 150 ms.
    if (schedule.active) {
      this.okSince = null;
      if (this.errorSince === null) this.errorSince = now;
      if (!this.buzzing && now - this.errorSince >= HYSTERESIS_MS) {
        this.buzzing = true;
        this.buzzStart = now;
        this.lastPulse = -Infinity;
      }
    } else {
      this.errorSince = null;
      if (this.okSince === null) this.okSince = now;
      if (this.buzzing && now - this.okSince >= HYSTERESIS_MS && now - this.buzzStart >= MIN_BURST_MS) {
        this.buzzing = false;
      }
    }

    // One CONFIRM on the first re-entry to the dead zone after TURN.
    if (this.awaitingRealign) {
      if (schedule.headingExcessDeg > 0) {
        this.wasOutsideSinceTurn = true;
      } else if (this.wasOutsideSinceTurn || now - this.turnAt >= REALIGN_STABLE_MS) {
        this.awaitingRealign = false;
        confirm = true;
        // Silence is the reward: stop the buzz with the CONFIRM, not 0.5 s later.
        this.buzzing = false;
        this.okSince = now;
      }
    }

    // Roadward episode → COURSE_DEVIATION once.
    if (schedule.roadward && this.buzzing) {
      if (!this.inDeviationEpisode && schedule.driftSide) {
        this.inDeviationEpisode = true;
        deviation = { meters: Math.abs(err.crossTrackM), side: schedule.driftSide };
      }
    } else if (!schedule.roadward) {
      this.inDeviationEpisode = false;
    }

    // Pulse train (STOP pre-emption applies here only).
    let pulse: PulseStyle | null = null;
    if (this.buzzing && now >= this.suppressUntil && schedule.intervalMs !== null && schedule.style !== null) {
      if (now - this.lastPulse >= schedule.intervalMs) {
        this.lastPulse = now;
        pulse = schedule.style;
      }
    }

    // Side hint when the beacon is not carrying direction and the error persisted > 5 s.
    if (
      speak === null &&
      this.buzzing &&
      schedule.correction !== null &&
      now - this.buzzStart > SIDE_HINT_AFTER_MS &&
      now - this.hintSpokenAt >= SIDE_HINT_COOLDOWN_MS &&
      !(this.opts.beaconActive?.() ?? false)
    ) {
      this.hintSpokenAt = now;
      speak = schedule.correction === 'LEFT' ? 'course_hint_left' : 'course_hint_right';
    }

    return { schedule, buzzing: this.buzzing, pulse, confirm, speak, deviation };
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface HapticBackend {
  impact(style: PulseStyle): void;
  /** notificationAsync(Error) */
  notificationError(): void;
  /** notificationAsync(Success) — round 9, the "sent" cue. Optional for older fakes (falls back to two taps). */
  notificationSuccess?(): void;
}

export interface HapticServiceOptions {
  backend?: HapticBackend;
  /** Looked up lazily so the composition order does not matter. */
  speech?: () => SpeechService | undefined;
  bus?: AppEventBus;
  store?: AppStore;
  beaconActive?: () => boolean;
  /** Poll period for COURSE; default 50 ms (20 Hz; 01 asks for ≥ 10 Hz). */
  pollMs?: number;
  now?: () => number;
}

export interface AisleHapticService extends HapticService {
  /** The buzz is on right now (the Tier-1 prompt gate reads this). */
  isCourseBuzzing(): boolean;
  isCourseRunning(): boolean;
  /** Push-to-talk: iOS suppresses haptics while recording, so COURSE pauses; state is kept. */
  setSuspended(suspended: boolean): void;
  getDebugState(): { running: boolean; buzzing: boolean; suspended: boolean; schedule: CourseSchedule | null; lastPattern: HapticPattern | null; lastPatternAt: number | null };
  dispose(): void;
}

export const TURN_SEQUENCE_MS: readonly number[] = [0, 110, 220];
export const STOP_SEQUENCE_MS: readonly number[] = [0, 70, 140];

const TRAINING_LABEL: Readonly<Partial<Record<HapticPattern, PhraseKey>>> = {
  TURN: 'label_turn',
  STOP: 'label_stop',
  CONFIRM: 'label_okay',
};

/** Default backend on expo-haptics; required lazily so tests never touch native code. */
export function createExpoHapticBackend(): HapticBackend {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Haptics = require('expo-haptics') as typeof import('expo-haptics');
  const swallow = (): void => {};
  return {
    impact(style) {
      const s = style === 'Light'
        ? Haptics.ImpactFeedbackStyle.Light
        : style === 'Medium'
          ? Haptics.ImpactFeedbackStyle.Medium
          : Haptics.ImpactFeedbackStyle.Heavy;
      Haptics.impactAsync(s).catch(swallow);
    },
    notificationError() {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(swallow);
    },
    notificationSuccess() {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(swallow);
    },
  };
}

export function createHapticService(opts: HapticServiceOptions = {}): AisleHapticService {
  const backend = opts.backend ?? createExpoHapticBackend();
  const now = opts.now ?? Date.now;
  const pollMs = opts.pollMs ?? 50;
  const engine = new CourseEngine({ beaconActive: opts.beaconActive });

  let timer: ReturnType<typeof setInterval> | null = null;
  let getError: (() => CourseError) | null = null;
  let suspended = false;
  let lastPattern: HapticPattern | null = null;
  let lastPatternAt: number | null = null;
  const pending = new Set<ReturnType<typeof setTimeout>>();

  const later = (ms: number, fn: () => void): void => {
    const t = setTimeout(() => {
      pending.delete(t);
      fn();
    }, ms);
    pending.add(t);
  };

  const speakKey = (key: PhraseKey, priority: 'NAV' | 'INFO', cooldownMs: number): void => {
    opts.speech?.()?.say({
      text: PHRASES[key],
      priority,
      cacheKey: key,
      dedupeKey: key,
      cooldownMs,
    });
  };

  const tick = (): void => {
    if (!getError || suspended) return;
    let err: CourseError;
    try {
      err = getError();
    } catch {
      return; // a throwing producer must never kill the loop
    }
    const t = engine.step(now(), err);
    if (t.pulse) backend.impact(t.pulse);
    if (t.confirm) play('CONFIRM');
    if (t.speak === 'compass_uncertain') speakKey('compass_uncertain', 'NAV', COMPASS_UNCERTAIN_COOLDOWN_MS);
    else if (t.speak) speakKey(t.speak, 'NAV', SIDE_HINT_COOLDOWN_MS);
    if (t.deviation) opts.bus?.emit({ type: 'COURSE_DEVIATION', meters: t.deviation.meters, side: t.deviation.side });
  };

  const play = (pattern: HapticPattern): void => {
    const t0 = now();
    lastPattern = pattern;
    lastPatternAt = t0;
    switch (pattern) {
      case 'TURN':
        backend.impact('Light');
        later(TURN_SEQUENCE_MS[1], () => backend.impact('Medium'));
        later(TURN_SEQUENCE_MS[2], () => backend.impact('Heavy'));
        engine.noteTurn(t0);
        break;
      case 'STOP':
        backend.notificationError();
        backend.impact('Heavy');
        later(STOP_SEQUENCE_MS[1], () => backend.impact('Heavy'));
        later(STOP_SEQUENCE_MS[2], () => backend.impact('Heavy'));
        engine.noteStop(t0);
        break;
      case 'CONFIRM':
        backend.impact('Light');
        break;
      case 'LISTEN':
        backend.impact('Medium');
        later(90, () => backend.impact('Light'));
        break;
      case 'SENT':
        if (backend.notificationSuccess) backend.notificationSuccess();
        else {
          backend.impact('Light');
          later(70, () => backend.impact('Light'));
        }
        break;
      default:
        return;
    }
    const label = TRAINING_LABEL[pattern];
    if (label && opts.store?.getState().trainingMode) {
      speakKey(label, 'INFO', 3000);
    }
  };

  const stopCourse = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    getError = null;
    engine.resetCourse();
  };

  const startCourse = (producer: () => CourseError): void => {
    stopCourse();
    getError = producer;
    timer = setInterval(tick, pollMs);
    tick();
  };

  return {
    play,
    startCourse,
    stopCourse,
    isCourseBuzzing: () => engine.isBuzzing() && !suspended,
    isCourseRunning: () => timer !== null,
    setSuspended(s) {
      suspended = s;
    },
    getDebugState: () => ({
      running: timer !== null,
      buzzing: engine.isBuzzing(),
      suspended,
      schedule: engine.lastScheduleSeen(),
      lastPattern,
      lastPatternAt,
    }),
    dispose() {
      stopCourse();
      for (const t of pending) clearTimeout(t);
      pending.clear();
    },
  };
}
