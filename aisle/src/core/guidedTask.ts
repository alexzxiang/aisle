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
import { MAX_UTTERANCE_WORDS, countWords, findForbiddenTerm, hasDigit, phraseText } from './phrases';
import type { SemanticVision } from '../perception/semanticVision';
import type { PlannerClient } from '../outdoor/planner';
import { templateTaskPlan } from '../outdoor/plannerJobs';
import { createHandGuide, itemOfGoal, type HandGuide } from './handGuide';

export const TASK_TICK_MS = 3000;
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
/** Two consecutive `done` readings before a step closes on camera evidence alone (one blurry frame must not skip a step). */
export const TASK_DONE_STREAK = 2;
/** An unanswered step check expires after this; the loop goes back to watching. */
export const TASK_CHECK_TTL_MS = 15_000;
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
  conversation?: Pick<ConversationLog, 'pushAisle'>;
  now?: () => number;
  tickMs?: number;
  remindMs?: number;
  reassureMs?: number;
  doneConfidence?: number;
  askConfidence?: number;
  doneStreak?: number;
  checkTtlMs?: number;
  observeMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export interface GuidedTaskDebugState {
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
  gen: number;
  goal: string;
  context: TaskContext;
  steps: TaskPlanOutput['steps'];
  step: number;
  doneReadings: number;
  timer: ReturnType<typeof setTimeout> | null;
  remindTimer: ReturnType<typeof setTimeout> | null;
  reassureTimer: ReturnType<typeof setTimeout> | null;
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
}

export function createGuidedTask(deps: GuidedTaskDeps): GuidedTask {
  const now = deps.now ?? Date.now;
  const tickMs = deps.tickMs ?? TASK_TICK_MS;
  const remindMs = deps.remindMs ?? TASK_REMIND_MS;
  const reassureMs = deps.reassureMs ?? TASK_REASSURE_MS;
  const doneConfidence = deps.doneConfidence ?? TASK_DONE_CONFIDENCE;
  const askConfidence = deps.askConfidence ?? TASK_ASK_CONFIDENCE;
  const doneStreak = deps.doneStreak ?? TASK_DONE_STREAK;
  const checkTtlMs = deps.checkTtlMs ?? TASK_CHECK_TTL_MS;
  const observeMs = deps.observeMs ?? TASK_OBSERVE_MS;
  const setT: typeof setTimeout = deps.setTimeoutFn ?? setTimeout;
  const clearT: typeof clearTimeout = deps.clearTimeoutFn ?? clearTimeout;
  const { bus, store, speech } = deps;

  const handGuide: HandGuide = deps.handGuide ?? createHandGuide({ vision: deps.vision, speech, haptics: deps.haptics, bus, conversation: deps.conversation, now });
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
    r.timer = null;
    r.remindTimer = null;
    r.reassureTimer = null;
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
    speech.say({ text: s.instruction, priority: 'NAV', dedupeKey: `task-step-${r.step}`, cooldownMs: reminder ? 0 : 1500 });
    if (!reminder) {
      r.stepAt = now();
      deps.conversation?.pushAisle(s.instruction, 'prompt');
      bus.emit({ type: 'TASK_STEP', index: r.step, total: r.steps.length, instruction: s.instruction });
    }
    scheduleRemind(r);
    scheduleReassure(r);
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
      if (run !== r || mode() !== 'GUIDED_TASK' || r.check !== null) return;
      const text = phraseText('task_still_looking');
      speech.say({ text, priority: 'INFO', cacheKey: 'task_still_looking', dedupeKey: 'task-reassure', cooldownMs: reassureMs });
      deps.conversation?.pushAisle(text, 'prompt');
    }, reassureMs);
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
    speakStep(r, false);
  };

  const userText = (r: RunState): string => {
    const s = r.steps[r.step]!;
    const place = deps.scene?.();
    const where = place ? ` Place: ${place}.` : '';
    const seen = deps.seen?.();
    const memory = seen ? ` Seen: ${seen}.` : '';
    return `Goal: ${r.goal}.${where}${memory} Step ${r.step + 1} of ${r.steps.length}: ${s.instruction} Look for: ${s.lookFor}.`;
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
    const step = r.steps[r.step];
    if (step && isReachStep(step.instruction) && !r.handing) {
      // The reach: steer the hand word by word until it touches the item, then close the task step.
      r.handing = true;
      const item = itemOfGoal(r.goal);
      void handGuide.start(item).then((res) => {
        if (run !== r) return;
        r.handing = false;
        if (res.done === 'touching') advanceRun(r, false);
        // gave up / stopped: the step stays open; the reminder and the next reach retry it.
      });
    }
    if (!r.asking && !r.handing) {
      r.asking = true;
      asks += 1;
      lastAskAt = now();
      try {
        if (r.check && now() - r.check.at > checkTtlMs) r.check = null; // no answer: back to watching
        const out = await deps.vision.ask('task_step', { userText: userText(r), priority: 'NAV', silent: r.check !== null });
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
      }
    }
    if (run !== r) return;
    r.timer = setT(() => { void tick(r); }, tickMs);
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

  const begin = async (goal: string, context: TaskContext): Promise<void> => {
    stop();
    const gen = ++generation;
    sayPhrase('let_me_see', 0);
    let description: string | null = null;
    if (deps.describe) {
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
      const result = await deps.planner.run('taskPlan', { goal, context, ...(facts ? { facts } : {}) });
      plan = result.output;
      plannerFallback = result.fallback;
    } catch {
      plan = templateTaskPlan({ goal, context });
      plannerFallback = true;
    }
    if (gen !== generation || disposed || mode() !== 'GUIDED_TASK') return;
    if (!Array.isArray(plan.steps) || plan.steps.length === 0) plan = templateTaskPlan({ goal, context });

    const r: RunState = { gen, goal, context, steps: plan.steps, step: 0, doneReadings: 0, timer: null, remindTimer: null, reassureTimer: null, asking: false, check: null, checked: new Set(), stepAt: now(), description, handing: false };
    run = r;
    deps.conversation?.pushAisle(`Plan: ${plan.steps.length === 1 ? 'one step' : `${plan.steps.length} steps`} to ${goal}.`, 'prompt');
    speakStep(r, false);
    r.timer = setT(() => { void tick(r); }, tickMs);
  };

  unsubs.push(bus.on('TASK_REQUESTED', (e: Extract<AppEvent, { type: 'TASK_REQUESTED' }>) => {
    // The store's listener ran first: only an accepted request moved the mode.
    if (disposed || mode() !== 'GUIDED_TASK') return;
    void begin(e.goal, e.context);
  }));

  // Leaving GUIDED_TASK by any road (abort, DONE, a debug jump) ends the loop.
  unsubs.push(store.subscribe((s, prev) => {
    if (prev.mode === 'GUIDED_TASK' && s.mode !== 'GUIDED_TASK') stop();
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
      if (!r || !r.check || mode() !== 'GUIDED_TASK') return false;
      const t = transcript.trim();
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
