/**
 * Continuous mock replay, end to end: the composed app (A's store/speech/haptics,
 * B's LegRunner + CrossingController, C's perception binding) driven only by D's
 * replayers on fixtures/track.json and fixtures/perception/*.jsonl, at 1×.
 *
 * Pins the demo beat the reviewer found missing: with packs keyed by AppMode the curb
 * pack arms on the AT_CURB edge, so its WALK onset lands while the controller is
 * READING and "Walk signal on." is spoken at the curb — before the user steps off.
 */
import demoStore from '../fixtures/stores/demo-store-01.json';
import type { AppMode } from '../src/core/contracts';
import type { AudioChannelBackend } from '../src/core/audio';
import { createEventBus } from '../src/core/bus';
import { composeApp, type AppPlatform } from '../src/core/composeApp';
import { PHRASES } from '../src/core/phrases';
import { createMemoryPrefsStorage, serializePrefs } from '../src/core/prefs';
import { services } from '../src/core/services';
import type { SpeechBackend } from '../src/core/speech';
import { bindStoreToBus, createAppStore } from '../src/core/store';
import { createOutdoorStore } from '../src/outdoor/store';
import { bridgeAppStore, createMockServices } from './index';
import { track } from './fixtures';

const T0 = 1_700_000_000_000;
const CONFIG = { proxyUrl: 'http://proxy.test:8787', proxyWs: 'ws://proxy.test:8787/ws', mock: true };

interface Spoken { text: string; mode: AppMode; t: number }

function fakePlatform(getMode: () => AppMode, getT: () => number) {
  const spoken: Spoken[] = [];
  const player = () => ({ play: () => undefined, stop: () => undefined, dispose: () => undefined });
  const speechBackend: SpeechBackend = {
    hasCached: () => false,
    playCached: () => null,
    playFile: () => null,
    playUrl: () => null,
    speak(text, _rate, onDone) {
      spoken.push({ text, mode: getMode(), t: getT() });
      const h = setTimeout(onDone, 300);
      return { backend: 'expo-speech', stop: () => clearTimeout(h) };
    },
    synthesize: async () => null,
    streamUrl: (id) => `stream/${id}`,
  };
  const audioBackend: AudioChannelBackend = { beaconLeft: player(), beaconRight: player(), tick: player(), setAudioMode: async () => undefined };
  const platform: AppPlatform = {
    hapticBackend: { impact: () => undefined, notificationError: () => undefined },
    speechBackend,
    audioBackend,
    fetchImpl: (async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch,
    prefsStorage: createMemoryPrefsStorage(serializePrefs({ firstRun: false, trainingMode: false, speechRate: 1, bodyOffsetDeg: 0 })),
  };
  return { platform, spoken };
}

describe('mock replay end to end (fixtures/track.json + perception packs)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    services.reset();
  });
  afterEach(() => {
    services.reset();
    jest.useRealTimers();
  });

  it('walks OUTDOOR_NAV → APPROACH_CROSSING → AT_CURB → CROSSING and speaks walk_signal_on at the curb, before the first step off it', async () => {
    const bus = createEventBus();
    const store = createAppStore({ bus, warn: () => undefined });
    const unbind = bindStoreToBus(store, bus);
    const mocks = createMockServices({ bus, store: bridgeAppStore(store), latencyScale: 0 });
    const trackT = () => mocks.harness.getTimeS();
    const { platform, spoken } = fakePlatform(() => store.getState().mode, trackT);
    const outdoor = createOutdoorStore();
    const app = composeApp({ config: CONFIG, bus, store, platform, mocks, fixtureTrack: track, loadStoreMap: () => demoStore, outdoor });

    const edges: Array<{ mode: AppMode; t: number; pack: string | null }> = [];
    const unsubEdges = store.subscribe((s, prev) => {
      if (s.mode !== prev.mode) edges.push({ mode: s.mode, t: Math.round(trackT()), pack: mocks.perception.currentPack() });
    });

    await app.start();
    bus.emit({ type: 'ITEM_REQUESTED', item: 'eggs', source: 'mock' });
    await jest.advanceTimersByTimeAsync(1000);
    expect(store.getState().mode).toBe('OUTDOOR_NAV');
    expect(mocks.perception.debug().modeDriven).toBe(true);
    expect(mocks.perception.currentPack()).toBe('outdoor-leg');

    const curb = track.meta!.curb!;
    // Replay at 1× up to the middle of the crossing (the far curb is ~22 m away at 1.3 m/s).
    await jest.advanceTimersByTimeAsync((curb.arriveT + curb.dwellS + 8) * 1000);

    // The whole sequence is in the failure message; the crossing beat must appear in order.
    const sequence = edges.map((e) => `${e.mode}@${e.t}`).join(' > ');
    expect(sequence).toMatch(/^OUTDOOR_NAV@0 > /);
    expect(sequence).toMatch(/APPROACH_CROSSING@\d+ > AT_CURB@\d+ > CROSSING@\d+/);
    const curbIdx = edges.findIndex((e) => e.mode === 'AT_CURB');
    const approach = edges[curbIdx - 1]!;
    const atCurb = edges[curbIdx]!;
    const crossing = edges[curbIdx + 1]!;
    expect(edges.filter((e) => e.mode === 'AT_CURB')).toHaveLength(1);
    // Packs keyed by mode: the approach plays vehicles; the curb pack starts at the curb, not 25 m out.
    expect(approach.pack).toBe('vehicle-approach');
    expect(atCurb.pack).toBe('curb-walk-onset');
    expect(atCurb.t).toBeGreaterThanOrEqual(curb.arriveT);
    expect(atCurb.t).toBeLessThan(curb.arriveT + curb.dwellS);
    // The user leaves the curb when the track says so; CROSSING keeps the curb pack (COUNTDOWN follows).
    expect(crossing.t).toBeGreaterThanOrEqual(curb.arriveT + curb.dwellS);
    expect(crossing.pack).toBe('curb-walk-onset');

    // The demo beat: "Walk signal on." spoken at the curb, after the curb edge and before stepping off.
    const walk = spoken.find((s) => s.text === PHRASES.walk_signal_on);
    expect(walk).toBeDefined();
    expect(walk!.mode).toBe('AT_CURB');
    expect(walk!.t).toBeGreaterThanOrEqual(atCurb.t);
    expect(walk!.t).toBeLessThanOrEqual(crossing.t);
    // No "Countdown." / "Don't walk." before the onset (the old approach-armed pack had already run past WALK).
    const beforeWalk = spoken.filter((s) => s.t < walk!.t).map((s) => s.text);
    expect(beforeWalk).not.toContain(PHRASES.countdown);
    expect(spoken.filter((s) => s.text === PHRASES.walk_signal_on)).toHaveLength(1);

    // 06 demo beat: the vehicle warning lands while CROSSING (the curb pack carries the car), not on the approach only.
    expect(spoken.some((s) => s.mode === 'CROSSING' && /^Vehicle/.test(s.text))).toBe(true);
    expect(store.getState().mode).toBe('CROSSING');

    expect(app.metrics.illegalTransitions).toBe(0);
    for (const s of spoken) expect(s.text.split(/\s+/).length).toBeLessThanOrEqual(12);

    unsubEdges();
    app.dispose();
    mocks.harness.dispose();
    unbind();
  });
});
