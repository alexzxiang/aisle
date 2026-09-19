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
import { itemOfGoal, normalizeGoal } from './handGuide';
import { isAffirmative, isNegative, normalizeAnswer } from './yesNo';
import { fitWords } from './phrases';
import type { SearchExplorer } from './searchExplorer';
import { checkedLine, hypothesisLine, rankHypotheses, spoken, statedPlaceIn, type PlaceEvidence, type PlaceHypothesis } from './hypotheses';

export type MissionPhase = 'approach_item' | 'approach_place' | 'open_place' | 'scan_place' | 'find_place' | 'find_door' | 'reach' | 'confirm';

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
  const g = normalizeGoal(goal.trim().replace(/[.!?]+$/, ''));
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

/** "bananas are", "the milk is": the user's own word decides. */
export function isPlural(name: string): boolean {
  const w = name.trim().toLowerCase();
  return /s$/.test(w) && !/(?:ss|us|is)$/.test(w);
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
  /** guide.instructionFor(working place) with the model's box for it; null without a working place. */
  place: GuideInstruction | null;
  /** Round 11: what the phone can act on for each candidate place (the stated one and the usual ones). */
  candidates?: ReadonlyArray<{ place: string; evidence: PlaceEvidence }>;
  /** Round 14: the explorer is walking somewhere or waiting for consent — hold the guesses. */
  exploring?: boolean;
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
  /** A question is open: the room question, or "open it, then say open" at a container. */
  asking: 'room' | 'open' | null;
  /** Geometry has nothing to steer by: the search explorer may take this tick instead. */
  explore?: boolean;
}

export interface MissionState {
  phase: MissionPhase;
  /** The room question was asked in this room. */
  askedRoom: boolean;
  /** The user said the place is elsewhere; we are heading for a doorway. */
  throughDoorAt: number | null;
  scanSince: number | null;
  /** Round 9: the last time the chased thing was in view, how far it was and where in the frame — for "you passed it". */
  lastSeen: { what: 'item' | 'place'; at: number; steps: number | null; bottom: number; relativeDeg: number | null } | null;
  /** Round 9: the previous forward line's step count, for "keep going, two more steps". */
  lastForwardSteps: number | null;
  /** When the walk line was last a new one (a person who stalls hears "keep walking"). */
  forwardSince: number | null;
  /** Round 11: the place being tried now — the stated one, or the best hypothesis. */
  working: string | null;
  /** Places scanned without the item, in order. */
  tried: string[];
  /** The reason for the current working place has been said ("It is usually on the counter."). */
  reasoned: boolean;
  /** At a container: the person was asked to open it; and did. */
  openAsked: boolean;
  opened: boolean;
}

export function initialMissionState(place: string | null = null): MissionState {
  return { phase: 'find_place', askedRoom: false, throughDoorAt: null, scanSince: null, lastSeen: null, lastForwardSteps: null, forwardSince: null, working: place, tried: [], reasoned: place !== null, openAsked: false, opened: false };
}
/** Scanning a place this long without the item rules it out. */
export const MISSION_SCAN_GIVE_UP_MS = 15_000;
/** Looking around for the stated place this long before asking whether it is in another room. */
export const MISSION_ASK_ROOM_AFTER_MS = 12_000;
/** A usual place that is nowhere in sight is looked for this long before the next guess. */
export const MISSION_UNSEEN_GUESS_MS = 8000;

/** A close thing that drops out of view within this long was walked past, not lost. */
export const MISSION_OVERSHOOT_MS = 4000;
/** "Keep walking" when the same forward line has stood this long without progress. */
export const MISSION_STALL_MS = 7000;

