import type { Detection } from './contracts';
import { MAX_UTTERANCE_WORDS, countWords, findForbiddenTerm, hasDigit } from './phrases';
import { CLASS_HEIGHT_M, coachHand, createGuide, degreesFromBox, handWord, NEAR_CLOSE_MAX_STEPS, NEAR_MID_MAX_STEPS, phraseFor, stepsFromBox, type GuideKind } from './guide';

const det = (cls: Detection['cls'], cx: number, h: number, near?: number): Detection => ({ cls, box: [cx - 0.15, 0.5 - h / 2, 0.3, h], score: 0.8, trackId: 1, ...(near !== undefined ? { near } : {}) });

function rig(opts: { detections?: Detection[]; where?: unknown; hfov?: number; now?: () => number } = {}) {
  const memory = { whereIs: jest.fn(() => (opts.where ?? 'unseen') as never), facing: () => 0 };
  const guide = createGuide({ detections: () => opts.detections ?? [], memory, hfovDeg: () => opts.hfov ?? 56, now: opts.now });
  return { guide, memory };
}

describe('guide (pure)', () => {
  it('requires appearance confirmation for a neon green metal bottle, while generic bottles retain CV guidance', () => {
    const guide = rig({ detections: [det('bottle', 0.5, 0.4)] }).guide;
    expect(guide.instructionFor('water bottle')?.targetVisible).toBe(true);
    expect(guide.instructionFor('neon green metal water bottle')?.targetVisible).not.toBe(true);
  });
  it('requires semantic confirmation for AirPods instead of accepting generic headphones', () => {
    const guide = rig({ detections: [det('headphones', 0.5, 0.3)] }).guide;
    expect(guide.instructionFor('headphones')?.targetVisible).toBe(true);
    expect(guide.instructionFor('my AirPods')?.targetVisible).not.toBe(true);
  });
  it('relative depth alone cannot declare a small distant fridge within reach', () => {
    expect(rig({ detections: [det('fridge', 0.5, 0.3, 0.95)] }).guide.instructionFor('fridge')?.kind).not.toBe('arrived');
  });
  it('uses the same object dimensions for spoken steps and reach', () => {
    const guide = rig({ detections: [det('remote', 0.5, 0.1)] }).guide;
    expect(guide.instructionFor('remote')).toMatchObject({ kind: 'forward', steps: 2 });
  });
  it('does not replace forward progress with stop on uncorroborated static relative depth', () => {
    const guide = createGuide({ detections: () => [det('fridge', 0.5, 0.3)], memory: { whereIs: () => 'unseen', facing: () => 0 }, hfovDeg: () => 56, path: () => ({ center: 0.9, closingRate: 0.001 }) });
    expect(guide.instructionFor('fridge')).toMatchObject({ kind: 'forward' });
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
    expect(rig({ detections: [det('fridge', 0.15, 0.3)], now }).guide.instructionFor('fridge')).toMatchObject({ kind: 'turn', targetVisible: true });
    expect(rig({ detections: [{ ...det('fridge', 0.5, 0.9, 0.9), box: [0.01, 0.005, 0.98, 0.99] }], now }).guide.instructionFor('fridge')).toMatchObject({ kind: 'arrived' });
    expect(rig({ detections: [det('fridge', 0.5, 0.9, 0.99)], now }).guide.instructionFor('fridge')?.kind).not.toBe('arrived');
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
    // An egg carton filling fifteen percent of the frame is within reach (WORD_HEIGHT_M, round 8); a small one is steps away.
    expect(g.instructionFor('eggs', { box: [0.4, 0.4, 0.2, 0.15], at: 500 })).toMatchObject({ kind: 'arrived', targetVisible: true });
    expect(g.instructionFor('eggs', { box: [0.45, 0.4, 0.1, 0.04], at: 500 })).toMatchObject({ kind: 'forward', targetVisible: true, steps: 2 });
    expect(g.instructionFor('the doorway', { box: [0.4, 0.2, 0.2, 0.5], at: 500 })).toMatchObject({ kind: 'forward', steps: 4 });
    expect(g.instructionFor('eggs', { box: [0.4, 0.4, 0.2, 0.15], at: -5000 })).toMatchObject({ kind: 'scan_unknown' });   // stale box
  });

  it('something close in the way stops walking; relative depth alone cannot prove a side is traversable', () => {
    const now = () => 1000;
    const memory = { whereIs: jest.fn(() => 'unseen' as never), facing: () => 0 };
    const blockedLeftOpen = createGuide({ detections: () => [det('fridge', 0.5, 0.3)], memory, hfovDeg: () => 56, now, path: () => ({ center: 0.85, closingRate: 0.1, left: 0.2, right: 0.6 }) });
    expect(blockedLeftOpen.instructionFor('fridge')).toMatchObject({ kind: 'sidestep' });
    expect(blockedLeftOpen.instructionFor('fridge')!.text).toMatch(/Stop/);
    const blockedRightOpen = createGuide({ detections: () => [det('fridge', 0.5, 0.3)], memory, hfovDeg: () => 56, now, path: () => ({ center: 0.85, closingRate: 0.1, left: 0.7, right: 0.1 }) });
    expect(blockedRightOpen.instructionFor('fridge')!.text).toMatch(/Stop/);
    const open = createGuide({ detections: () => [det('fridge', 0.5, 0.3)], memory, hfovDeg: () => 56, now, path: () => ({ center: 0.2, left: 0.2, right: 0.2 }) });
    expect(open.instructionFor('fridge')).toMatchObject({ kind: 'forward' });
    // Close to the target, the "blockage" is the target itself: no sidestep.
    const atIt = createGuide({ detections: () => [{ ...det('fridge', 0.5, 0.9, 0.9), box: [0.01, 0.005, 0.98, 0.99] }], memory, hfovDeg: () => 56, now, path: () => ({ center: 0.9, left: 0.9, right: 0.9 }) });
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

describe('coachHand (round 9): push, pull back, other way, reach further vs grab', () => {
  const box: [number, number, number, number] = [0.6, 0.3, 0.2, 0.2];   // centre (0.7, 0.4)
  it('says the word, then "a little more" as the gap closes, "other way" when it grows, "too far" on a flip', () => {
    const first = coachHand({ tipX: 0.3, tipY: 0.4 }, { box }, 0, null);
    expect(first).toMatchObject({ word: 'right', kind: 'word', text: 'Right.' });
    const closer = coachHand({ tipX: 0.5, tipY: 0.4 }, { box }, 0, { word: 'right', dx: first.dx, dy: first.dy });
    expect(closer).toMatchObject({ word: 'right', kind: 'push', text: 'A little more to the right.' });
    const away = coachHand({ tipX: 0.1, tipY: 0.4 }, { box }, 0, { word: 'right', dx: closer.dx, dy: closer.dy });
    expect(away).toMatchObject({ word: 'right', kind: 'other_way', text: 'Other way. Right.' });
    const overshoot = coachHand({ tipX: 0.9, tipY: 0.4 }, { box }, 0, { word: 'right', dx: 0.1, dy: 0 });
    expect(overshoot).toMatchObject({ word: 'left', kind: 'pull_back', text: 'Too far. Back to the left a little.' });
    const farFlip = coachHand({ tipX: 0.95, tipY: 0.4 }, { box }, 0, { word: 'right', dx: 0.5, dy: 0 });
    expect(farFlip).toMatchObject({ word: 'left', kind: 'word' });   // a flip after a big correction is just a new word
    expect(coachHand({ tipX: 0.7, tipY: 0.9 }, { box }, 0, { word: 'higher', dx: 0, dy: -0.55 })).toMatchObject({ word: 'higher', kind: 'word' });
    expect(coachHand({ tipX: 0.7, tipY: 0.1 }, { box }, 0, { word: 'higher', dx: 0, dy: -0.1 })).toMatchObject({ word: 'lower', kind: 'pull_back', text: 'Too high. Back down a little.' });
  });
  it('inside the box: without depth reach then grab; with depth the hand must actually get there', () => {
    expect(coachHand({ tipX: 0.7, tipY: 0.4 }, { box }, 0, null)).toMatchObject({ word: 'forward', kind: 'reach', text: 'Reach forward.' });
    expect(coachHand({ tipX: 0.7, tipY: 0.4 }, { box }, 2, null)).toMatchObject({ word: 'grab', kind: 'grab' });
    expect(coachHand({ tipX: 0.7, tipY: 0.4, near: 0.9 }, { box, near: 0.5 }, 3, null)).toMatchObject({ word: 'forward', kind: 'reach_further', text: 'Reach further forward.' });
    expect(coachHand({ tipX: 0.7, tipY: 0.4, near: 0.55 }, { box, near: 0.5 }, 0, null)).toMatchObject({ word: 'grab', kind: 'grab', text: 'Grab it.' });
    expect(coachHand({ tipX: 0.7, tipY: 0.4, near: 0.2 }, { box, near: 0.5 }, 0, null)).toMatchObject({ word: 'forward', kind: 'pull_back', text: 'Too far. Pull back a little.' });
  });
});

describe('depth bounds the box-height distance', () => {
  // A fridge box small in frame reads as far away by height alone.
  const farLooking: [number, number, number, number] = [0.4, 0.4, 0.1, 0.12];

  it('pulls the estimate in when the grid says the thing is close', () => {
    const byHeightAlone = stepsFromBox('fridge', farLooking, undefined);
    expect(byHeightAlone).toBeGreaterThan(NEAR_CLOSE_MAX_STEPS);
    expect(stepsFromBox('fridge', farLooking, 0.9)).toBeLessThanOrEqual(NEAR_CLOSE_MAX_STEPS);
    expect(stepsFromBox('fridge', farLooking, 0.5)).toBeLessThanOrEqual(NEAR_MID_MAX_STEPS);
  });

  it('never pushes the estimate out — a far reading cannot make a close thing sound distant', () => {
    const closeLooking: [number, number, number, number] = [0.1, 0.05, 0.8, 0.9];
    const byHeightAlone = stepsFromBox('fridge', closeLooking, undefined);
    expect(stepsFromBox('fridge', closeLooking, 0.05)).toBe(byHeightAlone);
  });

  it('is unchanged when the grid has nothing to say', () => {
    for (const near of [undefined, NaN]) {
      expect(stepsFromBox('fridge', farLooking, near)).toBe(stepsFromBox('fridge', farLooking, undefined));
    }
  });
});
