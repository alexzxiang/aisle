import { createStubHaptics, createStubSensors, createCallLog } from '../core/stubs';
import type { SignalState } from '../core/contracts';
import { PHRASES, PHRASE_KEYS, isPhraseKey } from '../core/phrases';
import { MAX_UTTERANCE_WORDS, findForbidden, wordCount } from './copy';
import {
  BEACON_DEMO_MS, COURSE_DEMO_MS, MAX_LINES_PER_STEP, ONBOARDING_STEPS, TICKER_STEP_MS,
  heroFor, spokenLines, stepsFor, type StepServices,
} from './onboardingSteps';

function makeServices(): { s: StepServices; calls: ReturnType<typeof createCallLog>; ticks: SignalState[]; beacon: Array<{ bearingDeg: number } | null> } {
  const calls = createCallLog();
  const ticks: SignalState[] = [];
  const beacon: Array<{ bearingDeg: number } | null> = [];
  const s: StepServices = {
    haptics: createStubHaptics(calls),
    sensors: createStubSensors(calls),
    ticker: { setState: (st) => ticks.push(st) },
    beacon: { setTarget: (t) => beacon.push(t) },
  };
  return { s, calls, ticks, beacon };
}

describe('onboarding script', () => {
  it('covers the whole lesson: disclaimer, four patterns, beacon, ticker, gear, calibration, the yes/no rehearsal, done', () => {
    const ids = ONBOARDING_STEPS.map((s) => s.id);
    expect(ids).toEqual(['disclaimer', 'intro', 'course-intro', 'course', 'turn', 'stop', 'confirm', 'beacon', 'ticker-a', 'ticker-b', 'gear', 'lanyard', 'calibrate', 'practice-scene', 'done']);
  });

  it('ends with exactly one answered step, and it is the awareness question', () => {
    const answered = ONBOARDING_STEPS.filter((s) => s.practice === 'yes_no');
    expect(answered.map((s) => s.id)).toEqual(['practice-scene']);
    expect(spokenLines(answered[0])[0].text).toMatch(/\?$/);
    // Last but one: the lesson still signs off with "done".
    expect(ONBOARDING_STEPS[ONBOARDING_STEPS.length - 2].practice).toBe('yes_no');
  });

  it.each(ONBOARDING_STEPS.map((s) => [s.id, s] as const))('%s speaks within the rules, through pre-generated keys only', (_id, step) => {
    expect(step.lines.length).toBeGreaterThanOrEqual(1);
    expect(step.lines.length).toBeLessThanOrEqual(MAX_LINES_PER_STEP);   // NAV keeps one pending slot
    for (const line of spokenLines(step)) {
      expect(isPhraseKey(line.cacheKey)).toBe(true);
      expect(line.cacheKey === 'disclaimer' || line.cacheKey.startsWith('onboarding_')).toBe(true);
      expect(line.text).toBe(PHRASES[line.cacheKey]);                   // canonical text, never a paraphrase
      expect(findForbidden(line.text)).toEqual([]);
      expect(line.text).not.toMatch(/\d/);
      if (line.cacheKey !== 'disclaimer') expect(wordCount(line.text)).toBeLessThanOrEqual(MAX_UTTERANCE_WORDS);
    }
    expect(findForbidden(heroFor(step))).toEqual([]);
    expect(wordCount(heroFor(step))).toBeLessThanOrEqual(MAX_UTTERANCE_WORDS);
    expect(findForbidden(step.detail ?? '')).toEqual([]);
    expect(findForbidden(step.modeWord)).toEqual([]);
  });

  it('uses every generated onboarding_* clip and the disclaimer, each once', () => {
    const used = ONBOARDING_STEPS.flatMap((s) => [...s.lines]);
    const table = PHRASE_KEYS.filter((k) => k.startsWith('onboarding_'));
    expect([...used].sort()).toEqual(['disclaimer', ...table].sort());
  });

  it('the hero defaults to the first spoken line; the disclaimer keeps a short hero', () => {
    const intro = ONBOARDING_STEPS.find((s) => s.id === 'intro')!;
    expect(heroFor(intro)).toBe(PHRASES.onboarding_intro);
    const disclaimer = ONBOARDING_STEPS.find((s) => s.id === 'disclaimer')!;
    expect(heroFor(disclaimer)).toBe('Aisle is a prototype, not a safety device.');
  });

  it('only the first run hears the disclaimer step', () => {
    expect(stepsFor(true)[0].id).toBe('disclaimer');
    expect(stepsFor(false)[0].id).toBe('intro');
    expect(stepsFor(false)).toHaveLength(ONBOARDING_STEPS.length - 1);
  });
});

