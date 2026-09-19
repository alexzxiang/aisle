import type { SpeechRequest, TransitionSignal } from '../core/contracts';
import { FORBIDDEN_TERMS, countWords, findForbiddenTerm } from '../core/phrases';
import { SECOND_LINE_DELAY_MS, announceStoreEntry, wireStoreEntryAnnouncement } from './announce';

function fakes() {
  const haptics: string[] = [];
  const said: SpeechRequest[] = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const deps = {
    haptics: { play: (p: string) => { haptics.push(p); } },
    speech: { say: (r: SpeechRequest) => { said.push(r); } },
    setTimeoutFn: (fn: () => void, ms: number) => { timers.push({ fn, ms, cleared: false }); return timers.length - 1; },
    clearTimeoutFn: (h: unknown) => { timers[h as number]!.cleared = true; },
  };
  const fire = (i = 0) => { if (!timers[i]!.cleared) timers[i]!.fn(); };
  return { haptics, said, timers, deps, fire };
}

describe('announceStoreEntry', () => {
  it('plays CONFIRM, says the cached entering_store line at NAV, then the INFO line ≥ 4 s later', () => {
    const f = fakes();
    announceStoreEntry(f.deps);
    expect(f.haptics).toEqual(['CONFIRM']);
    expect(f.said).toHaveLength(1);
    expect(f.said[0]).toMatchObject({ cacheKey: 'entering_store', priority: 'NAV' });
    expect(f.timers[0]!.ms).toBeGreaterThanOrEqual(SECOND_LINE_DELAY_MS);
    f.fire();
    expect(f.said).toHaveLength(2);
    expect(f.said[1]).toMatchObject({ cacheKey: 'looking_for_signs', priority: 'INFO', dedupeKey: 'looking_for_signs' });
  });

  it('both lines are terse, digit-free and never use a forbidden word', () => {
    const f = fakes();
    announceStoreEntry(f.deps);
    f.fire();
    for (const r of f.said) {
      expect(countWords(r.text)).toBeLessThanOrEqual(6);
      expect(findForbiddenTerm(r.text)).toBeNull();
      expect(/\d/.test(r.text)).toBe(false);
    }
    expect(FORBIDDEN_TERMS.length).toBeGreaterThan(0);
  });

  it('cancel() drops the pending second line and nothing else', () => {
    const f = fakes();
    const h = announceStoreEntry(f.deps);
    h.cancel();
    expect(f.timers[0]!.cleared).toBe(true);
    f.fire();
    expect(f.said).toHaveLength(1);
    expect(f.haptics).toEqual(['CONFIRM']);
    h.cancel(); // idempotent
  });
});

describe('wireStoreEntryAnnouncement', () => {
  it('runs the script on every onEnter and the unsubscribe cancels a pending line', () => {
    const f = fakes();
    let cb: ((s: TransitionSignal) => void) | null = null;
    let offCalled = false;
    const detector = { onEnter: (c: (s: TransitionSignal) => void) => { cb = c; return () => { offCalled = true; }; } };
    const fired: string[] = [];
    const off = wireStoreEntryAnnouncement(detector, f.deps, (s) => fired.push(s.reason));
    const signal: TransitionSignal = {
      reason: 'FUSED', confidence: 0.8, detectedAt: 1,
      signals: { distanceMinThenRise: 0.3, accuracyStepUp: 0.3, stepsSinceMin: 0.2, storefrontFrame: 0, ambientLight: 0 },
    };
    cb!(signal);
    expect(f.haptics).toEqual(['CONFIRM']);
    expect(f.said.map((r) => r.cacheKey)).toEqual(['entering_store']);
    expect(fired).toEqual(['FUSED']);
    off();
    expect(offCalled).toBe(true);
    expect(f.timers[0]!.cleared).toBe(true);
  });
});
