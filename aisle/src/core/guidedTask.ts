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
import type { AppEvent, AppMode, HapticService, SpeechService, TaskContext, TaskPlanOutput, VisionResponse } from './contracts';
import type { AppEventBus } from './bus';
import type { AppStore } from './store';
import type { ConversationLog } from './conversation';
import type { VoiceOutcome } from './voice';
import { phraseText } from './phrases';
import type { SemanticVision } from '../perception/semanticVision';
import type { PlannerClient } from '../outdoor/planner';
import { templateTaskPlan } from '../outdoor/plannerJobs';

export const TASK_TICK_MS = 3000;
export const TASK_DONE_CONFIDENCE = 0.6;
export const TASK_REMIND_MS = 20_000;
/** Two consecutive `done` readings before a step closes on camera evidence alone (one blurry frame must not skip a step). */
export const TASK_DONE_STREAK = 2;

const NEXT_RE = /^(?:ok(?:ay)?[,. ]*)?(?:next(?: step)?|done|did it|i did it|got it|skip(?: (?:this|that|it))?(?: step)?|finished|complete[d]?|continue|go on)[.!]?$/i;

export function isAdvanceRequest(transcript: string): boolean {
  return NEXT_RE.test(transcript.trim());
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
  conversation?: Pick<ConversationLog, 'pushAisle'>;
  now?: () => number;
  tickMs?: number;
  remindMs?: number;
  doneConfidence?: number;
  doneStreak?: number;
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
  plannerFallback: boolean | null;
  lastAskAt: number | null;
}

export interface GuidedTask {
  /** App routes every parsed voice outcome here (like `trip.onVoiceOutcome`). */
  onVoiceOutcome(o: Pick<VoiceOutcome, 'output' | 'transcript'>): Promise<void>;
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
  asking: boolean;
}

export function createGuidedTask(deps: GuidedTaskDeps): GuidedTask {
  const now = deps.now ?? Date.now;
  const tickMs = deps.tickMs ?? TASK_TICK_MS;
  const remindMs = deps.remindMs ?? TASK_REMIND_MS;
  const doneConfidence = deps.doneConfidence ?? TASK_DONE_CONFIDENCE;
  const doneStreak = deps.doneStreak ?? TASK_DONE_STREAK;
  const setT: typeof setTimeout = deps.setTimeoutFn ?? setTimeout;
  const clearT: typeof clearTimeout = deps.clearTimeoutFn ?? clearTimeout;
  const { bus, store, speech } = deps;

  let run: RunState | null = null;
  let generation = 0;
  let disposed = false;
  let asks = 0;
  let plannerFallback: boolean | null = null;
  let lastAskAt: number | null = null;
  const unsubs: Array<() => void> = [];

  const mode = (): AppMode => store.getState().mode;

  const sayPhrase = (key: 'let_me_see' | 'task_done' | 'task_step_done' | 'task_next', cooldownMs = 2000): void => {
    speech.say({ text: phraseText(key), priority: 'NAV', cacheKey: key, dedupeKey: `task-${key}`, cooldownMs });
  };

  const clearTimers = (r: RunState): void => {
    if (r.timer !== null) clearT(r.timer);
    if (r.remindTimer !== null) clearT(r.remindTimer);
    r.timer = null;
    r.remindTimer = null;
  };

  const stop = (): void => {
    if (!run) return;
    clearTimers(run);
    run = null;
    generation += 1;
  };

  const speakStep = (r: RunState, reminder: boolean): void => {
    const s = r.steps[r.step];
    if (!s) return;
    speech.say({ text: s.instruction, priority: 'NAV', dedupeKey: `task-step-${r.step}`, cooldownMs: reminder ? 0 : 1500 });
    if (!reminder) bus.emit({ type: 'TASK_STEP', index: r.step, total: r.steps.length, instruction: s.instruction });
    scheduleRemind(r);
  };

  const scheduleRemind = (r: RunState): void => {
    if (r.remindTimer !== null) clearT(r.remindTimer);
    r.remindTimer = setT(() => {
      r.remindTimer = null;
      if (run !== r || mode() !== 'GUIDED_TASK') return;
      speakStep(r, true);
    }, remindMs);
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
    return `Goal: ${r.goal}. Step ${r.step + 1} of ${r.steps.length}: ${s.instruction} Look for: ${s.lookFor}.`;
  };

  const readDone = (res: VisionResponse | null): boolean => {
    if (!res) return false;
    const t = res.task;
    return t.done === true && t.confidence >= doneConfidence;
  };

  const tick = async (r: RunState): Promise<void> => {
    if (run !== r || disposed) return;
    if (mode() !== 'GUIDED_TASK') {
      stop();
      return;
    }
    if (!r.asking) {
      r.asking = true;
      asks += 1;
      lastAskAt = now();
      try {
        const out = await deps.vision.ask('task_step', { userText: userText(r), priority: 'NAV' });
        if (run === r && out.status === 'applied' && readDone(out.response)) {
          r.doneReadings += 1;
          if (r.doneReadings >= doneStreak) advanceRun(r, false);
        } else if (run === r && out.status === 'applied') {
          r.doneReadings = 0;
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

  const factsForPlanner = (): { detections: string[]; ocr: string[] } | undefined => {
    if (!deps.vision.getFacts) return undefined;
    try {
      const f = deps.vision.getFacts();
      const detections = Array.from(new Set(f.detections.map((d) => d.cls))).slice(0, 12);
      const ocr = f.ocrTokens.slice(0, 12);
      return { detections, ocr };
    } catch {
      return undefined;
    }
  };

  const begin = async (goal: string, context: TaskContext): Promise<void> => {
    stop();
    const gen = ++generation;
    sayPhrase('let_me_see', 0);
    if (deps.describe) {
      try {
        await deps.describe();
      } catch {
        // A failed look is not a failed task.
      }
    }
    if (gen !== generation || disposed || mode() !== 'GUIDED_TASK') return;

    let plan: TaskPlanOutput;
    try {
      const facts = factsForPlanner();
      const result = await deps.planner.run('taskPlan', { goal, context, ...(facts ? { facts } : {}) });
      plan = result.output;
      plannerFallback = result.fallback;
    } catch {
      plan = templateTaskPlan({ goal, context });
      plannerFallback = true;
    }
    if (gen !== generation || disposed || mode() !== 'GUIDED_TASK') return;
    if (plan.steps.length === 0) plan = templateTaskPlan({ goal, context });

    const r: RunState = { gen, goal, context, steps: plan.steps, step: 0, doneReadings: 0, timer: null, remindTimer: null, asking: false };
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
