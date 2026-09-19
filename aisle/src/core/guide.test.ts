import type { Detection } from './contracts';
import { MAX_UTTERANCE_WORDS, countWords, findForbiddenTerm, hasDigit } from './phrases';
import { CLASS_HEIGHT_M, createGuide, degreesFromBox, handWord, phraseFor, stepsFromBox, type GuideKind } from './guide';

const det = (cls: Detection['cls'], cx: number, h: number, near?: number): Detection => ({ cls, box: [cx - 0.15, 0.5 - h / 2, 0.3, h], score: 0.8, trackId: 1, ...(near !== undefined ? { near } : {}) });

function rig(opts: { detections?: Detection[]; where?: unknown; hfov?: number; now?: () => number } = {}) {
  const memory = { whereIs: jest.fn(() => (opts.where ?? 'unseen') as never), facing: () => 0 };
  const guide = createGuide({ detections: () => opts.detections ?? [], memory, hfovDeg: () => opts.hfov ?? 56, now: opts.now });
  return { guide, memory };
}

describe('guide (pure)', () => {
  it('relative depth alone cannot declare a small distant fridge within reach', () => {
    expect(rig({ detections: [det('fridge', 0.5, 0.3, 0.95)] }).guide.instructionFor('fridge')?.kind).not.toBe('arrived');
  });
  it('steps from box height: a fridge filling the frame is one step, a fifth of it about eight', () => {
    expect(stepsFromBox('fridge', [0.3, 0.1, 0.4, 0.8], undefined)).toBe(2);
    expect(stepsFromBox('fridge', [0.4, 0.4, 0.2, 0.2], undefined)).toBe(9);
    expect(stepsFromBox('fridge', [0.4, 0.4, 0.2, 0.2], 0.8)).toBeGreaterThan(1); // relative depth is not proof of arrival
    expect(stepsFromBox('cup', [0.45, 0.45, 0.1, 0.1], undefined)).toBe(1);
    expect(stepsFromBox(null, [0.45, 0.45, 0.1, 0.05], undefined)).toBeLessThanOrEqual(20);
    expect(CLASS_HEIGHT_M.fridge).toBe(1.7);
  });

  it('degrees from a box: centre is zero, the right edge is half the field of view', () => {
    expect(degreesFromBox([0.35, 0, 0.3, 0.4], 56)).toBeCloseTo(0);
    expect(degreesFromBox([0.7, 0, 0.3, 0.4], 56)).toBeCloseTo(19.6);
    expect(degreesFromBox([0, 0, 0.2, 0.4], 100)).toBeCloseTo(-40);
  });

  it('every phrasing of every kind is twelve words or fewer, digit-free and never a forbidden term', () => {
    const kinds: GuideKind[] = ['arrived', 'forward', 'sidestep', 'turn_little', 'turn', 'turn_around', 'scan_remembered', 'scan_unknown'];
    for (const kind of kinds) {
      const seen = new Set<number>();
      for (let i = 0; i < 40; i += 1) {
        const r = phraseFor(kind, 'fridge', 17, 'right', undefined);
        seen.add(r.index);
        expect({ kind, text: r.text, words: countWords(r.text) }).toMatchObject({ words: expect.any(Number) });
        expect(countWords(r.text)).toBeLessThanOrEqual(MAX_UTTERANCE_WORDS);
        expect(hasDigit(r.text)).toBe(false);
        expect(findForbiddenTerm(r.text)).toBeNull();
      }
      expect(seen.size).toBeGreaterThan(1);
      // The previous phrasing is never reused back to back.
      for (let i = 0; i < 20; i += 1) {
        const a = phraseFor(kind, 'couch', 3, 'left', undefined);
        const b = phraseFor(kind, 'couch', 3, 'left', a.index);
        if (seen.size > 1) expect(b.index).not.toBe(a.index);
      }
    }
  });

  it('hand words: image coordinates, larger correction first, inside twice is grab', () => {
    const target: [number, number, number, number] = [0.6, 0.3, 0.2, 0.2];   // centre (0.7, 0.4)
    expect(handWord({ tipX: 0.3, tipY: 0.4 }, target, 0)).toBe('right');
    expect(handWord({ tipX: 0.7, tipY: 0.8 }, target, 0)).toBe('higher');
    expect(handWord({ tipX: 0.7, tipY: 0.1 }, target, 0)).toBe('lower');
    expect(handWord({ tipX: 0.95, tipY: 0.4 }, target, 0)).toBe('left');
    expect(handWord({ tipX: 0.65, tipY: 0.35 }, target, 0)).toBe('forward');
    expect(handWord({ tipX: 0.65, tipY: 0.35 }, target, 2)).toBe('grab');
    expect(handWord({ tipX: 0.66, tipY: 0.5001 }, target, 0)).toBe('higher');  // just below the box: the target is above the hand
  });
});

