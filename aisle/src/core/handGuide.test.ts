import type { Detection, HandPoseEvent, SpeechRequest, VisionResponse } from './contracts';
import { PHRASES } from './phrases';
import { HAND_TICK_MS, HAND_WORD_INTERVAL_MS, createHandGuide, itemOfGoal, reachLine } from './handGuide';
import type { AskOutcome } from '../perception/semanticVision';

const T0 = 1_700_000_000_000;

function response(hand: VisionResponse['hand']['hint'], target: VisionResponse['target'] = { box: null, confidence: 0 }): AskOutcome {
  const r: VisionResponse = {
    speech: '', cameraRequest: 'none', userAction: 'none',
    aisle: { matchedAisleId: null, matchedLandmarkId: null, confidence: 0 },
    storefront: { visible: false, confidence: 0 }, scan: { vehiclesSeen: 'none', confidence: 0 },
    signal: { state: 'UNKNOWN', confidence: 0 }, hand: { hint: hand }, task: { done: false, confidence: 0 },
    scene: { setting: 'unknown', label: '', confidence: 0 }, target, confidence: 0.8, seq: 1,
  };
  return { status: 'applied', seq: 1, response: r, streamed: false, latencyMs: 300 };
}

function rig(askImpl: () => Promise<AskOutcome>) {
  const said: SpeechRequest[] = [];
  const haptic: string[] = [];
  const hands = new Set<(e: HandPoseEvent) => void>();
  const dets = new Set<(d: Detection[]) => void>();
  const guide = createHandGuide({
    vision: { ask: jest.fn(askImpl) as never },
    speech: { say: (r) => { said.push(r); } },
    haptics: { play: (p) => { haptic.push(p); } },
    perception: {
      onHandPose: (cb) => { hands.add(cb); return () => hands.delete(cb); },
      onDetections: (cb) => { dets.add(cb); return () => dets.delete(cb); },
    },
    now: () => Date.now(),
  });
  return {
    guide, said, haptic,
    hand: (tipX: number, tipY: number) => { for (const cb of Array.from(hands)) cb({ tipX, tipY, wristX: tipX, wristY: tipY + 0.15, box: [tipX - 0.05, tipY - 0.05, 0.1, 0.2], confidence: 0.9, timestamp: Date.now() }); },
    see: (list: Detection[]) => { for (const cb of Array.from(dets)) cb(list); },
    words: () => said.map((r) => r.text).filter((s) => s !== PHRASES.hold_out_hand),
  };
}

