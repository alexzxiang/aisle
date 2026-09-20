import type { Detection, Pose } from './contracts';
import { PHRASES } from './phrases';
import {
  bearingFor,
  classForWords,
  createSceneMemory,
  directionPhrase,
  labelMatches,
  whereQuery,
  whereSentence,
  wrap180,
} from './sceneMemory';
import { MAX_UTTERANCE_WORDS, countWords, findForbiddenTerm, hasDigit } from './phrases';

const det = (cls: Detection['cls'], cx: number, w = 0.3, h = 0.4, trackId = 1): Detection => ({ cls, box: [cx - w / 2, 0.3, w, h], score: 0.8, trackId });
const pose = (yawDeg: number): Pose => ({ yawDeg, x: 0, y: 0, z: 0, trackingState: 'NORMAL', timestamp: 0 });

it.each([
  ['teacher desk', 'desk'], ['student desks', 'desk'], ['kitchen island', 'countertop'],
  ['produce bin', 'food_container'], ['display shelves', 'shelf'], ['display table', 'table'],
  ['bedside table', 'nightstand'], ['classroom chairs', 'chair'],
  ['sun hat', 'hat'], ['AirPods', 'headphones'], ['wireless earbuds', 'headphones'],
])('preserves the supporting structure in %s', (words, cls) => {
  expect(classForWords(words)).toBe(cls);
});

function rig(now: () => number) {
  const dets = new Set<(d: Detection[]) => void>();
  const poses = new Set<(p: Pose) => void>();
  const scenes = new Set<(e: { labels: Array<{ id: string; confidence: number }>; timestamp: number }) => void>();
  const said: string[] = [];
  const mem = createSceneMemory({
    perception: {
      onDetections: (cb) => { dets.add(cb); return () => dets.delete(cb); },
      onPose: (cb) => { poses.add(cb); return () => poses.delete(cb); },
      onSceneClass: (cb) => { scenes.add(cb); return () => scenes.delete(cb); },
    },
    speech: { say: (r) => { said.push(r.text); } },
    now,
  });
  return {
    mem, said,
    see: (yaw: number, list: Detection[]) => { for (const p of Array.from(poses)) p(pose(yaw)); for (const d of Array.from(dets)) d(list); },
    face: (yaw: number) => { for (const p of Array.from(poses)) p(pose(yaw)); },
    classify: (yaw: number, labels: Array<{ id: string; confidence: number }>) => { for (const p of Array.from(poses)) p(pose(yaw)); for (const s of Array.from(scenes)) s({ labels, timestamp: 0 }); },
  };
}

describe('sceneMemory (pure)', () => {
  it('bearings and wrapping', () => {
    expect(bearingFor(0, [0.35, 0, 0.3, 0.4])).toBe(0);            // centred box: straight ahead
    expect(bearingFor(0, [0.7, 0, 0.3, 0.4], 56)).toBeCloseTo(19.6); // right edge of frame
    expect(bearingFor(350, [0.7, 0, 0.3, 0.4], 56)).toBeCloseTo(9.6);
    expect(wrap180(190)).toBe(-170);
    expect(wrap180(-190)).toBe(170);
    expect(wrap180(180)).toBe(180);
  });

  it('words → classes, questions → things', () => {
    expect(classForWords('the fridge')).toBe('fridge');
    expect(classForWords('my couch')).toBe('couch');
    expect(classForWords('television')).toBe('tv');
    expect(classForWords('a dragon')).toBeNull();
    expect(whereQuery("where's the fridge?")).toBe('fridge');
    expect(whereQuery('Where is my couch')).toBe('couch');
    expect(whereQuery('do you see a dog')).toBe('dog');
    expect(whereQuery('where am I')).toBeNull();
    expect(whereQuery('take me to eggs')).toBeNull();
    // Tasks and placed questions stay with the planner.
    expect(whereQuery('find the eggs in my fridge')).toBeNull();
    expect(whereQuery('where are the eggs in my fridge')).toBeNull();
    expect(whereQuery('where are the bananas')).toBe('bananas');
    expect(classForWords('bananas')).toBe('banana');
  });

  it('direction words and speakable sentences', () => {
    expect(directionPhrase(5)).toBe('ahead');
    expect(directionPhrase(-40)).toBe('ahead to your left');
    expect(directionPhrase(90)).toBe('to your right');
    expect(directionPhrase(-140)).toBe('behind you to the left');
    expect(directionPhrase(175)).toBe('behind you');
    for (const [cls, rel, area] of [['fridge', -90, 0.3], ['tv', 10, 0.05], ['traffic_light', 170, 0.005], ['couch', 130, 0.1]] as const) {
      const s = whereSentence(cls, rel, area);
      expect(countWords(s)).toBeLessThanOrEqual(MAX_UTTERANCE_WORDS);
      expect(hasDigit(s)).toBe(false);
      expect(findForbiddenTerm(s)).toBeNull();
    }
    expect(whereSentence('fridge', -90, 0.3)).toBe('The fridge is to your left.');
    expect(whereSentence('couch', 175, 0.1)).toBe('The couch is behind you. Turn around.');
  });
});

