import type { AppMode, SignalState } from './contracts';
import { createAppStore, type AppStore } from './store';
import {
  BEACON_CENTER_TICK_DELAY_MS,
  BEACON_CURB_INTERVAL_MS,
  BEACON_INTERVAL_MS,
  DEFAULT_AUDIO_MODE,
  TICKER_INTERVAL_MS,
  beaconPulse,
  channelPlan,
  createAudioChannels,
  tickerIntervalMs,
  type AudioChannelBackend,
  type AudioSessionMode,
  type OneShotPlayer,
} from './audio';

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

describe('ticker tempo (OKO-style)', () => {
  it('maps the four states to 1/s, 2/s, 4/s and silence', () => {
    expect(TICKER_INTERVAL_MS).toEqual({ DONT_WALK: 1000, COUNTDOWN: 500, WALK: 250, UNKNOWN: null });
    expect(tickerIntervalMs('WALK')).toBe(250);
    expect(tickerIntervalMs('UNKNOWN')).toBeNull();
  });
});

describe('channelPlan (priority: speech > ticker at curb / beacon while crossing)', () => {
  const base = { tickerState: 'DONT_WALK' as SignalState, hasBeaconTarget: true, speaking: false };

  it('speech mutes both channels in every mode', () => {
    for (const mode of ['OUTDOOR_NAV', 'AT_CURB', 'CROSSING', 'ONBOARDING'] as AppMode[]) {
      const p = channelPlan({ ...base, mode, speaking: true });
      expect(p.ticker).toBe(false);
      expect(p.beacon).toBe(false);
    }
  });

  it('at the curb the ticker wins; the beacon is sparse and only when the ticker is silent', () => {
    const withSignal = channelPlan({ ...base, mode: 'AT_CURB' });
    expect(withSignal).toEqual({ ticker: true, beacon: false, beaconIntervalMs: BEACON_CURB_INTERVAL_MS });
    const unknown = channelPlan({ ...base, mode: 'AT_CURB', tickerState: 'UNKNOWN' });
    expect(unknown).toEqual({ ticker: false, beacon: true, beaconIntervalMs: BEACON_CURB_INTERVAL_MS });
  });

  it('while crossing the beacon wins toward the far curb; never both', () => {
    const p = channelPlan({ ...base, mode: 'CROSSING', tickerState: 'WALK' });
    expect(p.beacon).toBe(true);
    expect(p.ticker).toBe(false);
    expect(p.beaconIntervalMs).toBe(BEACON_INTERVAL_MS);
    const noTarget = channelPlan({ ...base, mode: 'CROSSING', tickerState: 'WALK', hasBeaconTarget: false });
    expect(noTarget.ticker).toBe(true);
    expect(noTarget.beacon).toBe(false);
  });

  it('the ticker is off outside ONBOARDING / AT_CURB / CROSSING and the beacon is off indoors', () => {
    expect(channelPlan({ ...base, mode: 'OUTDOOR_NAV', tickerState: 'WALK' }).ticker).toBe(false);
    expect(channelPlan({ ...base, mode: 'OUTDOOR_NAV' }).beacon).toBe(true);
    for (const mode of ['TRANSITION', 'INDOOR_NAV', 'AT_ITEM', 'ITEM_PICKUP', 'CHECKOUT_NAV', 'DONE'] as AppMode[]) {
      expect(channelPlan({ ...base, mode }).beacon).toBe(false);
    }
  });

  it('mutes are honoured per channel', () => {
    expect(channelPlan({ ...base, mode: 'AT_CURB', tickerMuted: true }).ticker).toBe(false);
    expect(channelPlan({ ...base, mode: 'OUTDOOR_NAV', beaconMuted: true }).beacon).toBe(false);
  });

  it('never lets ticker and beacon sound together in any combination', () => {
    const modes: AppMode[] = ['IDLE', 'ONBOARDING', 'OUTDOOR_NAV', 'APPROACH_CROSSING', 'AT_CURB', 'CROSSING', 'INDOOR_NAV'];
    const states: SignalState[] = ['WALK', 'DONT_WALK', 'COUNTDOWN', 'UNKNOWN'];
    for (const mode of modes) for (const tickerState of states) for (const hasBeaconTarget of [true, false]) {
      const p = channelPlan({ mode, tickerState, hasBeaconTarget, speaking: false });
      expect(p.ticker && p.beacon).toBe(false);
    }
  });
});

