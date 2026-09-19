import type { SpeechRequest, VisionResponse } from './contracts';
import { createEventBus } from './bus';
import { bindStoreToBus, createAppStore } from './store';
import { PHRASES } from './phrases';
import {
  SITUATE_ASK_INTERVAL_MS,
  SITUATE_PROMPT_INTERVAL_MS,
  SITUATE_QUESTION_GAP_MS,
  SITUATE_REENTRY_MS,
  SITUATE_SETTLE_MS,
  classifySceneLabels,
  contextForSetting,
  createSituate,
  isNo,
  isYes,
  sameScene,
  sceneQuestion,
  settingFromWords,
  speakableLabel,
  whereaboutsFrom,
  type SituateDeps,
} from './situate';
import type { AskOutcome } from '../perception/semanticVision';

const T0 = 1_700_000_000_000;

function response(scene: VisionResponse['scene'], speech = ''): VisionResponse {
  return {
    speech,
    cameraRequest: 'none',
    userAction: 'none',
    aisle: { matchedAisleId: null, matchedLandmarkId: null, confidence: 0 },
    storefront: { visible: false, confidence: 0 },
    scan: { vehiclesSeen: 'none', confidence: 0 },
    signal: { state: 'UNKNOWN', confidence: 0 },
    hand: { hint: 'not_seen' },
    task: { done: false, confidence: 0 },
    scene,
    target: { box: null, confidence: 0 },
    confidence: 0.8,
    seq: 1,
  };
}

const applied = (scene: VisionResponse['scene'], speech = ''): AskOutcome => ({ status: 'applied', seq: 1, response: response(scene, speech), streamed: false, latencyMs: 300 });
const skipped: AskOutcome = { status: 'skipped', gate: 'scene_unchanged', seq: 1, response: null, streamed: false, latencyMs: null };

function harness(readings: AskOutcome[] = []) {
  const bus = createEventBus();
  const store = createAppStore({ bus, warn: () => undefined, initial: { firstRun: false } });
  bindStoreToBus(store, bus);
  const said: SpeechRequest[] = [];
  const log: string[] = [];
  const queue = [...readings];
  const ask = jest.fn(async (_q: string, _o?: { silent?: boolean; userText?: string }) => queue.shift() ?? skipped);
  const deps: SituateDeps = {
    store,
    speech: { say: (r) => { said.push(r); } },
    vision: { ask: ask as never },
    conversation: { pushAisle: (t) => { log.push(t); } },
    now: () => Date.now(),
  };
  return { deps, store, said, log, ask, queue };
}

async function flush(ms = 0): Promise<void> {
  await jest.advanceTimersByTimeAsync(ms);
}

describe('situate (pure)', () => {
  it('classifies yes / no and whereabouts statements', () => {
    for (const t of ['yes', 'Yeah.', 'correct', "that's right", 'yep']) expect(isYes(t)).toBe(true);
    for (const t of ['no', 'Nope', 'wrong', 'not really']) expect(isNo(t)).toBe(true);
    expect(isYes('yes please take me to eggs')).toBe(false);
    expect(whereaboutsFrom("I'm in the kitchen")).toBe('in the kitchen');
    expect(whereaboutsFrom('I am at the bus stop.')).toBe('at the bus stop');
    expect(whereaboutsFrom("we're outside on the sidewalk")).toBe('outside on the sidewalk');
    expect(whereaboutsFrom("I'm hungry")).toBe('in hungry'); // a statement, still taken as a place (the user can correct it)
    expect(whereaboutsFrom('take me to eggs')).toBeNull();
    expect(whereaboutsFrom('')).toBeNull();
  });

  it('maps words to settings and settings to task contexts', () => {
    expect(settingFromWords('in the kitchen by the fridge')).toBe('kitchen');
    expect(settingFromWords('in my living room')).toBe('room');
    expect(settingFromWords('on the sidewalk')).toBe('street');
    expect(settingFromWords('in aisle seven at giant eagle')).toBe('store');
    // Grocery sections a shopper names count as the store, so an item request there reroutes to the model.
    expect(settingFromWords('by the dairy')).toBe('store');
    expect(settingFromWords('over in produce')).toBe('store');
    expect(settingFromWords('over at the deli')).toBe('store');
    expect(settingFromWords('near the cashier')).toBe('store');
    expect(settingFromWords('somewhere')).toBe('unknown');
    expect(contextForSetting('kitchen')).toBe('home');
    expect(contextForSetting('crossing')).toBe('street');
    expect(contextForSetting('store')).toBe('store');
    expect(contextForSetting('vehicle')).toBe('unknown');
  });

  it('questions are twelve words at most, digit-free and never a forbidden term; long labels fall back to the setting', () => {
    expect(sceneQuestion('in a kitchen', 'kitchen')).toBe('You seem to be in a kitchen. Is that right?');
    // Six- and seven-word labels (what Haiku returns for real photos) keep their detail with the short tail.
    expect(sceneQuestion('in a kitchen by a refrigerator', 'home')).toBe('You seem to be in a kitchen by a refrigerator. Correct?');
    expect(sceneQuestion('at a street crossing by some stores', 'crossing')).toBe('You seem to be at a street crossing by some stores. Correct?');
    expect(sceneQuestion('on a sidewalk beside a busy four lane road', 'street')).toBe('You seem to be on a street. Is that right?');
    expect(speakableLabel('in aisle 7', 'store')).toBe('in a store');
    expect(speakableLabel('a safe spot', 'room')).toBe('in a room');
    expect(sceneQuestion('', 'unknown')).toBeNull();
  });

  it('sameScene: same setting and a shared content word', () => {
    expect(sameScene({ setting: 'kitchen', label: 'in a kitchen' }, { setting: 'kitchen', label: 'in a kitchen by the fridge' })).toBe(true);
    expect(sameScene({ setting: 'kitchen', label: 'in a kitchen' }, { setting: 'room', label: 'in a living room' })).toBe(false);
    expect(sameScene({ setting: 'street', label: 'on a sidewalk' }, { setting: 'street', label: 'on a street corner' })).toBe(false);
    expect(sameScene({ setting: 'street', label: '' }, { setting: 'street', label: 'on a street corner' })).toBe(true);
  });
});

