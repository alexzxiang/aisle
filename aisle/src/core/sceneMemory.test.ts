import type { Detection, Pose } from './contracts';
import { PHRASES } from './phrases';
import {
  bearingFor,
  classForWords,
  createSceneMemory,
  directionPhrase,
  whereQuery,
  whereSentence,
  wrap180,
} from './sceneMemory';
import { MAX_UTTERANCE_WORDS, countWords, findForbiddenTerm, hasDigit } from './phrases';

const det = (cls: Detection['cls'], cx: number, w = 0.3, h = 0.4, trackId = 1): Detection => ({ cls, box: [cx - w / 2, 0.3, w, h], score: 0.8, trackId });
const pose = (yawDeg: number): Pose => ({ yawDeg, x: 0, y: 0, z: 0, trackingState: 'NORMAL', timestamp: 0 });

function rig(now: () => number) {
  const dets = new Set<(d: Detection[]) => void>();
  const poses = new Set<(p: Pose) => void>();
  const said: string[] = [];
  const mem = createSceneMemory({
    perception: {
      onDetections: (cb) => { dets.add(cb); return () => dets.delete(cb); },
      onPose: (cb) => { poses.add(cb); return () => poses.delete(cb); },
    },
    speech: { say: (r) => { said.push(r.text); } },
    now,
  });
  return {
    mem, said,
    see: (yaw: number, list: Detection[]) => { for (const p of Array.from(poses)) p(pose(yaw)); for (const d of Array.from(dets)) d(list); },
    face: (yaw: number) => { for (const p of Array.from(poses)) p(pose(yaw)); },
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
    expect(whereSentence('fridge', -90, 0.3)).toBe('The fridge is to your left, close.');
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
    expect(r.mem.whereIs('fridge')).toMatchObject({ cls: 'fridge', relativeDeg: -90, phrase: 'The fridge is to your left, a few steps away.' });
    expect(r.mem.whereIs('couch')).toMatchObject({ relativeDeg: 0 });
    r.face(180);
    expect(r.mem.whereIs('fridge')).toMatchObject({ phrase: 'The fridge is behind you. Turn around.' });
    expect(r.mem.describe()).toBe('couch to your left, fridge behind you');
    expect(r.mem.whereIs('dog')).toBe('unseen');
    expect(r.mem.whereIs('dragon')).toBe('unknown_thing');
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

  it('intercepts "where is the X": from memory, or asks for a look; leaves unknown things to the planner', () => {
    let t = 0;
    const r = rig(() => t);
    expect(r.mem.intercept('take me to the CVS')).toBe(false);
    expect(r.mem.intercept('where is the dragon')).toBe(false);
    expect(r.mem.intercept("where's the fridge")).toBe(true);
    expect(r.said).toEqual(['I have not seen a fridge yet.', PHRASES.show_surroundings]);
    r.see(30, [det('fridge', 0.5)]);
    r.face(30);
    expect(r.mem.intercept('where is the fridge?')).toBe(true);
    expect(r.said[r.said.length - 1]).toBe('The fridge is ahead, a few steps away.');
    r.mem.dispose();
  });
});