describe('beaconPulse', () => {
  it('pans by relative bearing and flags the ±15° forward window', () => {
    const ahead = beaconPulse(90, 90);
    expect(ahead.centred).toBe(true);
    expect(ahead.left).toBeCloseTo(ahead.right, 9);
    const right = beaconPulse(0, 90);
    expect(right.right).toBe(1);
    expect(right.centred).toBe(false);
    expect(right.relativeDeg).toBe(90);
    const left = beaconPulse(90, 0);
    expect(left.left).toBe(1);
    expect(left.relativeDeg).toBe(-90);
    expect(beaconPulse(350, 4).centred).toBe(true);
    expect(beaconPulse(350, 6).centred).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scheduler with a fake backend + fake timers
// ---------------------------------------------------------------------------

interface Play { ch: 'L' | 'R' | 'tick'; volume: number; t: number }

function fakeBackend() {
  const plays: Play[] = [];
  const modes: Array<Partial<AudioSessionMode>> = [];
  const one = (ch: Play['ch']): OneShotPlayer & { stops: number } => {
    const p = {
      stops: 0,
      play(volume: number) { plays.push({ ch, volume, t: Date.now() }); },
      stop() { p.stops += 1; },
      dispose() {},
    };
    return p;
  };
  const be: AudioChannelBackend & { plays: Play[]; modes: Array<Partial<AudioSessionMode>> } = {
    beaconLeft: one('L'),
    beaconRight: one('R'),
    tick: one('tick'),
    setAudioMode: async (m) => { modes.push(m); },
    plays,
    modes,
  };
  return be;
}

describe('createAudioChannels', () => {
  let store: AppStore;
  let be: ReturnType<typeof fakeBackend>;
  let heading: number | null;
  let speaking: boolean;

  const make = (mode: AppMode) => {
    store.setState({ mode });
    return createAudioChannels({ backend: be, store, heading: () => heading, speaking: () => speaking });
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(1_000_000);
    store = createAppStore({ warn: () => {} });
    be = fakeBackend();
    heading = 0;
    speaking = false;
  });
  afterEach(() => jest.useRealTimers());

  it('configures the session with the 02 Task 5 defaults and toggles recording only for push-to-talk', async () => {
    const ch = make('IDLE');
    await ch.configureSession();
    expect(be.modes[0]).toEqual(DEFAULT_AUDIO_MODE);
    expect(DEFAULT_AUDIO_MODE).toEqual({ playsInSilentMode: true, interruptionMode: 'doNotMix', shouldPlayInBackground: false, allowsRecording: false });
    await ch.setRecordingMode(true);
    expect(be.modes[1]).toMatchObject({ allowsRecording: true, interruptionMode: 'doNotMix' });
    expect(ch.isRecordingMode()).toBe(true);
    await ch.setRecordingMode(true);            // idempotent
    expect(be.modes).toHaveLength(2);
    await ch.setRecordingMode(false);
    expect(be.modes[2]).toMatchObject({ allowsRecording: false });
    ch.dispose();
  });

  it('ticker: WALK ticks 4/s, DONT_WALK 1/s, UNKNOWN is silence; a state change restarts at once', () => {
    const ch = make('AT_CURB');
    ch.ticker.setState('WALK');
    jest.advanceTimersByTime(1000);
    expect(be.plays.filter((p) => p.ch === 'tick')).toHaveLength(4);
    be.plays.length = 0;
    ch.ticker.setState('DONT_WALK');
    jest.advanceTimersByTime(50);
    expect(be.plays.filter((p) => p.ch === 'tick')).toHaveLength(1);   // < 150 ms after the change
    jest.advanceTimersByTime(2950);
    expect(be.plays.filter((p) => p.ch === 'tick')).toHaveLength(3);
    be.plays.length = 0;
    ch.ticker.setState('UNKNOWN');
    jest.advanceTimersByTime(3000);
    expect(be.plays).toEqual([]);
    expect(ch.ticker.isActive()).toBe(false);
    ch.dispose();
  });

  it('beacon: one pulse per second on both players with the constant-power pan, extra tick when centred', () => {
    const ch = make('OUTDOOR_NAV');
    heading = 0;
    ch.beacon.setTarget({ bearingDeg: 90 });
    jest.advanceTimersByTime(3050);
    const L = be.plays.filter((p) => p.ch === 'L');
    const R = be.plays.filter((p) => p.ch === 'R');
    expect(L).toHaveLength(4);        // t≈0, 1, 2, 3 s
    expect(R).toHaveLength(4);
    for (const p of R) expect(p.volume).toBe(1);
    for (const p of L) expect(p.volume).toBeCloseTo(0, 9);
    expect(be.plays.filter((p) => p.ch === 'tick')).toEqual([]);   // not centred → no extra tick
    expect(ch.beacon.isActive()).toBe(true);
    expect(ch.getDebugState().lastRelativeDeg).toBe(90);

    be.plays.length = 0;
    heading = 85;                                                    // inside ±15°
    jest.advanceTimersByTime(1200);                                  // next pulse at 4 s + 150 ms tick
    const ticks = be.plays.filter((p) => p.ch === 'tick');
    expect(ticks).toHaveLength(1);
    const pulse = be.plays.find((p) => p.ch === 'L') as Play;
    expect(ticks[0].t - pulse.t).toBe(BEACON_CENTER_TICK_DELAY_MS);
    ch.dispose();
  });

  it('beacon is silent without a heading (no wrong pan) and restarts on target change', () => {
    const ch = make('OUTDOOR_NAV');
    heading = null;
    ch.beacon.setTarget({ bearingDeg: 45 });
    jest.advanceTimersByTime(2500);
    expect(be.plays).toEqual([]);
    heading = 45;
    jest.advanceTimersByTime(1000);
    expect(be.plays.filter((p) => p.ch === 'L').length).toBeGreaterThanOrEqual(1);
    be.plays.length = 0;
    ch.beacon.setTarget({ bearingDeg: 200 });
    jest.advanceTimersByTime(60);
    expect(be.plays.filter((p) => p.ch === 'L')).toHaveLength(1);    // immediate pulse on a new target
    ch.beacon.setTarget(null);
    expect(be.beaconLeft).toMatchObject({ stops: 1 });
    expect(ch.beacon.isActive()).toBe(false);
    ch.dispose();
  });

  it('speech ducks both channels to silence', () => {
    const ch = make('CROSSING');
    ch.beacon.setTarget({ bearingDeg: 0 });
    ch.ticker.setState('WALK');
    speaking = true;
    jest.advanceTimersByTime(2000);
    expect(be.plays).toEqual([]);
    speaking = false;
    jest.advanceTimersByTime(1000);
    expect(be.plays.length).toBeGreaterThan(0);
    ch.dispose();
  });

  it('at the curb the ticker wins; with UNKNOWN the beacon pulses once per 3 s', () => {
    const ch = make('AT_CURB');
    ch.beacon.setTarget({ bearingDeg: 0 });
    ch.ticker.setState('DONT_WALK');
    jest.advanceTimersByTime(3000);
    expect(be.plays.filter((p) => p.ch === 'L')).toEqual([]);
    expect(be.plays.filter((p) => p.ch === 'tick').length).toBeGreaterThanOrEqual(3);
    be.plays.length = 0;
    ch.ticker.setState('UNKNOWN');
    jest.advanceTimersByTime(6050);
    const L = be.plays.filter((p) => p.ch === 'L');
    expect(L).toHaveLength(3);                                       // t≈0, 3, 6 s
    expect(L[1].t - L[0].t).toBe(BEACON_CURB_INTERVAL_MS);
    ch.dispose();
  });

  it('mode changes: IDLE clears both, indoors drops the beacon target, leaving curb/crossing resets the ticker', () => {
    const ch = make('OUTDOOR_NAV');
    ch.beacon.setTarget({ bearingDeg: 10 });
    store.getState().setMode('TRANSITION');
    expect(ch.beacon.getTarget()).toBeNull();

    store.setState({ mode: 'CROSSING' });
    ch.beacon.setTarget({ bearingDeg: 10 });
    ch.ticker.setState('WALK');
    store.getState().setMode('OUTDOOR_NAV');                           // FAR_CURB_REACHED
    expect(ch.ticker.getState()).toBe('UNKNOWN');
    expect(ch.beacon.getTarget()).toEqual({ bearingDeg: 10 });         // outdoors keeps the beacon

    store.getState().abort();
    expect(ch.beacon.getTarget()).toBeNull();
    expect(ch.ticker.getState()).toBe('UNKNOWN');
    jest.advanceTimersByTime(2000);
    expect(be.plays).toEqual([]);
    ch.dispose();
  });

  it('a lat/lng target is resolved against the last fix each pulse', () => {
    store.setState({ mode: 'OUTDOOR_NAV' });
    const ch = createAudioChannels({
      backend: be, store, heading: () => 0, speaking: () => false,
      position: () => ({ lat: 40.4443, lng: -79.9560, accuracyM: 5, courseDeg: null, speedMps: null, timestamp: Date.now() }),
    });
    ch.beacon.setTarget({ lat: 40.4443, lng: -79.9500 });             // due east
    jest.advanceTimersByTime(100);
    expect(ch.getDebugState().lastRelativeDeg).toBeCloseTo(90, 0);
    expect(be.plays.find((p) => p.ch === 'R')?.volume).toBeCloseTo(1, 6);
    ch.dispose();
  });

  it('muting a channel silences it without losing its state', () => {
    const ch = make('AT_CURB');
    ch.ticker.setState('WALK');
    ch.ticker.setMuted(true);
    jest.advanceTimersByTime(1000);
    expect(be.plays).toEqual([]);
    expect(ch.ticker.getState()).toBe('WALK');
    ch.ticker.setMuted(false);
    jest.advanceTimersByTime(1000);
    expect(be.plays.length).toBeGreaterThan(0);
    ch.dispose();
  });
});