/** One walking line for a thing in view or remembered (also used by the search explorer for landmarks). */
export const itemLine = (name: string, g: GuideInstruction): { text: string; key: string; haptic: HapticPattern | null } => {
  const n = cap(name);
  const steps = g.steps === null ? 'a few steps' : stepsWords(g.steps);
  const side = (g.relativeDeg ?? 0) < 0 ? 'left' : 'right';
  // Under fifteen degrees a clock hour rounds to twelve, which contradicts "turn a little".
  // "slightly left" (two words) keeps the longest line at twelve words for a two-word name.
  const clock = g.relativeDeg === null ? null : Math.abs(g.relativeDeg) < 15 ? `slightly ${side}` : `at ${clockWord(g.relativeDeg)}`;
  const were = isPlural(name) ? 'were' : 'was';
  const line = (text: string, key: string, haptic: HapticPattern | null): { text: string; key: string; haptic: HapticPattern | null } => ({ text: fitWords(text), key, haptic });
  switch (g.kind) {
    case 'arrived': return line(`${n} right in front of you. Reach out.`, 'arrived', 'CONFIRM');
    case 'forward': return line(`${n} ahead. Walk forward ${steps}.`, `forward:${g.steps}`, null);
    case 'sidestep': return line(`Something in your way. Step ${side}, then walk forward.`, `sidestep:${side}`, 'STOP');
    case 'turn_little': return line(`${n} ${clock}. Turn ${side} a little, then walk ${steps}.`, `turn_little:${side}:${g.steps}`, 'TURN');
    case 'turn': return line(`${n} ${clock}. Turn ${side} to face it.`, `turn:${side}`, 'TURN');
    case 'turn_around': return line(`${n} behind you. Turn around slowly.`, 'turn_around', 'TURN');
    case 'scan_remembered': return line(`${n} ${were} on your ${side}. Turn ${side} slowly.`, `remembered:${side}`, 'TURN');
    case 'scan_unknown': return line(`${n} not seen yet. Turn slowly all the way around.`, 'unknown', null);
  }
};

/**
 * One decision from one snapshot. Pure: the caller keeps `state` and applies `next`.
 * Phases move forward on evidence (a thing in view, an arrival) and back when the thing is
 * lost; the runner decides whether the returned text is news.
 */
