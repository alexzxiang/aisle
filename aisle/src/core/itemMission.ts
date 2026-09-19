/**
 * ItemMission — "find the bananas on the table" as a small navigator (round 8, Stream A).
 *
 * The living-room report of 2026-09-19 evening: the detector saw the bananas and the
 * table, and the app said "Turn slowly to scan the table surface ahead." twelve seconds
 * after the request, then raced through a planner's steps. What a blind person needs is
 * what a sighted friend would say, from wherever they stand:
 *
 *   bananas in view      → "Bananas at one o'clock. Turn a little right, then walk four steps."
 *   only the table       → "No bananas yet. Table ahead, walk forward six steps." … "At the
 *                           table. Tilt the camera down and pan slowly."
 *   table seen earlier   → "Table was on your left. Turn left slowly."
 *   nothing, ever        → "I think the table is in the kitchen. Is that right?" → yes →
 *                           "Turn slowly until I see a doorway." → "Doorway at eleven
 *                           o'clock, five steps. Walk to it." → through → look again
 *   within reach         → the hand loop (handGuide), then "Have you picked it up?"
 *
 * Geometry (guide.ts) supplies side, clock position and steps from the detector's boxes,
 * scene memory's bearings and Claude's `target.box` for things the detector has no class
 * for (keys, a doorway). This module owns the *policy*: which thing to chase now, what to
 * ask Claude to box, when to speak, and the words. It is a pure decision function over a
 * snapshot plus a thin runner that keeps the phase and the last line.
 *
 * Nothing here waits for a planner or a description: the first line is spoken on the
 * first tick after the request.
 */
import type { DetectionClass, HapticPattern } from './contracts';
import type { Guide, GuideInstruction, TargetBox } from './guide';
import { stepsWords } from './guide';
import { classForWords, spokenName } from './sceneMemory';
import { itemOfGoal } from './handGuide';
import { isAffirmative, isNegative, normalizeAnswer } from './yesNo';

export type MissionPhase = 'approach_item' | 'approach_place' | 'scan_place' | 'find_place' | 'find_door' | 'reach' | 'confirm';

export interface MissionGoal {
  goal: string;
  /** The thing to end up holding, in the user's words ("bananas", "my keys"). */
  item: string;
  itemCls: DetectionClass | null;
  /** Where the user said it is ("table", "counter"), when they said. */
  place: string | null;
  placeCls: DetectionClass | null;
}

/** The plan the UI shows: one line per phase group. */
export const MISSION_STEPS = [
  { instruction: 'Find the item.', lookFor: 'the item' },
  { instruction: 'Reach for the item.', lookFor: 'the item and the outstretched hand together' },
  { instruction: 'Have you picked it up? Say yes when you have it.', lookFor: 'user explicitly confirms holding the item' },
] as const;

export function missionStepIndex(phase: MissionPhase): number {
  if (phase === 'reach') return 1;
  if (phase === 'confirm') return 2;
  return 0;
}

const PLACE_RE = /\b(?:on|in|at|inside|from|by|near|next to|beside)\s+(?:the |my |a |an |this |that )?(.+?)$/i;
const ROOM_WORDS = /^(?:kitchen|living room|lounge|bedroom|bathroom|hallway|hall|office|dining room|garage|closet|pantry|room)$/i;

/**
 * "bananas on the table" → item bananas, place table. Rooms are not places the camera can
 * box ("remote in the living room" → item remote, no place). Fridge goals belong to the
 * fridge mission (they have an "open" stage); this returns null for them.
 */
export function parseMissionGoal(goal: string): MissionGoal | null {
  const g = goal.trim().replace(/[.!?]+$/, '');
  if (g.length === 0 || /\b(fridge|refrigerator|freezer)\b/i.test(g)) return null;
  const item = itemOfGoal(g);
  if (!item) return null;
  const placeWords = g.match(PLACE_RE)?.[1]?.trim().toLowerCase() ?? null;
  const place = placeWords && !ROOM_WORDS.test(placeWords) ? placeWords.replace(/^(?:the|my|a|an)\s+/, '') : null;
  return { goal: g, item, itemCls: classForWords(item), place, placeCls: place ? classForWords(place) : null };
}

