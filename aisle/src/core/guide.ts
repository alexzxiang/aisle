/**
 * Guide — walking instructions computed from what the phone sees (round 7, Stream A).
 *
 * The complaint that drove this: the detector reported `fridge ahead (close)` and
 * the voice said "Bear left." Every spoken step came from a language model reading a
 * still; nothing turned the phone's own geometry into words. Now the words come from
 * geometry first, the model second:
 *
 *   target visible (detector box, fresh)
 *     → side from the box centre, distance in steps from the box height and the
 *       depth grid → "Fridge ahead, about five steps. Walk forward."
 *                   "Fridge to your right, a few steps. Turn right a little."
 *                   "Fridge right in front of you. Reach out."
 *   target not visible, remembered (scene memory bearing)
 *     → "Turn slowly to the left so I can see the fridge." / "…behind you. Turn around."
 *   never seen
 *     → "I have not seen the fridge yet. Turn slowly all the way around."
 *   target the detector has no class for (eggs)
 *     → a box from Claude (`target.box`, ≤ 3 s old) is used the same way; else null and
 *       the caller falls back to the model's sentence.
 *
 * Distance: a box of a known-height thing subtends h of the portrait frame; with the
 * wide lens's ~70° vertical field of view, distance ≈ H / (1.4 × h). One step ≈ 0.7 m.
 * The depth grid's nearness (0..1) caps it: ≥ 0.75 is "right in front of you" whatever
 * the box says. Ultra-wide (≈ 95° vertical) uses 1.9 instead of 1.4.
 *
 * Wording varies on purpose (the same sentence twice in a row is what people call
 * "spamming"): each kind has several phrasings and the previous one is never reused.
 * Nothing here decides *when* to speak; `changed(prev, next)` tells the caller whether
 * the instruction is news.
 */
import type { Detection, DetectionClass, HandPoseEvent } from './contracts';
import { classForWords, spokenName, wrap180, type SceneMemory } from './sceneMemory';
import { integerToWords } from '../outdoor/numberWords';
import { guidanceText } from './preparedGuidance';

export type GuideKind = 'arrived' | 'forward' | 'sidestep' | 'turn_little' | 'turn' | 'turn_around' | 'scan_remembered' | 'scan_unknown';

export interface GuideInstruction {
  kind: GuideKind;
  text: string;
  /** Signed degrees to the target from the current facing (+ right), when known. */
  relativeDeg: number | null;
  /** Whole steps to the target when the target is in view; null otherwise. */
  steps: number | null;
  targetVisible: boolean;
}

export interface TargetBox {
  box: [number, number, number, number];
  /** Depth-grid nearness at the box, when known. */
  near?: number;
  at: number;
}

/** Real-world heights (metres) for the step estimate. Missing classes use 0.8. */
export const CLASS_HEIGHT_M: Readonly<Partial<Record<DetectionClass, number>>> = {
  fridge: 1.7, oven: 0.9, microwave: 0.3, sink: 0.9, toilet: 0.75, table: 0.75, chair: 0.9, couch: 0.85, bed: 0.6,
  tv: 0.6, laptop: 0.25, bottle: 0.25, cup: 0.1, bowl: 0.08, plant: 0.7, book: 0.25, clock: 0.3, dog: 0.5, cat: 0.3,
  backpack: 0.45, handbag: 0.3, suitcase: 0.6, umbrella: 0.9, bench: 0.9, traffic_light: 1.0, stop_sign: 0.75, hydrant: 0.8,
  person: 1.7, car: 1.5, bus: 3.0, truck: 2.5, bicycle: 1.0, motorcycle: 1.1, cart: 1.0,
};
export const DEFAULT_HEIGHT_M = 0.8;
export const STEP_M = 0.7;
export const MAX_STEPS = 20;
/** Fresh enough to steer by. */
export const TARGET_FRESH_MS = 3000;
/** Depth-grid nearness at which the bottom-centre cell counts as something in the way. */
export const PATH_BLOCKED = 0.7;

export function stepsFromBox(cls: DetectionClass | null, box: [number, number, number, number], near: number | undefined, ultraWide = false): number {
  const h = Math.max(0.02, box[3]);
  const heightM = (cls && CLASS_HEIGHT_M[cls]) ?? DEFAULT_HEIGHT_M;
  const k = ultraWide ? 1.9 : 1.4;
  let distanceM = heightM / (k * h);
  if (typeof near === 'number') {
    if (near >= 0.75 && h >= 0.75) distanceM = Math.min(distanceM, 1.0);
    else if (near >= 0.5) distanceM = Math.min(distanceM, 2.5);
  }
  return Math.max(0, Math.min(MAX_STEPS, Math.round(distanceM / STEP_M)));
}

/** Signed degrees from the frame centre to a box centre: + right. */
export function degreesFromBox(box: [number, number, number, number], hfovDeg: number): number {
  const cx = box[0] + box[2] / 2;
  return (cx - 0.5) * hfovDeg;
}

