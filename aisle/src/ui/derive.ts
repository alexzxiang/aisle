/**
 * Pure screen state: bus events + mode -> the mode word, the one hero
 * instruction, and the three perception sentences.
 *
 * Everything here is a pure function of (facts, mode, now), so the screens hold
 * no logic and the wording is testable without a renderer. Nothing in this file
 * speaks, buzzes or touches a service.
 */
import type {
  AppEvent,
  AppMode,
  Direction,
  DistanceClass,
  Side,
  SignalState,
  VehiclesSeen,
} from '../core/contracts';

export type InstructionKind =
  | 'leg' | 'crossing' | 'signal' | 'vehicle' | 'scan' | 'obstacle'
  | 'aisle' | 'transition' | 'checkout' | 'route' | 'error';

export interface Instruction {
  text: string;
  kind: InstructionKind;
  ts: number;
  /**
   * The mode the app was in when this instruction was issued (the store has
   * already applied the event's transition when the UI reduces it, because the
   * bus runs typed listeners before `onAny`). `null` = unknown, e.g. a seed
   * replayed from bus history. A fresh instruction from another mode is stale
   * and never shown: "Crossing ahead: Forbes" must not survive a re-plan.
   */
  mode: AppMode | null;
}

export interface UiFacts {
  /** What the band shows as the hero, until it expires (see INSTRUCTION_TTL_MS). */
  instruction: Instruction | null;
  signal: { state: SignalState; fresh: boolean; confidence: number; ts: number } | null;
  vehicle: { direction: Direction; ts: number } | null;
  scan: { side: Side; vehiclesSeen: VehiclesSeen; ts: number } | null;
  obstacle: { distanceClass: DistanceClass; direction: Direction; ts: number } | null;
  aisle: { label: string; reached: boolean; side: Side | null; ts: number } | null;
  crossing: { street: string; signalized: boolean | null; pushButtonLikely: boolean; ts: number } | null;
  route: { legCount: number; destName: string; crossingCount: number; ts: number } | null;
  error: { scope: string; message: string; ts: number } | null;
}

export const EMPTY_FACTS: UiFacts = {
  instruction: null,
  signal: null,
  vehicle: null,
  scan: null,
  obstacle: null,
  aisle: null,
  crossing: null,
  route: null,
  error: null,
};

/**
 * How long a hero instruction stays on the band before the mode's standing
 * instruction takes back over. A transient hazard must not sit on the screen
 * after it has passed; a leg instruction has no reason to expire.
 */
export const INSTRUCTION_TTL_MS: Readonly<Record<InstructionKind, number>> = {
  leg: Number.POSITIVE_INFINITY,
  crossing: Number.POSITIVE_INFINITY,
  signal: Number.POSITIVE_INFINITY,
  vehicle: 4000,
  scan: 10000,
  obstacle: 4000,
  aisle: Number.POSITIVE_INFINITY,
  transition: Number.POSITIVE_INFINITY,
  checkout: Number.POSITIVE_INFINITY,
  route: 8000,
  error: 8000,
};

export function isFresh(i: Instruction, now: number): boolean {
  return now - i.ts < INSTRUCTION_TTL_MS[i.kind];
}

/** Fresh, and issued in the mode being shown (or of unknown provenance). */
export function isCurrent(i: Instruction, mode: AppMode, now: number): boolean {
  return isFresh(i, now) && (i.mode === null || i.mode === mode);
}

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

const SIGNAL_WORD: Readonly<Record<SignalState, string>> = {
  WALK: 'walk',
  DONT_WALK: 'hand',
  COUNTDOWN: 'countdown',
  UNKNOWN: 'not seen',
};

/** The word the band and the strip both state, so colour is never alone. */
export function signalWord(state: SignalState): string {
  return SIGNAL_WORD[state];
}

const SIGNAL_HERO: Readonly<Record<SignalState, string>> = {
  WALK: 'Walk signal on',
  DONT_WALK: "Don't walk",
  COUNTDOWN: 'Countdown',
  UNKNOWN: "Can't see the signal",
};

const DIRECTION_WORD: Readonly<Record<Direction, string>> = {
  LEFT: 'left',
  CENTER: 'ahead',
  RIGHT: 'right',
};

const SIDE_WORD: Readonly<Record<Side, string>> = { LEFT: 'left', RIGHT: 'right' };