describe('createSceneMemory', () => {
  it('remembers where things were seen and answers relative to the current facing', () => {
    let t = 1_000_000;
    const r = rig(() => t);
    r.see(0, [det('fridge', 0.5)]);            // fridge straight ahead while facing north
    t += 1000;
    r.see(90, [det('couch', 0.5, 0.4, 0.5)]);  // turned east: couch ahead
    t += 1000;
    r.face(90);
    expect(r.mem.whereIs('fridge')).toMatchObject({ cls: 'fridge', relativeDeg: -90, phrase: 'The fridge is to your left.' });
    expect(r.mem.whereIs('couch')).toMatchObject({ relativeDeg: 0 });
    r.face(180);
    expect(r.mem.whereIs('fridge')).toMatchObject({ phrase: 'The fridge is behind you. Turn around.' });
    expect(r.mem.describe()).toBe('couch to your left, fridge behind you');
    expect(r.mem.whereIs('dog')).toBe('unseen');
    expect(r.mem.whereIs('dragon')).toBe('unseen');       // any named thing: 'unseen' rather than a store trip
    expect(r.mem.whereIs('it')).toBe('unknown_thing');
    r.mem.dispose();
  });

  it('merges repeat sightings of the same thing, forgets after the ttl, and ignores signal heads', () => {
    let t = 0;
    const r = rig(() => t);
    r.see(0, [det('chair', 0.5), det('ped_walk', 0.5)]);
    r.see(0, [det('chair', 0.55)]);            // same chair, a little to the right
    expect(r.mem.entries()).toHaveLength(1);
    expect(r.mem.entries()[0]).toMatchObject({ cls: 'chair', sightings: 2 });
    r.see(0, [det('chair', 0.5, 0.1, 0.1, 2)]);
    r.see(120, [det('chair', 0.5)]);           // another chair far to the right
    expect(r.mem.entries().filter((e) => e.cls === 'chair')).toHaveLength(2);
    t += 91_000;
    r.face(0);
    expect(r.mem.whereIs('chair')).toBe('unseen');
    r.mem.dispose();
  });

  it('things only the classifier names (yogurt, ketchup) are remembered image-wide and answered without a distance', () => {
    let t = 0;
    const r = rig(() => t);
    // Round 9: eggs and milk became detector classes, so the classifier-only things here are yogurt and cereal.
    r.classify(0, [{ id: 'kitchen', confidence: 0.6 }, { id: 'yogurt', confidence: 0.45 }, { id: 'ketchup', confidence: 0.35 }, { id: 'refrigerator', confidence: 0.5 }, { id: 'noise', confidence: 0.1 }]);
    // Keep classifier sightings even for detector classes; kitchen is only a setting.
    expect(r.mem.entries().filter((e) => e.source === 'classifier').map((e) => e.cls).sort()).toEqual(['ketchup', 'refrigerator', 'yogurt']);
    r.face(90);
    expect(r.mem.whereIs('yogurt')).toMatchObject({ cls: 'yogurt', relativeDeg: -90, phrase: 'The yogurt is to your left.' });
    expect(r.mem.whereIs('the ketchup')).toMatchObject({ cls: 'ketchup', phrase: 'The ketchup is to your left.' });
    expect(r.mem.whereIs('cereal')).toBe('unseen');
    expect(r.mem.intercept('where is the yogurt?')).toBe(true);
    expect(r.said[r.said.length - 1]).toBe('The yogurt is to your left.');
    expect(r.mem.intercept('where is the cereal')).toBe(true);
    expect(r.said.slice(-2)[0]).toBe('I have not seen a cereal yet.');
    expect(labelMatches('milk_carton', 'milk')).toBe(true);
    expect(labelMatches('egg', 'the eggs')).toBe(true);
    r.mem.dispose();
  });

  it('intercepts "where is the X": from memory, or asks for a look; a thing it cannot name is still "unseen", never a store trip', () => {
    let t = 0;
    const r = rig(() => t);
    expect(r.mem.intercept('take me to the CVS')).toBe(false);
    expect(r.mem.intercept('where is the dragon')).toBe(true);
    expect(r.said[r.said.length - 2]).toBe('I have not seen a dragon yet.');
    expect(r.mem.intercept("where's the fridge")).toBe(true);
    expect(r.said.slice(-2)).toEqual(['I have not seen a fridge yet.', PHRASES.show_surroundings]);
    r.see(30, [det('fridge', 0.5)]);
    r.face(30);
    expect(r.mem.intercept('where is the fridge?')).toBe(true);
    expect(r.said[r.said.length - 1]).toBe('The fridge is ahead.');
    r.mem.dispose();
  });
});

it('keeps egg classifier evidence despite an orange detection, without relabeling boxes', () => {
  let t = 1000;
  const r = rig(() => t);
  r.see(0, [det('orange', 0.8)]);
  r.classify(0, [{ id: 'egg', confidence: 0.8 }]);
  r.face(90);
  expect(r.mem.whereIs('eggs')).toMatchObject({ cls: 'egg', relativeDeg: -90 });
  expect(r.mem.entries().find(e => e.cls === 'egg')).toMatchObject({ source: 'classifier', area: 0 });
  expect(r.mem.entries().find(e => e.cls === 'orange')?.source).toBe('detector');
  t += 91_000;
  expect(r.mem.whereIs('eggs')).toBe('unseen');
  r.mem.dispose();
});

it('keeps a later detector box separate from an image-wide classifier sighting', () => {
  const r = rig(() => 1000);
  r.classify(0, [{ id: 'egg', confidence: 0.8 }]);
  r.see(0, [det('egg', 0.8)]);
  expect(r.mem.entries().filter(e => e.cls === 'egg')).toHaveLength(2);
  expect(r.mem.entries().find(e => e.cls === 'egg' && e.source === 'classifier')?.area).toBe(0);
  const answer = r.mem.whereIs('eggs');
  expect(typeof answer).toBe('object');
  if (typeof answer === 'object') expect(answer.relativeDeg).toBeCloseTo(16.8);
  r.mem.dispose();
});
