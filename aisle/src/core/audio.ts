/**
 * Audio channel manager (02 Task 5): the audio session and the two non-speech
 * channels — the direction beacon and the signal-state ticker.
 *
 * Priority: speech > ticker (AT_CURB) / beacon (CROSSING, outdoors) > nothing.
 * The ticker wins at AT_CURB, the beacon wins while CROSSING; they never play
 * together (01 §3 "Audio siblings"). Both read mode from the store; on IDLE
 * both stop; indoors the beacon is off.
 *
 * Beacon (Soundscape-style, direction not distance): a pulse every 1 s panned
 * by the target's bearing relative to the fused heading, plus a short extra
 * tick when the target is inside the ±15° forward window. `expo-audio` has no
 * pan property, so the pulse is two clips (hard-left, hard-right) whose
 * volumes follow the constant-power law in `angles.ts`. Never changes with
 * distance; distance is spoken. At AT_CURB the beacon is sparse (one pulse per
 * 3 s) and only when the ticker is silent.
 *
 * Ticker (OKO-style tempo): DONT_WALK 1/s, COUNTDOWN 2/s, WALK 4/s, UNKNOWN
 * silent. A state change restarts the timer at once (< 150 ms end to end).
 *
 * Pure parts (`tickerIntervalMs`, `channelPlan`) are exported for tests; the
 * scheduler runs on a 50 ms loop with an injected backend.
 */
import type { AppMode, GeoFix, SignalState } from './contracts';
import type { AppStore } from './store';
import { angleDiffDeg, constantPowerPan, isWithinDeg, normalizeDeg } from './angles';
import { bearingDeg, type LatLng } from './geo';

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

export const BEACON_INTERVAL_MS = 1000;
export const BEACON_CURB_INTERVAL_MS = 3000;
export const BEACON_FORWARD_WINDOW_DEG = 15;
export const BEACON_CENTER_TICK_DELAY_MS = 150;
export const BEACON_CENTER_TICK_VOLUME = 0.6;
export const SCHEDULER_MS = 50;

export const TICKER_INTERVAL_MS: Readonly<Record<SignalState, number | null>> = {
  DONT_WALK: 1000,
  COUNTDOWN: 500,
  WALK: 250,
  UNKNOWN: null,
};

export function tickerIntervalMs(state: SignalState): number | null {
  return TICKER_INTERVAL_MS[state];
}

const BEACON_MODES: ReadonlySet<AppMode> = new Set([
  'IDLE', 'ONBOARDING', 'OUTDOOR_NAV', 'APPROACH_CROSSING', 'AT_CURB', 'CROSSING',
]);
const TICKER_MODES: ReadonlySet<AppMode> = new Set(['ONBOARDING', 'AT_CURB', 'CROSSING']);

export interface ChannelPlan {
  /** The ticker may sound (mode allows it and state ≠ UNKNOWN). */
  ticker: boolean;
  /** The beacon may sound this cycle; `intervalMs` is 3000 at the curb. */
  beacon: boolean;
  beaconIntervalMs: number;
}

/**
 * Which channel is allowed to sound, given mode, ticker state, whether a
 * beacon target exists and whether speech is playing. Speech mutes both.
 */
export function channelPlan(input: {
  mode: AppMode;
  tickerState: SignalState;
  hasBeaconTarget: boolean;
  speaking: boolean;
  tickerMuted?: boolean;
  beaconMuted?: boolean;
}): ChannelPlan {
  const tickerAllowed =
    !input.speaking && !input.tickerMuted && TICKER_MODES.has(input.mode) && tickerIntervalMs(input.tickerState) !== null;
  const beaconAllowedByMode =
    !input.speaking && !input.beaconMuted && input.hasBeaconTarget && BEACON_MODES.has(input.mode);

  if (input.mode === 'AT_CURB') {
    // Ticker wins; beacon only when the ticker is silent, and then sparse.
    return { ticker: tickerAllowed, beacon: beaconAllowedByMode && !tickerAllowed, beaconIntervalMs: BEACON_CURB_INTERVAL_MS };
  }
  if (input.mode === 'CROSSING') {
    // Beacon wins toward the far curb; the ticker continues only without a target.
    return { ticker: tickerAllowed && !beaconAllowedByMode, beacon: beaconAllowedByMode, beaconIntervalMs: BEACON_INTERVAL_MS };
  }
  // Elsewhere (in practice only ONBOARDING can have both) the ticker wins: never both.
  return { ticker: tickerAllowed, beacon: beaconAllowedByMode && !tickerAllowed, beaconIntervalMs: BEACON_INTERVAL_MS };
}

/** Left/right gains and the centre-tick decision for one beacon pulse. */
export function beaconPulse(headingDeg: number, targetBearingDeg: number): { left: number; right: number; centred: boolean; relativeDeg: number } {
  const relativeDeg = angleDiffDeg(headingDeg, targetBearingDeg);
  const { left, right } = constantPowerPan(relativeDeg);
  return { left, right, centred: isWithinDeg(headingDeg, targetBearingDeg, BEACON_FORWARD_WINDOW_DEG), relativeDeg };
}