describe('handGuide (round 7: the phone\'s own hand)', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(T0); });
  afterEach(() => jest.useRealTimers());

  it('does not finish a reach from a hint with an unidentified target', async () => {
    const r = rig(async () => response('touching', { box: [0.2, 0.3, 0.2, 0.15], confidence: 0.3 }));
    const done = r.guide.start('eggs');
    await jest.advanceTimersByTimeAsync(4100);
    expect(r.guide.isRunning()).toBe(true);
    expect(r.words()).not.toContain(PHRASES.mission_hand_aligned);
    r.guide.stop();
    await jest.advanceTimersByTimeAsync(400);
    expect((await done).done).toBe('stopped');
  });

  it('itemOfGoal keeps the thing, not the place', () => {
    expect(itemOfGoal('eggs in my fridge')).toBe('eggs');
    expect(itemOfGoal('the milk on the top shelf')).toBe('milk');
    expect(itemOfGoal('my keys')).toBe('keys');
  });

  it('steers the hand from the detector box: Right, Higher, Reach forward, Grab it — one word per beat, only on change', async () => {
    const r = rig(async () => response('not_seen'));
    const done = r.guide.start('the cup');
    expect(r.said[0].text).toBe(PHRASES.hold_out_hand);
    // A cup at the top right; the hand starts bottom left.
    r.see([{ cls: 'cup', box: [0.6, 0.2, 0.2, 0.15], score: 0.8, trackId: 1 }]);
    r.hand(0.2, 0.7);
    await jest.advanceTimersByTimeAsync(HAND_TICK_MS);
    expect(r.words()).toEqual([PHRASES.right]);
    await jest.advanceTimersByTimeAsync(HAND_TICK_MS);            // same word inside the beat: silence
    expect(r.words()).toEqual([PHRASES.right]);
    r.hand(0.7, 0.7); r.see([{ cls: 'cup', box: [0.6, 0.2, 0.2, 0.15], score: 0.8, trackId: 1 }]);
    await jest.advanceTimersByTimeAsync(HAND_WORD_INTERVAL_MS);
    expect(r.words()).toEqual([PHRASES.right, PHRASES.higher]);
    r.hand(0.7, 0.27); r.see([{ cls: 'cup', box: [0.6, 0.2, 0.2, 0.15], score: 0.8, trackId: 1 }]);
    await jest.advanceTimersByTimeAsync(HAND_WORD_INTERVAL_MS);
    expect(r.words()).toEqual([PHRASES.right, PHRASES.higher, PHRASES.reach_forward]);
    r.hand(0.7, 0.27); r.see([{ cls: 'cup', box: [0.6, 0.2, 0.2, 0.15], score: 0.8, trackId: 1 }]);
    await jest.advanceTimersByTimeAsync(HAND_WORD_INTERVAL_MS);
    expect(r.words()).toEqual([PHRASES.right, PHRASES.higher, PHRASES.reach_forward, PHRASES.mission_hand_aligned]);
    const res = await done;
    expect(res).toMatchObject({ done: 'touching', handWords: 3 });
    expect(r.haptic).toEqual(['CONFIRM']);
  });

  it('a target only Claude can name (eggs) steers by its target.box; a hand with no target asks for the camera', async () => {
    let answers = 0;
    const r = rig(async () => response('not_seen', answers++ === 0 ? { box: [0.2, 0.3, 0.2, 0.15], confidence: 0.8 } : { box: null, confidence: 0 }));
    const done = r.guide.start('eggs');
    r.hand(0.8, 0.4);
    await jest.advanceTimersByTimeAsync(HAND_TICK_MS * 2);        // the first Claude answer lands
    expect(r.words()).toEqual([PHRASES.left]);
    // Claude's box goes stale and nothing replaces it: the loop says so.
    await jest.advanceTimersByTimeAsync(6000);
    r.hand(0.8, 0.4);
    await jest.advanceTimersByTimeAsync(HAND_TICK_MS * 2);
    expect(r.words()).toContain(PHRASES.mission_target_missing);
    r.guide.stop();
    await jest.advanceTimersByTimeAsync(HAND_TICK_MS);
    const res = await done;
    expect(res.done).toBe('stopped');
  });

  it('without an on-device hand, Claude\'s hints steer as before and touching finishes', async () => {
    const hints: Array<VisionResponse['hand']['hint']> = ['higher', 'left', 'touching'];
    const r = rig(async () => response(hints.shift() ?? 'touching', { box: [0.2, 0.3, 0.2, 0.15], confidence: 0.9 }));
    const done = r.guide.start('the milk');
    await jest.advanceTimersByTimeAsync(2000 * 3 + 100);
    expect(r.words()).toEqual([PHRASES.higher, PHRASES.left, PHRASES.mission_hand_aligned]);
    expect(await done).toMatchObject({ done: 'touching', handWords: 0 });
  });

  it('the item in view but no hand at all: says where to reach from the box, every four seconds (round 16)', async () => {
    const r = rig(async () => response('not_seen'));
    const done = r.guide.start('bananas', { goal: 'bananas', target: { box: [0.05, 0.35, 0.25, 0.2], at: Date.now(), near: 0.8 } });
    await jest.advanceTimersByTimeAsync(4500);
    expect(r.words()).toContain('Bananas to your left, at chest height. Reach out left.');
    r.guide.stop();
    await jest.advanceTimersByTimeAsync(400);
    await done;
    expect(reachLine('the milk', [0.4, 0.05, 0.2, 0.2], 0.3)).toBe('Milk straight ahead, up high. One step closer, then reach.');
    expect(reachLine('eggs', [0.7, 0.75, 0.2, 0.2], 0.9)).toBe('Eggs to your right, down low. Reach out right.');
  });
});