/** Where a thing usually lives, for the educated guess when it is nowhere in sight. */
export function guessRoom(place: string | null, item: string): string | null {
  const w = `${place ?? ''} ${item}`.toLowerCase();
  if (/\b(table|counter|fridge|oven|stove|sink|microwave|toaster|dish|cup|mug|bowl|fork|knife|spoon|banana|apple|orange|bread|eggs?|milk|food|snack)/.test(w)) return 'kitchen';
  if (/\b(couch|sofa|tv|television|remote|coffee table)/.test(w)) return 'living room';
  if (/\b(bed|pillow|blanket|dresser|nightstand)/.test(w)) return 'bedroom';
  if (/\b(toilet|shower|bath|toothbrush|towel)/.test(w)) return 'bathroom';
  return null;
}

/** Clock-face position for a signed bearing (+ right): the O&M convention blind travellers use. */
export function clockWord(relativeDeg: number): string {
  const d = ((relativeDeg % 360) + 360) % 360;
  const hour = Math.round(d / 30) % 12;
  const words = ['twelve', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven'];
  return `${words[hour]} o'clock`;
}

function cap(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** The spoken name: the user's own word when it names the detected class ("bananas", not "banana"). */
export function missionName(words: string, cls: DetectionClass | null): string {
  const w = words.toLowerCase().replace(/^(?:the|my|a|an|some)\s+/, '').trim();
  if (cls && classForWords(w) === cls) return w;
  return cls ? spokenName(cls) : w;
}

export interface MissionSnapshot {
  now: number;
  /** guide.instructionFor(item) with the model's item box. */
  item: GuideInstruction | null;
  /** guide.instructionFor(place) with the model's place box; null without a place. */
  place: GuideInstruction | null;
  /** guide.instructionFor('doorway') with the model's doorway box. */
  door: GuideInstruction | null;
  /** The awareness loop's room label ("in a kitchen"), when it has one. */
  sceneLabel: string | null;
}

export interface MissionDecision {
  phase: MissionPhase;
  /** What to say now, or null to stay quiet. */
  text: string | null;
  /** A stable key: the same key twice is "nothing new" (repeat only on the slow clock). */
  key: string;
  /** What Claude should put a box around on the next ask. */
  boxTarget: string;
  haptic: HapticPattern | null;
  /** Geometry has nothing: the model's own sentence may be spoken. */
  modelMaySpeak: boolean;
  /** A question is open (the room question). */
  asking: 'room' | null;
}

export interface MissionState {
  phase: MissionPhase;
  /** The room question was asked in this room. */
  askedRoom: boolean;
  /** The user said the place is elsewhere; we are heading for a doorway. */
  throughDoorAt: number | null;
  scanSince: number | null;
}

export function initialMissionState(): MissionState {
  return { phase: 'find_place', askedRoom: false, throughDoorAt: null, scanSince: null };
}

const itemLine = (name: string, g: GuideInstruction): { text: string; key: string; haptic: HapticPattern | null } => {
  const n = cap(name);
  const steps = g.steps === null ? 'a few steps' : stepsWords(g.steps);
  const side = (g.relativeDeg ?? 0) < 0 ? 'left' : 'right';
  // Under fifteen degrees a clock hour rounds to twelve, which contradicts "turn a little".
  const clock = g.relativeDeg === null ? null : Math.abs(g.relativeDeg) < 15 ? `just to your ${side}` : `at ${clockWord(g.relativeDeg)}`;
  switch (g.kind) {
    case 'arrived': return { text: `${n} right in front of you. Reach out.`, key: 'arrived', haptic: 'CONFIRM' };
    case 'forward': return { text: `${n} ahead. Walk forward ${steps}.`, key: `forward:${g.steps}`, haptic: null };
    case 'sidestep': return { text: `Something in your way. Step ${side}, then walk forward.`, key: `sidestep:${side}`, haptic: 'STOP' };
    case 'turn_little': return { text: `${n} ${clock}. Turn ${side} a little, then walk ${steps}.`, key: `turn_little:${side}:${g.steps}`, haptic: 'TURN' };
    case 'turn': return { text: `${n} ${clock}. Turn ${side} to face it.`, key: `turn:${side}`, haptic: 'TURN' };
    case 'turn_around': return { text: `${n} behind you. Turn around slowly.`, key: 'turn_around', haptic: 'TURN' };
    case 'scan_remembered': return { text: `${n} was on your ${side}. Turn ${side} slowly.`, key: `remembered:${side}`, haptic: 'TURN' };
    case 'scan_unknown': return { text: `${n} not seen yet. Turn slowly all the way around.`, key: 'unknown', haptic: null };
  }
};

/**
 * One decision from one snapshot. Pure: the caller keeps `state` and applies `next`.
 * Phases move forward on evidence (a thing in view, an arrival) and back when the thing is
 * lost; the runner decides whether the returned text is news.
 */
export function decide(goal: MissionGoal, state: MissionState, s: MissionSnapshot): { decision: MissionDecision; next: MissionState } {
  const itemName = missionName(goal.item, goal.itemCls);
  const placeName = goal.place ? missionName(goal.place, goal.placeCls) : null;
  const next: MissionState = { ...state };
  const out = (phase: MissionPhase, text: string | null, key: string, boxTarget: string, haptic: HapticPattern | null = null, modelMaySpeak = false, asking: MissionDecision['asking'] = null): { decision: MissionDecision; next: MissionState } => {
    next.phase = phase;
    return { decision: { phase, text, key: `${phase}:${key}`, boxTarget, haptic, modelMaySpeak, asking }, next };
  };

  // Reach and confirm are owned by the caller (hand loop, the user's "yes"); hold them.
  if (state.phase === 'reach') return out('reach', null, 'hold', goal.item);
  if (state.phase === 'confirm') return out('confirm', null, 'hold', goal.item);

  // 1. The item itself is in view (detector or the model's box): chase it.
  if (s.item?.targetVisible) {
    if (s.item.kind === 'arrived') {
      next.scanSince = null;
      return out('reach', `${cap(itemName)} right in front of you. Reach out.`, 'arrived', goal.item, 'CONFIRM');
    }
    const l = itemLine(itemName, s.item);
    next.scanSince = null;
    return out('approach_item', l.text, l.key, goal.item, l.haptic);
  }

  // 2. Not in view, but the place it should be on is: walk there, then look across it.
  if (placeName && s.place) {
    if (s.place.targetVisible || state.phase === 'scan_place') {
      if (s.place.kind === 'arrived' || state.phase === 'scan_place') {
        const since = state.scanSince ?? s.now;
        next.scanSince = since;
        if (state.phase !== 'scan_place') {
          return out('scan_place', `At the ${placeName}. Tilt the camera down and pan slowly.`, 'start', goal.item, 'CONFIRM');
        }
        if (!s.place.targetVisible && s.now - since > 20_000) {
          // Scanned for a while and the place itself is gone: we drifted; find it again.
          next.scanSince = null;
          return out('approach_place', null, 'lost', goal.place ?? goal.item);
        }
        return out('scan_place', `Still looking for the ${itemName}. Pan slowly across the ${placeName}.`, 'looking', goal.item, null, true);
      }
      const l = itemLine(placeName, s.place);
      const prefix = l.text.startsWith('Something') ? '' : `No ${itemName} yet. `;
      return out('approach_place', `${prefix}${l.text}`, l.key, goal.item, l.haptic);
    }
    // The place is remembered from earlier: turn to it.
    if (s.place.kind === 'scan_remembered' || s.place.kind === 'turn' || s.place.kind === 'turn_around') {
      const l = itemLine(placeName, s.place);
      return out('find_place', l.text, l.key, goal.place ?? goal.item, l.haptic);
    }
  }

  // 3. Heading for a doorway because the user said the place is in another room.
  if (state.phase === 'find_door' || state.throughDoorAt !== null) {
    if (s.door?.targetVisible) {
      if (s.door.kind === 'arrived') {
        next.throughDoorAt = null;
        next.askedRoom = false;
        next.scanSince = null;
        return out('find_place', 'At the doorway. Walk through, then turn slowly.', 'through', goal.place ?? goal.item, 'CONFIRM');
      }
      const l = itemLine('doorway', s.door);
      return out('find_door', l.text, l.key, 'the doorway', l.haptic);
    }
    return out('find_door', 'Turn slowly until I see a doorway.', 'scan', 'the doorway', null, true);
  }

  // 4. Nothing in view and nothing remembered.
  if (placeName) {
    if (!state.askedRoom) {
      next.askedRoom = true;
      const room = guessRoom(goal.place, goal.item);
      const here = s.sceneLabel?.toLowerCase() ?? '';
      const elsewhere = room !== null && here.length > 0 && !here.includes(room);
      const q = elsewhere ? `I think the ${placeName} is in the ${room}. Is that right?` : `I do not see a ${placeName} here. Is it in another room?`;
      return out('find_place', q, 'ask_room', goal.place ?? goal.item, null, false, 'room');
    }
    return out('find_place', `Turn slowly all the way around so I can find the ${placeName}.`, 'scan', goal.place ?? goal.item, null, true);
  }
  if (s.item && !s.item.targetVisible && s.item.kind !== 'scan_unknown') {
    const l = itemLine(itemName, s.item);
    return out('approach_item', l.text, l.key, goal.item, l.haptic);
  }
  return out('approach_item', `${cap(itemName)} not seen yet. Turn slowly all the way around.`, 'scan', goal.item, null, true);
}

/** The user's answer to "is it in another room?" — true when consumed. */
export function answerRoom(state: MissionState, transcript: string, now: number): { consumed: boolean; next: MissionState; text: string | null } {
  const t = normalizeAnswer(transcript);
  const here = isNegative(t) || /\b(?:this|same) room\b/.test(t) || /\bin here\b/.test(t);
  const elsewhere = !here && (isAffirmative(t) || /\b(?:another|other|different|next) room\b/.test(t) || /\b(?:kitchen|living room|bedroom|bathroom|hallway)\b/.test(t));
  if (elsewhere) return { consumed: true, next: { ...state, phase: 'find_door', throughDoorAt: now }, text: 'Turn slowly until I see a doorway.' };
  if (here) return { consumed: true, next: { ...state, phase: 'find_place', askedRoom: true }, text: 'Turn slowly all the way around so I can find it.' };
  return { consumed: false, next: state, text: null };
}

export interface MissionRunnerDeps {
  guide: Pick<Guide, 'instructionFor'>;
  sceneLabel?: () => string | null;
  now?: () => number;
}

/** Between two different lines. */
export const MISSION_CHANGE_FLOOR_MS = 2000;
/** The same line again while it still applies. */
export const MISSION_REPEAT_MS = 4000;
/** Scan / "still looking" lines repeat on a slower clock. */
export const MISSION_SLOW_REPEAT_MS = 8000;
/** A model box older than this no longer steers. */
export const MISSION_MODEL_BOX_MS = 3500;

export interface MissionRunner {
  readonly goal: MissionGoal;
  phase(): MissionPhase;
  stepIndex(): number;
  /** One tick: returns the line to speak now (or null) and the haptic to play, after updating the phase. */
  tick(): { text: string | null; haptic: HapticPattern | null; modelMaySpeak: boolean; decision: MissionDecision };
  /** What the next Claude ask should box, and the mission facts for its userText. */
  boxTarget(): string;
  userText(): string;
  /** Claude's box for `words` (the thing it was asked to box). */
  onModelBox(words: string, box: [number, number, number, number], at: number): void;
  /** The user answered the open room question. True when consumed. */
  intercept(transcript: string): { consumed: boolean; text: string | null };
  /** Say the current line again on the next tick ("repeat", a reminder). */
  repeat(): void;
  /** The hand loop finished touching the item. */
  reached(): void;
  /** Back to looking (hand loop gave up, or the user said "no"). */
  lost(): void;
  askingRoom(): boolean;
}

export function createMissionRunner(goal: MissionGoal, deps: MissionRunnerDeps): MissionRunner {
  const now = deps.now ?? Date.now;
  let state: MissionState = initialMissionState();
  let asking: 'room' | null = null;
  let lastKey: string | null = null;
  let lastSpokenAt = -Infinity;
  const boxes = new Map<string, TargetBox>();

  const modelBox = (words: string): TargetBox | null => {
    const b = boxes.get(words.toLowerCase());
    return b && now() - b.at <= MISSION_MODEL_BOX_MS ? b : null;
  };

  const snapshot = (): MissionSnapshot => ({
    now: now(),
    item: deps.guide.instructionFor(goal.item, modelBox(goal.item)),
    place: goal.place ? deps.guide.instructionFor(goal.place, modelBox(goal.place)) : null,
    door: deps.guide.instructionFor('doorway', modelBox('the doorway')),
    sceneLabel: deps.sceneLabel?.() ?? null,
  });

  return {
    goal,
    phase: () => state.phase,
    stepIndex: () => missionStepIndex(state.phase),
    tick() {
      const t = now();
      const { decision, next } = decide(goal, state, snapshot());
      state = next;
      if (decision.asking) asking = decision.asking;
      if (decision.text === null) return { text: null, haptic: null, modelMaySpeak: decision.modelMaySpeak, decision };
      const slow = /:(?:scan|looking|unknown|ask_room)$/.test(decision.key);
      const news = decision.key !== lastKey;
      const floor = news ? MISSION_CHANGE_FLOOR_MS : slow ? MISSION_SLOW_REPEAT_MS : MISSION_REPEAT_MS;
      if (t - lastSpokenAt < floor && !(news && decision.haptic === 'CONFIRM')) {
        return { text: null, haptic: null, modelMaySpeak: false, decision };
      }
      lastKey = decision.key;
      lastSpokenAt = t;
      return { text: decision.text, haptic: decision.haptic, modelMaySpeak: decision.modelMaySpeak, decision };
    },
    boxTarget() {
      const { decision } = decide(goal, state, snapshot());
      return decision.boxTarget;
    },
    userText() {
      const target = this.boxTarget();
      const place = goal.place ? ` The user says it is on the ${goal.place}.` : '';
      return `Goal: ${goal.goal}. Phase: ${state.phase}.${place} Look for: ${target}. Return the box of ${target} in target.box when visible, else null. Local geometry owns walking words; keep speech to what you see.`;
    },
    onModelBox(words, box, at) {
      boxes.set(words.toLowerCase(), { box, at });
    },
    intercept(transcript) {
      if (asking !== 'room') return { consumed: false, text: null };
      const r = answerRoom(state, transcript, now());
      if (!r.consumed) return { consumed: false, text: null };
      asking = null;
      state = r.next;
      lastKey = null;
      lastSpokenAt = now();
      return { consumed: true, text: r.text };
    },
    repeat() {
      lastKey = null;
      lastSpokenAt = -Infinity;
    },
    reached() {
      state = { ...state, phase: 'confirm' };
      lastKey = null;
    },
    lost() {
      state = { ...state, phase: 'approach_item', scanSince: null };
      lastKey = null;
      lastSpokenAt = -Infinity;
    },
    askingRoom: () => asking === 'room',
  };
}