const VARIANTS: Readonly<Record<GuideKind, ReadonlyArray<(name: string, steps: string, side: string) => string>>> = {
  arrived: [
    (n) => `${cap(n)} right in front of you. Reach out.`,
    (n) => `You are at the ${n}. Reach out.`,
    (n) => `The ${n} is within reach.`,
  ],
  forward: [
    (n, s) => `${cap(n)} ahead, about ${s}. Walk forward.`,
    (n, s) => `Walk forward ${s}. The ${n} is straight ahead.`,
    (n, s) => `Straight ahead, ${s} to the ${n}.`,
    (n, s) => `Keep walking. ${cap(n)} ahead, ${s}.`,
  ],
  sidestep: [
    (n, s, side) => `Something in your way. Step ${side}, then walk forward.`,
    (n, s, side) => `Blocked ahead. Move one step ${side} and continue to the ${n}.`,
    (n, s, side) => `Step ${side} around it. The ${n} is still ahead.`,
  ],
  turn_little: [
    (n, s, side) => `${cap(n)} ahead to your ${side}. Turn ${side} a little.`,
    (n, s, side) => `A little to the ${side}. The ${n} is ${s} away.`,
    (n, s, side) => `Turn ${side} a little; the ${n} is just off ${side}.`,
  ],
  turn: [
    (n, s, side) => `The ${n} is to your ${side}. Turn ${side}.`,
    (n, s, side) => `Turn ${side} to face the ${n}.`,
    (n, s, side) => `${cap(n)} on your ${side}, ${s} away. Turn ${side}.`,
  ],
  turn_around: [
    (n) => `The ${n} is behind you. Turn around.`,
    (n) => `Turn around; the ${n} is behind you.`,
  ],
  scan_remembered: [
    (n, s, side) => `Turn slowly to the ${side} so I can see the ${n}.`,
    (n, s, side) => `Pan ${side} slowly. The ${n} was on your ${side}.`,
    (n, s, side) => `Look ${side}, slowly, until I see the ${n}.`,
  ],
  scan_unknown: [
    (n) => `${cap(n)} not seen yet. Turn slowly all the way around.`,
    (n) => `Turn slowly in a full circle so I can find the ${n}.`,
    (n) => `Show me the room slowly; I am looking for the ${n}.`,
  ],
};

function cap(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s;
}

export function stepsWords(steps: number): string {
  if (steps <= 1) return 'one step';
  return `${integerToWords(steps)} steps`;
}

/** Pick a phrasing for a kind, never the one used last time for the same kind. */
export function phraseFor(kind: GuideKind, name: string, steps: number | null, side: string, lastIndex: number | undefined): { text: string; index: number } {
  const options = VARIANTS[kind];
  let index = Math.floor(Math.random() * options.length);
  if (options.length > 1 && index === lastIndex) index = (index + 1) % options.length;
  const s = steps === null ? 'a few steps' : stepsWords(steps);
  return { text: options[index]!(name, s, side), index };
}

export interface GuideDeps {
  /** The detector's latest tracks (a fresh copy each call). */
  detections: () => readonly Detection[];
  /** The depth grid's bottom row, fresh (≤ 1 s): nearness 0..1 ahead / left / right. Null when unknown. */
  path?: () => { center: number; left?: number; right?: number; closingRate?: number } | null;
  /** Scene memory: remembered bearings for things out of view, and the facing. */
  memory: Pick<SceneMemory, 'whereIs' | 'facing'>;
  /** Portrait horizontal field of view of the still, degrees (56 wide / 100 ultra-wide). */
  hfovDeg: () => number;
  now?: () => number;
}

export interface Guide {
  /** The instruction for a goal phrase ("eggs in my fridge" → the fridge; "the couch"), or null when nothing applies. */
  instructionFor(targetWords: string, modelBox?: TargetBox | null): GuideInstruction | null;
  /** Is `next` news against what was last spoken? Same kind and same step count within one is not. */
  changed(prev: GuideInstruction | null, next: GuideInstruction): boolean;
}