describe('classifySceneLabels (Apple on-device labels → a place)', () => {
  it('votes by setting and names the room and the nearest thing', () => {
    expect(classifySceneLabels([{ id: 'kitchen', confidence: 0.6 }, { id: 'refrigerator', confidence: 0.3 }, { id: 'indoor', confidence: 0.2 }]))
      .toMatchObject({ setting: 'kitchen', label: 'in a kitchen by a fridge' });
    expect(classifySceneLabels([{ id: 'kitchen', confidence: 0.6 }, { id: 'refrigerator', confidence: 0.3 }])!.score).toBeCloseTo(0.9);
    expect(classifySceneLabels([{ id: 'living_room', confidence: 0.5 }, { id: 'couch', confidence: 0.4 }, { id: 'television', confidence: 0.2 }]))
      .toMatchObject({ setting: 'room', label: 'in a living room by a couch' });
    expect(classifySceneLabels([{ id: 'crosswalk', confidence: 0.4 }, { id: 'street', confidence: 0.5 }, { id: 'building', confidence: 0.3 }]))
      .toMatchObject({ setting: 'street', label: 'on a street by a crosswalk' });
    expect(classifySceneLabels([{ id: 'supermarket', confidence: 0.7 }, { id: 'shelf', confidence: 0.4 }]))
      .toMatchObject({ setting: 'store', label: 'in a grocery store by shelves' });
    expect(classifySceneLabels([{ id: 'sky', confidence: 0.9 }, { id: 'cloud', confidence: 0.5 }])).toBeNull();
    expect(classifySceneLabels([])).toBeNull();
  });
});