export function decide(goal: MissionGoal, state: MissionState, s: MissionSnapshot): { decision: MissionDecision; next: MissionState } {
  const itemName = missionName(goal.item, goal.itemCls);
  const plural = isPlural(itemName);
  const working = state.working;
  const placeName = working ? spoken(missionName(working, classForWords(working))) : null;
  const next: MissionState = { ...state, tried: [...state.tried] };
  const out = (phase: MissionPhase, text: string | null, key: string, boxTarget: string, haptic: HapticPattern | null = null, modelMaySpeak = false, asking: MissionDecision['asking'] = null, explore = false): { decision: MissionDecision; next: MissionState } => {
    next.phase = phase;
    return { decision: { phase, text, key: `${phase}:${key}`, boxTarget, haptic, modelMaySpeak, asking, explore }, next };
  };
  /** Rule the working place out and pick the next hypothesis; says why in one line. */
  const nextHypothesis = (): { decision: MissionDecision; next: MissionState } | null => {
    const previous = next.working;
    if (previous) { next.tried.push(previous); next.working = null; }
    next.scanSince = null; next.openAsked = false; next.opened = false; next.reasoned = false; next.askedRoom = false;
    const evidence = (place: string): PlaceEvidence => s.candidates?.find((c) => c.place === place)?.evidence ?? 'unseen';
    const ranked = rankHypotheses(goal.item, goal.place, next.tried, evidence);
    const pick: PlaceHypothesis | undefined = ranked[0];
    if (!pick) return null;
    next.working = pick.place;
    next.reasoned = true;
    return out('find_place', hypothesisLine(itemName, plural, pick, previous === null && next.tried.length === 0, previous), `hypothesis:${pick.place}`, pick.place, null);
  };

  // Reach and confirm are owned by the caller (hand loop, the user's "yes"); hold them.
  if (state.phase === 'reach') return out('reach', null, 'hold', goal.item);
  if (state.phase === 'confirm') return out('confirm', null, 'hold', goal.item);

  // 1. The item itself is in view (detector or the model's box): chase it.
  if (s.item?.targetVisible) {
    next.lastSeen = { what: 'item', at: s.now, steps: s.item.steps, bottom: s.item.box ? s.item.box.box[1] + s.item.box.box[3] : 0, relativeDeg: s.item.relativeDeg };
    if (s.item.kind === 'arrived') {
      next.scanSince = null;
      next.lastForwardSteps = null;
      return out('reach', `${cap(itemName)} right in front of you. Reach out.`, 'arrived', goal.item, 'CONFIRM');
    }
    const l = itemLine(itemName, s.item);
    next.scanSince = null;
    // Push: the same walk, closer than last time — "keep going"; the same walk, no progress for a while — "keep walking".
    if (s.item.kind === 'forward' && s.item.steps !== null) {
      const prev = state.lastForwardSteps;
      next.lastForwardSteps = s.item.steps;
      if (prev !== null && s.item.steps < prev) {
        next.forwardSince = s.now;
        return out('approach_item', `Keep going. ${cap(stepsWords(s.item.steps))} more.`, `forward:${s.item.steps}`, goal.item, null);
      }
      if (prev !== null && s.item.steps === prev) {
        const since = state.forwardSince ?? s.now;
        next.forwardSince = since;
        if (s.now - since >= MISSION_STALL_MS) {
          next.forwardSince = s.now;
          return out('approach_item', `Keep walking forward. ${cap(itemName)} ${isPlural(itemName) ? 'are' : 'is'} ${stepsWords(s.item.steps)} ahead.`, `stall:${s.item.steps}`, goal.item, null);
        }
      } else next.forwardSince = s.now;
    } else next.lastForwardSteps = null;
    return out('approach_item', l.text, l.key, goal.item, l.haptic);
  }
  // Pull back: it was close a moment ago and is gone from the frame — behind or below the camera.
  const seen = state.lastSeen;
  if (seen && seen.what === 'item' && s.now - seen.at <= MISSION_OVERSHOOT_MS && seen.steps !== null && seen.steps <= 2) {
    const behind = s.item && !s.item.targetVisible && s.item.relativeDeg !== null && Math.abs(s.item.relativeDeg) > 100;
    if (behind || seen.bottom >= 0.85) {
      next.lastSeen = null;
      next.lastForwardSteps = null;
      const side = (seen.relativeDeg ?? 0) < 0 ? 'left' : 'right';
      return out('approach_item', `Stop. You passed the ${itemName}. Turn around, ${isPlural(itemName) ? 'they are' : 'it is'} on your ${side}.`, 'overshoot', goal.item, 'STOP');
    }
  }
  if (state.phase === 'approach_item' && !s.item?.targetVisible) next.lastForwardSteps = null;

  // 1a. The item itself was seen earlier: its bearing beats any guess.
  if (!working && s.item && !s.item.targetVisible && s.item.kind !== 'scan_unknown') {
    const l = itemLine(itemName, s.item);
    return out('approach_item', l.text, l.key, goal.item, l.haptic);
  }
  // 1b. No working place yet (nothing stated, or the stated one was ruled out): reason about where it usually is.
  if (!working) {
    const picked = nextHypothesis();
    if (picked) return picked;
    if (state.tried.length > 0) {
      return out('find_place', `${checkedLine(state.tried)} Where else?`, 'exhausted', goal.item, null, false, null, true);
    }
  }

  // 2. Not in view, but the place it should be on is: walk there, then look across it.
  if (working && placeName && s.place) {
    const opens = rankHypotheses(goal.item, goal.place, [], () => 'unseen').find((h) => h.place === working)?.opens ?? /^(?:fridge|freezer|cabinet|drawer|wardrobe|dishwasher|microwave|oven|box)$/.test(working);
    if (s.place.targetVisible) next.lastSeen = { what: 'place', at: s.now, steps: s.place.steps, bottom: s.place.box ? s.place.box.box[1] + s.place.box.box[3] : 0, relativeDeg: s.place.relativeDeg };
    else if (seen && seen.what === 'place' && state.phase === 'approach_place' && s.now - seen.at <= MISSION_OVERSHOOT_MS && seen.steps !== null && seen.steps <= 2 && seen.bottom >= 0.85) {
      next.lastSeen = null;
      return out('approach_place', `Stop. You walked past the ${placeName}. Turn around slowly.`, 'overshoot', working, 'STOP');
    }
    if (s.place.targetVisible || state.phase === 'scan_place' || state.phase === 'open_place') {
      if (s.place.kind === 'arrived' || state.phase === 'scan_place' || state.phase === 'open_place') {
        // A container: the item is inside; it has to be opened before anything can be seen.
        if (opens && !state.opened) {
          if (!state.openAsked) {
            next.openAsked = true;
            return out('open_place', `The ${itemName} may be inside the ${placeName}. Open it, then say open.`, 'open', working, 'CONFIRM', false, 'open');
          }
          return out('open_place', `Open the ${placeName}, then say open.`, 'open-wait', working, null, false, 'open');
        }
        const since = state.scanSince ?? s.now;
        next.scanSince = since;
        if (state.phase !== 'scan_place') {
          const line = opens ? `Point the camera inside the ${placeName} and pan slowly.` : `At the ${placeName}. Tilt the camera down and pan slowly.`;
          return out('scan_place', line, 'start', goal.item, 'CONFIRM');
        }
        if (s.now - since > MISSION_SCAN_GIVE_UP_MS) {
          // Scanned long enough without the item: this place is ruled out; reason about the next.
          const picked = nextHypothesis();
          if (picked) return picked;
          next.working = null;
          return out('find_place', `${checkedLine(next.tried)} Where else?`, 'exhausted', goal.item, null, false, null, true);
        }
        if (!s.place.targetVisible && s.now - since > 8000) {
          // The place itself is gone from view while scanning: we drifted; find it again.
          next.scanSince = null;
          return out('approach_place', null, 'lost', working);
        }
        return out('scan_place', `Still looking for the ${itemName}. Pan slowly across the ${placeName}.`, 'looking', goal.item, null, true);
      }
      // The reason was said once (the hypothesis line); the walk itself is plain and short.
      const l = itemLine(placeName, s.place);
      return out('approach_place', l.text, l.key, goal.item, l.haptic);
    }
    // The place is remembered from earlier: turn to it.
    if (s.place.kind === 'scan_remembered' || s.place.kind === 'turn' || s.place.kind === 'turn_around') {
      const l = itemLine(placeName, s.place);
      return out('find_place', l.text, l.key, working, l.haptic);
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

  // 4. Nothing in view and nothing remembered for the working place.
  if (working && placeName) {
    // A usual place (not stated) that is nowhere in sight: look for it briefly, then move on to the next guess.
    const usual = goal.place === null || working.toLowerCase() !== goal.place.toLowerCase();
    if (usual) {
      // A guess that is nowhere in sight gets a short look (the explorer's poses run meanwhile),
      // then the next guess; the stated place, below, gets the full search.
      const since = state.scanSince ?? s.now;
      next.scanSince = since;
      if (!s.exploring && s.now - since > MISSION_UNSEEN_GUESS_MS) {
        const picked = nextHypothesis();
        if (picked) return picked;
        next.working = null;
        return out('find_place', `${checkedLine(next.tried)} Where else?`, 'exhausted', goal.item, null, false, null, true);
      }
      return out('find_place', `Turn slowly all the way around so I can find the ${placeName}.`, 'scan', working, null, true, null, true);
    }
    // The stated place: look around first (the explorer's poses, or a full turn); only when that
    // finds nothing is the person asked whether it is in another room.
    const since = state.scanSince ?? s.now;
    next.scanSince = since;
    if (!s.exploring && !state.askedRoom && s.now - since >= MISSION_ASK_ROOM_AFTER_MS) {
      next.askedRoom = true;
      const room = guessRoom(working, goal.item);
      const here = s.sceneLabel?.toLowerCase() ?? '';
      const elsewhere = room !== null && here.length > 0 && !here.includes(room);
      const q = elsewhere ? `I think the ${placeName} is in the ${room}. Is that right?` : `I do not see a ${placeName} here. Is it in another room?`;
      return out('find_place', q, 'ask_room', working, null, false, 'room');
    }
    return out('find_place', `Turn slowly all the way around so I can find the ${placeName}.`, 'scan', working, null, true, null, true);
  }
  if (s.item && !s.item.targetVisible && s.item.kind !== 'scan_unknown') {
    const l = itemLine(itemName, s.item);
    return out('approach_item', l.text, l.key, goal.item, l.haptic);
  }
  return out('approach_item', `${cap(itemName)} not seen yet. Turn slowly all the way around.`, 'scan', goal.item, null, true, null, true);
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

/** "explore", "keep exploring", "look somewhere else", "next aisle", "another room", "move on" → leave this spot. */
export function exploreRequest(transcript: string): { asked: boolean; prefer: 'aisle' | 'room' | null } {
  const t = normalizeAnswer(transcript);
  if (/\b(?:next|another|other|different) aisle\b/.test(t) || /\baisles?\b/.test(t) && /\b(?:try|check|look|search|move|explore)\b/.test(t)) return { asked: true, prefer: 'aisle' };
  if (/\b(?:next|another|other|different) room\b/.test(t) || /\brooms?\b/.test(t) && /\b(?:try|check|look|search|move|explore)\b/.test(t)) return { asked: true, prefer: 'room' };
  if (/^(?:explore|keep exploring|explore more|look around more|look somewhere else|search somewhere else|try somewhere else|move on|keep moving|let'?s move|somewhere else|elsewhere|look elsewhere|search elsewhere)$/.test(t)) return { asked: true, prefer: null };
  if (/^(?:it'?s|its|it is) not here$/.test(t) || /^not here$/.test(t)) return { asked: true, prefer: null };
  return { asked: false, prefer: null };
}

/** "open" / "it's open" / "done" at a container: the inside can be scanned now. */
export function answerOpen(state: MissionState, transcript: string): { consumed: boolean; next: MissionState; text: string | null } {
  const t = normalizeAnswer(transcript);
  if (/^(?:open|it'?s open|its open|opened|i opened it|done|ok(?:ay)?|yes|it is open)$/.test(t) || isAffirmative(t)) {
    // Stays in open_place so the next tick opens the scan with "Point the camera inside…".
    return { consumed: true, next: { ...state, opened: true, phase: 'open_place', scanSince: null }, text: null };
  }
  if (isNegative(t) || /\b(?:can'?t|cannot|stuck|locked|won'?t open)\b/.test(t)) {
    return { consumed: true, next: { ...state, tried: [...state.tried, ...(state.working ? [state.working] : [])], working: null, openAsked: false, opened: false, phase: 'find_place' }, text: 'Okay. Let me think of somewhere else.' };
  }
  return { consumed: false, next: state, text: null };
}

export interface MissionRunnerDeps {
  search?: SearchExplorer;
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
/** A detector track that drops out for less than this still counts as in view (a far banana flickers frame to frame). */
export const MISSION_STICKY_MS = 1500;
/** Turning toward a remembered place gets this long before the search explorer takes over. */
export const MISSION_MEMORY_MS = 12_000;

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
  /** Round 14: the person asked to explore — leave this spot now. Returns the line to say. */
  explore(prefer?: 'aisle' | 'room' | null): string | null;
  /** The freshest box for the item (model's or the detector's), for the hand loop. */
  itemBox(): TargetBox | null;
  /** The hand loop finished touching the item. */
  reached(): void;
  /** Back to looking (hand loop gave up, or the user said "no"). */
  lost(): void;
  askingRoom(): boolean;
}

export function createMissionRunner(goal: MissionGoal, deps: MissionRunnerDeps): MissionRunner {
  const now = deps.now ?? Date.now;
  let state: MissionState = initialMissionState(goal.place);
  let asking: 'room' | 'open' | null = null;
  let lastKey: string | null = null;
  let lastSpokenAt = -Infinity;
  let searchTarget: string | null = null;
  let memorySince: number | null = null;
  const boxes = new Map<string, TargetBox>();

  const sticky = new Map<string, TargetBox>();

  const modelBox = (words: string): TargetBox | null => {
    const b = boxes.get(words.toLowerCase());
    return b && now() - b.at <= (deps.search ? 6000 : MISSION_MODEL_BOX_MS) ? b : null;
  };
  /** The freshest box for a thing: the model's, else the last one the detector had inside the sticky window. */
  const look = (words: string): GuideInstruction | null => {
    const key = words.toLowerCase();
    const t = now();
    const s = sticky.get(key);
    const fallback = modelBox(key) ?? (s && t - s.at <= MISSION_STICKY_MS ? s : null);
    // The detector's box steers the approach (a banana at fifteen frames a second beats a
    // three-second round trip); the reach itself waits for Claude to confirm the food (guidedTask).
    const g = deps.guide.instructionFor(words, fallback, deps.search ? { maxAgeMs: 6000 } : undefined);
    if (g?.targetVisible && g.box) sticky.set(key, g.box);
    return g;
  };

  const evidenceOf = (g: GuideInstruction | null): PlaceEvidence =>
    g?.targetVisible ? 'visible' : g && (g.kind === 'scan_remembered' || g.kind === 'turn' || g.kind === 'turn_around') ? 'remembered' : 'unseen';
  const snapshot = (): MissionSnapshot => {
    const candidates = state.working ? undefined
      : rankHypotheses(goal.item, goal.place, state.tried, () => 'unseen').slice(0, 4).map((h) => ({ place: h.place, evidence: evidenceOf(look(h.place)) }));
    return {
      now: now(),
      item: look(goal.item),
      place: state.working ? look(state.working) : null,
      door: look('the doorway'),
      sceneLabel: deps.sceneLabel?.() ?? null,
      exploring: deps.search?.busy() ?? false,
      ...(candidates ? { candidates } : {}),
    };
  };

  return {
    goal,
    phase: () => state.phase,
    stepIndex: () => missionStepIndex(state.phase),
    tick() {
      const t = now();
      const snap = snapshot();
      // Scene memory first: a remembered bearing for the place is an immediate, free answer
      // ("Table was on your left. Turn left slowly."). If turning there does not bring it into
      // view within MISSION_MEMORY_MS, the explorer takes over.
      const remembered = !snap.item?.targetVisible && snap.place !== null && !snap.place.targetVisible
        && (snap.place.kind === 'scan_remembered' || snap.place.kind === 'turn' || snap.place.kind === 'turn_around');
      if (remembered) memorySince = memorySince ?? t;
      else memorySince = null;
      const memoryFresh = remembered && memorySince !== null && t - memorySince <= MISSION_MEMORY_MS;
      // Reasoning first (the stated place, then where such things usually are, with what the
      // phone can act on); the explorer takes the tick only when geometry has nothing to say.
      const reasoned = decide(goal, state, snap);
      const explorerBusy = deps.search?.busy() ?? false;
      const wantsExplore = reasoned.decision.explore === true || explorerBusy || (state.phase === 'scan_place' && !snap.item?.targetVisible && reasoned.decision.key.endsWith(':looking'));
      if (deps.search && !memoryFresh && wantsExplore && state.phase !== 'reach' && state.phase !== 'confirm' && !snap.item?.targetVisible) {
        const scanningSurface = state.phase === 'scan_place' && !explorerBusy;
        const exploration = deps.search.tick(scanningSurface ? goal.item : state.working ?? goal.item, null, { surface: scanningSurface });
        if (exploration) {
          searchTarget = exploration.target;
          asking = null;
          state = { ...reasoned.next, phase: scanningSurface ? 'scan_place' : 'find_place' };
          const haptic = exploration.haptic ?? null;
          if (exploration.text) {
            const decision: MissionDecision = { phase: state.phase, text: exploration.text, key: `search:${exploration.phase}`, boxTarget: exploration.target, haptic, modelMaySpeak: false, asking: null };
            lastKey = decision.key; lastSpokenAt = t;
            return { text: fitWords(exploration.text), haptic, modelMaySpeak: false, decision };
          }
          // The explorer is quiet this tick: the navigator's own reasoning line (a new guess) may go out.
          if (!reasoned.decision.key.includes(':hypothesis:') && !reasoned.decision.key.endsWith(':exhausted')) {
            return { text: null, haptic: null, modelMaySpeak: false, decision: { ...reasoned.decision, text: null } };
          }
        }
      }
      searchTarget = null;
      const { decision, next } = reasoned;
      state = next;
      if (decision.asking) asking = decision.asking;
      if (decision.text === null) return { text: null, haptic: null, modelMaySpeak: decision.modelMaySpeak, decision };
      const slow = /:(?:scan|looking|unknown|ask_room|exhausted|open-wait)$/.test(decision.key);
      const news = decision.key !== lastKey;
      const floor = news ? MISSION_CHANGE_FLOOR_MS : slow ? MISSION_SLOW_REPEAT_MS : MISSION_REPEAT_MS;
      if (t - lastSpokenAt < floor && !(news && decision.haptic === 'CONFIRM')) {
        return { text: null, haptic: null, modelMaySpeak: false, decision };
      }
      lastKey = decision.key;
      lastSpokenAt = t;
      return { text: fitWords(decision.text), haptic: decision.haptic, modelMaySpeak: decision.modelMaySpeak, decision };
    },
    boxTarget() {
      if (searchTarget) return deps.search?.target() ?? searchTarget;
      const { decision } = decide(goal, state, snapshot());
      return decision.boxTarget;
    },
    userText() {
      const target = this.boxTarget();
      const place = goal.place ? ` The user says it is on the ${goal.place}.` : '';
      const working = state.working && state.working !== goal.place ? ` Hypothesis: ${goal.item} usually ${/^(?:fridge|freezer|cabinet|drawer|wardrobe)$/.test(state.working) ? 'in' : 'on'} the ${spoken(state.working)}.` : '';
      const checked = state.tried.length ? ` Checked without finding it: ${state.tried.map(spoken).join(', ')}.` : '';
      return `Goal: ${goal.goal}. Phase: ${state.phase}.${place}${working}${checked} Look for: ${target}. Return the box of ${target} in target.box when visible, else null. Also box the ${goal.item} in search.item if you can see it anywhere. Local geometry owns walking words; keep speech to what you see.`;
    },
    onModelBox(words, box, at) {
      boxes.set(words.toLowerCase(), { box, at });
    },
    intercept(transcript) {
      const t = transcript.trim();
      // "explore" / "look somewhere else" / "next aisle" / "another room": leave this spot now.
      const ex = exploreRequest(t);
      if (ex.asked && state.phase !== 'reach' && state.phase !== 'confirm') {
        return { consumed: true, text: this.explore(ex.prefer) };
      }
      // "try the cabinet" / "it's on the table": the person's word beats every guess.
      const redirect = statedPlaceIn(t);
      if (redirect && state.phase !== 'reach' && state.phase !== 'confirm') {
        state = { ...state, working: redirect, tried: state.tried.filter((p) => p !== redirect), reasoned: true, openAsked: false, opened: false, scanSince: null, askedRoom: false, phase: 'find_place' };
        asking = null;
        lastKey = null;
        lastSpokenAt = now();
        deps.search?.restart();
        return { consumed: true, text: `Okay. Trying the ${spoken(redirect)}.` };
      }
      if (/^(?:where have (?:we|you) (?:looked|checked|been)|what have (?:we|you) checked|what did you check)\??$/i.test(t)) {
        return { consumed: true, text: checkedLine(state.tried) };
      }
      const searchAnswer = deps.search?.intercept(t);
      if (searchAnswer?.consumed) return searchAnswer;
      if (asking === 'open') {
        const r = answerOpen(state, t);
        if (!r.consumed) return { consumed: false, text: null };
        asking = null;
        state = r.next;
        lastKey = null;
        lastSpokenAt = r.text ? now() : -Infinity;
        return { consumed: true, text: r.text };
      }
      if (asking !== 'room') return { consumed: false, text: null };
      const r = answerRoom(state, t, now());
      if (!r.consumed) return { consumed: false, text: null };
      asking = null;
      state = r.next;
      lastKey = null;
      lastSpokenAt = now();
      return { consumed: true, text: r.text };
    },
    repeat() {
      deps.search?.repeat();
      lastKey = null;
      lastSpokenAt = -Infinity;
    },
    explore(prefer = null) {
      // The working place is done with; the next guess waits until the explorer has moved us.
      if (state.working) state = { ...state, tried: state.tried.includes(state.working) ? state.tried : [...state.tried, state.working], working: null, scanSince: null, openAsked: false, opened: false, askedRoom: false, phase: 'find_place' };
      asking = null;
      lastKey = null;
      lastSpokenAt = now();
      if (!deps.search) return 'Okay. Turn slowly all the way around so I can look.';
      const d = deps.search.exploreNow(prefer);
      searchTarget = d.target;
      return d.text ?? 'Okay. Exploring.';
    },
    itemBox() {
      const key = goal.item.toLowerCase();
      const s = sticky.get(key);
      return modelBox(key) ?? (s && now() - s.at <= MISSION_STICKY_MS ? s : null);
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
    askingRoom: () => asking === 'room' || asking === 'open',
  };
}
