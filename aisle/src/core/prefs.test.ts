import { createAppStore } from './store';
import {
  DEFAULT_PREFS,
  applyPrefs,
  bindPrefs,
  createMemoryPrefsStorage,
  parsePrefs,
  prefsFrom,
  samePrefs,
  serializePrefs,
} from './prefs';

describe('prefs codec (pure)', () => {
  it('round-trips through serialize/parse', () => {
    const p = { firstRun: false, trainingMode: false, speechRate: 1.3, bodyOffsetDeg: -12.5 };
    expect(parsePrefs(serializePrefs(p))).toEqual(p);
  });

  it('is tolerant: garbage, wrong types and unknown keys are ignored; rate is clamped', () => {
    expect(parsePrefs(null)).toEqual({});
    expect(parsePrefs('')).toEqual({});
    expect(parsePrefs('not json')).toEqual({});
    expect(parsePrefs('[1,2]')).toEqual({});
    expect(parsePrefs(JSON.stringify({ firstRun: 'no', trainingMode: 1, speechRate: 'fast', bodyOffsetDeg: NaN, extra: true }))).toEqual({});
    expect(parsePrefs(JSON.stringify({ speechRate: 9, bodyOffsetDeg: 4 }))).toEqual({ speechRate: 1.6, bodyOffsetDeg: 4 });
    expect(parsePrefs(JSON.stringify({ firstRun: false }))).toEqual({ firstRun: false });
  });

  it('prefsFrom / samePrefs read the four persisted fields only', () => {
    const store = createAppStore({ warn: () => undefined });
    expect(prefsFrom(store.getState())).toEqual(DEFAULT_PREFS);
    expect(samePrefs(prefsFrom(store.getState()), { ...DEFAULT_PREFS })).toBe(true);
    store.getState().setTargetItem('eggs'); // not a pref
    expect(samePrefs(prefsFrom(store.getState()), { ...DEFAULT_PREFS })).toBe(true);
    store.getState().setSpeechRate(1.2);
    expect(samePrefs(prefsFrom(store.getState()), { ...DEFAULT_PREFS })).toBe(false);
  });

  it('applyPrefs goes through the store actions and clamps the rate', () => {
    const store = createAppStore({ warn: () => undefined });
    applyPrefs(store, { firstRun: false, speechRate: 5 });
    expect(store.getState().firstRun).toBe(false);
    expect(store.getState().speechRate).toBe(1.6);
    expect(store.getState().trainingMode).toBe(true);
  });
});

describe('bindPrefs', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('hydrates the store from storage, then writes changes back (debounced)', async () => {
    const storage = createMemoryPrefsStorage(serializePrefs({ firstRun: false, trainingMode: false, speechRate: 1.4, bodyOffsetDeg: 7 }));
    const store = createAppStore({ warn: () => undefined });
    const binding = bindPrefs(store, storage, { debounceMs: 100 });
    await binding.hydrated;
    expect(store.getState().firstRun).toBe(false);
    expect(store.getState().trainingMode).toBe(false);
    expect(store.getState().speechRate).toBe(1.4);
    expect(store.getState().bodyOffsetDeg).toBe(7);

    const before = storage.current();
    store.getState().setTrainingMode(true);
    store.getState().setTrainingMode(false);
    store.getState().setTrainingMode(true);
    expect(storage.current()).toBe(before); // nothing yet: debounced
    await jest.advanceTimersByTimeAsync(100);
    expect(parsePrefs(storage.current())).toEqual({ firstRun: false, trainingMode: true, describeSurroundings: true, speechRate: 1.4, bodyOffsetDeg: 7 });
    binding.dispose();
  });

  it('describeSurroundings (round 3) defaults to true, is absent-tolerant on read and persisted on change', async () => {
    expect(DEFAULT_PREFS.describeSurroundings).toBe(true);
    expect(parsePrefs(JSON.stringify({ describeSurroundings: false }))).toEqual({ describeSurroundings: false });
    expect(parsePrefs(JSON.stringify({ describeSurroundings: 'no' }))).toEqual({});

    // A file written before the key existed leaves the store default in place.
    const storage = createMemoryPrefsStorage(serializePrefs({ firstRun: false, trainingMode: true, speechRate: 1, bodyOffsetDeg: 0 }));
    const store = createAppStore({ warn: () => undefined });
    const binding = bindPrefs(store, storage, { debounceMs: 50 });
    await binding.hydrated;
    expect(store.getState().describeSurroundings).toBe(true);

    store.getState().setDescribeSurroundings(false);
    await jest.advanceTimersByTimeAsync(50);
    expect(parsePrefs(storage.current()).describeSurroundings).toBe(false);

    // And it comes back on the next launch.
    const store2 = createAppStore({ warn: () => undefined });
    const binding2 = bindPrefs(store2, storage, { debounceMs: 50 });
    await binding2.hydrated;
    expect(store2.getState().describeSurroundings).toBe(false);
    binding.dispose();
    binding2.dispose();
  });

  it('an empty or unreadable store means first launch and writes nothing until something changes', async () => {
    const storage = createMemoryPrefsStorage(null);
    const store = createAppStore({ warn: () => undefined });
    const binding = bindPrefs(store, storage, { debounceMs: 10 });
    expect(await binding.hydrated).toEqual({});
    expect(store.getState().firstRun).toBe(true);
    await jest.advanceTimersByTimeAsync(50);
    expect(storage.current()).toBeNull();
    store.getState().setFirstRun(false);
    await jest.advanceTimersByTimeAsync(10);
    expect(parsePrefs(storage.current()).firstRun).toBe(false);
    binding.dispose();
  });

  it('a failing read is reported and treated as empty; a failing write is reported and retried', async () => {
    const errors: string[] = [];
    let fail = true;
    const storage = {
      read: async (): Promise<string | null> => {
        throw new Error('disk');
      },
      write: async (): Promise<void> => {
        if (fail) throw new Error('full');
      },
    };
    const store = createAppStore({ warn: () => undefined });
    const binding = bindPrefs(store, storage, { debounceMs: 10, onError: (stage) => errors.push(stage) });
    await binding.hydrated;
    expect(errors).toEqual(['read']);
    store.getState().setFirstRun(false);
    await jest.advanceTimersByTimeAsync(10);
    expect(errors).toEqual(['read', 'write']);
    fail = false;
    store.getState().setSpeechRate(1.1);
    await jest.advanceTimersByTimeAsync(10);
    expect(errors).toEqual(['read', 'write']);
    binding.dispose();
  });

  it('flush writes immediately; dispose stops further writes', async () => {
    const storage = createMemoryPrefsStorage(null);
    const store = createAppStore({ warn: () => undefined });
    const binding = bindPrefs(store, storage, { debounceMs: 1000 });
    await binding.hydrated;
    store.getState().setBodyOffsetDeg(3);
    await binding.flush();
    expect(parsePrefs(storage.current()).bodyOffsetDeg).toBe(3);
    binding.dispose();
    store.getState().setBodyOffsetDeg(9);
    await jest.advanceTimersByTimeAsync(2000);
    expect(parsePrefs(storage.current()).bodyOffsetDeg).toBe(3);
  });
});
