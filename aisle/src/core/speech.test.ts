import type { AppMode } from './contracts';
import { createEventBus, type AppEventBus } from './bus';
import { createAppStore, type AppStore } from './store';
import { PHRASES } from './phrases';
import {
  CRITICAL_CLASSES,
  DEFAULT_COOLDOWN_MS,
  MIN_GAP_MS,
  MODE_POLICY,
  PROMPT_MIN_INTERVAL_MS,
  RUNTIME_KEY_PREFIX,
  SpeechTextError,
  classifyRequest,
  createSpeechService,
  fnv1a32,
  isAllowedInMode,
  validateText,
  type AisleSpeechService,
  type PlaybackHandle,
  type SpeechBackend,
  type SpeechBackendName,
} from './speech';

// ---------------------------------------------------------------------------
// Fake backend: every playback is a handle we finish by hand
// ---------------------------------------------------------------------------

interface Played { backend: SpeechBackendName; what: string; rate: number; t: number; stopped: boolean }

function fakeBackend(cachedKeys: string[] = Object.keys(PHRASES)) {
  const cached = new Set(cachedKeys);
  const played: Played[] = [];
  const pendingDone: Array<() => void> = [];
  let synthResult: string | null = 'file:///cache/tts/x.mp3';
  let synthCalls = 0;
  const mk = (backend: SpeechBackendName, what: string, rate: number, onDone: () => void): PlaybackHandle => {
    const rec: Played = { backend, what, rate, t: Date.now(), stopped: false };
    played.push(rec);
    pendingDone.push(onDone);
    return { backend, stop: () => { rec.stopped = true; } };
  };
  const be: SpeechBackend = {
    hasCached: (k) => cached.has(k),
    playCached: (k, rate, onDone) => mk('cached', k, rate, onDone),
    playFile: (uri, rate, onDone) => mk('file', uri, rate, onDone),
    playUrl: (url, rate, onDone) => mk('stream', url, rate, onDone),
    speak: (text, rate, onDone) => mk('expo-speech', text, rate, onDone),
    synthesize: async () => { synthCalls += 1; return synthResult; },
    streamUrl: (id) => `http://proxy/api/tts/stream/${id}`,
  };
  return {
    be, played,
    /** Finish the oldest unfinished playback. */
    finish() { pendingDone.shift()?.(); },
    finishAll() { while (pendingDone.length) pendingDone.shift()?.(); },
    setSynth(v: string | null) { synthResult = v; },
    synthCalls: () => synthCalls,
    last: () => played[played.length - 1],
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe('SpeechService', () => {
  let bus: AppEventBus;
  let store: AppStore;
  let errors: string[];
  let fb: ReturnType<typeof fakeBackend>;
  let svc: AisleSpeechService;

  const make = (mode: AppMode = 'OUTDOOR_NAV', opts: Partial<Parameters<typeof createSpeechService>[0]> = {}) => {
    store.setState({ mode });
    svc = createSpeechService({ backend: fb.be, store, bus, isDev: true, ...opts });
    return svc;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(10_000);
    bus = createEventBus();
    store = createAppStore({ bus, warn: () => {} });
    errors = [];
    bus.on('ERROR', (e) => errors.push(`${e.scope}: ${e.message}`));
    fb = fakeBackend();
  });
  afterEach(() => {
    svc?.dispose();
    jest.useRealTimers();
  });

  // --- playback tiers ---------------------------------------------------------

  it('prepared geometry plays locally by exact text; uncached task speech never waits for synthesis', () => {
    make('GUIDED_TASK');
    svc.say({ text: PHRASES.guide_fridge_forward_5, priority: 'NAV' });
    expect(fb.last().what).toBe('guide_fridge_forward_5');
    expect(fb.synthCalls()).toBe(0);
    fb.finish();
    jest.advanceTimersByTime(MIN_GAP_MS);
    svc.say({ text: 'Your striped carton is on the middle shelf.', priority: 'NAV' });
    expect(fb.last()).toMatchObject({ backend: 'expo-speech', what: 'Your striped carton is on the middle shelf.' });
    expect(fb.synthCalls()).toBe(0);
  });

  it('a hung synthesizer cannot hold the queue, and late audio cannot speak twice', async () => {
    let release!: (uri: string) => void;
    fb.be.synthesize = () => new Promise((resolve) => { release = resolve; });
    make();
    svc.say({ text: 'Turn toward Forbes Avenue.', priority: 'NAV' });
    await jest.advanceTimersByTimeAsync(500);
    expect(fb.last().backend).toBe('expo-speech');
    release('file:///late.mp3');
    await flush();
    expect(fb.played).toHaveLength(1);
  });

  it('hand cues have a one-second gap and mic suspension prevents speech until released', () => {
    make('GUIDED_TASK');
    svc.say({ text: PHRASES.left, priority: 'NAV', cacheKey: 'left' });
    fb.finish();
    svc.say({ text: PHRASES.higher, priority: 'NAV', cacheKey: 'higher' });
    jest.advanceTimersByTime(1000);
    expect(fb.last().what).toBe('higher');
    svc.setSuspended(true);
    svc.say({ text: PHRASES.right, priority: 'NAV' });
    jest.advanceTimersByTime(5000);
    expect(fb.played).toHaveLength(2);
    svc.setSuspended(false);
    svc.say({ text: PHRASES.right, priority: 'NAV' });
    expect(fb.last().what).toBe('right');
  });

  it('plays a cached phrase from the bundled player at the current rate', () => {
    make();
    store.getState().setSpeechRate(1.15);
    svc.say({ text: PHRASES.turn_right_soon, priority: 'NAV', cacheKey: 'turn_right_soon' });
    expect(fb.played).toEqual([expect.objectContaining({ backend: 'cached', what: 'turn_right_soon', rate: 1.15 })]);
    expect(svc.isSpeaking()).toBe(true);
    fb.finish();
    expect(svc.isSpeaking()).toBe(false);
    expect(svc.getStats().lastBackend).toBe('cached');
  });

  it('live text goes through /api/tts and falls back to expo-speech when synthesis fails', async () => {
    make();
    svc.say({ text: 'Crossing ahead: Forbes. Signalized.', priority: 'NAV' });
    expect(svc.isSpeaking()).toBe(true);           // slot held while synthesizing
    await flush();
    expect(fb.last()).toEqual(expect.objectContaining({ backend: 'file', what: 'file:///cache/tts/x.mp3' }));
    fb.finish();

    fb.setSynth(null);
    jest.advanceTimersByTime(MIN_GAP_MS);
    svc.say({ text: 'Turn right onto Craig Street.', priority: 'NAV' });
    await flush();
    expect(fb.last()).toEqual(expect.objectContaining({ backend: 'expo-speech', what: 'Turn right onto Craig Street.' }));
  });

  it('prefetch caches variable text so a later say() never goes live', async () => {
    make();
    const key = await svc.prefetch('Aisle three. Eggs on your right.');
    expect(key).toBe(`${RUNTIME_KEY_PREFIX}${fnv1a32('Aisle three. Eggs on your right.')}`);
    expect(svc.runtimeKeyFor('Aisle three. Eggs on your right.')).toBe(key);
    const before = fb.synthCalls();
    svc.say({ text: 'Aisle three. Eggs on your right.', priority: 'NAV', cacheKey: key as string });
    expect(fb.synthCalls()).toBe(before);
    expect(fb.last()).toEqual(expect.objectContaining({ backend: 'file' }));
    fb.finish();
    // Same text without the key also hits the file.
    jest.advanceTimersByTime(MIN_GAP_MS);
    svc.say({ text: 'Aisle three. Eggs on your right.', priority: 'NAV' });
    expect(fb.synthCalls()).toBe(before);
    expect(fb.last().backend).toBe('file');
  });

  it('prefetch resolves null offline and rejects forbidden text', async () => {
    make();
    fb.setSynth(null);
    await expect(svc.prefetch('Left onto Fifth Avenue.')).resolves.toBeNull();
    await expect(svc.prefetch('It is safe now')).rejects.toBeInstanceOf(SpeechTextError);
  });

  it('playStream plays the proxy relay URL through the same queue', () => {
    make('INDOOR_NAV');
    svc.playStream('42', 'NAV');
    expect(fb.last()).toEqual(expect.objectContaining({ backend: 'stream', what: 'http://proxy/api/tts/stream/42' }));
    expect(svc.getStats().lastText).toBe('<stream 42>');
  });

  // --- queue rules --------------------------------------------------------------

  it('NAV queues with one pending slot (newest wins) and respects the 4 s gap', () => {
    make();
    svc.say({ text: PHRASES.turn_right_soon, priority: 'NAV', cacheKey: 'turn_right_soon' });
    fb.finish();
    jest.advanceTimersByTime(1000);
    svc.say({ text: PHRASES.crossing_ahead_signalized, priority: 'NAV', cacheKey: 'crossing_ahead_signalized' });
    svc.say({ text: PHRASES.turn_right_now, priority: 'NAV', cacheKey: 'turn_right_now' });
    expect(fb.played).toHaveLength(1);                     // gap not yet elapsed
    expect(svc.getStats().pending).toBe(1);
    jest.advanceTimersByTime(MIN_GAP_MS - 1000 - 1);
    expect(fb.played).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(fb.played).toHaveLength(2);
    expect(fb.last().what).toBe('turn_right_now');           // the older pending item lost
    expect(fb.last().t - fb.played[0].t).toBe(MIN_GAP_MS);
    expect(svc.getStats().queueDropped).toBe(1);
  });

  it('INFO is dropped when anything is queued, otherwise plays', () => {
    make();
    svc.say({ text: PHRASES.turn_right_soon, priority: 'NAV', cacheKey: 'turn_right_soon' });
    svc.say({ text: PHRASES.turn_right_now, priority: 'NAV', cacheKey: 'turn_right_now' });
    svc.say({ text: PHRASES.label_okay, priority: 'INFO', cacheKey: 'label_okay' });
    expect(svc.getStats().pending).toBe(1);
    expect(svc.getStats().queueDropped).toBe(1);
    fb.finish();
    jest.advanceTimersByTime(MIN_GAP_MS);
    expect(fb.last().what).toBe('turn_right_now');
    fb.finish();
    jest.advanceTimersByTime(MIN_GAP_MS);
    svc.say({ text: PHRASES.label_okay, priority: 'INFO', cacheKey: 'label_okay' });
    expect(fb.last().what).toBe('label_okay');
  });

  it('CRITICAL interrupts the current utterance on any backend, flushes below, plays at once', async () => {
    make();
    svc.say({ text: 'Left onto Craig Street.', priority: 'NAV' });
    await flush();
    expect(fb.last().backend).toBe('file');
    svc.say({ text: PHRASES.turn_right_now, priority: 'NAV', cacheKey: 'turn_right_now' }); // pending
    svc.say({ text: PHRASES.vehicle_right, priority: 'CRITICAL', cacheKey: 'vehicle_right' });
    expect(fb.played[0].stopped).toBe(true);
    expect(fb.last()).toEqual(expect.objectContaining({ backend: 'cached', what: 'vehicle_right' }));
    expect(svc.getStats().pending).toBe(0);              // NAV flushed
    // CRITICAL ignores the 4 s gap.
    expect(fb.last().t - fb.played[0].t).toBeLessThan(MIN_GAP_MS);
  });

  it('CRITICAL behind CRITICAL queues unless interrupt is set', () => {
    make();
    svc.say({ text: PHRASES.vehicle_left, priority: 'CRITICAL', cacheKey: 'vehicle_left' });
    svc.say({ text: PHRASES.vehicle_right, priority: 'CRITICAL', cacheKey: 'vehicle_right' });
    expect(fb.played).toHaveLength(1);
    expect(fb.played[0].stopped).toBe(false);
    svc.say({ text: PHRASES.obstacle_ahead, priority: 'CRITICAL', cacheKey: 'obstacle_ahead', interrupt: true });
    expect(fb.played[0].stopped).toBe(true);
    expect(fb.last().what).toBe('obstacle_ahead');   // the interrupter jumps the line
    fb.finishAll();
    expect(fb.last().what).toBe('vehicle_right');    // the earlier CRITICAL still follows
  });

  it('drops a dedupeKey repeat inside its cooldown (default 8 s)', () => {
    make();
    svc.say({ text: PHRASES.crossing_ahead_signalized, priority: 'NAV', cacheKey: 'crossing_ahead_signalized', dedupeKey: 'x' });
    fb.finish();
    jest.advanceTimersByTime(MIN_GAP_MS);
    svc.say({ text: PHRASES.crossing_ahead_signalized, priority: 'NAV', cacheKey: 'crossing_ahead_signalized', dedupeKey: 'x' });
    expect(fb.played).toHaveLength(1);
    expect(svc.getStats().dedupeDropped).toBe(1);
    jest.advanceTimersByTime(DEFAULT_COOLDOWN_MS - MIN_GAP_MS);
    svc.say({ text: PHRASES.crossing_ahead_signalized, priority: 'NAV', cacheKey: 'crossing_ahead_signalized', dedupeKey: 'x' });
    expect(fb.played).toHaveLength(2);
    // A custom cooldown.
    fb.finish();
    jest.advanceTimersByTime(MIN_GAP_MS);
    svc.say({ text: PHRASES.label_okay, priority: 'NAV', cacheKey: 'label_okay', dedupeKey: 'ok', cooldownMs: 1000 });
    fb.finish();
    jest.advanceTimersByTime(MIN_GAP_MS);
    svc.say({ text: PHRASES.label_okay, priority: 'NAV', cacheKey: 'label_okay', dedupeKey: 'ok', cooldownMs: 1000 });
    expect(fb.played).toHaveLength(4);
  });

  it('an INFO the queue dropped does not burn its dedupe cooldown: the retry after the drain plays', () => {
    make();
    svc.say({ text: PHRASES.turn_right_soon, priority: 'NAV', cacheKey: 'turn_right_soon' });
    svc.say({ text: PHRASES.turn_right_now, priority: 'NAV', cacheKey: 'turn_right_now' });   // pending
    svc.say({ text: PHRASES.label_okay, priority: 'INFO', cacheKey: 'label_okay', dedupeKey: 'ok', cooldownMs: 30_000 });
    expect(svc.getStats().queueDropped).toBe(1);
    fb.finish();
    jest.advanceTimersByTime(MIN_GAP_MS);
    expect(fb.last().what).toBe('turn_right_now');
    fb.finish();
    jest.advanceTimersByTime(MIN_GAP_MS);
    // 8 s later, well inside the 30 s cooldown: the user never heard it, so it plays.
    svc.say({ text: PHRASES.label_okay, priority: 'INFO', cacheKey: 'label_okay', dedupeKey: 'ok', cooldownMs: 30_000 });
    expect(fb.last().what).toBe('label_okay');
    expect(svc.getStats().dedupeDropped).toBe(0);
    // And an accepted item still arms it.
    fb.finish();
    jest.advanceTimersByTime(MIN_GAP_MS);
    svc.say({ text: PHRASES.label_okay, priority: 'INFO', cacheKey: 'label_okay', dedupeKey: 'ok', cooldownMs: 30_000 });
    expect(svc.getStats().dedupeDropped).toBe(1);
  });

  it('a watchdog releases the slot if a backend never reports done', () => {
    make();
    svc.say({ text: PHRASES.turn_right_soon, priority: 'NAV', cacheKey: 'turn_right_soon' });
    jest.advanceTimersByTime(4000);
    expect(svc.isSpeaking()).toBe(true); // don't chop a normal ElevenLabs sentence
    jest.advanceTimersByTime(6000);
    expect(svc.isSpeaking()).toBe(false);
  });

  it('clearQueue(priority) drops that level and below, keeps above', () => {
    make();
    svc.say({ text: PHRASES.vehicle_left, priority: 'CRITICAL', cacheKey: 'vehicle_left' });
    svc.say({ text: PHRASES.vehicle_right, priority: 'CRITICAL', cacheKey: 'vehicle_right' });
    svc.clearQueue('NAV');
    expect(svc.getStats().pending).toBe(1);
    expect(fb.played[0].stopped).toBe(false);
    svc.clearQueue();
    expect(svc.getStats().pending).toBe(0);
    expect(fb.played[0].stopped).toBe(true);
    expect(svc.isSpeaking()).toBe(false);
  });

  // --- text guard ---------------------------------------------------------------

  it('dev: throws on digits and forbidden words; a long line is fitted, never thrown away (round 13); the disclaimer is exempt from length only', () => {
    make();
    // Thirteen words: the line is fitted to twelve and spoken, in dev as in prod.
    expect(() => svc.say({ text: 'one two three four five six seven eight nine ten eleven twelve thirteen', priority: 'NAV' })).not.toThrow();
    expect(() => svc.say({ text: 'Turn right in 20 feet', priority: 'NAV' })).toThrow(/digits/);
    expect(() => svc.say({ text: 'The road is clear', priority: 'NAV' })).toThrow(/forbidden/);
    expect(() => svc.say({ text: PHRASES.disclaimer, priority: 'NAV', cacheKey: 'disclaimer' })).not.toThrow();
    expect(() => svc.say({ text: PHRASES.disclaimer, priority: 'NAV' })).not.toThrow();
    // The allow-list key cannot smuggle other text (forbidden or not): the mismatch guard fires first,
    // and the table wording itself is lint-clean (phrases.test), so no forbidden word reaches the queue.
    expect(() => svc.say({ text: `${PHRASES.disclaimer} It is safe.`, priority: 'NAV', cacheKey: 'disclaimer' })).toThrow(/differs from the phrase table/);
  });

  it('a phrase-table cacheKey speaks the table wording; dev throws when the caller text differs', () => {
    make();
    // A privileged key cannot carry other text past the policy or the 12-word rule.
    expect(() => svc.say({ text: 'Forbes Avenue.', priority: 'CRITICAL', cacheKey: 'vehicle_left' })).toThrow(/differs from the phrase table/);
    const fortyFive = Array.from({ length: 45 }, () => 'word').join(' ');
    expect(() => svc.say({ text: fortyFive, priority: 'NAV', cacheKey: 'disclaimer' })).toThrow(/differs from the phrase table/);
    // A key that is neither in the table nor a runtime key is a caller bug.
    expect(() => svc.say({ text: 'Forbes Avenue.', priority: 'NAV', cacheKey: 'not_a_key' })).toThrow(/not a phrase key/);
    expect(fb.played).toEqual([]);
    // Runtime keys keep the caller's text.
    svc.say({ text: 'Forbes Avenue.', priority: 'NAV', cacheKey: `${RUNTIME_KEY_PREFIX}deadbeef` });
    expect(svc.isSpeaking()).toBe(true);
  });

  it('prod: a mismatched keyed text is replaced by the table wording and reported; an unknown key is stripped', async () => {
    make('OUTDOOR_NAV', { isDev: false });
    svc.say({ text: 'Car on your left, watch out.', priority: 'CRITICAL', cacheKey: 'vehicle_left' });
    expect(fb.last()).toEqual(expect.objectContaining({ backend: 'cached', what: 'vehicle_left' }));
    expect(svc.getStats().lastText).toBe(PHRASES.vehicle_left);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^speech: .*vehicle_left.*differs from the phrase table/);
    expect(svc.getStats().textRepaired).toBe(1);
    fb.finishAll();
    jest.advanceTimersByTime(MIN_GAP_MS);
    svc.say({ text: 'Forbes Avenue.', priority: 'NAV', cacheKey: 'not_a_key' });
    await flush();
    expect(errors).toHaveLength(2);
    expect(errors[1]).toMatch(/not a phrase key/);
    expect(fb.last().backend).toBe('file');       // spoken as free text, not looked up as a cached key
  });

  it('prod: truncates at 12 words, drops forbidden text, reports ERROR {scope: speech}', () => {
    make('OUTDOOR_NAV', { isDev: false });
    svc.say({ text: 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen', priority: 'NAV' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^speech: .*14 words.*truncated/);
    fb.finishAll();
    jest.advanceTimersByTime(MIN_GAP_MS);
    svc.say({ text: 'You can cross', priority: 'NAV' });
    expect(errors).toHaveLength(2);
    expect(errors[1]).toMatch(/forbidden.*dropped/);
    expect(svc.getStats().textRepaired).toBe(2);
  });

  it('validateText applies the 6-word cap to Tier-1 prompts', () => {
    expect(validateText('Tilt the camera up a little please', { allowLong: false, isPrompt: true, isDev: false }).problems).toEqual(['7 words (max 6)']);
    expect(validateText('Tilt the camera up.', { allowLong: false, isPrompt: true, isDev: true }).problems).toEqual([]);
  });

  // --- mode policy ---------------------------------------------------------------

  it('AT_CURB lets through signal, vehicle, scan, countdown and compass only', () => {
    make('AT_CURB');
    const allowed = ['walk_signal_on', 'dont_walk', 'countdown', 'vehicle_left', 'no_vehicles_left', 'compass_uncertain', 'disclaimer'] as const;
    const blocked = ['turn_right_now', 'crossing_ahead_signalized', 'entering_store', 'obstacle_ahead', 'course_hint_left', 'tilt_camera_up', 'label_turn'] as const;
    for (const k of blocked) {
      svc.say({ text: PHRASES[k], priority: 'NAV', cacheKey: k });
    }
    expect(fb.played).toEqual([]);
    expect(svc.getStats().policyDropped).toBe(blocked.length);
    for (const k of allowed) expect(isAllowedInMode('AT_CURB', classifyRequest({ cacheKey: k }), 'NAV')).toBe(true);
    // Unknown live text is not curb speech either.
    svc.say({ text: 'Forbes Avenue.', priority: 'NAV' });
    expect(fb.played).toEqual([]);
    // Nor does the CRITICAL flag buy it a way in: only hazard classes skip the table.
    svc.say({ text: 'Forbes Avenue.', priority: 'CRITICAL' });
    expect(fb.played).toEqual([]);
    expect(svc.isSpeaking()).toBe(false);
    svc.say({ text: PHRASES.vehicle_left, priority: 'CRITICAL', cacheKey: 'vehicle_left' });
    expect(fb.last().what).toBe('vehicle_left');
  });

  it('CRITICAL admits only hazard classes (vehicle, obstacle, scan, always) and reports anything else', () => {
    expect([...CRITICAL_CLASSES].sort()).toEqual(['always', 'obstacle', 'scan', 'vehicle']);
    make('AT_CURB');
    svc.say({ text: 'free text', priority: 'CRITICAL' });
    expect(fb.played).toEqual([]);
    expect(svc.getStats().policyDropped).toBe(1);
    expect(errors).toEqual([expect.stringMatching(/^speech: CRITICAL say\("free text"\) dropped: class "unknown"/)]);
    // A leg cue is not a hazard either, even keyed.
    svc.say({ text: PHRASES.turn_right_now, priority: 'CRITICAL', cacheKey: 'turn_right_now' });
    expect(fb.played).toEqual([]);
    expect(svc.getStats().policyDropped).toBe(2);
    // The hazard classes play at the curb, and obstacle plays there although the NAV table excludes it.
    for (const k of ['vehicle_left', 'obstacle_ahead', 'no_vehicles_left', 'offline_notice'] as const) {
      svc.say({ text: PHRASES[k], priority: 'CRITICAL', cacheKey: k });
    }
    fb.finishAll();
    expect(fb.played.map((p) => p.what)).toEqual(['vehicle_left', 'obstacle_ahead', 'no_vehicles_left', 'offline_notice']);
    expect(isAllowedInMode('CROSSING', 'stream', 'CRITICAL')).toBe(false);
    expect(isAllowedInMode('INDOOR_NAV', 'stream', 'CRITICAL')).toBe(false);
  });

  it('a CRITICAL stream never plays, at the curb or anywhere else', () => {
    make('AT_CURB');
    svc.playStream('7', 'CRITICAL');
    expect(fb.played).toEqual([]);
    expect(svc.getStats().policyDropped).toBe(1);
    expect(errors).toEqual([expect.stringMatching(/CRITICAL playStream\("7"\) dropped: class "stream"/)]);
    store.getState().setMode('IDLE');
    store.setState({ mode: 'INDOOR_NAV' });
    svc.playStream('8', 'CRITICAL');
    expect(fb.played).toEqual([]);
    svc.playStream('9', 'NAV');
    expect(fb.last().what).toBe('http://proxy/api/tts/stream/9');
  });

  it('CROSSING allows vehicle, countdown and far_curb; indoor modes allow aisle facts, not leg cues', () => {
    expect(MODE_POLICY.CROSSING.has('far_curb')).toBe(true);
    expect(MODE_POLICY.CROSSING.has('countdown')).toBe(true);
    expect(MODE_POLICY.CROSSING.has('vehicle')).toBe(true);
    expect(MODE_POLICY.CROSSING.has('signal')).toBe(false);
    expect(MODE_POLICY.CROSSING.has('leg')).toBe(false);
    expect(MODE_POLICY.INDOOR_NAV.has('indoor')).toBe(true);
    expect(MODE_POLICY.INDOOR_NAV.has('leg')).toBe(false);
    expect(MODE_POLICY.INDOOR_NAV.has('signal')).toBe(false);
    expect(MODE_POLICY.OUTDOOR_NAV.has('indoor')).toBe(false);
    for (const m of Object.keys(MODE_POLICY) as AppMode[]) expect(MODE_POLICY[m].has('always')).toBe(true);
  });

  it('re-checks the policy at dequeue so nothing queued before the curb leaks into it', () => {
    make('APPROACH_CROSSING');
    svc.say({ text: PHRASES.crossing_ahead_signalized, priority: 'NAV', cacheKey: 'crossing_ahead_signalized' });
    svc.say({ text: PHRASES.push_button_likely, priority: 'NAV', cacheKey: 'push_button_likely' }); // pending
    store.getState().setMode('AT_CURB');
    expect(svc.getStats().pending).toBe(0);
    fb.finish();
    jest.advanceTimersByTime(MIN_GAP_MS + 100);
    expect(fb.played).toHaveLength(1);
  });

  it('IDLE flushes everything', () => {
    make();
    svc.say({ text: PHRASES.turn_right_soon, priority: 'NAV', cacheKey: 'turn_right_soon' });
    svc.say({ text: PHRASES.turn_right_now, priority: 'NAV', cacheKey: 'turn_right_now' });
    store.getState().abort();
    expect(fb.played[0].stopped).toBe(true);
    expect(svc.getStats().pending).toBe(0);
    expect(svc.isSpeaking()).toBe(false);
  });

  // --- Tier-1 prompt gate -------------------------------------------------------

  it('Tier-1 prompts: ≤ 1 per 3 s and never while COURSE buzzes; course_hint is exempt', () => {
    let buzzing = false;
    make('INDOOR_NAV', { isCourseBuzzing: () => buzzing });
    svc.say({ text: PHRASES.tilt_camera_up, priority: 'NAV', cacheKey: 'tilt_camera_up' });
    expect(fb.played).toHaveLength(1);
    fb.finish();
    jest.advanceTimersByTime(MIN_GAP_MS);
    svc.say({ text: PHRASES.turn_left_a_little, priority: 'NAV', cacheKey: 'turn_left_a_little' });
    expect(fb.played).toHaveLength(2);      // 4 s > 3 s, allowed
    fb.finish();
    jest.advanceTimersByTime(PROMPT_MIN_INTERVAL_MS - 500);
    svc.say({ text: PHRASES.turn_right_a_little, priority: 'NAV', cacheKey: 'turn_right_a_little' });
    expect(svc.getStats().gateDropped).toBe(1);

    buzzing = true;
    jest.advanceTimersByTime(MIN_GAP_MS);
    svc.say({ text: PHRASES.turn_right_a_little, priority: 'NAV', cacheKey: 'turn_right_a_little' });
    expect(svc.getStats().gateDropped).toBe(2);
    svc.say({ text: PHRASES.course_hint_right, priority: 'NAV', cacheKey: 'course_hint_right' });
    expect(fb.last().what).toBe('course_hint_right');
  });

  it('a queue-dropped Tier-1 prompt does not burn the 3 s prompt slot', () => {
    make('INDOOR_NAV');
    svc.say({ text: PHRASES.keep_going, priority: 'NAV', cacheKey: 'keep_going' });
    svc.say({ text: PHRASES.checkout_ahead, priority: 'NAV', cacheKey: 'checkout_ahead' });   // pending
    svc.say({ text: PHRASES.tilt_camera_up, priority: 'INFO', cacheKey: 'tilt_camera_up' }); // queue-dropped
    expect(svc.getStats().queueDropped).toBe(1);
    svc.clearQueue('NAV');
    jest.advanceTimersByTime(1000);
    svc.say({ text: PHRASES.tilt_camera_up, priority: 'NAV', cacheKey: 'tilt_camera_up' });
    expect(svc.getStats().gateDropped).toBe(0);
    expect(svc.getStats().pending).toBe(1);                 // waiting on the 4 s gap, not gated
  });

  // --- rate and stats ------------------------------------------------------------

  it('setRate clamps to 0.8–1.6, writes the store, and applies to the next player', () => {
    make();
    svc.setRate(3);
    expect(store.getState().speechRate).toBe(1.6);
    svc.setRate(0.1);
    expect(store.getState().speechRate).toBe(0.8);
    store.getState().setSpeechRate(1.2);
    svc.say({ text: PHRASES.turn_right_soon, priority: 'NAV', cacheKey: 'turn_right_soon' });
    expect(fb.last().rate).toBe(1.2);
  });

  it('counts utterances per minute and the last backend', () => {
    make();
    for (let i = 0; i < 5; i += 1) {
      svc.say({ text: PHRASES.turn_right_soon, priority: 'NAV', cacheKey: 'turn_right_soon' });
      fb.finish();
      jest.advanceTimersByTime(MIN_GAP_MS);
    }
    expect(svc.getStats().utterancesPerMinute).toBe(5);
    expect(svc.getStats().spoken).toBe(5);
    jest.advanceTimersByTime(60_000);
    expect(svc.getStats().utterancesPerMinute).toBe(0);
  });

  it('pushes every utterance that starts playing to the conversation log, never a dropped one (round 3)', async () => {
    const pushed: Array<{ text: string; source?: string }> = [];
    make('OUTDOOR_NAV', { conversation: { pushAisle: (text, source) => { pushed.push({ text, source }); } } });
    svc.say({ text: PHRASES.turn_right_soon, priority: 'NAV', cacheKey: 'turn_right_soon' });
    expect(pushed).toEqual([{ text: PHRASES.turn_right_soon, source: 'speech' }]);
    // Queue-dropped INFO (something is pending) and policy-dropped speech never appear.
    svc.say({ text: PHRASES.turn_left_now, priority: 'NAV', cacheKey: 'turn_left_now' });      // pending
    svc.say({ text: 'Open door ahead.', priority: 'INFO' });                                     // dropped: pending exists
    store.setState({ mode: 'AT_CURB' });
    svc.say({ text: 'Shelves both sides.', priority: 'INFO' });                                  // policy-dropped at the curb
    expect(pushed).toHaveLength(1);
    fb.finish();
    jest.advanceTimersByTime(MIN_GAP_MS);
    expect(pushed).toHaveLength(1);   // the pending leg cue was policy-dropped at dequeue (curb)
    store.setState({ mode: 'OUTDOOR_NAV' });
    svc.say({ text: 'Open door ahead.', priority: 'INFO' });
    await flush();
    expect(pushed).toEqual([
      { text: PHRASES.turn_right_soon, source: 'speech' },
      { text: 'Open door ahead.', source: 'speech' },
    ]);
    // A stream has no text to show; a throwing log never takes the queue down.
    svc.clearQueue();
    svc.playStream('7', 'NAV');
    expect(pushed).toHaveLength(2);
    svc.dispose();
    make('OUTDOOR_NAV', { conversation: { pushAisle: () => { throw new Error('log'); } } });
    expect(() => svc.say({ text: PHRASES.turn_right_soon, priority: 'NAV', cacheKey: 'turn_right_soon' })).not.toThrow();
    expect(svc.getStats().spoken).toBe(1);
  });

  it('fnv1a32 is stable and hex', () => {
    expect(fnv1a32('Aisle three.')).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1a32('Aisle three.')).toBe(fnv1a32('Aisle three.'));
    expect(fnv1a32('Aisle three.')).not.toBe(fnv1a32('Aisle four.'));
  });
});