describe('onboarding demonstrations', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const step = (id: string) => {
    const s = ONBOARDING_STEPS.find((x) => x.id === id);
    if (!s || !s.run) throw new Error(`no runnable step ${id}`);
    return s;
  };

  it('course: starts COURSE against the current heading and stops it after ten seconds or on cleanup', () => {
    const { s, calls } = makeServices();
    const cleanup = step('course').run?.(s);
    expect(calls.calls.map((c) => c.method)).toEqual(['courseErrorFor', 'startCourse']);
    expect(calls.calls[0].args[0]).toEqual({ bearingDeg: 0, roadSide: 'NONE' });
    jest.advanceTimersByTime(COURSE_DEMO_MS);
    expect(calls.calls.map((c) => c.method)).toContain('stopCourse');
    if (typeof cleanup === 'function') cleanup();
  });

  it('course cleanup stops the buzz early', () => {
    const { s, calls } = makeServices();
    const cleanup = step('course').run?.(s);
    if (typeof cleanup === 'function') cleanup();
    expect(calls.calls.map((c) => c.method)).toContain('stopCourse');
    jest.advanceTimersByTime(COURSE_DEMO_MS);
    expect(calls.calls.filter((c) => c.method === 'stopCourse')).toHaveLength(1);
  });

  it.each([
    ['turn', 'TURN'],
    ['stop', 'STOP'],
    ['confirm', 'CONFIRM'],
  ])('%s plays exactly one %s', (id, pattern) => {
    const { s, calls } = makeServices();
    step(id).run?.(s);
    expect(calls.calls).toEqual([expect.objectContaining({ method: 'play', args: [pattern] })]);
  });

  it('beacon: points ninety degrees off the current heading, then off', () => {
    const { s, beacon } = makeServices();
    const cleanup = step('beacon').run?.(s);
    expect(beacon).toEqual([{ bearingDeg: 90 }]);
    jest.advanceTimersByTime(BEACON_DEMO_MS);
    expect(beacon[1]).toBeNull();
    if (typeof cleanup === 'function') cleanup();
  });

  it('beacon step is harmless without a beacon port', () => {
    const { s } = makeServices();
    delete s.beacon;
    expect(() => step('beacon').run?.(s)).not.toThrow();
  });

  it('ticker: slow then fast, then silence; second step medium then silence', () => {
    const { s, ticks } = makeServices();
    step('ticker-a').run?.(s);
    jest.advanceTimersByTime(TICKER_STEP_MS * 2);
    expect(ticks).toEqual(['DONT_WALK', 'WALK', 'UNKNOWN']);
    ticks.length = 0;
    const cleanup = step('ticker-b').run?.(s);
    jest.advanceTimersByTime(TICKER_STEP_MS);
    expect(ticks).toEqual(['COUNTDOWN', 'UNKNOWN']);
    if (typeof cleanup === 'function') cleanup();
    expect(ticks[ticks.length - 1]).toBe('UNKNOWN');
  });

  it('ticker cleanup cancels the remaining changes', () => {
    const { s, ticks } = makeServices();
    const cleanup = step('ticker-a').run?.(s);
    jest.advanceTimersByTime(TICKER_STEP_MS - 1);
    if (typeof cleanup === 'function') cleanup();
    jest.advanceTimersByTime(TICKER_STEP_MS * 3);
    expect(ticks).toEqual(['DONT_WALK', 'UNKNOWN']);
  });

  it('calibrate: runs the straight-walk routine and reports the result once', async () => {
    const { s, calls } = makeServices();
    const results: Array<{ offsetDeg: number; ok: boolean }> = [];
    s.onCalibrated = (r) => results.push(r);
    step('calibrate').run?.(s);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.calls.map((c) => c.method)).toEqual(['calibrateBodyOffset']);
    expect(results).toEqual([{ offsetDeg: 0, ok: false }]);
  });

  it('calibrate: a cleanup before the result drops it', async () => {
    const { s } = makeServices();
    const results: unknown[] = [];
    s.onCalibrated = (r) => results.push(r);
    const cleanup = step('calibrate').run?.(s);
    if (typeof cleanup === 'function') cleanup();
    await Promise.resolve();
    await Promise.resolve();
    expect(results).toEqual([]);
  });
});