const MODE_WORD: Readonly<Record<AppMode, string>> = {
  IDLE: 'Ready',
  ONBOARDING: 'Practice',
  OUTDOOR_NAV: 'Walking',
  APPROACH_CROSSING: 'Crossing ahead',
  AT_CURB: 'At the curb',
  CROSSING: 'Crossing',
  TRANSITION: 'Entering',
  INDOOR_NAV: 'In the store',
  AT_ITEM: 'At the aisle',
  ITEM_PICKUP: 'Reaching',
  CHECKOUT_NAV: 'To checkout',
  DONE: 'Done',
  GUIDED_TASK: 'Guided task',
};

export function modeWord(mode: AppMode): string {
  return MODE_WORD[mode];
}

/** Scan wording from 00 principle 8 -- facts, never permission. */
export function scanSentence(side: Side, seen: VehiclesSeen): string {
  const s = SIDE_WORD[side];
  switch (seen) {
    case 'none':
      return `No vehicles seen to the ${s}`;
    case 'distant':
      return `Vehicle in the distance to the ${s}`;
    case 'approaching':
      return `Vehicle approaching from the ${s}`;
    case 'unclear':
      return `Can't see well to the ${s}`;
  }
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function makeInstruction(text: string, kind: InstructionKind, ts: number, mode: AppMode | null): Instruction {
  return { text, kind, ts, mode };
}

/**
 * One event in, new facts out. Never mutates; returns the same object when an
 * event carries nothing the screen shows. `mode` is the store's mode after the
 * event was applied (null when unknown); it tags the instruction, see Instruction.
 */
export function reduceUi(facts: UiFacts, e: AppEvent, ts: number, mode: AppMode | null = null): UiFacts {
  const instruction = (text: string, kind: InstructionKind): Instruction => makeInstruction(text, kind, ts, mode);
  switch (e.type) {
    case 'OUTDOOR_LEG_ADVANCED':
      return { ...facts, instruction: instruction(e.instruction, 'leg') };

    case 'ROUTE_READY':
      return {
        ...facts,
        route: { legCount: e.legCount, destName: e.destName, crossingCount: e.crossingCount, ts },
      };

    case 'CROSSING_AHEAD': {
      const signalized = e.signalized === true ? 'Signalized.' : e.signalized === false ? 'No signal here.' : '';
      const text = `Crossing ahead: ${e.street}. ${signalized}`.trim();
      return {
        ...facts,
        crossing: { street: e.street, signalized: e.signalized, pushButtonLikely: e.pushButtonLikely, ts },
        instruction: instruction(text, 'crossing'),
      };
    }

    case 'CURB_REACHED':
      return { ...facts, instruction: instruction('Line up with the crossing', 'crossing') };

    case 'SIGNAL_STATE': {
      const signal = { state: e.state, fresh: e.fresh, confidence: e.confidence, ts };
      if (e.state === 'UNKNOWN') return { ...facts, signal };
      const text = e.state === 'WALK' && !e.fresh ? 'Walk already on. Wait for the next one' : SIGNAL_HERO[e.state];
      return { ...facts, signal, instruction: instruction(text, 'signal') };
    }

    case 'VEHICLE_APPROACHING':
      return {
        ...facts,
        vehicle: { direction: e.direction, ts },
        instruction: instruction(`Vehicle ${DIRECTION_WORD[e.direction]}`, 'vehicle'),
      };

    case 'SCAN_RESULT':
      return {
        ...facts,
        scan: { side: e.side, vehiclesSeen: e.vehiclesSeen, ts },
        instruction: instruction(scanSentence(e.side, e.vehiclesSeen), 'scan'),
      };

    case 'OBSTACLE_AHEAD':
      return {
        ...facts,
        obstacle: { distanceClass: e.distanceClass, direction: e.direction, ts },
        instruction: instruction('Obstacle ahead', 'obstacle'),
      };

    case 'HAZARD':
      return {
        ...facts,
        obstacle: { distanceClass: 'MID', direction: e.direction, ts },
        instruction: instruction(e.kind === 'CART_AHEAD' ? 'Cart ahead' : 'Person ahead', 'obstacle'),
      };

    case 'AISLE_IDENTIFIED':
      return { ...facts, aisle: { label: e.label, reached: false, side: null, ts } };

    case 'TARGET_AISLE_REACHED':
      return {
        ...facts,
        aisle: { label: facts.aisle?.label ?? e.aisleId, reached: true, side: e.side, ts },
      };

    case 'STORE_ENTERED':
      return { ...facts, instruction: instruction('Entering the store', 'transition') };

    case 'CHECKOUT_REACHED':
      return { ...facts, instruction: instruction("You've reached checkout", 'checkout') };

    case 'CROSSING_ABORTED':
      return { ...facts, signal: null, instruction: instruction('Back on the sidewalk', 'leg') };

    case 'FAR_CURB_REACHED':
      return { ...facts, signal: null, instruction: instruction('Far curb reached', 'leg') };

    case 'ERROR':
      return { ...facts, error: { scope: e.scope, message: e.message, ts } };

    case 'ITEM_HAND_GUIDANCE': {
      const hint = e.hint === 'not_seen' ? 'Move your hand slowly' : `Reach ${e.hint}`;
      const text = e.hint === 'touching' ? 'Touching' : hint;
      return { ...facts, instruction: instruction(text, 'aisle') };
    }

    default:
      // ITEM_REQUESTED, OUTDOOR/CROSSING plumbing, COURSE_DEVIATION, CAMERA_REQUEST,
      // USER_ACTION: nothing the band shows (they are spoken or felt, not read).
      return facts;
  }
}

// ---------------------------------------------------------------------------
// Band content
// ---------------------------------------------------------------------------

export interface HeroContext {
  item: string | null;
  side: Side | null;
  destinationOnly?: boolean;   // "take me to <place>": DONE reads "You've arrived"
  taskGoal?: string | null;    // GUIDED_TASK: the goal in the user's words
}

const EMPTY_CTX: HeroContext = { item: null, side: null };

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/** The standing instruction for a mode, used until an event supplies a fresher one. */
export function standingHero(mode: AppMode, facts: UiFacts, ctx: HeroContext = EMPTY_CTX): string {
  switch (mode) {
    case 'IDLE':
      return ctx.item ? `Planning a route for ${ctx.item}` : 'What do you need?';
    case 'ONBOARDING':
      return 'Practice the vibrations';
    case 'OUTDOOR_NAV':
      return 'Keep walking';
    case 'APPROACH_CROSSING':
      return facts.crossing ? `Crossing ahead: ${facts.crossing.street}` : 'Crossing ahead';
    case 'AT_CURB':
      // Unsignalized: the scan report is the instruction; until it lands, say what is true.
      if (facts.crossing?.signalized === false) return 'No signal here. Listen for traffic';
      // Signalized but no reading yet: the alignment prompt, not a premature "can't see".
      if (!facts.signal) return 'Line up with the crossing';
      return SIGNAL_HERO[facts.signal.state];
    case 'CROSSING':
      return facts.signal && facts.signal.state !== 'UNKNOWN'
        ? SIGNAL_HERO[facts.signal.state]
        : 'Hold your line to the far curb';
    case 'TRANSITION':
      return 'Entering the store';
    case 'INDOOR_NAV':
      return ctx.item ? `Walking to the ${ctx.item} aisle` : 'Looking for your aisle';
    case 'AT_ITEM':
      return ctx.item && ctx.side
        ? `${capitalize(ctx.item)} on your ${SIDE_WORD[ctx.side]}`
        : 'You are at the aisle';
    case 'ITEM_PICKUP':
      return 'Reach out';
    case 'CHECKOUT_NAV':
      return 'Checkout ahead';
    case 'DONE':
      return ctx.destinationOnly ? "You've arrived" : "You've reached checkout";
    case 'GUIDED_TASK':
      return ctx.taskGoal ? `Task: ${ctx.taskGoal}` : 'Guided task';
  }
}

/** The one hero line: the current instruction, else the mode's standing one. */
export function heroText(mode: AppMode, facts: UiFacts, now: number, ctx: HeroContext = EMPTY_CTX): string {
  const i = facts.instruction;
  if (i && isCurrent(i, mode, now)) return i.text;
  return standingHero(mode, facts, ctx);
}

// ---------------------------------------------------------------------------
// Errors: what happened and what to do next (DESIGN.md rule 10)
// ---------------------------------------------------------------------------

export const ERROR_TTL_MS = INSTRUCTION_TTL_MS.error;

/**
 * Scopes the user can act on get a sentence; internal scopes (store, speech,
 * ui, bus) stay in the DebugPanel and return null. Unknown scopes get a
 * generic line so a new emitter is never silent.
 */
export function errorSentence(scope: string, message: string): string | null {
  const s = scope.toLowerCase();
  if (s === 'store' || s === 'speech' || s === 'ui' || s === 'bus' || s === 'haptics') return null;
  if (s === 'route-degraded') return 'No route data. Heading straight to the store.';
  if (s.startsWith('route') || s.startsWith('plan') || s === 'outdoor') return "Couldn't plan the route. Check the connection and try again.";
  if (s === 'voice' || s === 'stt' || s === 'mic') return "Didn't catch that. Hold to talk and try again.";
  if (s === 'perception' || s === 'camera') return 'The camera is not running. Check the camera permission.';
  if (s === 'network' || s === 'offline' || s === 'proxy') return 'Offline. Cached guidance continues.';
  if (s === 'location' || s === 'gps') return 'No location yet. Step outside or check the location permission.';
  const detail = message.trim().replace(/\s+/g, ' ');
  const short = detail.length > 60 ? `${detail.slice(0, 59)}…` : detail;
  return short.length > 0 ? `Something failed in ${scope}: ${short}` : `Something failed in ${scope}. Try again.`;
}

/** The error line to show now, or null when none is fresh or user-facing. */
export function visibleError(facts: UiFacts, now: number): string | null {
  const e = facts.error;
  if (!e || now - e.ts >= ERROR_TTL_MS) return null;
  return errorSentence(e.scope, e.message);
}

/** Only these modes show a signal colour on the band (theme.bandColorFor). */
export function bandSignal(facts: UiFacts): SignalState {
  return facts.signal?.state ?? 'UNKNOWN';
}

// ---------------------------------------------------------------------------
// Perception strip: three fixed slots, each reading as a sentence
// ---------------------------------------------------------------------------

export interface StripSlot {
  key: 'signal' | 'vehicles' | 'aisle';
  label: string;
  /** Reads as a sentence with the label: "Signal: walk, seen 1 s ago". */
  value: string;
}

export function ageText(ts: number, now: number): string {
  const secs = Math.max(0, Math.round((now - ts) / 1000));
  if (secs > 99) return 'seen a while ago';
  return `seen ${secs} s ago`;
}

export function stripSlots(facts: UiFacts, now: number): StripSlot[] {
  return [signalSlot(facts, now), vehiclesSlot(facts, now), aisleSlot(facts, now)];
}

function signalSlot(facts: UiFacts, now: number): StripSlot {
  const s = facts.signal;
  if (!s) return { key: 'signal', label: 'Signal', value: 'not seen' };
  const already = s.state === 'WALK' && !s.fresh ? ' already on' : '';
  return { key: 'signal', label: 'Signal', value: `${signalWord(s.state)}${already}, ${ageText(s.ts, now)}` };
}

function vehiclesSlot(facts: UiFacts, now: number): StripSlot {
  const v = facts.vehicle;
  const sc = facts.scan;
  const newest = !v ? sc : !sc ? v : v.ts >= sc.ts ? v : sc;
  if (!newest) return { key: 'vehicles', label: 'Vehicles', value: 'none reported' };
  if (v && newest === v) {
    return { key: 'vehicles', label: 'Vehicles', value: `${DIRECTION_WORD[v.direction]}, ${ageText(v.ts, now)}` };
  }
  const s = sc as NonNullable<UiFacts['scan']>;
  const phrase = scanSentence(s.side, s.vehiclesSeen).toLowerCase();
  return { key: 'vehicles', label: 'Vehicles', value: `${phrase}, ${ageText(s.ts, now)}` };
}

function aisleSlot(facts: UiFacts, now: number): StripSlot {
  const a = facts.aisle;
  if (!a) return { key: 'aisle', label: 'Aisle', value: 'no sign read yet' };
  const what = a.reached && a.side ? `${a.label}, on your ${SIDE_WORD[a.side]}` : a.label;
  return { key: 'aisle', label: 'Aisle', value: `${what}, ${ageText(a.ts, now)}` };
}
