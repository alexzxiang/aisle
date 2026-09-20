/**
 * Round 4: "take me to the eggs in my fridge" — a camera-guided, step-by-step task
 * with no route. The place is wherever the user is (home, a store aisle, a
 * street door), so the guidance is a short plan of physical steps, each confirmed
 * by the camera before the next one is spoken.
 *
 * Script, per accepted TASK_REQUESTED (the store moved IDLE → GUIDED_TASK first):
 *   1. "Let me see your surroundings." — then the describer's on-demand look, so
 *      the plan starts from what the camera actually sees.
 *   2. Tier 2 `taskPlan` (Nemotron, or the local template on a miss) → three to
 *      eight steps, each `instruction` (spoken) + `lookFor` (what confirms it).
 *   3. Speak step one; TASK_STEP carries it to the hero band.
 *   4. Loop: about every `tickMs`, ask Tier 1 `task_step` with the goal, the step and
 *      what to look for. Claude's `speech` (a micro-hint such as "The fridge is on
 *      your left.") and its camera / user-action prompts are spoken by the vision
 *      service; this loop only reads `task.done`. Done with confidence ≥
 *      `doneConfidence` → CONFIRM tap, "Step done.", next step.
 *   5. Last step done → "Done. Task complete." → TASK_COMPLETED (→ DONE).
 *
 * Voice while the task runs (App routes the parsed outcome here as it does to the
 * trip): "next" / "done" / "skip" advance by hand, "repeat" re-speaks the step,
 * "stop" is the store's abort. The step is re-spoken every `remindMs` while it
 * stays open, so a quiet camera never leaves the user without the instruction.
 *
 * Safety: nothing here speaks about traffic; the street context's template and
 * prompt confine the plan to doors and standing places (plannerJobs.ts).
 */
import type { AppEvent, AppMode, HapticService, SpeechService, TaskContext, TaskPlanInput, TaskPlanOutput, VisionResponse } from './contracts';
import type { AppEventBus } from './bus';
import type { AppStore } from './store';
import type { ConversationLog } from './conversation';
import type { VoiceOutcome } from './voice';
import { MAX_SEARCH_SPEECH_WORDS, MAX_UTTERANCE_WORDS, countWords, findForbiddenTerm, hasDigit, phraseText } from './phrases';
import type { SemanticVision } from '../perception/semanticVision';
import type { PlannerClient } from '../outdoor/planner';
import { templateTaskPlan } from '../outdoor/plannerJobs';
import { createHandGuide, itemOfGoal, type HandGuide } from './handGuide';
import type { Guide, GuideInstruction, TargetBox } from './guide';
import { classForWords } from './sceneMemory';
import { contextForSetting } from './situate';
import { fridgeMission, likelyFridgeGoal, FRIDGE_STAGES, type FridgeStage } from './fridgeMission';
import { MISSION_PHRASES } from './preparedGuidance';
import { MISSION_STEPS, createMissionRunner, exploreRequest, parseMissionGoal, type MissionPhase, type MissionRunner } from './itemMission';
import { isAffirmative, isNegative } from './yesNo';
import { createSearchExplorer, type SearchExplorer } from './searchExplorer';
import { foodSection } from './foodCatalog';

export const TASK_TICK_MS = 3000;
/** Claude's own box for a food item must be this fresh before the hand loop reaches for it (search runs). */
export const REACH_CONFIRM_MS = 10_000;
/** A `done` reading at or above this counts toward closing the step on camera evidence alone. */
export const TASK_DONE_CONFIDENCE = 0.8;
/** A `done` reading in [ASK, DONE) is put to the user instead: "It looks like <thing>. Is that right?" */
export const TASK_ASK_CONFIDENCE = 0.5;
export const TASK_REMIND_MS = 20_000;
/**
 * Between the 20 s step reminders a guided task is otherwise silent (the describer and
 * the awareness loop do not speak in GUIDED_TASK). A short reassurance nudge at INFO
 * fills that quiet so the user knows the app is still with them; it yields to any real
 * guidance and never fires while a "Is that right?" check is waiting.
 */
export const TASK_REASSURE_MS = 12_000;
/**
 * If a single step never confirms for this long — the shopper cannot find the aisle, the
 * item is not on the shelf — the task ends gracefully with "Ask staff for help finding it."
 * rather than reminding forever (04 Task 9's give-up precedent). The reach step is exempt:
 * its hand loop (handGuide) owns its own give-up.
 */
export const TASK_GIVE_UP_MS = 120_000;
/** Two consecutive `done` readings before a step closes on camera evidence alone (one blurry frame must not skip a step). */
export const TASK_DONE_STREAK = 2;
/** An unanswered step check expires after this; the loop goes back to watching. */
export const TASK_CHECK_TTL_MS = 15_000;
/** A geometric instruction that has not changed is said again after this (round 7). */
export const TASK_GUIDE_REPEAT_MS = 4000;
/** Geometry waits this long after a step is announced, so the step's sentence is heard first. */
export const TASK_GUIDE_AFTER_STEP_MS = 4000;

/**
 * The thing a step is about, for the geometric guide: the step's `lookFor` when it names a
 * thing the detector or memory knows, else the goal's item ("eggs in my fridge" → "fridge"
 * for walking steps: the place the item is in; "eggs" for the reach).
 */
export function stepTarget(instruction: string, lookFor: string, goal: string): string {
  const place = goal.match(/\b(?:in|on|at|inside|from)\s+(?:the |my |a )?(.+?)$/i)?.[1]?.trim() ?? null;
  if (isReachStep(instruction)) return itemOfGoal(goal);
  // Walking steps aim at the goal's place whenever the phone can see or remember it (the
  // fridge, the couch); a plan's intermediate "kitchen counter" / "door frame" only when the
  // detector knows that thing — otherwise the guide would hunt for a counter it cannot see
  // while the fridge sits in plain view (the 09-19 living-room report).
  const placeKnown = place !== null && classForWords(place) !== null;
  const lf = lookFor.trim().toLowerCase().replace(/^(the|a|an|my)\s+/, '');
  const lfKnown = lf.length > 0 && classForWords(lf) !== null;
  if (placeKnown && isWalkingStep(instruction)) return place!;
  if (lfKnown) return lf;
  return place ?? itemOfGoal(goal);
}
/**
 * A look-around step ("Turn slowly so I can see the room.") has no target the camera
 * can confirm; it closes on the first `done` reading of any confidence, or after this.
 */
export const TASK_OBSERVE_MS = 8000;
const OBSERVE_RE = /\b(turn slowly|look around|show me|so i can see|let me see|scan)\b/i;
/** A step that ends with the item in hand: the hand guide takes over from the step loop (round 6c). */
const REACH_RE = /\b(reach|grab|pick up|take the|take a|get the|grasp|hold the|feel for)\b/i;

