import type { Detection } from './contracts';
import { createGuide, type GuideInstruction } from './guide';
import { MAX_UTTERANCE_WORDS, checkPhrase, countWords } from './phrases';
import { createSearchExplorer } from './searchExplorer';
import { createExplorationMap } from './explorationMap';
import {
  answerOpen, answerRoom, clockWord, createMissionRunner, decide, exploreRequest, guessRoom, initialMissionState, itemLine, missionName, parseMissionGoal,
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
const start = () => initialMissionState(goal.place);

describe('every walking line fits twelve words by construction (round 13)', () => {
  it('two-word names, the longest step count, every kind', () => {
    const kinds = ['arrived', 'forward', 'sidestep', 'turn_little', 'turn', 'turn_around', 'scan_remembered', 'scan_unknown'] as const;
    for (const kind of kinds) {
      for (const rel of [-70, -10, 10, 70, 170]) {
        const l = itemLine('produce display', { kind, text: '', relativeDeg: rel, steps: 17, targetVisible: true });
        expect(countWords(l.text)).toBeLessThanOrEqual(MAX_UTTERANCE_WORDS);
        expect(checkPhrase(l.text)).toEqual([]);
      }
    }
    // A three-word landmark name still yields an instruction, not silence.
    const long = itemLine('kitchen counter top', { kind: 'turn_little', text: '', relativeDeg: 10, steps: 17, targetVisible: true });
    expect(countWords(long.text)).toBeLessThanOrEqual(MAX_UTTERANCE_WORDS);
    expect(long.text).toMatch(/walk seventeen steps\.$/);
  });
});

describe('decide: where the person stands → what to say', () => {
  const snap = (over: Partial<Parameters<typeof decide>[2]>) => ({ now: T0, item: null, place: null, door: null, sceneLabel: null, ...over });

  it('bananas in view: clock, side and steps; within reach → the reach phase', () => {
    let s = start();
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
    let r = decide(goal, start(), snap({ item: g({ kind: 'forward', relativeDeg: 2, steps: 5 }) }));
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
    let r = decide(goal, start(), snap({ item: close }));
    expect(r.next.lastSeen).toMatchObject({ what: 'item', steps: 2 });
    const gone = g({ kind: 'scan_unknown', relativeDeg: null, steps: null, targetVisible: false });
    r = decide(goal, r.next, snap({ now: T0 + 1500, item: gone, place: gone }));
    expect(r.decision).toMatchObject({ text: 'Stop. You passed the bananas. Turn around, they are on your right.', haptic: 'STOP', key: 'approach_item:overshoot' });
    // Said once: the next tick is an ordinary hunt.
    r = decide(goal, r.next, snap({ now: T0 + 2000, item: gone, place: gone }));
    expect(r.decision.key).not.toContain('overshoot');
    // A far thing that drops out is simply lost, not passed.
    const far = g({ kind: 'forward', relativeDeg: 0, steps: 6, box: { box: [0.4, 0.3, 0.1, 0.1], at: T0 } });
    const lost = decide(goal, decide(goal, start(), snap({ item: far })).next, snap({ now: T0 + 1500, item: gone, place: gone }));
    expect(lost.decision.key).not.toContain('overshoot');
  });

  it('only the table in view: walk to it, then scan its surface; the item appearing takes over', () => {
    let r = decide(goal, start(), snap({ place: g({ kind: 'turn_little', relativeDeg: -25, steps: 6 }) }));
    expect(r.decision).toMatchObject({ phase: 'approach_place', text: "Table at eleven o'clock. Turn left a little, then walk six steps." });
    r = decide(goal, r.next, snap({ place: g({ kind: 'forward', relativeDeg: 0, steps: 5 }) }));
    expect(r.decision.text).toBe('Table ahead. Walk forward five steps.');
    r = decide(goal, r.next, snap({ place: g({ kind: 'arrived', relativeDeg: 0, steps: 1 }) }));
    expect(r.decision).toMatchObject({ phase: 'scan_place', text: 'At the table. Tilt the camera down and pan slowly.', haptic: 'CONFIRM', boxTarget: 'bananas' });
    r = decide(goal, r.next, snap({ now: T0 + 5000, place: g({ kind: 'arrived', relativeDeg: 0, steps: 1 }) }));
    expect(r.decision).toMatchObject({ phase: 'scan_place', text: 'Still looking for the bananas. Pan slowly across the table.', modelMaySpeak: true });
    r = decide(goal, r.next, snap({ now: T0 + 6000, item: g({ kind: 'turn_little', relativeDeg: 30, steps: 1 }), place: g({ kind: 'arrived' }) }));
    expect(r.decision.phase).toBe('approach_item');
  });

  it('table remembered from earlier: turn toward it', () => {
    const r = decide(goal, start(), snap({ place: g({ kind: 'scan_remembered', relativeDeg: -70, steps: null, targetVisible: false }) }));
    expect(r.decision).toMatchObject({ phase: 'find_place', text: 'Table was on your left. Turn left slowly.', haptic: 'TURN', boxTarget: 'table' });
    const behind = decide(goal, start(), snap({ place: g({ kind: 'turn_around', relativeDeg: 170, steps: null, targetVisible: false }) }));
    expect(behind.decision.text).toBe('Table behind you. Turn around slowly.');
  });

  it('nothing in view: an educated guess with a question, once; then the room answer drives the doorway search', () => {
    const unseen = g({ kind: 'scan_unknown', relativeDeg: null, steps: null, targetVisible: false });
    let r = decide(goal, start(), snap({ item: unseen, place: unseen, sceneLabel: 'in a bedroom' }));
    expect(r.decision).toMatchObject({ text: 'Turn slowly all the way around so I can find the table.', explore: true });   // look first
    r = decide(goal, r.next, snap({ now: T0 + 13_000, item: unseen, place: unseen, sceneLabel: 'in a bedroom' }));
    expect(r.decision).toMatchObject({ phase: 'find_place', text: 'I think the table is in the kitchen. Is that right?', asking: 'room' });
    // Not asked twice: the fallback is a slow scan the model may talk over.
    r = decide(goal, r.next, snap({ now: T0 + 14_000, item: unseen, place: unseen, sceneLabel: 'in a bedroom' }));
    expect(r.decision).toMatchObject({ text: 'Turn slowly all the way around so I can find the table.', modelMaySpeak: true });
    // No scene label → the plain question.
    expect(decide(goal, { ...start(), scanSince: T0 - 13_000 }, snap({ item: unseen, place: unseen })).decision.text).toBe('I do not see a table here. Is it in another room?');

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
    expect(answerRoom(start(), 'no, this room', T0)).toMatchObject({ consumed: true, text: 'Turn slowly all the way around so I can find it.' });
    expect(answerRoom(start(), 'in the kitchen', T0).next.phase).toBe('find_door');
    expect(answerRoom(start(), 'what', T0).consumed).toBe(false);
  });

  it('an item with no place: reason about where it usually is, prefer a place in view, then remembered, then unseen', () => {
    const keys = parseMissionGoal('my keys')!;
    const unseen = g({ kind: 'scan_unknown', relativeDeg: null, steps: null, targetVisible: false });
    // Nothing in view at all: the best usual place, said as a hypothesis.
    let r = decide(keys, initialMissionState(), snap({ item: unseen, candidates: [{ place: 'table', evidence: 'unseen' }, { place: 'countertop', evidence: 'unseen' }] }));
    expect(r.decision).toMatchObject({ text: 'No keys in view. They are usually on the table.', boxTarget: 'table', phase: 'find_place' });
    expect(r.next.working).toBe('table');
    // A counter in view beats an unseen table.
    r = decide(keys, initialMissionState(), snap({ item: unseen, candidates: [{ place: 'table', evidence: 'unseen' }, { place: 'countertop', evidence: 'visible' }] }));
    expect(r.decision.text).toBe('No keys in view. They are usually on the counter.');
    expect(r.next.working).toBe('countertop');
    // The item itself remembered from earlier still wins over any guess.
    expect(decide(keys, initialMissionState(), snap({ item: g({ kind: 'scan_remembered', relativeDeg: 50, steps: null, targetVisible: false }) })).decision.text)
      .toBe('Keys were on your right. Turn right slowly.');
  });

  it('rules a place out after a fruitless scan, says so, moves to the next guess, and finally asks where else (round 11)', () => {
    const keys = parseMissionGoal('my keys')!;
    const unseen = g({ kind: 'scan_unknown', relativeDeg: null, steps: null, targetVisible: false });
    let r = decide(keys, initialMissionState(), snap({ item: unseen, candidates: [{ place: 'table', evidence: 'visible' }] }));
    expect(r.next.working).toBe('table');
    r = decide(keys, r.next, snap({ item: unseen, place: g({ kind: 'arrived', relativeDeg: 0, steps: 1 }) }));
    expect(r.decision.text).toBe('At the table. Tilt the camera down and pan slowly.');
    r = decide(keys, r.next, snap({ now: T0 + 5000, item: unseen, place: g({ kind: 'arrived', relativeDeg: 0, steps: 1 }) }));
    expect(r.decision.text).toBe('Still looking for the keys. Pan slowly across the table.');
    r = decide(keys, r.next, snap({ now: T0 + 16_000, item: unseen, place: g({ kind: 'arrived', relativeDeg: 0, steps: 1 }) }));
    expect(r.decision.text).toBe('Not on the table. Maybe on the counter.');
    expect(r.next.tried).toEqual(['table']);
    expect(r.next.working).toBe('countertop');
    // Exhaust every guess: the app admits it and asks.
    let state = r.next;
    for (let i = 0; i < 8 && state.working; i += 1) {
      state = decide(keys, { ...state, scanSince: T0 }, snap({ now: T0 + 20_000, item: unseen, place: g({ kind: 'arrived', relativeDeg: 0, steps: 1 }) })).next;
    }
    const done = decide(keys, { ...state, working: null, tried: ['table', 'countertop', 'desk', 'couch', 'nightstand', 'door'] }, snap({ now: T0 + 20_000, item: unseen }));
    expect(done.decision.text).toBe('Checked the table, counter, desk, couch, nightstand and door. Where else?');
    expect(done.decision.explore).toBe(true);
  });

  it('the whole chain when the bananas are not where they usually are: table → counter → bowl → fridge → "where else?" → explore', () => {
    const unseen = g({ kind: 'scan_unknown', relativeDeg: null, steps: null, targetVisible: false });
    const bananas = parseMissionGoal('bananas')!;
    const said: string[] = [];
    let state = initialMissionState();
    let now = T0;
    const step = (snapPatch: Partial<Parameters<typeof decide>[2]>, ms = 0): ReturnType<typeof decide>['decision'] => {
      now += ms;
      const r = decide(bananas, state, snap({ now, item: unseen, ...snapPatch }));
      state = r.next;
      if (r.decision.text) said.push(r.decision.text);
      return r.decision;
    };
    // Table in view: the first guess, walk there, scan it, rule it out.
    step({ candidates: [{ place: 'countertop', evidence: 'unseen' }, { place: 'table', evidence: 'visible' }, { place: 'bowl', evidence: 'unseen' }, { place: 'fridge', evidence: 'unseen' }] });
    expect(said.at(-1)).toBe('No bananas in view. They are usually on the table.');
    step({ place: g({ kind: 'forward', relativeDeg: 0, steps: 3 }) }, 500);
    expect(said.at(-1)).toBe('Bananas ahead. Walk forward three steps.'.replace('Bananas', 'Table'));
    step({ place: g({ kind: 'arrived', relativeDeg: 0, steps: 1 }) }, 3000);
    expect(said.at(-1)).toBe('At the table. Tilt the camera down and pan slowly.');
    step({ place: g({ kind: 'arrived', relativeDeg: 0, steps: 1 }) }, 16_000);
    expect(said.at(-1)).toBe('Not on the table. Maybe on the counter.');
    // The counter is nowhere in sight: a short look with the explorer's poses, then the next guess.
    const look = step({ place: unseen }, 500);
    expect(look.explore).toBe(true);
    step({ place: unseen }, 9000);
    expect(said.at(-1)).toBe('Not on the counter. Maybe in the bowl.');
    step({ place: unseen }, 500);
    step({ place: unseen }, 9000);
    expect(said.at(-1)).toBe('Not in the bowl. Maybe in the fridge.');
    step({ place: unseen }, 500);
    const done = step({ place: unseen }, 9000);
    expect(said.at(-1)).toBe('Checked the table, counter, bowl and fridge. Where else?');
    expect(done.explore).toBe(true);
    for (const line of said) expect(countWords(line)).toBeLessThanOrEqual(MAX_UTTERANCE_WORDS);
  });

  it('"explore" / "next aisle" / "it is not here" are requests to leave this spot (round 14)', () => {
    expect(exploreRequest('explore')).toEqual({ asked: true, prefer: null });
    expect(exploreRequest('Look somewhere else.')).toEqual({ asked: true, prefer: null });
    expect(exploreRequest("it's not here")).toEqual({ asked: true, prefer: null });
    expect(exploreRequest('try the next aisle')).toEqual({ asked: true, prefer: 'aisle' });
    expect(exploreRequest('check another room')).toEqual({ asked: true, prefer: 'room' });
    expect(exploreRequest('yes')).toEqual({ asked: false, prefer: null });
    expect(exploreRequest('where are the bananas')).toEqual({ asked: false, prefer: null });
  });

  it('a container has to be opened: "may be inside, open it, then say open" → open → scan inside; cannot open → next guess', () => {
    const water = parseMissionGoal('a bottle of water')!;
    const unseen = g({ kind: 'scan_unknown', relativeDeg: null, steps: null, targetVisible: false });
    let r = decide(water, initialMissionState(), snap({ item: unseen, candidates: [{ place: 'fridge', evidence: 'visible' }] }));
    expect(r.decision.text).toBe('No bottle of water in view. It is usually in the fridge.');
    r = decide(water, r.next, snap({ item: unseen, place: g({ kind: 'arrived', relativeDeg: 0, steps: 1 }) }));
    expect(r.decision).toMatchObject({ phase: 'open_place', text: 'The bottle of water may be inside the fridge. Open it, then say open.', asking: 'open' });
    const opened = answerOpen(r.next, 'it is open');
    expect(opened.consumed).toBe(true);
    r = decide(water, opened.next, snap({ item: unseen, place: g({ kind: 'arrived', relativeDeg: 0, steps: 1 }) }));
    expect(r.decision.text).toBe('Point the camera inside the fridge and pan slowly.');
    const stuck = answerOpen({ ...r.next, opened: false, openAsked: true }, "I can't open it");
    expect(stuck).toMatchObject({ consumed: true, text: 'Okay. Let me think of somewhere else.' });
    expect(stuck.next.tried).toContain('fridge');
  });
});

describe('createMissionRunner: the first line is immediate, repeats are paced, the model box steers', () => {
  it('speaks at once from the detector, holds an unchanged line for four seconds, and moves to reach', () => {
    let t = T0;
    let dets: Detection[] = [{ cls: 'banana', box: [0.7, 0.4, 0.1, 0.1], score: 0.9, trackId: 1 }, { cls: 'table', box: [0.1, 0.3, 0.4, 0.4], score: 0.9, trackId: 2 }];
    const guide = createGuide({ detections: () => dets, memory: { whereIs: () => 'unseen', facing: () => 0 }, hfovDeg: () => 56, now: () => t });
    const m = createMissionRunner(goal, { guide, now: () => t });
    const first = m.tick();
    expect(first.text).toMatch(/^Bananas slightly right\. Turn right a little, then walk/);
    expect(first.haptic).toBe('TURN');
    expect(m.phase()).toBe('approach_item');
    t += 1000;
    expect(m.tick().text).toBeNull();                      // same line inside the repeat window
    t += MISSION_REPEAT_MS;
    expect(m.tick().text).toMatch(/^Bananas slightly right/); // said again after four seconds
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
    expect(m.tick().text).toBe('No keys in view. They are usually on the table.');
    expect(m.boxTarget()).toBe('table');
    t += 3000;
    expect(m.tick().text).toBe('Turn slowly all the way around so I can find the table.');
    t += MISSION_SLOW_REPEAT_MS;
    expect(m.tick().text).toBe('Turn slowly all the way around so I can find the table.');
    m.onModelBox('keys', [0.6, 0.5, 0.05, 0.03], t);
    t += MISSION_CHANGE_FLOOR_MS;
    expect(m.tick().text).toMatch(/^Keys slightly right/);
    expect(m.userText()).toContain('Look for: keys');
  });

  it('"explore" mid-search leaves the spot at once: the explorer walks, the navigator holds its guesses (round 14)', () => {
    let t = T0;
    const pose = { x: 0, z: 0, y: 0, yawDeg: 0, trackingState: 'NORMAL' as const, timestamp: t };
    const guide = createGuide({ detections: () => [], memory: { whereIs: () => 'unseen', facing: () => 0 }, hfovDeg: () => 56, now: () => t });
    const map = createExplorationMap(() => t);
    const feed = (ms: number) => { for (let i = 0; i < ms; i += 100) { t += 100; map.ingestPose({ ...pose, timestamp: t }); } };
    feed(300);
    const search = createSearchExplorer({ map, item: 'bananas', context: 'home', guide, now: () => t, pose: () => ({ ...pose, timestamp: t }), path: () => ({ center: 0.1, left: 0.1, right: 0.1 }) });
    const m = createMissionRunner(parseMissionGoal('bananas')!, { guide, now: () => t, search });
    expect(m.tick().text).toBe('No bananas in view. They are usually on the counter.');
    t += 1000;
    const r = m.intercept('explore');
    expect(r.consumed).toBe(true);
    expect(r.text).toBe('Okay. Hold still. Let me check the path ahead.');
    expect(search.busy()).toBe(true);
    // While the leg runs, the navigator does not hop to "maybe on the table".
    feed(2000);
    const during = m.tick();
    expect(during.text === null || /Keep walking|Drifting|Keep turning/.test(during.text)).toBe(true);
    expect(during.decision.key.startsWith('search:') || during.text === null).toBe(true);
    // Six metres on: the leg ends, a look around, then reasoning resumes.
    for (let z = 0.1; z <= 6.5; z += 0.1) { pose.z = -z; feed(100); }
    expect(m.tick().text).toBe('Stop here. Let me look around.');
    expect(search.busy()).toBe(false);
  });

  it('a remembered table does not ping-pong "left… right…": dead zone ahead, two ticks to switch sides, and a memory that leads nowhere is doubted (round 15)', () => {
    let t = T0;
    let rel = 8;
    const guide = createGuide({ detections: () => [], memory: { whereIs: () => ({ cls: 'table', relativeDeg: rel, ageMs: 1000, phrase: '' }), facing: () => 0 }, hfovDeg: () => 56, now: () => t });
    const m = createMissionRunner(goal, { guide, now: () => t });
    expect(m.tick().text).toBe('Table should be straight ahead. Hold the camera level.');
    rel = -12; t += 2500;
    expect(m.tick().text).toBeNull();                       // still inside the dead zone: nothing new
    rel = 40; t += 2500;
    expect(m.tick().text).toBe('Table was on your right. Turn right slowly.');
    rel = -40; t += 500;
    expect(m.tick().text).toBeNull();                       // a flip needs a second tick
    t += 500;
    expect(m.tick().text).toBeNull();                       // …and the change floor
    t += 2000;
    expect(m.tick().text).toBe('Table was on your left. Turn left slowly.');
    // Twelve seconds of turning without a sighting: the memory is doubted and the search looks around instead.
    t += 12_000;
    const lost = m.tick();
    expect(lost.text).toBe('I cannot find the table I remembered. Let me look around.');
    expect(lost.decision.explore).toBe(true);
    t += 3000;
    expect(m.tick().text).toBe('Turn slowly all the way around so I can find the table.');
  });

  it('"not on this table" persists across a pan away and back, and across a new mission; a different table is still fair game (round 18)', () => {
    let t = T0;
    const pose = { x: 0, z: 0, y: 0, yawDeg: 0, trackingState: 'NORMAL' as const, timestamp: t };
    const map = createExplorationMap(() => t);
    // One table straight ahead, three steps away (box height → steps).
    let dets: Detection[] = [{ cls: 'table', box: [0.3, 0.4, 0.4, 0.25], score: 0.9, trackId: 1 }];
    const guide = createGuide({ detections: () => dets, memory: { whereIs: () => 'unseen', facing: () => 0 }, hfovDeg: () => 56, now: () => t });
    const deps = { guide, now: () => t, map, pose: () => ({ ...pose, timestamp: t }) };
    const m = createMissionRunner(parseMissionGoal('bananas')!, deps);
    expect(m.tick().text).toBe('No bananas in view. They are usually on the table.');
    t += 2500;
    expect(m.tick().text).toMatch(/^Table ahead\. Walk forward/);
    // Arrive and scan it for fifteen seconds without bananas.
    dets = [{ cls: 'table', box: [0.05, 0.2, 0.9, 0.8], score: 0.9, trackId: 1 }];
    t += 2500;
    expect(m.tick().text).toBe('At the table. Tilt the camera down and pan slowly.');
    // Continuous poses and three usable shelf bands are required before session exclusion.
    for (let i = 0; i < 160; i++) { t += 100; map.ingestPose({ ...pose, timestamp: t }); }
    for (const view of ['upper', 'upper', 'middle', 'middle', 'lower', 'lower'] as const) {
      for (let i = 0; i < 8; i++) { t += 100; map.ingestPose({ ...pose, pitchDeg: view === 'upper' ? 15 : view === 'lower' ? -15 : 0, timestamp: t }); }
      map.trip.observe({ inspection: { target: 'bananas', assessed: true, confidence: 0.95 }, sign: null, items: [], view, quality: 'usable', confidence: 0.9, barrier: 'none', landmarks: [] }, 'bananas', t);
    }
    expect(m.tick().text).toBe('Not on the table. Maybe on the counter.');
    expect(map.absentMarks('bananas')).toHaveLength(1);
    expect(map.absentMarks('bananas')[0]).toMatchObject({ place: 'table' });
    // Pan away (no table in view) — the counter guess runs its short course.
    dets = [];
    t += 2500; m.tick();
    // Pan back onto the same table later: it is *not* a place to walk to any more.
    dets = [{ cls: 'table', box: [0.3, 0.4, 0.4, 0.25], score: 0.9, trackId: 1 }];
    t += 60_000;
    for (let i = 0; i < 6; i += 1) { t += 2500; const r = m.tick(); expect(r.text ?? '').not.toMatch(/^Table/); }
    // A new mission for the same item, from the same spot: the table is still known to be checked.
    const again = createMissionRunner(parseMissionGoal('bananas')!, deps);
    const first = again.tick().text ?? '';
    expect(first).not.toMatch(/usually on the table/);
    // A different table, ten metres away across the room: fair game.
    pose.x = 10;
    const other = createMissionRunner(parseMissionGoal('bananas')!, deps);
    expect(other.tick().text).toBe('No bananas in view. They are usually on the table.');
  });

  it('answers the room question through intercept and repeats on demand', () => {
    let t = T0;
    const guide = createGuide({ detections: () => [], memory: { whereIs: () => 'unseen', facing: () => 0 }, hfovDeg: () => 56, now: () => t });
    const m = createMissionRunner(goal, { guide, now: () => t, sceneLabel: () => 'in a bedroom' });
    expect(m.tick().text).toBe('Turn slowly all the way around so I can find the table.');   // look first
    t += 13_000;
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