describe('createSituate', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
  });
  afterEach(() => jest.useRealTimers());

  it('with nothing known: "Turn slowly. Show me your surroundings." after the settle time, then every thirty seconds; situate asks start too', async () => {
    const h = harness();
    const s = createSituate(h.deps);
    s.start();
    await flush(SITUATE_SETTLE_MS);
    // Looking starts at the settle time; speaking waits out the re-entry hold as well.
    expect(h.ask).toHaveBeenCalledWith('situate', { silent: true });
    expect(h.said).toEqual([]);
    await flush(SITUATE_REENTRY_MS - SITUATE_SETTLE_MS);
    expect(h.said.map((r) => r.cacheKey)).toEqual(['show_surroundings']);
    expect(h.said[0].text).toBe(PHRASES.show_surroundings);
    await flush(SITUATE_PROMPT_INTERVAL_MS - 1000);
    expect(h.said).toHaveLength(1);
    await flush(1000);
    expect(h.said).toHaveLength(2);
    // Asks keep their own cadence from the settle time.
    expect(h.ask.mock.calls.length).toBe(1 + Math.floor((SITUATE_REENTRY_MS - SITUATE_SETTLE_MS + SITUATE_PROMPT_INTERVAL_MS) / SITUATE_ASK_INTERVAL_MS));
    s.dispose();
  });

  it('a confident reading becomes a question; "yes" confirms it ("Got it."), the store shows it, and the context follows', async () => {
    const h = harness([applied({ setting: 'kitchen', label: 'in a kitchen', confidence: 0.8 })]);
    const s = createSituate(h.deps);
    s.start();
    await flush(SITUATE_REENTRY_MS);
    // A confident reading arrived during the hold: no "show me" prompt, straight to the question.
    expect(h.said.map((r) => r.text)).toEqual(['You seem to be in a kitchen. Is that right?']);
    expect(h.store.getState().scene).toMatchObject({ setting: 'kitchen', label: 'in a kitchen', confirmed: false, source: 'camera' });
    expect(s.getDebugState().pending).toBe('question');
    expect(s.intercept('take me to eggs')).toBe(false);
    expect(s.intercept('yes')).toBe(true);
    expect(h.store.getState().scene).toMatchObject({ setting: 'kitchen', confirmed: true });
    expect(h.said[h.said.length - 1].cacheKey).toBe('noted');
    expect(s.getContext()).toBe('home');
    expect(s.getDebugState().pending).toBeNull();
    // Confirmed: no "show me" prompts, and a matching reading refreshes silently.
    h.queue.push(applied({ setting: 'kitchen', label: 'in a kitchen near a counter', confidence: 0.7 }));
    await flush(SITUATE_PROMPT_INTERVAL_MS);
    expect(h.said.filter((r) => r.cacheKey === 'show_surroundings')).toHaveLength(0);
    expect(h.said.filter((r) => r.dedupeKey === 'situate-question')).toHaveLength(1);
    expect(h.store.getState().scene).toMatchObject({ label: 'in a kitchen', confirmed: true });
    s.dispose();
  });

  it('"no" asks where they are; the answer becomes the scene in their words; a spontaneous "I am on the sidewalk" does the same', async () => {
    const h = harness([applied({ setting: 'room', label: 'in a bedroom', confidence: 0.9 })]);
    const s = createSituate(h.deps);
    s.start();
    await flush(SITUATE_REENTRY_MS);
    expect(s.intercept('No.')).toBe(true);
    expect(h.said[h.said.length - 1].cacheKey).toBe('tell_me_where');
    expect(s.getDebugState().pending).toBe('whereabouts');
    expect(s.intercept('the living room')).toBe(true);
    expect(h.store.getState().scene).toMatchObject({ setting: 'room', label: 'in the living room', confirmed: true, source: 'user' });
    expect(h.said[h.said.length - 1].cacheKey).toBe('noted');
    expect(h.log).toContain('Got it.');
    // The user's statement is passed to the camera question from then on.
    await flush(SITUATE_ASK_INTERVAL_MS);
    expect(h.ask.mock.calls[h.ask.mock.calls.length - 1][1]).toEqual({ silent: true, userText: 'User says they are in the living room.' });
    // Spontaneous correction, no question open.
    expect(s.intercept("I'm on the sidewalk")).toBe(true);
    expect(h.store.getState().scene).toMatchObject({ setting: 'street', label: 'on the sidewalk', confirmed: true, source: 'user' });
    expect(s.getContext()).toBe('street');
    s.dispose();
  });

  it('a different place after a confirmed one is asked again, but not within the question gap; leaving the aware modes pauses the loop', async () => {
    const h = harness([applied({ setting: 'kitchen', label: 'in a kitchen', confidence: 0.8 })]);
    const s = createSituate(h.deps);
    s.start();
    await flush(SITUATE_REENTRY_MS);
    s.intercept('yes');
    // A new place too soon: ignored.
    h.queue.push(applied({ setting: 'street', label: 'on a sidewalk', confidence: 0.9 }));
    await flush(SITUATE_ASK_INTERVAL_MS);
    expect(h.said.filter((r) => r.dedupeKey === 'situate-question')).toHaveLength(1);
    // After the gap, the next reading of the new place is asked.
    await flush(SITUATE_QUESTION_GAP_MS);
    h.queue.push(applied({ setting: 'street', label: 'on a sidewalk', confidence: 0.9 }));
    await flush(SITUATE_ASK_INTERVAL_MS);
    expect(h.said.filter((r) => r.dedupeKey === 'situate-question').map((r) => r.text)).toEqual([
      'You seem to be in a kitchen. Is that right?',
      'You seem to be on a sidewalk. Is that right?',
    ]);
    // A trip starts: nothing more is asked or said while walking.
    h.store.getState().setMode('OUTDOOR_NAV');
    const asksBefore = h.ask.mock.calls.length;
    const saidBefore = h.said.length;
    await flush(SITUATE_PROMPT_INTERVAL_MS * 2);
    expect(h.ask.mock.calls.length).toBe(asksBefore);
    expect(h.said.length).toBe(saidBefore);
    s.dispose();
  });

  it('in a guided task (or with a request pending) the loop looks but never speaks; the guess still reaches the screen', async () => {
    const h = harness([applied({ setting: 'kitchen', label: 'in a kitchen', confidence: 0.8 })]);
    const s = createSituate(h.deps);
    h.deps.store.getState().setMode('GUIDED_TASK');
    s.start();
    await flush(SITUATE_SETTLE_MS + SITUATE_ASK_INTERVAL_MS);
    expect(h.ask).toHaveBeenCalled();
    expect(h.said).toEqual([]);
    expect(h.store.getState().scene).toMatchObject({ setting: 'kitchen', confirmed: false });
    expect(s.getContext()).toBe('home');
    h.deps.store.getState().abort();
    h.deps.store.setState({ targetItem: 'eggs' });
    await flush(SITUATE_PROMPT_INTERVAL_MS);
    expect(h.said).toEqual([]);
    s.dispose();
  });

  it('narrates what the camera faces at INFO, at most every five seconds, never the same words twice in thirty; off with the preference', async () => {
    const unknown = { setting: 'unknown' as const, label: '', confidence: 0 };
    const h = harness([
      applied(unknown, 'You are looking at a wall.'),
      applied(unknown, 'You are looking at a wall.'),          // same words: not news
      applied(unknown, 'A person is ahead of you, close.'),
      applied(unknown, 'Aisle 3 is on your left.'),            // a digit: never spoken
      applied(unknown, 'You may cross now, it is clear.'),     // forbidden: never spoken
    ]);
    const s = createSituate(h.deps);
    s.start();
    await flush(SITUATE_SETTLE_MS + SITUATE_ASK_INTERVAL_MS * 4 + 100);
    const narrated = h.said.filter((r) => r.dedupeKey === 'situate-narration');
    expect(narrated.map((r) => r.text)).toEqual(['You are looking at a wall.', 'A person is ahead of you, close.']);
    expect(narrated.every((r) => r.priority === 'INFO')).toBe(true);
    expect(h.log).toContain('You are looking at a wall.');
    expect(s.getDebugState().narrations).toBe(2);
    s.dispose();

    const h2 = harness([applied(unknown, 'You are looking at a wall.')]);
    const s2 = createSituate({ ...h2.deps, narrate: () => false });
    s2.start();
    await flush(SITUATE_SETTLE_MS + SITUATE_ASK_INTERVAL_MS);
    expect(h2.said.filter((r) => r.dedupeKey === 'situate-narration')).toHaveLength(0);
    s2.dispose();
  });

  it('two agreeing on-device readings propose the place at once; a lone or weak reading does not', async () => {
    const listeners = new Set<(e: { labels: Array<{ id: string; confidence: number }>; timestamp: number }) => void>();
    const h = harness();
    const s = createSituate({ ...h.deps, perception: { onSceneClass: (cb) => { listeners.add(cb); return () => listeners.delete(cb); } } });
    s.start();
    await flush(SITUATE_REENTRY_MS);
    const fire = (labels: Array<{ id: string; confidence: number }>) => { for (const cb of Array.from(listeners)) cb({ labels, timestamp: Date.now() }); };
    fire([{ id: 'kitchen', confidence: 0.5 }, { id: 'refrigerator', confidence: 0.3 }]);
    expect(h.store.getState().scene).toBeNull();                       // one reading: not yet
    fire([{ id: 'living_room', confidence: 0.5 }]);                    // a different setting resets the streak
    fire([{ id: 'kitchen', confidence: 0.5 }, { id: 'refrigerator', confidence: 0.3 }]);
    expect(h.store.getState().scene).toBeNull();
    fire([{ id: 'kitchen', confidence: 0.4 }, { id: 'stove', confidence: 0.2 }]);
    expect(h.store.getState().scene).toMatchObject({ setting: 'kitchen', confirmed: false, source: 'camera' });
    // The standing ask had already gone out at the hold's end (nothing known then); the question follows.
    expect(h.said.map((r) => r.text)).toEqual([PHRASES.show_surroundings, 'You seem to be in a kitchen by a stove. Correct?']);
    expect(s.getDebugState()).toMatchObject({ classReadings: 4, classAccepted: 1 });
    // Weak labels never count.
    fire([{ id: 'street', confidence: 0.05 }]);
    fire([{ id: 'street', confidence: 0.05 }]);
    expect(h.store.getState().scene).toMatchObject({ setting: 'kitchen' });
    s.dispose();
    expect(listeners.size).toBe(0);
  });

  it('a vision error or a low-confidence reading changes nothing', async () => {
    const h = harness([
      { status: 'error', seq: 1, response: null, streamed: false, latencyMs: 10 },
      applied({ setting: 'kitchen', label: 'in a kitchen', confidence: 0.3 }),
      applied({ setting: 'unknown', label: '', confidence: 0.9 }),
    ]);
    const s = createSituate(h.deps);
    s.start();
    await flush(SITUATE_SETTLE_MS + SITUATE_ASK_INTERVAL_MS * 2);
    expect(h.store.getState().scene).toBeNull();
    expect(h.said.filter((r) => r.dedupeKey === 'situate-question')).toHaveLength(0);
    s.dispose();
  });
});