export function isReachStep(instruction: string): boolean {
  return REACH_RE.test(instruction);
}

export function isWalkingStep(instruction: string): boolean {
  return /\b(walk|approach|move toward|face|turn toward|turn left|turn right|find the fridge)\b/i.test(instruction)
    && !/\b(open|pull|reach|grab|pick up)\b/i.test(instruction);
}

export function isObservationStep(instruction: string): boolean {
  return OBSERVE_RE.test(instruction);
}

const NEXT_RE = /^(?:ok(?:ay)?[,. ]*)?(?:next(?: step)?|done|did it|i did it|got it|skip(?: (?:this|that|it))?(?: step)?|finished|complete[d]?|continue|go on)[.!]?$/i;
const YES_RE = /^(?:yes|yeah|yep|yup|correct|right|that's right|thats right|that is right|exactly|sure|uh huh|affirmative)[.!]?$/i;
const NO_RE = /^(?:no|nope|nah|wrong|incorrect|not really|not yet|that's wrong|thats wrong|negative)[.!]?$/i;

export function isAdvanceRequest(transcript: string): boolean {
  return NEXT_RE.test(transcript.trim());
}

/** "It looks like the fridge door open. Is that right?" — null when the words cannot be spoken safely. */
export function stepCheckQuestion(lookFor: string): string | null {
  const l = lookFor.trim().replace(/[.!?]+$/, '').toLowerCase();
  if (l.length === 0 || hasDigit(l) || findForbiddenTerm(l) !== null) return null;
  const q = `It looks like ${l}. Is that right?`;
  return countWords(q) <= MAX_UTTERANCE_WORDS ? q : null;
}

export interface GuidedTaskDeps {
  adaptiveSearch?: boolean;
  heading?: () => number | null;
  steps?: () => number;
  /** Round 12: ARKit pose and the depth grid's bottom row, for exploring a big space by coverage. */
  pose?: () => import('./contracts').Pose | null;
  path?: () => { center: number; left?: number; right?: number } | null;
  /** Round 18: the session's exploration map (viewed cells, "not here" marks) shared by every mission. */
  map?: import('./explorationMap').ExplorationMap;
  /** Round 17: the lens's field of view and the phone's own OCR sign reads, for the explorer. */
  hfovDeg?: () => number;
  signs?: () => ReadonlyArray<{ text: string; box: [number, number, number, number]; at: number }>;
  bus: Pick<AppEventBus, 'on' | 'emit'>;
  store: Pick<AppStore, 'getState' | 'subscribe'>;
  speech: Pick<SpeechService, 'say'>;
  haptics: Pick<HapticService, 'play'>;
  /** `ask` for the step loop; `getFacts` feeds the planner what the camera already sees. */
  vision: Pick<SemanticVision, 'ask'> & Partial<Pick<SemanticVision, 'getFacts'>>;
  planner: Pick<PlannerClient, 'run'>;
  /** The scene describer's on-demand look (A's `describeNow`); resolves to what it spoke. */
  describe?: () => Promise<string | null>;
  /** The awareness loop's current place label, for the planner and the step loop. */
  scene?: () => string | null;
  /** Scene memory: "fridge to your left, couch behind you" — what was seen and where it is now. */
  seen?: () => string;
  /** The reach step's hand loop (handGuide.ts). Default: built from vision / speech / haptics. */
  handGuide?: HandGuide;
  /**
   * Round 7: walking instructions from geometry (guide.ts). When it has something to say
   * about the step's target, its sentence is spoken instead of the model's, and the model
   * is asked silently (it still judges `task.done` and supplies a `target.box`).
   */
  guide?: Guide;
  /** Minimum time between two geometric instructions that say the same thing. */
  guideRepeatMs?: number;
  /** Round 7b: one line per decision to the proxy's trace file. */
  trace?: (kind: string, payload: Record<string, unknown>) => void;
  conversation?: Pick<ConversationLog, 'pushAisle'>;
  now?: () => number;
  tickMs?: number;
  remindMs?: number;
  reassureMs?: number;
  giveUpMs?: number;
  doneConfidence?: number;
  askConfidence?: number;
  doneStreak?: number;
  checkTtlMs?: number;
  observeMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export interface GuidedTaskDebugState {
  searchAreas?: ReturnType<SearchExplorer['memory']>;
  stage: FridgeStage | MissionPhase | null;
  /** Round 14: the thing the walk is aimed at right now (a place, an appliance, the item), for the obstacle gate. */
  target?: string | null;
  active: boolean;
  goal: string | null;
  context: TaskContext | null;
  step: number;
  total: number;
  asks: number;
  doneReadings: number;
  /** A "Is that right?" step check is waiting for yes / no. */
  checkOpen: boolean;
  checks: number;
  plannerFallback: boolean | null;
  lastAskAt: number | null;
}

export interface GuidedTask {
  /** App routes every parsed voice outcome here (like `trip.onVoiceOutcome`). */
  onVoiceOutcome(o: Pick<VoiceOutcome, 'output' | 'transcript'>): Promise<void>;
  /** Voice, before the planner: "yes" / "no" to an open step check. True when consumed. */
  intercept(transcript: string): boolean;
  /** Move to the next step by hand (a button, a voice "next"). No-op when idle. */
  advance(): void;
  /** Speak the current step again. */
  repeat(): void;
  isActive(): boolean;
  getDebugState(): GuidedTaskDebugState;
  dispose(): void;
}

interface RunState {
  itemEvidence?: { seq: number; at: number };
  /** When "hold the camera on it" was last said while waiting for Claude to confirm the food, how often, and since when. */
  reachHoldAt?: number;
  reachHolds?: number;
  reachFirstHoldAt?: number;
  /** The hand loop already ran once for this reach (a retry does not greet again). */
  reachTried?: boolean;
  search: SearchExplorer | null;
  searchTarget: string | null;
  /** Round 8: "find X on the Y" at home runs the item navigator instead of a planner's steps. */
  mission: MissionRunner | null;
  fridge: boolean;
  leftContainer?: boolean;
  lastVisionAt: number;
  gen: number;
  goal: string;
  context: TaskContext;
  sceneVote?: { context: TaskContext; hits: number };
  steps: TaskPlanOutput['steps'];
  step: number;
  doneReadings: number;
  timer: ReturnType<typeof setTimeout> | null;
  remindTimer: ReturnType<typeof setTimeout> | null;
  reassureTimer: ReturnType<typeof setTimeout> | null;
  giveUpTimer: ReturnType<typeof setTimeout> | null;
  asking: boolean;
  /** An open "Is that right?" for this step, with when it was asked. */
  check: { step: number; at: number } | null;
  /** When the current step was spoken first (observation steps time out from here). */
  stepAt: number;
  /** The last description the camera gave (the look at the start), for the planner and the step loop. */
  description: string | null;
  /** Steps already put to the user once (a "no" means: watch, do not ask again). */
  checked: Set<number>;
  /** The hand loop is running for this step (reach steps only). */
  handing: boolean;
  /** The last geometric instruction spoken for this step, and when (round 7). */
  guided: { at: number; instruction: GuideInstruction } | null;
  /** The model's last target box for this step (steers targets the detector cannot name). */
  modelTarget: TargetBox | null;
  /** Round 8: the navigator had nothing geometric to say this tick, so the model's sentence may be spoken. */
  missionModelMaySpeak: boolean;
  /** Invalidates pending model replies when the user changes the search direction. */
  searchRevision?: number;
}

export function createGuidedTask(deps: GuidedTaskDeps): GuidedTask {
  const now = deps.now ?? Date.now;
  const tickMs = deps.tickMs ?? TASK_TICK_MS;
  const remindMs = deps.remindMs ?? TASK_REMIND_MS;
  const reassureMs = deps.reassureMs ?? TASK_REASSURE_MS;
  const giveUpMs = deps.giveUpMs ?? TASK_GIVE_UP_MS;
  const doneConfidence = deps.doneConfidence ?? TASK_DONE_CONFIDENCE;
  const askConfidence = deps.askConfidence ?? TASK_ASK_CONFIDENCE;
  const doneStreak = deps.doneStreak ?? TASK_DONE_STREAK;
  const checkTtlMs = deps.checkTtlMs ?? TASK_CHECK_TTL_MS;
  const guideRepeatMs = deps.guideRepeatMs ?? TASK_GUIDE_REPEAT_MS;
  const observeMs = deps.observeMs ?? TASK_OBSERVE_MS;
  const setT: typeof setTimeout = deps.setTimeoutFn ?? setTimeout;
  const clearT: typeof clearTimeout = deps.clearTimeoutFn ?? clearTimeout;
  const { bus, store, speech } = deps;

  const handGuide: HandGuide = deps.handGuide ?? createHandGuide({ vision: deps.vision, speech, haptics: deps.haptics, bus, conversation: deps.conversation, now });
  const lastTurnPulse = new WeakMap<RunState, number>();
  const lastArrivalFrame = new WeakMap<RunState, number>();

  /**
   * Round 7: geometry speaks first. Returns true when a geometric instruction was spoken (or
   * deliberately held because it has not changed), so the model's prose is muted for this ask.
   */
  const speakGeometry = (r: RunState): boolean => {
    if (!deps.guide) return false;
    const s = r.steps[r.step];
    if (r.mission) return false;
    if (!s || (r.fridge ? r.step !== 0 && r.step !== 2 : !isWalkingStep(s.instruction))) return false;
    const t = now();
    if (t - r.stepAt < (r.fridge ? 0 : TASK_GUIDE_AFTER_STEP_MS)) return false;
    const target = r.fridge ? (r.step === 2 ? itemOfGoal(r.goal) : /\bfreezer\b/i.test(r.goal) ? 'freezer' : 'fridge') : stepTarget(s.instruction, s.lookFor, r.goal);
    const next = deps.guide.instructionFor(target, r.modelTarget, r.search ? { modelOnly: r.fridge && r.step === 2, maxAgeMs: 6000 } : undefined);
    deps.trace?.('guide', { step: r.step, instruction: s.instruction, target, decision: next ? { kind: next.kind, steps: next.steps, relativeDeg: next.relativeDeg, visible: next.targetVisible, text: next.text } : null, modelTarget: r.modelTarget?.box ?? null });
    if (r.search && r.fridge) {
      const exploration = r.search.tick(target, next, { confined: r.step === 2, surface: r.step === 2 && !next?.targetVisible });
      if (exploration) {
        r.searchTarget = exploration.target;
        r.doneReadings = 0;
        lastArrivalFrame.delete(r);
        if (exploration.haptic) deps.haptics.play(exploration.haptic);
        if (exploration.text) {
          speech.say({ text: exploration.text, priority: 'NAV', dedupeKey: 'task-search', cooldownMs: 0 });
          deps.conversation?.pushAisle(exploration.text, 'prompt');
        }
        return true;
      }
      r.searchTarget = null;
    }
    if (!next) { r.doneReadings = 0; lastArrivalFrame.delete(r); return false; }
    // Two separate live geometry readings must agree. Opening is never completed by
    // proximity, and cloud replies cannot erase the approach's geometric evidence.
    if (next.kind === 'arrived') {
      const frameAt = next.box?.at ?? now();
      if (lastArrivalFrame.get(r) !== frameAt) r.doneReadings += 1;
      lastArrivalFrame.set(r, frameAt);
    } else { r.doneReadings = 0; lastArrivalFrame.delete(r); }
    const prev = r.guided;
    const news = deps.guide.changed(prev?.instruction ?? null, next);
    if (next.targetVisible && next.kind.startsWith('turn') && t - (lastTurnPulse.get(r) ?? -Infinity) >= 1500) {
      deps.haptics.play('TURN');
      lastTurnPulse.set(r, t);
    }
    if (prev && t - prev.at < (news ? 2500 : guideRepeatMs)) return true;
    if (next.kind === 'scan_remembered') deps.haptics.play('TURN');
    else if (next.kind === 'forward' && prev?.instruction.kind !== 'forward') deps.haptics.play('CONFIRM');
    speech.say({ text: next.text, priority: 'NAV', dedupeKey: 'task-guide', cooldownMs: 800 });
    r.guided = { at: t, instruction: next };
    return true;
  };
  /**
   * Round 8: one navigator tick — the line for where the person stands now (item in view,
   * its place in view, remembered, or nowhere), its haptic, and the phase change it implies.
   * The reach phase hands over to the hand loop; the confirm phase waits for the user.
   */
  const missionTick = (r: RunState): void => {
    const m = r.mission;
    if (!m) return;
    const before = m.phase();
    const out = m.tick();
    deps.trace?.('mission', { goal: r.goal, phase: out.decision.phase, key: out.decision.key, text: out.text, box: out.decision.boxTarget });
    if (out.haptic) deps.haptics.play(out.haptic);
    if (out.text) {
      speech.say({ text: out.text, priority: 'NAV', dedupeKey: 'task-guide', cooldownMs: 800 });
      deps.conversation?.pushAisle(out.text, 'prompt');
    }
    r.missionModelMaySpeak = out.modelMaySpeak;
    const after = m.phase();
    if (after !== before) deps.trace?.('mission_checkpoint', { goal: r.goal, stage: after, step: m.stepIndex(), instruction: MISSION_STEPS[m.stepIndex()]!.instruction });
    if (after === 'reach' && r.step === 0) {
      r.step = 1;
      r.guided = null;
      bus.emit({ type: 'TASK_STEP', index: 1, total: r.steps.length, instruction: MISSION_STEPS[1].instruction });
      startMissionReach(r);
    }
  };

  const startMissionReach = (r: RunState): void => {
    const m = r.mission;
    if (!m || r.handing) return;
    // A food the coarse detector can confuse (eggs and oranges) is reached for once Claude has
    // boxed the item recently — or once the detector has held it steadily for a few seconds, or
    // after two asks: "hold the camera on it" must never become the whole conversation.
    const confirmed = (r.itemEvidence && now() - r.itemEvidence.at <= REACH_CONFIRM_MS) || (r.reachHolds ?? 0) >= 2
      || (m.itemBox() !== null && now() - (r.reachFirstHoldAt ?? now()) >= 3000);
    if (r.search && foodSection(m.goal.item) !== 'unknown' && !confirmed) {
      r.reachFirstHoldAt = r.reachFirstHoldAt ?? now();
      if (now() - (r.reachHoldAt ?? -Infinity) >= 5000) {
        r.reachHoldAt = now();
        r.reachHolds = (r.reachHolds ?? 0) + 1;
        const line = `Hold the camera on it. Let me confirm it is the ${m.goal.item}.`;
        speech.say({ text: line, priority: 'NAV', dedupeKey: 'task-guide', cooldownMs: 0 });
        deps.conversation?.pushAisle(line, 'prompt');
      }
      return;
    }
    r.handing = true;
    const handStep = r.step;
    const retry = r.reachTried === true;
    r.reachTried = true;
    void handGuide.start(m.goal.item, { goal: r.goal, target: m.itemBox() ?? r.modelTarget, retry }).then((res) => {
      if (run !== r || r.step !== handStep) return;
      r.handing = false;
      if (res.done === 'touching') {
        m.reached();
        r.step = 2;
        r.guided = null;
        deps.haptics.play('CONFIRM');
        speech.say({ text: MISSION_PHRASES.mission_pickup_confirm, priority: 'NAV', dedupeKey: 'task-step-2', cooldownMs: 1500 });
        deps.conversation?.pushAisle(MISSION_PHRASES.mission_pickup_confirm, 'prompt');
        bus.emit({ type: 'TASK_STEP', index: 2, total: r.steps.length, instruction: MISSION_STEPS[2].instruction });
        scheduleRemind(r);
      } else if (res.done === 'gave_up') {
        // Lost the item at arm's length: back to looking, from geometry.
        m.lost();
        r.step = 0;
        r.guided = null;
      }
    });
  };
  let run: RunState | null = null;
  let generation = 0;
  let disposed = false;
  let asks = 0;
  let checks = 0;
  let plannerFallback: boolean | null = null;
  let lastAskAt: number | null = null;
  const unsubs: Array<() => void> = [];

  const mode = (): AppMode => store.getState().mode;

  // The blurb keeps every prompt even when the queue's newest-wins rule skips it
  // (same role + text inside the log's collapse window is one entry).
  const sayPhrase = (key: 'let_me_see' | 'task_done' | 'task_step_done' | 'task_next', cooldownMs = 2000): void => {
    speech.say({ text: phraseText(key), priority: 'NAV', cacheKey: key, dedupeKey: `task-${key}`, cooldownMs });
    deps.conversation?.pushAisle(phraseText(key), 'prompt');
  };

  const clearTimers = (r: RunState): void => {
    if (r.timer !== null) clearT(r.timer);
    if (r.remindTimer !== null) clearT(r.remindTimer);
    if (r.reassureTimer !== null) clearT(r.reassureTimer);
    if (r.giveUpTimer !== null) clearT(r.giveUpTimer);
    r.timer = null;
    r.remindTimer = null;
    r.reassureTimer = null;
    r.giveUpTimer = null;
  };

  const stop = (): void => {
    if (!run) return;
    clearTimers(run);
    if (handGuide.isRunning()) handGuide.stop();
    run = null;
    generation += 1;
  };

  const speakStep = (r: RunState, reminder: boolean): void => {
    const s = r.steps[r.step];
    if (!s) return;
    if (!reminder) r.stepAt = now();
    if (r.mission && r.step === 0) {
      // The navigator speaks for itself, now: a reminder is a forced repeat of its line.
      if (reminder) r.mission.repeat();
      missionTick(r);
    } else {
      const geometrySpoke = deps.guide && r.fridge && r.step === 0 && !s.instruction.startsWith('It may be') ? speakGeometry(r) : false;
      if (!geometrySpoke) speech.say({ text: s.instruction, priority: 'NAV', dedupeKey: `task-step-${r.step}`, cooldownMs: reminder ? 0 : 1500 });
    }
    if (!reminder) {
      r.stepAt = now();
      if (!(r.mission && r.step === 0)) deps.conversation?.pushAisle(s.instruction, 'prompt');
      bus.emit({ type: 'TASK_STEP', index: r.step, total: r.steps.length, instruction: s.instruction });
      deps.trace?.('mission_checkpoint', { goal: r.goal, stage: r.fridge ? FRIDGE_STAGES[r.step] : r.mission?.phase() ?? null, step: r.step, instruction: s.instruction });
    }
    scheduleRemind(r);
    scheduleReassure(r);
    if (!reminder) scheduleGiveUp(r);   // a fresh step resets the patience; reminders do not
  };

  const scheduleRemind = (r: RunState): void => {
    if (r.remindTimer !== null) clearT(r.remindTimer);
    r.remindTimer = setT(() => {
      r.remindTimer = null;
      if (run !== r || mode() !== 'GUIDED_TASK') return;
      speakStep(r, true);
    }, remindMs);
  };

  // A short "still with you" between reminders, at INFO so real guidance always wins.
  // Not re-armed here: the next step or reminder re-arms it, so it fires at most once
  // per quiet window and never while a step check is open.
  const scheduleReassure = (r: RunState): void => {
    if (r.reassureTimer !== null) clearT(r.reassureTimer);
    r.reassureTimer = setT(() => {
      r.reassureTimer = null;
      if (run !== r || mode() !== 'GUIDED_TASK' || r.check !== null || r.search) return;
      const text = phraseText('task_still_looking');
      speech.say({ text, priority: 'INFO', cacheKey: 'task_still_looking', dedupeKey: 'task-reassure', cooldownMs: reassureMs });
      deps.conversation?.pushAisle(text, 'prompt');
    }, reassureMs);
  };

  // A step that never confirms ends the task with "Ask staff for help finding it." rather than
  // looping forever. Armed once per fresh step; deferred while the reach step's hand loop runs.
  const scheduleGiveUp = (r: RunState): void => {
    if (r.giveUpTimer !== null) clearT(r.giveUpTimer);
    r.giveUpTimer = setT(() => {
      r.giveUpTimer = null;
      if (run !== r || mode() !== 'GUIDED_TASK') return;
      if (r.handing) { scheduleGiveUp(r); return; }   // handGuide owns the reach step's give-up
      giveUp(r);
    }, giveUpMs);
  };

  const giveUp = (r: RunState): void => {
    if (run !== r) return;
    if (r.search) { scheduleGiveUp(r); return; }
    if (r.fridge || r.mission) {
      speech.say({ text: MISSION_PHRASES.mission_paused, priority: 'NAV' });
      scheduleGiveUp(r);
      return;
    }
    stop();
    deps.haptics.play('CONFIRM');
    speech.say({ text: phraseText('ask_staff'), priority: 'NAV', cacheKey: 'ask_staff', dedupeKey: 'task-give-up', cooldownMs: 0 });
    deps.conversation?.pushAisle(phraseText('ask_staff'), 'prompt');
    bus.emit({ type: 'TASK_COMPLETED', goal: r.goal });
  };

  const complete = (r: RunState): void => {
    if (run !== r) return;
    stop();
    deps.haptics.play('CONFIRM');
    sayPhrase('task_done', 0);
    bus.emit({ type: 'TASK_COMPLETED', goal: r.goal });
  };

  const advanceRun = (r: RunState, byUser: boolean): void => {
    if (run !== r || mode() !== 'GUIDED_TASK') return;
    r.doneReadings = 0;
    r.check = null;
    if (r.handing) {
      handGuide.stop();
      r.handing = false;
    }
    if (r.step >= r.steps.length - 1) {
      complete(r);
      return;
    }
    deps.haptics.play('CONFIRM');
    sayPhrase(byUser ? 'task_next' : 'task_step_done', 0);
    r.step += 1;
    r.searchTarget = null;
    r.search?.restart();
    if (r.fridge && r.step === 2) r.search?.enterArea(/\bfreezer\b/i.test(r.goal) ? 'inside freezer' : 'inside fridge');
    r.guided = null;
    if (!(r.fridge && r.step === 3) && !(r.mission && r.step === 1)) r.modelTarget = null;
    if (r.mission) {
      // By-hand advance ("next"): reach from wherever the item is, or close on "done".
      if (r.step === 1) { r.mission.lost(); r.mission.reached(); r.step = 2; }
      else if (r.step === 2) { complete(r); return; }
    }
    speakStep(r, false);
  };

  const userText = (r: RunState): string => {
    const search = r.search ? ` ${r.search.context()}` : '';
    if (r.mission) {
      const place = deps.scene?.();
      const seen = deps.seen?.();
      return `Setting: ${r.context}. ${r.mission.userText()}${search}${place ? ` Place: ${place}.` : ''}${seen ? ` Seen: ${seen}.` : ''}`.slice(0, r.search ? 1800 : 500);
    }
    const s = r.steps[r.step]!;
    const place = deps.scene?.();
    const where = place ? ` Place: ${place}.` : '';
    const seen = deps.seen?.();
    const memory = seen ? ` Seen: ${seen}.` : '';
    return `Setting: ${r.context}. Goal: ${r.goal}. Step ${r.step + 1} of ${r.steps.length}: ${s.instruction} Look for: ${r.searchTarget ?? s.lookFor}.${r.fridge ? ` Stage: ${FRIDGE_STAGES[r.step]}. Preserve this mission; do not describe the room or plan a route.` : ''}${search}${where}${memory}`.slice(0, r.search ? 1800 : 500);
  };

  /** 'done' closes on the streak; 'ask' puts it to the user; 'no' resets. */
  const readDone = (res: VisionResponse | null): 'done' | 'ask' | 'no' => {
    if (!res || res.task.done !== true) return 'no';
    if (res.task.confidence >= doneConfidence) return 'done';
    return res.task.confidence >= askConfidence ? 'ask' : 'no';
  };

  const openCheck = (r: RunState): void => {
    const s = r.steps[r.step];
    if (!s || r.check || r.checked.has(r.step)) return;
    const q = stepCheckQuestion(s.lookFor);
    if (!q) return;
    checks += 1;
    r.checked.add(r.step);
    r.check = { step: r.step, at: now() };
    speech.say({ text: q, priority: 'NAV', dedupeKey: 'task-check', cooldownMs: 5000 });
    deps.conversation?.pushAisle(q, 'prompt');
  };

  const tick = async (r: RunState): Promise<void> => {
    if (run !== r || disposed) return;
    if (mode() !== 'GUIDED_TASK') {
      stop();
      return;
    }
    // Schedule before awaiting anything. Geometry keeps running even with a stalled
    // vision request, and advancing a step can never accidentally kill the loop.
    r.timer = setT(() => { void tick(r); }, deps.guide ? Math.min(tickMs, 500) : tickMs);
    const trackingBlocked = !!(deps.adaptiveSearch && deps.map && deps.pose && (!deps.pose() || !deps.map.trip.ready()));
    if (trackingBlocked) {
      handGuide.stop(); r.handing = false;
      speech.say({ text: 'Stop. Hold the phone steady while I recover our position.', priority: 'NAV', dedupeKey: 'task-tracking', cooldownMs: 10000 });
    }
    const step = r.steps[r.step];
    if ((r.fridge && r.step === 4) || (r.mission && r.step === 2)) return; // only user confirmation completes pickup
    if (r.mission && !trackingBlocked) {
      if (r.mission.phase() === 'reach') startMissionReach(r);
      else if (!r.handing) missionTick(r);
    }
    const geometric = trackingBlocked || r.mission ? true : speakGeometry(r);
    if (!trackingBlocked && geometric && !r.mission && r.doneReadings >= doneStreak) {
      advanceRun(r, false);
      return;
    }
    if (!trackingBlocked && step && !r.mission && (r.fridge ? r.step === 3 || (r.step === 1 && !r.checked.has(-1)) : isReachStep(step.instruction)) && !r.handing) {
      // The reach: steer the hand word by word until it touches the item, then close the task step.
      r.handing = true;
      const handleStage = r.fridge && r.step === 1;
      const item = handleStage ? (/\bfreezer\b/i.test(r.goal) ? 'freezer handle' : 'fridge handle') : itemOfGoal(r.goal);
      const handStep = r.step;
      void handGuide.start(item, { goal: r.goal, target: handleStage ? null : r.modelTarget }).then((res) => {
        if (run !== r || r.step !== handStep) return;
        r.handing = false;
        // A missing/hidden handle must not lock out checking an already-open door.
        // After one attempt, resume observing the opening checkpoint.
        if (handleStage) r.checked.add(-1);
        if (res.done === 'touching') {
          if (handleStage) {
            speech.say({ text: 'Find the handle by touch. Open the door slowly.', priority: 'NAV', dedupeKey: 'handle-open', cooldownMs: 4000 });
          } else advanceRun(r, false);
        }
        // gave up / stopped: the step stays open; the reminder and the next reach retry it.
      });
    }
    // Paused exploration must still see a recovered camera or a newly revealed
    // opening. Poll more slowly while stationary; never resume walking blindly.
    const visionInterval = r.search?.status() === 'paused' ? Math.max(tickMs, 5000) : tickMs;
    if (!r.asking && !r.handing && now() - r.lastVisionAt >= visionInterval) {
      r.asking = true;
      r.search?.analyzing?.(true);
      r.lastVisionAt = now();
      const askedStep = r.step;
      const searchRevision = r.searchRevision;
      const captureSteps = deps.steps?.();
      const captureHeading = deps.heading?.();
      const boxTarget = r.mission?.boxTarget() ?? r.searchTarget ?? '';
      asks += 1;
      lastAskAt = now();
      try {
        if (r.check && now() - r.check.at > checkTtlMs) r.check = null; // no answer: back to watching
        const out = await deps.vision.ask('task_step', { userText: userText(r), priority: 'NAV', silent: true, force: true });
        if (run !== r || r.step !== askedStep || r.searchRevision !== searchRevision || mode() !== 'GUIDED_TASK') return;
        const scene = out.response?.scene;
        const inferredContext = scene ? contextForSetting(scene.setting) : 'unknown';
        if ((out.status === 'applied' || out.status === 'low_confidence') && scene && scene.confidence >= 0.8 && inferredContext !== 'unknown' && inferredContext !== 'street'
          && deps.store.getState().scene?.source !== 'user' && r.context !== inferredContext) {
          r.sceneVote = r.sceneVote?.context === inferredContext ? { context: inferredContext, hits: r.sceneVote.hits + 1 } : { context: inferredContext, hits: 1 };
          if (r.sceneVote.hits >= 2) {
            deps.trace?.('search_context', { from: r.context, to: inferredContext, source: 'camera', reason: scene.label });
            void begin(r.goal, inferredContext);
            return;
          }
        } else r.sceneVote = undefined;
        const acceptedSearch = (out.status === 'applied' || out.status === 'low_confidence') && out.capturedAt !== null
          ? r.search?.observe(out.response?.search, out.seq, out.capturedAt ?? now() - (out.latencyMs ?? 0)) : false;
        deps.trace?.('search_observation', { status: out.status, seq: out.seq, capturedAt: out.capturedAt, latencyMs: out.latencyMs, trackingBlocked, search: out.response?.search ?? null });
        if (trackingBlocked) return;
        if (r.search?.status() === 'paused') return;
        if (r.search) {
          const currentHeading = deps.heading?.();
          const turned = typeof captureHeading === 'number' && typeof currentHeading === 'number'
            && Math.abs(((currentHeading - captureHeading + 540) % 360) - 180) > 15;
          if (turned || (captureSteps !== undefined && captureSteps !== deps.steps?.())) return;
        }
        const observation = out.status === 'applied' ? out.response?.search : undefined;
        // Round 11: Claude's landmarks are evidence for the navigator's hypotheses too — a counter it
        // boxed is a counter the phone can walk to, even when the detector has no box for it.
        if (r.mission && observation && observation.quality === 'usable') {
          for (const l of observation.landmarks) {
            const cls = classForWords(l.name);
            if (cls && l.confidence >= 0.6) r.mission.onModelBox(cls, l.box, now() - (out.latencyMs ?? 0));
          }
        }
        if (r.context === 'home' && !r.leftContainer && r.search && r.mission && observation && observation.confidence >= 0.8 && observation.quality === 'usable'
          && (observation.barrier === 'closed_fridge' || observation.barrier === 'closed_freezer')
          && observation.landmarks.some((l) => l.kind === 'appliance' && l.confidence >= 0.8 && /fridge|refrigerator|freezer/i.test(l.name))) {
          // Discovering a closed container inserts prerequisites before item approach.
          const appliance = observation.barrier === 'closed_freezer' ? 'freezer' : 'fridge';
          r.goal = `${r.mission.goal.item} in the ${appliance}`;
          r.steps = fridgeMission(r.goal)!.steps;
          r.mission = null; r.fridge = true; r.step = 0; r.modelTarget = null; r.searchTarget = null; r.guided = null;
          r.doneReadings = 0; r.search.restart();
          speakStep(r, false);
          return;
        }
        const itemBoxed = out.status === 'applied' && !!out.response && (
          (observation?.item?.box && observation.item.confidence >= 0.6 && observation.barrier !== 'closed_fridge' && observation.barrier !== 'closed_freezer')
          || (boxTarget === r.mission?.goal.item && out.response.target.box !== null && out.response.target.confidence >= 0.6));
        if (r.mission && itemBoxed) {
          const previous = r.itemEvidence;
          r.itemEvidence = { seq: out.seq, at: now() };
          // Steering by Claude's box waits for a second sighting (one frame can be a look-alike).
          const box = observation?.item?.box ?? out.response!.target.box;
          if (box && previous && previous.seq !== out.seq && now() - previous.at <= 15000) {
            r.mission.onModelBox(r.mission.goal.item, box, now() - (out.latencyMs ?? 0));
          }
        } else if (r.search) r.itemEvidence = undefined;
        deps.trace?.('task_step', { step: r.step, geometric, status: out.status, speech: out.response?.speech ?? null, done: out.response?.task ?? null, target: out.response?.target ?? null, latencyMs: out.latencyMs });
        if (run === r && out.status === 'applied' && out.response?.target.box && out.response.target.confidence >= (r.search || (r.fridge && r.step === 2) ? doneConfidence : 0.4)) {
          // A relocation landmark is never evidence that the fridge or item was found.
          if (!r.fridge || !r.searchTarget || r.searchTarget === (r.step === 2 ? itemOfGoal(r.goal) : /\bfreezer\b/i.test(r.goal) ? 'freezer' : 'fridge')) r.modelTarget = { box: out.response.target.box, at: now() - (out.latencyMs ?? 0) };
          if (r.mission && (!r.search || boxTarget !== r.mission.goal.item)) r.mission.onModelBox(boxTarget, out.response.target.box, now() - (out.latencyMs ?? 0));
        }
        if (r.mission) {
          // Geometry owns the words; the model's sentence only fills a silence it cannot.
          if (r.missionModelMaySpeak && (!r.search || acceptedSearch && r.search.narrating()) && !itemBoxed && out.status === 'applied' && out.response?.speech) {
            const proposed = out.response.speech;
            const walking = /\b(?:walk|walking|step|steps|move|moving|proceed|head toward|head towards)\b/i.test(proposed);
            const path = deps.path?.();
            const text = walking && (!path || !Number.isFinite(path.center) || path.center >= 0.7)
              ? 'Hold still while I check the path ahead.' : proposed;
            if (!hasDigit(text) && !findForbiddenTerm(text) && countWords(text) <= MAX_SEARCH_SPEECH_WORDS) {
              speech.say({ text, priority: 'NAV', searchNarration: true, dedupeKey: 'task-model', cooldownMs: 6000 });
              r.search?.narrated();
            }
          }
          return;
        }
        // Seeing an item (or a cloud claim of proximity) cannot close a walking
        // checkpoint. Only fresh geometric reach evidence above can do that.
        if (r.fridge && (r.step === 0 || r.step === 2)) return;
        if (geometric) return;
        if (out.status === 'applied' && out.response?.speech && !r.check) {
          const text = out.response.speech;
          if (!hasDigit(text) && !findForbiddenTerm(text) && countWords(text) <= MAX_UTTERANCE_WORDS) {
            speech.say({ text, priority: 'NAV', dedupeKey: 'task-model', cooldownMs: 6000 });
          }
        }
        const observing = isObservationStep(r.steps[r.step]?.instruction ?? '');
        if (run === r && observing && (now() - r.stepAt >= observeMs || (out.status === 'applied' && out.response?.task.done === true))) {
          // A look-around step is done once the camera has had its look.
          advanceRun(r, false);
        } else if (run === r && out.status === 'applied') {
          const verdict = readDone(out.response);
          if (verdict === 'done') {
            r.doneReadings += 1;
            if (r.doneReadings >= doneStreak) advanceRun(r, false);
          } else if (verdict === 'ask') {
            r.doneReadings = 0;
            openCheck(r);
          } else {
            r.doneReadings = 0;
          }
        }
      } catch {
        // The loop is best-effort; the reminder keeps the instruction alive.
      } finally {
        r.asking = false;
        r.search?.analyzing?.(false);
      }
    }
  };

  const factsForPlanner = (description: string | null): NonNullable<TaskPlanInput['facts']> | undefined => {
    let detections: string[] = [];
    let ocr: string[] = [];
    try {
      const f = deps.vision.getFacts?.();
      if (f) {
        detections = Array.from(new Set(f.detections.map((d) => d.cls))).slice(0, 12);
        ocr = f.ocrTokens.slice(0, 12);
      }
    } catch {
      // facts are a courtesy
    }
    const scene = deps.scene?.() ?? null;
    const seen = deps.seen?.() ?? '';
    const desc = [description, seen ? `Seen recently: ${seen}.` : null].filter(Boolean).join(' ') || null;
    if (detections.length === 0 && ocr.length === 0 && !scene && !desc) return undefined;
    return { detections, ocr, ...(scene ? { scene } : {}), ...(desc ? { description: desc } : {}) };
  };

  const begin = async (goal: string, context: TaskContext, leaveContainer = false, explorationConsent = true): Promise<void> => {
    stop();
    const gen = ++generation;
    const itemGuide = deps.guide?.instructionFor(itemOfGoal(goal));
    const inferredGoal = likelyFridgeGoal(goal, context,
      !!itemGuide && (itemGuide.targetVisible || itemGuide.kind !== 'scan_unknown'));
    const fixedFridge = deps.guide && context === 'home' && !leaveContainer ? fridgeMission(inferredGoal ?? goal) : null;
    if (fixedFridge && inferredGoal) {
      fixedFridge.steps[0] = {
        ...fixedFridge.steps[0]!,
        instruction: 'It may be in the fridge. Find the fridge first.',
      };
    }
    const search = deps.adaptiveSearch && deps.guide && context !== 'street' ? createSearchExplorer({ item: itemOfGoal(goal), context, guide: deps.guide, heading: deps.heading, steps: deps.steps, pose: deps.pose, path: deps.path, hfovDeg: deps.hfovDeg, signs: deps.signs, map: deps.map, now, trace: deps.trace,
      doorway: () => { const g = deps.guide!.instructionFor('the doorway'); return g?.targetVisible && g.box ? g.box : null; } }) : null;
    const missionGoal = deps.guide && !fixedFridge && (context === 'home' || search) ? parseMissionGoal(goal) : null;
    const mission = missionGoal ? createMissionRunner(missionGoal, { guide: deps.guide!, sceneLabel: deps.scene, search: search ?? undefined, context, map: deps.map, pose: deps.pose, now, ...(leaveContainer ? { initialTried: ['fridge', 'freezer'] } : {}) }) : null;

    const fixed = fixedFridge ?? (mission ? { askFirst: MISSION_STEPS[0].instruction, steps: [...MISSION_STEPS] } : null);
    if (!fixed) sayPhrase('let_me_see', 0);
    let description: string | null = null;
    if (!fixed && deps.describe) {
      try {
        description = await deps.describe();
      } catch {
        // A failed look is not a failed task.
      }
    }
    if (gen !== generation || disposed || mode() !== 'GUIDED_TASK') return;

    let plan: TaskPlanOutput;
    try {
      const facts = factsForPlanner(description);
      if (fixed) { plan = fixed; plannerFallback = false; }
      else {
        const result = await deps.planner.run('taskPlan', { goal, context, ...(facts ? { facts } : {}) });
        plan = result.output;
        plannerFallback = result.fallback;
      }
    } catch {
      plan = templateTaskPlan({ goal, context });
      plannerFallback = true;
    }
    if (gen !== generation || disposed || mode() !== 'GUIDED_TASK') return;
    if (!Array.isArray(plan.steps) || plan.steps.length === 0) plan = templateTaskPlan({ goal, context });

    const r: RunState = { search, searchTarget: null, mission, fridge: fixedFridge !== null, missionModelMaySpeak: false, lastVisionAt: -Infinity, gen, goal, context, steps: plan.steps, step: 0, doneReadings: 0, timer: null, remindTimer: null, reassureTimer: null, giveUpTimer: null, asking: false, check: null, checked: new Set(), stepAt: now(), description, handing: false, guided: null, modelTarget: null };
    run = r;
    r.leftContainer = leaveContainer;
    if (leaveContainer) {
      if (explorationConsent) r.mission?.explore();
      else r.search?.exploreNow(null, false);
    }
    deps.conversation?.pushAisle(`Plan: ${plan.steps.length === 1 ? 'one step' : `${plan.steps.length} steps`} to ${goal}.`, 'prompt');
    speakStep(r, false);
    // With a guide the loop runs on the fast clock from the start (geometry, not the model, sets the pace).
    r.timer = setT(() => { void tick(r); }, deps.guide ? Math.min(tickMs, 500) : tickMs);
  };

  unsubs.push(bus.on('TASK_REQUESTED', (e: Extract<AppEvent, { type: 'TASK_REQUESTED' }>) => {
    // The store's listener ran first: only an accepted request moved the mode.
    if (disposed || mode() !== 'GUIDED_TASK') return;
    void begin(e.goal, e.context);
  }));

  // Leaving GUIDED_TASK by any road (abort, DONE, a debug jump) ends the loop.
  unsubs.push(store.subscribe((s, prev) => {
    if (prev.mode === 'GUIDED_TASK' && s.mode !== 'GUIDED_TASK') stop();
    // An explicit location correction must replace an already-running home search.
    // Keep the shared trip map; rebuild only this mission's assumptions.
    if (s.mode === 'GUIDED_TASK' && run && s.scene !== prev.scene
      && s.scene?.confirmed && s.scene.source === 'user' && contextForSetting(s.scene.setting) !== 'unknown'
      && run.context !== contextForSetting(s.scene.setting)) {
      deps.trace?.('search_context', { from: run.context, to: contextForSetting(s.scene.setting), source: 'user' });
      void begin(run.goal, contextForSetting(s.scene.setting));
    }
  }));

  return {
    async onVoiceOutcome(o) {
      if (!run || mode() !== 'GUIDED_TASK') return;
      const intent = o.output.intent;
      if (intent === 'repeat') {
        speakStep(run, true);
        return;
      }
      if ((intent === 'unknown' || intent === 'help') && isAdvanceRequest(o.transcript)) advanceRun(run, true);
    },
    intercept(transcript) {
      const r = run;
      if (!r || mode() !== 'GUIDED_TASK') return false;
      const t = transcript.trim();
      if (r.fridge && r.search && r.step < 4 && exploreRequest(t).asked && r.step !== 0) {
        void begin(itemOfGoal(r.goal), r.context, true, !/\b(?:can|should|may|could) (?:i|we)\b/i.test(t));
        return true;
      }
      // "Explore" / "next aisle" while looking for the fridge itself: leave this spot now.
      if (r.fridge && r.search && r.step === 0 && exploreRequest(t).asked) {
        r.searchRevision = (r.searchRevision ?? 0) + 1;
        const d = r.search.exploreNow(exploreRequest(t).prefer, !/\b(?:can|should|may|could) (?:i|we)\b/i.test(t));
        r.searchTarget = d.target;
        if (d.haptic) deps.haptics.play(d.haptic);
        if (d.text) {
          speech.say({ text: d.text, priority: 'NAV', dedupeKey: 'task-search', cooldownMs: 0 });
          deps.conversation?.pushAisle(d.text, 'prompt');
        }
        return true;
      }
      if (r.step === 0 || (r.fridge && r.step === 2)) {
        const answer = r.search?.intercept(t);
        if (answer?.consumed) {
          r.searchRevision = (r.searchRevision ?? 0) + 1;
          if (answer.text) {
            speech.say({ text: answer.text, priority: 'NAV', dedupeKey: 'task-search-answer', cooldownMs: 0 });
            deps.conversation?.pushAisle(answer.text, 'prompt');
          }
          return true;
        }
      }
      if (r.mission) {
        // Open questions (room, "open it"), redirects ("try the cabinet"), "where have we looked".
        // Never while the person is answering the pickup question (step 2): "yes" means holding it.
        if (r.step !== 2) {
          const a = r.mission.intercept(t);
          if (a.consumed) {
            r.searchRevision = (r.searchRevision ?? 0) + 1;
            if (a.text) {
              speech.say({ text: a.text, priority: 'NAV', dedupeKey: 'task-guide', cooldownMs: 0 });
              deps.conversation?.pushAisle(a.text, 'prompt');
            }
            // A redirect while the hand loop runs: back to walking.
            if (r.handing && r.mission.phase() === 'find_place') { handGuide.stop(); r.handing = false; r.step = 0; r.guided = null; }
            missionTick(r);
            return true;
          }
        }
        if (r.step === 2 && (isAffirmative(t) || /^(?:i have|i am holding|i'm holding|got) (?:it|them|the .+)[.!]?$/i.test(t))) { complete(r); return true; }
        if (r.step === 2 && isNegative(t)) {
          r.mission.lost();
          r.step = 0;
          r.guided = null;
          speech.say({ text: 'Looking again.', priority: 'NAV', dedupeKey: 'task-guide', cooldownMs: 0 });
          missionTick(r);
          return true;
        }
        if (/^(?:where (?:is|are) (?:it|they|the .+)|where(?: are)? the .+|how far(?: is it)?)\??$/i.test(t) && r.step === 0) {
          r.mission.repeat();
          missionTick(r);
          return true;
        }
      }
      if (isAdvanceRequest(t)) { advanceRun(r, true); return true; }
      if (/^(?:repeat|what next|what am i doing|what is my task|what's my task|how far(?: is it)?)\??$/i.test(t)) {
        r.guided = null;
        speakStep(r, true);
        return true;
      }
      if (r.fridge && r.step === 1 && /^(?:the )?(?:fridge |refrigerator |freezer )?door is open[.!]?$|^i (?:have )?opened (?:it|the fridge|the freezer)[.!]?$/i.test(t)) { advanceRun(r, true); return true; }
      if (r.fridge && r.step === 4 && (YES_RE.test(t) || /^(?:i have|i am holding|i'm holding) (?:it|them|the eggs|the milk)[.!]?$/i.test(t))) { complete(r); return true; }
      if (!r.check) return false;
      if (YES_RE.test(t)) {
        advanceRun(r, false);
        return true;
      }
      if (NO_RE.test(t)) {
        r.check = null;
        r.doneReadings = 0;
        speakStep(r, true);
        return true;
      }
      return false;
    },
    advance() {
      if (run) advanceRun(run, true);
    },
    repeat() {
      if (run) speakStep(run, true);
    },
    isActive: () => run !== null,
    getDebugState() {
      return {
        ...(run?.search ? { searchAreas: run.search.memory() } : {}),
        stage: run?.fridge ? FRIDGE_STAGES[run.step] ?? null : run?.mission ? run.mission.phase() : null,
        target: run?.fridge ? (run.step === 2 ? itemOfGoal(run.goal) : /\bfreezer\b/i.test(run.goal) ? 'freezer' : 'fridge') : run?.mission ? run.mission.boxTarget() : null,
        active: run !== null,
        goal: run?.goal ?? null,
        context: run?.context ?? null,
        step: run?.step ?? 0,
        total: run?.steps.length ?? 0,
        asks,
        doneReadings: run?.doneReadings ?? 0,
        checkOpen: run?.check !== null && run?.check !== undefined,
        checks,
        plannerFallback,
        lastAskAt,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      for (const u of unsubs.splice(0)) u();
    },
  };
}
