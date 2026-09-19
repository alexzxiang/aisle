import type { Detection } from './contracts';
import { createGuide, type GuideInstruction } from './guide';
import {
  answerRoom, clockWord, createMissionRunner, decide, guessRoom, initialMissionState, missionName, parseMissionGoal,
  MISSION_CHANGE_FLOOR_MS, MISSION_REPEAT_MS, MISSION_SLOW_REPEAT_MS,
} from './itemMission';

const T0 = 1_700_000_000_000;

describe('parseMissionGoal / names / clock', () => {
  it('splits the item from its place, drops rooms, and leaves fridge goals to the fridge mission', () => {
    expect(parseMissionGoal('bananas on the table')).toMatchObject({ item: 'bananas', itemCls: 'banana', place: 'table', placeCls: 'table' });
    expect(parseMissionGoal('my keys on the counter')).toMatchObject({ item: 'keys', itemCls: null, place: 'counter', placeCls: 'countertop' });
    expect(parseMissionGoal('the remote in the living room')).toMatchObject({ item: 'remote', itemCls: 'remote', place: null });
    expect(parseMissionGoal('the couch')).toMatchObject({ item: 'couch', itemCls: 'couch', place: null });
    expect(parseMissionGoal('eggs in my fridge')).toBeNull();
  });
  it('speaks the user\'s own word for a detected class and guesses a room', () => {
    expect(missionName('bananas', 'banana')).toBe('bananas');
    expect(missionName('the sofa', 'couch')).toBe('sofa');
    expect(missionName('keys', null)).toBe('keys');
    expect(guessRoom('table', 'bananas')).toBe('kitchen');
    expect(guessRoom(null, 'remote')).toBe('living room');
    expect(guessRoom(null, 'keys')).toBeNull();
  });
  it('clock positions from a signed bearing', () => {
    expect(clockWord(0)).toBe("twelve o'clock");
    expect(clockWord(20)).toBe("one o'clock");
    expect(clockWord(-40)).toBe("eleven o'clock");
    expect(clockWord(90)).toBe("three o'clock");
    expect(clockWord(175)).toBe("six o'clock");
  });
});

const g = (over: Partial<GuideInstruction>): GuideInstruction => ({ kind: 'forward', text: '', relativeDeg: 0, steps: 4, targetVisible: true, ...over });
const goal = parseMissionGoal('bananas on the table')!;