describe('createGuide', () => {
  it('a visible target: ahead → forward with steps; off centre → turn a little / turn; close → arrived', () => {
    const now = () => 1000;
    expect(rig({ detections: [det('fridge', 0.5, 0.3)], now }).guide.instructionFor('eggs in my fridge')).toMatchObject({ kind: 'forward', steps: 6, targetVisible: true });
    expect(rig({ detections: [det('fridge', 0.68, 0.3)], now }).guide.instructionFor('the fridge')).toMatchObject({ kind: 'turn_little', targetVisible: true });
    expect(rig({ detections: [det('fridge', 0.1, 0.3)], now }).guide.instructionFor('fridge')).toMatchObject({ kind: 'turn', targetVisible: true });
    expect(rig({ detections: [det('fridge', 0.5, 0.9, 0.9)], now }).guide.instructionFor('fridge')).toMatchObject({ kind: 'arrived' });
    const r = rig({ detections: [det('fridge', 0.5, 0.3)], now }).guide.instructionFor('fridge')!;
    expect(r.text).toMatch(/fridge/i);
    expect(r.text).toMatch(/six steps|ahead/i);
  });

  it('out of view: remembered bearing → scan / turn / turn around; never seen → scan the room; unknown thing → null', () => {
    const now = () => 1000;
    expect(rig({ where: { cls: 'fridge', relativeDeg: -30, ageMs: 5000, phrase: '' }, now }).guide.instructionFor('fridge')).toMatchObject({ kind: 'scan_remembered', relativeDeg: -30 });
    expect(rig({ where: { cls: 'fridge', relativeDeg: 100, ageMs: 5000, phrase: '' }, now }).guide.instructionFor('fridge')).toMatchObject({ kind: 'turn' });
    expect(rig({ where: { cls: 'fridge', relativeDeg: 175, ageMs: 5000, phrase: '' }, now }).guide.instructionFor('fridge')).toMatchObject({ kind: 'turn_around' });
    expect(rig({ where: 'unseen', now }).guide.instructionFor('fridge')).toMatchObject({ kind: 'scan_unknown' });
    expect(rig({ where: 'unknown_thing', now }).guide.instructionFor('the widget')).toBeNull();
    // A model box for something the detector cannot name still steers.
    const g = rig({ where: 'unseen', now }).guide;
    expect(g.instructionFor('eggs', { box: [0.4, 0.4, 0.2, 0.15], at: 500 })).toMatchObject({ kind: 'forward', targetVisible: true });
    expect(g.instructionFor('eggs', { box: [0.4, 0.4, 0.2, 0.15], at: -5000 })).toMatchObject({ kind: 'scan_unknown' });   // stale box
  });

  it('something close in the way stops walking; relative depth alone cannot prove a side is traversable', () => {
    const now = () => 1000;
    const memory = { whereIs: jest.fn(() => 'unseen' as never), facing: () => 0 };
    const blockedLeftOpen = createGuide({ detections: () => [det('fridge', 0.5, 0.3)], memory, hfovDeg: () => 56, now, path: () => ({ center: 0.85, left: 0.2, right: 0.6 }) });
    expect(blockedLeftOpen.instructionFor('fridge')).toMatchObject({ kind: 'sidestep' });
    expect(blockedLeftOpen.instructionFor('fridge')!.text).toMatch(/Stop/);
    const blockedRightOpen = createGuide({ detections: () => [det('fridge', 0.5, 0.3)], memory, hfovDeg: () => 56, now, path: () => ({ center: 0.85, left: 0.7, right: 0.1 }) });
    expect(blockedRightOpen.instructionFor('fridge')!.text).toMatch(/Stop/);
    const open = createGuide({ detections: () => [det('fridge', 0.5, 0.3)], memory, hfovDeg: () => 56, now, path: () => ({ center: 0.2, left: 0.2, right: 0.2 }) });
    expect(open.instructionFor('fridge')).toMatchObject({ kind: 'forward' });
    // Close to the target, the "blockage" is the target itself: no sidestep.
    const atIt = createGuide({ detections: () => [det('fridge', 0.5, 0.9, 0.9)], memory, hfovDeg: () => 56, now, path: () => ({ center: 0.9, left: 0.9, right: 0.9 }) });
    expect(atIt.instructionFor('fridge')).toMatchObject({ kind: 'arrived' });
  });

  it('changed(): same kind and about the same steps is not news', () => {
    const { guide } = rig();
    const a = { kind: 'forward' as const, text: '', relativeDeg: 3, steps: 6, targetVisible: true };
    expect(guide.changed(null, a)).toBe(true);
    expect(guide.changed(a, { ...a, steps: 5 })).toBe(false);
    expect(guide.changed(a, { ...a, steps: 3 })).toBe(true);
    expect(guide.changed(a, { ...a, kind: 'turn' })).toBe(true);
  });
});