export function createGuide(deps: GuideDeps): Guide {
  const now = deps.now ?? Date.now;
  const lastIndex = new Map<GuideKind, number>();

  const say = (kind: GuideKind, name: string, steps: number | null, side: string): string => {
    return guidanceText(kind, name, steps, side);
  };

  return {
    instructionFor(targetWords, modelBox) {
      const cls = classForWords(targetWords);
      const name = cls ? spokenName(cls) : targetWords.toLowerCase().replace(/^(the|a|an|my|some)\s+/, '');
      const hfov = deps.hfovDeg();
      const ultraWide = hfov > 80;

      // 1. In view: the detector's box, else the model's recent box.
      let box: [number, number, number, number] | null = null;
      let near: number | undefined;
      if (cls) {
        const seen = deps.detections().filter((d) => d.cls === cls).sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3])[0];
        if (seen) {
          box = seen.box;
          near = seen.near;
        }
      }
      if (!box && modelBox && now() - modelBox.at <= TARGET_FRESH_MS) {
        box = modelBox.box;
        near = modelBox.near;
      }
      if (box) {
        const rel = degreesFromBox(box, hfov);
        const steps = stepsFromBox(cls, box, near, ultraWide);
        const side = rel < 0 ? 'left' : 'right';
        const a = Math.abs(rel);
        if (a <= hfov * 0.18 && steps <= 1) {
          return { kind: 'arrived', text: say('arrived', name, steps, side), relativeDeg: rel, steps, targetVisible: true };
        }
        if (a <= hfov * 0.12) {
          // The way ahead: when the depth grid says something is close in front and the target
          // is still a few steps off, route around it toward the more open side (round 7b).
          const p = deps.path?.() ?? null;
          const obstruction = deps.detections().some((d) => d.cls !== cls && d.score >= 0.7 &&
            d.box[3] >= 0.4 && d.box[0] < 0.6 && d.box[0] + d.box[2] > 0.4 && d.box[1] + d.box[3] > 0.75);
          if (p && p.center >= PATH_BLOCKED && steps >= 2 && ((p.closingRate ?? 0) > 0.05 || obstruction)) {
            const leftOpen = typeof p.left === 'number' ? p.left : 1;
            const rightOpen = typeof p.right === 'number' ? p.right : 1;
            const stepSide = leftOpen <= rightOpen ? 'left' : 'right';
            return { kind: 'sidestep', text: say('sidestep', name, steps, stepSide), relativeDeg: rel, steps, targetVisible: true };
          }
          return { kind: 'forward', text: say('forward', name, steps, side), relativeDeg: rel, steps, targetVisible: true };
        }
        const turnText = `Turn ${side} about ${integerToWords(Math.max(5, Math.round(a / 5) * 5))} degrees toward the ${name}.`;
        if (a <= hfov * 0.3) return { kind: 'turn_little', text: turnText, relativeDeg: rel, steps, targetVisible: true };
        return { kind: 'turn', text: turnText, relativeDeg: rel, steps, targetVisible: true };
      }

      // 2. Out of view: remembered bearing.
      const where = deps.memory.whereIs(targetWords);
      if (typeof where === 'object') {
        const rel = wrap180(where.relativeDeg);
        const a = Math.abs(rel);
        const side = rel < 0 ? 'left' : 'right';
        if (a > 150) return { kind: 'turn_around', text: say('turn_around', name, null, side), relativeDeg: rel, steps: null, targetVisible: false };
        if (a > 60) return { kind: 'turn', text: say('turn', name, null, side), relativeDeg: rel, steps: null, targetVisible: false };
        return { kind: 'scan_remembered', text: say('scan_remembered', name, null, side), relativeDeg: rel, steps: null, targetVisible: false };
      }
      if (where === 'unknown_thing' && !cls) return null; // nothing we can name: the model's sentence is better than a guess
      return { kind: 'scan_unknown', text: say('scan_unknown', name, null, 'left'), relativeDeg: null, steps: null, targetVisible: false };
    },
    changed(prev, next) {
      if (!prev) return true;
      if (prev.kind !== next.kind) return true;
      if (prev.steps !== null && next.steps !== null) return Math.abs(prev.steps - next.steps) > 1;
      if (prev.relativeDeg !== null && next.relativeDeg !== null) return Math.abs(prev.relativeDeg - next.relativeDeg) > 25 && Math.sign(prev.relativeDeg) !== Math.sign(next.relativeDeg);
      return false;
    },
  };
}

/** Hand steering from the on-device hand pose against a target box (round 7). */
export type HandWord = 'left' | 'right' | 'higher' | 'lower' | 'forward' | 'grab' | null;

export const HAND_DEAD_ZONE = 0.08;

/**
 * Which way the hand must move to reach the target: image coordinates, origin top-left,
 * so a target *above* the hand has a smaller y ("Higher."). Larger correction first.
 */
export function handWord(hand: Pick<HandPoseEvent, 'tipX' | 'tipY'>, target: [number, number, number, number], insideFor: number): HandWord {
  const cx = target[0] + target[2] / 2;
  const cy = target[1] + target[3] / 2;
  const dx = cx - hand.tipX;
  const dy = cy - hand.tipY;
  const inside = hand.tipX >= target[0] && hand.tipX <= target[0] + target[2] && hand.tipY >= target[1] && hand.tipY <= target[1] + target[3];
  if (inside) return insideFor >= 2 ? 'grab' : 'forward';
  if (Math.abs(dx) >= Math.abs(dy)) {
    if (Math.abs(dx) > HAND_DEAD_ZONE) return dx > 0 ? 'right' : 'left';
    if (Math.abs(dy) > HAND_DEAD_ZONE) return dy > 0 ? 'lower' : 'higher';
  } else {
    if (Math.abs(dy) > HAND_DEAD_ZONE) return dy > 0 ? 'lower' : 'higher';
    if (Math.abs(dx) > HAND_DEAD_ZONE) return dx > 0 ? 'right' : 'left';
  }
  return 'forward';
}