describe('decide: where the person stands → what to say', () => {
  const snap = (over: Partial<Parameters<typeof decide>[2]>) => ({ now: T0, item: null, place: null, door: null, sceneLabel: null, ...over });

  it('bananas in view: clock, side and steps; within reach → the reach phase', () => {
    let s = initialMissionState();
    let r = decide(goal, s, snap({ item: g({ kind: 'turn_little', relativeDeg: 20, steps: 4 }) }));
    expect(r.decision).toMatchObject({ phase: 'approach_item', text: "Bananas at one o'clock. Turn right a little, then walk four steps.", haptic: 'TURN', boxTarget: 'bananas' });
    s = r.next;
    r = decide(goal, s, snap({ item: g({ kind: 'forward', relativeDeg: 3, steps: 3 }) }));
    expect(r.decision.text).toBe('Bananas ahead. Walk forward three steps.');
    r = decide(goal, r.next, snap({ item: g({ kind: 'arrived', relativeDeg: 0, steps: 1 }) }));
    expect(r.decision).toMatchObject({ phase: 'reach', text: 'Bananas right in front of you. Reach out.', haptic: 'CONFIRM' });
    expect(decide(goal, r.next, snap({})).decision).toMatchObject({ phase: 'reach', text: null });
  });

  it('push: a shorter walk than last time is "keep going"; the same walk for seven seconds is "keep walking" (round 9)', () => {
    let r = decide(goal, initialMissionState(), snap({ item: g({ kind: 'forward', relativeDeg: 2, steps: 5 }) }));
    expect(r.decision.text).toBe('Bananas ahead. Walk forward five steps.');
    r = decide(goal, r.next, snap({ now: T0 + 2000, item: g({ kind: 'forward', relativeDeg: 2, steps: 3 }) }));
    expect(r.decision.text).toBe('Keep going. Three steps more.');
    r = decide(goal, r.next, snap({ now: T0 + 4000, item: g({ kind: 'forward', relativeDeg: 2, steps: 3 }) }));
    expect(r.decision.text).toBe('Bananas ahead. Walk forward three steps.');       // same line, the runner paces it
    r = decide(goal, r.next, snap({ now: T0 + 12_000, item: g({ kind: 'forward', relativeDeg: 2, steps: 3 }) }));
    expect(r.decision.text).toBe('Keep walking forward. Bananas are three steps ahead.');
  });

  it('pull back: a close item that drops out of the bottom of the frame was walked past — "Stop. You passed the bananas." (round 9)', () => {
    const close = g({ kind: 'forward', relativeDeg: 6, steps: 2, box: { box: [0.4, 0.6, 0.3, 0.3], at: T0 } });
    let r = decide(goal, initialMissionState(), snap({ item: close }));
    expect(r.next.lastSeen).toMatchObject({ what: 'item', steps: 2 });
    const gone = g({ kind: 'scan_unknown', relativeDeg: null, steps: null, targetVisible: false });
    r = decide(goal, r.next, snap({ now: T0 + 1500, item: gone, place: gone }));
    expect(r.decision).toMatchObject({ text: 'Stop. You passed the bananas. Turn around, they are on your right.', haptic: 'STOP', key: 'approach_item:overshoot' });
    // Said once: the next tick is an ordinary hunt.
    r = decide(goal, r.next, snap({ now: T0 + 2000, item: gone, place: gone }));
    expect(r.decision.key).not.toContain('overshoot');
    // A far thing that drops out is simply lost, not passed.
    const far = g({ kind: 'forward', relativeDeg: 0, steps: 6, box: { box: [0.4, 0.3, 0.1, 0.1], at: T0 } });
    const lost = decide(goal, decide(goal, initialMissionState(), snap({ item: far })).next, snap({ now: T0 + 1500, item: gone, place: gone }));
    expect(lost.decision.key).not.toContain('overshoot');
  });

  it('only the table in view: walk to it, then scan its surface; the item appearing takes over', () => {
    let r = decide(goal, initialMissionState(), snap({ place: g({ kind: 'turn_little', relativeDeg: -25, steps: 6 }) }));
    expect(r.decision).toMatchObject({ phase: 'approach_place', text: "No bananas yet. Table at eleven o'clock. Turn left a little, then walk six steps." });
    r = decide(goal, r.next, snap({ place: g({ kind: 'forward', relativeDeg: 0, steps: 5 }) }));
    expect(r.decision.text).toBe('No bananas yet. Table ahead. Walk forward five steps.');
    r = decide(goal, r.next, snap({ place: g({ kind: 'arrived', relativeDeg: 0, steps: 1 }) }));
    expect(r.decision).toMatchObject({ phase: 'scan_place', text: 'At the table. Tilt the camera down and pan slowly.', haptic: 'CONFIRM', boxTarget: 'bananas' });
    r = decide(goal, r.next, snap({ now: T0 + 5000, place: g({ kind: 'arrived', relativeDeg: 0, steps: 1 }) }));
    expect(r.decision).toMatchObject({ phase: 'scan_place', text: 'Still looking for the bananas. Pan slowly across the table.', modelMaySpeak: true });
    r = decide(goal, r.next, snap({ now: T0 + 6000, item: g({ kind: 'turn_little', relativeDeg: 30, steps: 1 }), place: g({ kind: 'arrived' }) }));
    expect(r.decision.phase).toBe('approach_item');
  });

  it('table remembered from earlier: turn toward it', () => {
    const r = decide(goal, initialMissionState(), snap({ place: g({ kind: 'scan_remembered', relativeDeg: -70, steps: null, targetVisible: false }) }));
    expect(r.decision).toMatchObject({ phase: 'find_place', text: 'Table was on your left. Turn left slowly.', haptic: 'TURN', boxTarget: 'table' });
    const behind = decide(goal, initialMissionState(), snap({ place: g({ kind: 'turn_around', relativeDeg: 170, steps: null, targetVisible: false }) }));
    expect(behind.decision.text).toBe('Table behind you. Turn around slowly.');
  });

  it('nothing in view: an educated guess with a question, once; then the room answer drives the doorway search', () => {
    const unseen = g({ kind: 'scan_unknown', relativeDeg: null, steps: null, targetVisible: false });
    let r = decide(goal, initialMissionState(), snap({ item: unseen, place: unseen, sceneLabel: 'in a bedroom' }));
    expect(r.decision).toMatchObject({ phase: 'find_place', text: 'I think the table is in the kitchen. Is that right?', asking: 'room' });
    // Not asked twice: the fallback is a slow scan the model may talk over.
    r = decide(goal, r.next, snap({ item: unseen, place: unseen, sceneLabel: 'in a bedroom' }));
    expect(r.decision).toMatchObject({ text: 'Turn slowly all the way around so I can find the table.', modelMaySpeak: true });
    // No scene label → the plain question.
    expect(decide(goal, initialMissionState(), snap({ item: unseen, place: unseen })).decision.text).toBe('I do not see a table here. Is it in another room?');

    const yes = answerRoom(r.next, 'yes', T0);
    expect(yes).toMatchObject({ consumed: true, text: 'Turn slowly until I see a doorway.' });
    expect(yes.next.phase).toBe('find_door');
    let d = decide(goal, yes.next, snap({ item: unseen, place: unseen }));
    expect(d.decision).toMatchObject({ phase: 'find_door', text: 'Turn slowly until I see a doorway.', boxTarget: 'the doorway' });
    d = decide(goal, d.next, snap({ item: unseen, place: unseen, door: g({ kind: 'turn_little', relativeDeg: -30, steps: 5 }) }));
    expect(d.decision.text).toBe("Doorway at eleven o'clock. Turn left a little, then walk five steps.");
    d = decide(goal, d.next, snap({ item: unseen, place: unseen, door: g({ kind: 'arrived', relativeDeg: 0, steps: 1 }) }));
    expect(d.decision).toMatchObject({ phase: 'find_place', text: 'At the doorway. Walk through, then turn slowly.' });
    // In the new room the question may be asked again.
    expect(d.next.askedRoom).toBe(false);
    expect(answerRoom(initialMissionState(), 'no, this room', T0)).toMatchObject({ consumed: true, text: 'Turn slowly all the way around so I can find it.' });
    expect(answerRoom(initialMissionState(), 'in the kitchen', T0).next.phase).toBe('find_door');
    expect(answerRoom(initialMissionState(), 'what', T0).consumed).toBe(false);
  });

  it('an item with no place: chase it, remembered bearings, else a full turn', () => {
    const keys = parseMissionGoal('my keys')!;
    expect(decide(keys, initialMissionState(), snap({ item: g({ kind: 'scan_unknown', relativeDeg: null, steps: null, targetVisible: false }) })).decision)
      .toMatchObject({ text: 'Keys not seen yet. Turn slowly all the way around.', modelMaySpeak: true, boxTarget: 'keys' });
    expect(decide(keys, initialMissionState(), snap({ item: g({ kind: 'scan_remembered', relativeDeg: 50, steps: null, targetVisible: false }) })).decision.text)
      .toBe('Keys was on your right. Turn right slowly.'.replace('Keys was', 'Keys was'));
  });
});