// ---------------------------------------------------------------------------
// Backend contract
// ---------------------------------------------------------------------------

export interface OneShotPlayer {
  /** Restart from the top at `volume` (0..1). Must be cheap: called up to 4×/s. */
  play(volume: number): void;
  stop(): void;
  dispose(): void;
}

export interface AudioSessionMode {
  playsInSilentMode: boolean;
  interruptionMode: 'duckOthers' | 'doNotMix' | 'mixWithOthers';
  shouldPlayInBackground: boolean;
  allowsRecording: boolean;
}

export interface AudioChannelBackend {
  beaconLeft: OneShotPlayer;
  beaconRight: OneShotPlayer;
  tick: OneShotPlayer;
  setAudioMode(mode: Partial<AudioSessionMode>): Promise<void>;
}

export const DEFAULT_AUDIO_MODE: AudioSessionMode = {
  playsInSilentMode: true,
  interruptionMode: 'doNotMix',
  shouldPlayInBackground: false,
  allowsRecording: false,
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export type BeaconTarget = { bearingDeg: number } | { lat: number; lng: number };

export interface DirectionBeacon {
  /** Bearing, or a point (resolved against the last GPS fix each pulse). `null` turns it off. */
  setTarget(target: BeaconTarget | null): void;
  getTarget(): BeaconTarget | null;
  /** True when the beacon is sounding this cycle (the COURSE side hint is skipped then). */
  isActive(): boolean;
  setMuted(muted: boolean): void;
  isMuted(): boolean;
}

export interface SignalTicker {
  setState(state: SignalState): void;
  getState(): SignalState;
  isActive(): boolean;
  setMuted(muted: boolean): void;
  isMuted(): boolean;
}

export interface AudioChannels {
  beacon: DirectionBeacon;
  ticker: SignalTicker;
  /** `setAudioModeAsync` with the 02 Task 5 defaults; call once at app start. */
  configureSession(): Promise<void>;
  /** Push-to-talk only: `allowsRecording` on for the utterance, off the moment it ends. */
  setRecordingMode(on: boolean, nativeOwnsSession?: boolean): Promise<void>;
  isRecordingMode(): boolean;
  getDebugState(): {
    mode: AppMode; tickerState: SignalState; tickerActive: boolean; beaconActive: boolean;
    beaconTarget: BeaconTarget | null; lastRelativeDeg: number | null; recording: boolean;
  };
  dispose(): void;
}

export interface AudioChannelsOptions {
  backend: AudioChannelBackend;
  store: AppStore;
  /** Fused heading (SensorService.getFusedHeadingDeg); null = unknown → no pulse. */
  heading: () => number | null;
  /** Last GPS fix, for lat/lng targets. */
  position?: () => GeoFix | null;
  /** SpeechService.isSpeaking. */
  speaking: () => boolean;
  now?: () => number;
  /** Start the scheduler immediately (default true). */
  autoStart?: boolean;
}

export function createAudioChannels(opts: AudioChannelsOptions): AudioChannels {
  const { backend, store } = opts;
  const now = opts.now ?? Date.now;

  let target: BeaconTarget | null = null;
  let beaconMuted = false;
  let tickerMuted = false;
  let tickerState: SignalState = 'UNKNOWN';
  let nextBeaconAt = 0;
  let nextTickAt = 0;
  let beaconActive = false;
  let tickerActive = false;
  let lastRelativeDeg: number | null = null;
  let recording = false;
  let sessionMode: AudioSessionMode = { ...DEFAULT_AUDIO_MODE };
  let timer: ReturnType<typeof setInterval> | null = null;
  const pendingCentreTicks = new Set<ReturnType<typeof setTimeout>>();

  const resolveBearing = (): number | null => {
    if (!target) return null;
    if ('bearingDeg' in target) return normalizeDeg(target.bearingDeg);
    const fix = opts.position?.();
    if (!fix) return null;
    const here: LatLng = { lat: fix.lat, lng: fix.lng };
    return bearingDeg(here, target);
  };

  const tick = (): void => {
    const t = now();
    const mode = store.getState().mode;
    const plan = channelPlan({
      mode, tickerState, hasBeaconTarget: target !== null, speaking: recording || opts.speaking(), tickerMuted, beaconMuted,
    });
    tickerActive = plan.ticker;
    beaconActive = plan.beacon;

    if (plan.ticker) {
      const interval = tickerIntervalMs(tickerState) as number;
      if (t >= nextTickAt) {
        nextTickAt = t + interval;
        backend.tick.play(1);
      }
    }

    if (plan.beacon && t >= nextBeaconAt) {
      nextBeaconAt = t + plan.beaconIntervalMs;
      const heading = opts.heading();
      const bearing = resolveBearing();
      if (heading === null || bearing === null) {
        lastRelativeDeg = null;
        return; // no direction to encode; silence beats a wrong pan
      }
      const pulse = beaconPulse(heading, bearing);
      lastRelativeDeg = pulse.relativeDeg;
      backend.beaconLeft.play(pulse.left);
      backend.beaconRight.play(pulse.right);
      if (pulse.centred) {
        const h = setTimeout(() => {
          pendingCentreTicks.delete(h);
          if (!recording && !opts.speaking()) backend.tick.play(BEACON_CENTER_TICK_VOLUME);
        }, BEACON_CENTER_TICK_DELAY_MS);
        pendingCentreTicks.add(h);
      }
    }
  };

  const start = (): void => {
    if (timer === null) timer = setInterval(tick, SCHEDULER_MS);
  };

  const unsubStore = store.subscribe((s, prev) => {
    if (s.mode === prev.mode) return;
    if (s.mode === 'IDLE') {
      target = null;
      tickerState = 'UNKNOWN';
    } else if (!BEACON_MODES.has(s.mode)) {
      target = null; // off indoors
    }
    if (!TICKER_MODES.has(s.mode)) tickerState = 'UNKNOWN';
    // Restart both timers at the mode boundary so the new plan is audible at once.
    nextBeaconAt = 0;
    nextTickAt = 0;
  });

  if (opts.autoStart !== false) start();

  return {
    beacon: {
      setTarget(next) {
        target = next;
        nextBeaconAt = 0; // restart together on every target change (limits drift)
        if (next === null) {
          backend.beaconLeft.stop();
          backend.beaconRight.stop();
          beaconActive = false;
        }
      },
      getTarget: () => target,
      isActive: () => beaconActive,
      setMuted(m) {
        beaconMuted = m;
      },
      isMuted: () => beaconMuted,
    },
    ticker: {
      setState(state) {
        if (state === tickerState) return;
        tickerState = state;
        nextTickAt = 0; // a state change reaches the ear on the next scheduler tick
        if (tickerIntervalMs(state) === null) backend.tick.stop();
      },
      getState: () => tickerState,
      isActive: () => tickerActive,
      setMuted(m) {
        tickerMuted = m;
      },
      isMuted: () => tickerMuted,
    },
    async configureSession() {
      sessionMode = { ...DEFAULT_AUDIO_MODE };
      recording = false;
      await backend.setAudioMode(sessionMode);
    },
    async setRecordingMode(on, nativeOwnsSession = false) {
      // iOS keeps a separate, quieter output level for the play-and-record category. Leaving it
      // on after an utterance is "the voice got quiet" (round 6c: heard in guided tasks, where the
      // user answers often). So: the flag flips only when the mode really applied, turning it OFF
      // is retried a few times (the recogniser's audio engine can still hold the session for a
      // moment), and turning it off is never skipped just because we believed it was off.
      sessionMode = { ...sessionMode, allowsRecording: on };
      if (on) {
        if (recording) return;
        backend.beaconLeft.stop();
        backend.beaconRight.stop();
        backend.tick.stop();
        // expo-speech-recognition sets and activates its own category. Doing this
        // first causes two serial native session transitions before audio capture.
        if (!nativeOwnsSession) await backend.setAudioMode(sessionMode);
        recording = true;
        return;
      }
      const delays = [0, 400, 1200];
      let lastError: unknown = null;
      for (const ms of delays) {
        if (ms > 0) await new Promise<void>((r) => setTimeout(r, ms));
        try {
          await backend.setAudioMode(sessionMode);
          recording = false;
          return;
        } catch (e) {
          lastError = e;
        }
      }
      recording = false;
      throw lastError instanceof Error ? lastError : new Error('setAudioMode(playback) failed');
    },
    isRecordingMode: () => recording,
    getDebugState: () => ({
      mode: store.getState().mode,
      tickerState,
      tickerActive,
      beaconActive,
      beaconTarget: target,
      lastRelativeDeg,
      recording,
    }),
    dispose() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      for (const h of pendingCentreTicks) clearTimeout(h);
      pendingCentreTicks.clear();
      unsubStore();
      backend.beaconLeft.dispose();
      backend.beaconRight.dispose();
      backend.tick.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// expo-audio backend (required lazily; tests inject a fake)
// ---------------------------------------------------------------------------

export function createExpoAudioChannelBackend(): AudioChannelBackend {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Audio = require('expo-audio') as typeof import('expo-audio');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const tones = require('../../assets/audio/tones') as typeof import('../../assets/audio/tones');

  const oneShot = (asset: number): OneShotPlayer => {
    const player = Audio.createAudioPlayer(asset, { keepAudioSessionActive: true, updateInterval: 250 });
    let generation = 0;
    return {
      play(volume) {
        const request = ++generation;
        try {
          player.volume = Math.min(1, Math.max(0, volume));
          void player.seekTo(0).then(() => {
            if (request === generation) player.play();
          }).catch(() => undefined);
        } catch {
          // a released player is not a crash
        }
      },
      stop() {
        generation += 1;
        try {
          player.pause();
        } catch {
          // ignore
        }
      },
      dispose() {
        generation += 1;
        try {
          player.remove();
        } catch {
          // ignore
        }
      },
    };
  };

  return {
    beaconLeft: oneShot(tones.BEACON_L),
    beaconRight: oneShot(tones.BEACON_R),
    tick: oneShot(tones.TICK),
    setAudioMode: (mode) => Audio.setAudioModeAsync(mode),
  };
}