describe('createMissionRunner: the first line is immediate, repeats are paced, the model box steers', () => {
  it('speaks at once from the detector, holds an unchanged line for four seconds, and moves to reach', () => {
    let t = T0;
    let dets: Detection[] = [{ cls: 'banana', box: [0.7, 0.4, 0.1, 0.1], score: 0.9, trackId: 1 }, { cls: 'table', box: [0.1, 0.3, 0.4, 0.4], score: 0.9, trackId: 2 }];
    const guide = createGuide({ detections: () => dets, memory: { whereIs: () => 'unseen', facing: () => 0 }, hfovDeg: () => 56, now: () => t });
    const m = createMissionRunner(goal, { guide, now: () => t });
    const first = m.tick();
    expect(first.text).toMatch(/^Bananas just to your right\. Turn right a little, then walk/);
    expect(first.haptic).toBe('TURN');
    expect(m.phase()).toBe('approach_item');
    t += 1000;
    expect(m.tick().text).toBeNull();                      // same line inside the repeat window
    t += MISSION_REPEAT_MS;
    expect(m.tick().text).toMatch(/^Bananas just to your right/); // said again after four seconds
    t += MISSION_CHANGE_FLOOR_MS;
    dets = [{ cls: 'banana', box: [0.3, 0.2, 0.4, 0.7], score: 0.9, trackId: 1 }];
    const near = m.tick();
    expect(near.text).toBe('Bananas right in front of you. Reach out.');
    expect(m.phase()).toBe('reach');
    expect(m.stepIndex()).toBe(1);
    m.reached();
    expect(m.phase()).toBe('confirm');
  });

  it('a track that flickers for a second still counts as in view (no line ping-pong)', () => {
    let t = T0;
    let dets: Detection[] = [{ cls: 'banana', box: [0.7, 0.4, 0.06, 0.06], score: 0.9, trackId: 1 }, { cls: 'table', box: [0.1, 0.3, 0.4, 0.4], score: 0.9, trackId: 2 }];
    const guide = createGuide({ detections: () => dets, memory: { whereIs: () => 'unseen', facing: () => 0 }, hfovDeg: () => 56, now: () => t });
    const m = createMissionRunner(goal, { guide, now: () => t });
    expect(m.tick().text).toMatch(/^Bananas/);
    dets = [{ cls: 'table', box: [0.1, 0.3, 0.4, 0.4], score: 0.9, trackId: 2 }];   // the banana dropped out of this frame
    t += 500;
    m.tick();
    expect(m.phase()).toBe('approach_item');
    t += 2000;                                                                         // …for more than the sticky window
    m.tick();
    expect(m.phase()).toBe('approach_place');
  });

  it('a thing the detector cannot name is steered by the model\'s box for it, and the slow lines repeat slowly', () => {
    let t = T0;
    const guide = createGuide({ detections: () => [], memory: { whereIs: () => 'unknown_thing', facing: () => 0 }, hfovDeg: () => 56, now: () => t });
    const m = createMissionRunner(parseMissionGoal('my keys')!, { guide, now: () => t });
    expect(m.tick().text).toBe('Keys not seen yet. Turn slowly all the way around.');
    expect(m.boxTarget()).toBe('keys');
    t += 3000;
    expect(m.tick().text).toBeNull();                      // slow line: not yet
    t += MISSION_SLOW_REPEAT_MS;
    expect(m.tick().text).toBe('Keys not seen yet. Turn slowly all the way around.');
    m.onModelBox('keys', [0.6, 0.5, 0.05, 0.03], t);
    t += MISSION_CHANGE_FLOOR_MS;
    expect(m.tick().text).toMatch(/^Keys just to your right/);
    expect(m.userText()).toContain('Look for: keys');
  });

  it('answers the room question through intercept and repeats on demand', () => {
    let t = T0;
    const guide = createGuide({ detections: () => [], memory: { whereIs: () => 'unseen', facing: () => 0 }, hfovDeg: () => 56, now: () => t });
    const m = createMissionRunner(goal, { guide, now: () => t, sceneLabel: () => 'in a bedroom' });
    expect(m.tick().text).toBe('I think the table is in the kitchen. Is that right?');
    expect(m.askingRoom()).toBe(true);
    expect(m.intercept('hmm')).toEqual({ consumed: false, text: null });
    expect(m.intercept('yes')).toEqual({ consumed: true, text: 'Turn slowly until I see a doorway.' });
    expect(m.askingRoom()).toBe(false);
    expect(m.phase()).toBe('find_door');
    expect(m.boxTarget()).toBe('the doorway');
    t += 1000;
    expect(m.tick().text).toBeNull();
    m.repeat();
    expect(m.tick().text).toBe('Turn slowly until I see a doorway.');
  });
});
