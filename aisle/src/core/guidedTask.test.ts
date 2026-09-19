import type { PlannerResult, SpeechRequest, TaskPlanOutput, VisionResponse } from './contracts';
import { createEventBus } from './bus';
import { bindStoreToBus, createAppStore } from './store';
import { PHRASES } from './phrases';
import { createGuidedTask, isAdvanceRequest, TASK_REMIND_MS, TASK_TICK_MS, type GuidedTaskDeps } from './guidedTask';
import type { AskOutcome } from '../perception/semanticVision';

const T0 = 1_700_000_000_000;

const PLAN: TaskPlanOutput = {
  askFirst: 'Let me see your surroundings.',
  steps: [
    { instruction: 'Walk to the kitchen door frame.', lookFor: 'a door frame close ahead' },
    { instruction: 'Open the fridge door.', lookFor: 'the fridge door open' },
    { instruction: 'Reach for the eggs on the door shelf.', lookFor: 'the eggs within reach' },
  ],
};
const OBSERVE_PLAN: TaskPlanOutput = {
  askFirst: 'Let me see your surroundings.',
  steps: [
    { instruction: 'Turn slowly so I can see the room.', lookFor: 'the room layout' },
    ...PLAN.steps,
  ],
};
// The grocery demo: locate an item at the store. A look-around aisle-sign step, then walk
// to the aisle, then the shelf — the shape templateTaskPlan('store') and Nemotron return.
const STORE_PLAN: TaskPlanOutput = {
  askFirst: 'Let me see your surroundings.',
  steps: [
    { instruction: 'Turn slowly so I can see the aisle signs.', lookFor: 'an aisle sign' },
    { instruction: 'Walk to the pasta aisle.', lookFor: 'the pasta aisle sign' },
    { instruction: 'Face the shelf and reach for the pasta.', lookFor: 'the pasta within reach' },
  ],
};

function visionResponse(task: VisionResponse['task'], speech = ''): VisionResponse {
  return {
    speech,
    cameraRequest: 'none',
    userAction: 'none',
    aisle: { matchedAisleId: null, matchedLandmarkId: null, confidence: 0 },
    storefront: { visible: false, confidence: 0 },
    scan: { vehiclesSeen: 'none', confidence: 0 },
    signal: { state: 'UNKNOWN', confidence: 0 },
    hand: { hint: 'not_seen' },
    task,
    scene: { setting: 'unknown', label: '', confidence: 0 },
    confidence: 0.9,
    seq: 1,
  };
}

function applied(task: VisionResponse['task']): AskOutcome {
  return { status: 'applied', seq: 1, response: visionResponse(task), streamed: false, latencyMs: 400 };
}

interface Harness {
  deps: GuidedTaskDeps;
  bus: ReturnType<typeof createEventBus>;
  said: SpeechRequest[];
  haptic: string[];
  asks: jest.Mock;
  planner: jest.Mock;
  describe: jest.Mock;
  log: string[];
}

function harness(opts: { plan?: TaskPlanOutput; askImpl?: (userText: string) => Promise<AskOutcome>; plannerImpl?: () => Promise<PlannerResult<TaskPlanOutput>>; handHints?: Array<VisionResponse['hand']['hint']> } = {}): Harness {
  const bus = createEventBus();
  const store = createAppStore({ bus, warn: () => undefined, initial: { firstRun: false } });
  bindStoreToBus(store, bus);
  const said: SpeechRequest[] = [];
  const haptic: string[] = [];
  const log: string[] = [];
  // `hand_guidance` (the reach step, round 6c) answers "touching" unless a test says otherwise, so plans still complete.
  const handHints: Array<VisionResponse['hand']['hint']> = opts.handHints ? [...opts.handHints] : [];
  const handAnswer = async (): Promise<AskOutcome> => {
    const hint = handHints.length > 0 ? handHints.shift()! : 'touching';
    const r = visionResponse({ done: false, confidence: 0 });
    return { status: 'applied', seq: 1, response: { ...r, hand: { hint } }, streamed: false, latencyMs: 300 };
  };
  const asks = jest.fn((q: string, o: { userText?: string }) => {
    if (q === 'hand_guidance') return handAnswer();
    return opts.askImpl ? opts.askImpl(o.userText ?? '') : Promise.resolve(applied({ done: false, confidence: 0.2 }));
  });
  const planner = jest.fn(opts.plannerImpl ?? (async () => ({ job: 'taskPlan' as const, output: opts.plan ?? PLAN, fallback: false, latencyMs: 900 })));
  const describe = jest.fn(async () => 'A kitchen with a fridge on the left.');
  const deps: GuidedTaskDeps = {
    bus,
    store,
    speech: { say: (r) => { said.push(r); } },
    haptics: { play: (p) => { haptic.push(p); } },
    vision: { ask: asks as never, getFacts: () => ({ detections: [{ cls: 'refrigerator', score: 0.8, box: [0, 0, 0.5, 0.5] }] as never, ocrTokens: ['MILK'] }) },
    planner: { run: planner as never },
    describe,
    conversation: { pushAisle: (t) => { log.push(t); } },
    now: () => Date.now(),
    // Push the reassurance nudge past every timed assertion below; the one test that
    // exercises it passes its own small reassureMs.
    reassureMs: 120_000,
  };
  return { deps, bus, said, haptic, asks, planner, describe, log };
}

async function flush(ms = 0): Promise<void> {
  await jest.advanceTimersByTimeAsync(ms);
}

describe('createGuidedTask', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
  });
  afterEach(() => jest.useRealTimers());

  it('TASK_REQUESTED: "Let me see your surroundings." → describe → planner taskPlan with camera facts → step one spoken and on the band', async () => {
    const h = harness();
    const task = createGuidedTask(h.deps);
    h.deps.bus.emit({ type: 'TASK_REQUESTED', goal: 'eggs in my fridge', context: 'home', source: 'voice' });
    expect(h.deps.store.getState().mode).toBe('GUIDED_TASK');
    expect(h.deps.store.getState().taskGoal).toBe('eggs in my fridge');
    expect(h.said.map((r) => r.cacheKey)).toEqual(['let_me_see']);
    expect(h.said[0].text).toBe(PHRASES.let_me_see);
    await flush();
    expect(h.describe).toHaveBeenCalledTimes(1);
    // The look's own words reach the planner, so it can plan from "fridge on the left".
    expect(h.planner).toHaveBeenCalledWith('taskPlan', { goal: 'eggs in my fridge', context: 'home', facts: { detections: ['refrigerator'], ocr: ['MILK'], description: 'A kitchen with a fridge on the left.' } });
    expect(h.said.map((r) => r.text)).toEqual([PHRASES.let_me_see, PLAN.steps[0].instruction]);
    const steps = h.bus.history().filter((r) => r.event.type === 'TASK_STEP').map((r) => r.event);
    expect(steps).toEqual([{ type: 'TASK_STEP', index: 0, total: 3, instruction: PLAN.steps[0].instruction }]);
    expect(h.deps.store.getState().taskStep).toBe(0);
    expect(h.deps.store.getState().taskStepCount).toBe(3);
    expect(h.log).toEqual([PHRASES.let_me_see, 'Plan: 3 steps to eggs in my fridge.', PLAN.steps[0].instruction]);
    expect(task.isActive()).toBe(true);
    expect(task.getDebugState()).toMatchObject({ goal: 'eggs in my fridge', context: 'home', step: 0, total: 3, plannerFallback: false });
    task.dispose();
  });

  it('asks task_step with the goal, the step and what to look for; two confident done readings close the step', async () => {
    const readings: Array<VisionResponse['task']> = [
      { done: false, confidence: 0.3 },
      { done: true, confidence: 0.9 },
      { done: true, confidence: 0.4 },   // below every bar: streak resets
      { done: true, confidence: 0.8 },
      { done: true, confidence: 0.8 },
    ];
    const seen: string[] = [];
    const h = harness({ askImpl: async (userText) => { seen.push(userText); return applied(readings.shift() ?? { done: false, confidence: 0 }); } });
    const task = createGuidedTask(h.deps);
    h.deps.bus.emit({ type: 'TASK_REQUESTED', goal: 'eggs in my fridge', context: 'home', source: 'voice' });
    await flush();
    expect(h.asks).not.toHaveBeenCalled();
    await flush(TASK_TICK_MS);
    expect(h.asks).toHaveBeenCalledTimes(1);
    expect(h.asks.mock.calls[0][0]).toBe('task_step');
    expect(seen[0]).toBe('Goal: eggs in my fridge. Step 1 of 3: Walk to the kitchen door frame. Look for: a door frame close ahead.');
    await flush(TASK_TICK_MS * 3);
    // readings: no, yes, weak-yes → still on step one
    expect(task.getDebugState().step).toBe(0);
    await flush(TASK_TICK_MS);
    expect(h.asks).toHaveBeenCalledTimes(5);
    expect(task.getDebugState().step).toBe(1);
    expect(h.haptic).toEqual(['CONFIRM']);
    expect(h.said.map((r) => r.text)).toEqual([PHRASES.let_me_see, PLAN.steps[0].instruction, PHRASES.task_step_done, PLAN.steps[1].instruction]);
    expect(h.deps.store.getState().taskStep).toBe(1);
    // The next ask carries step two.
    await flush(TASK_TICK_MS);
    expect(seen[5]).toContain('Step 2 of 3: Open the fridge door.');
    task.dispose();
  });

  it('the last step done → "Done. Task complete." → TASK_COMPLETED → DONE, and the loop stops', async () => {
    const h = harness({ askImpl: async () => applied({ done: true, confidence: 0.95 }) });
    const task = createGuidedTask(h.deps);
    h.deps.bus.emit({ type: 'TASK_REQUESTED', goal: 'eggs in my fridge', context: 'home', source: 'keyboard' });
    await flush();
    // Each step needs two readings: 6 ticks for 3 steps.
    await flush(TASK_TICK_MS * 6);
    expect(h.deps.store.getState().mode).toBe('DONE');
    const completed = h.bus.history().filter((r) => r.event.type === 'TASK_COMPLETED');
    expect(completed).toHaveLength(1);
    expect(h.said.map((r) => r.text)).toEqual([
      PHRASES.let_me_see,
      PLAN.steps[0].instruction,
      PHRASES.task_step_done, PLAN.steps[1].instruction,
      PHRASES.task_step_done, PLAN.steps[2].instruction,
      PHRASES.hold_out_hand, PHRASES.grab_it,   // the reach step is the hand loop (round 6c)
      PHRASES.task_done,
    ]);
    expect(h.haptic).toEqual(['CONFIRM', 'CONFIRM', 'CONFIRM', 'CONFIRM']);   // two step closes, the touch, the completion
    expect(task.isActive()).toBe(false);
    const asksAtDone = h.asks.mock.calls.length;
    await flush(TASK_TICK_MS * 3);
    expect(h.asks).toHaveBeenCalledTimes(asksAtDone);
    task.dispose();
  });

  it('voice: "next" / "done" advance by hand ("Next step."), "repeat" re-speaks the step, and the reminder re-speaks it after twenty seconds', async () => {
    const h = harness();
    const task = createGuidedTask(h.deps);
    h.deps.bus.emit({ type: 'TASK_REQUESTED', goal: 'eggs in my fridge', context: 'home', source: 'voice' });
    await flush();
    await task.onVoiceOutcome({ output: { intent: 'repeat', item: null, reply: 'Repeating.' }, transcript: 'repeat' });
    expect(h.said.map((r) => r.text)).toEqual([PHRASES.let_me_see, PLAN.steps[0].instruction, PLAN.steps[0].instruction]);
    await task.onVoiceOutcome({ output: { intent: 'unknown', item: null, reply: 'x' }, transcript: 'Next step.' });
    expect(task.getDebugState().step).toBe(1);
    expect(h.said.slice(-2).map((r) => r.text)).toEqual([PHRASES.task_next, PLAN.steps[1].instruction]);
    await task.onVoiceOutcome({ output: { intent: 'unknown', item: null, reply: 'x' }, transcript: 'what is this' });
    expect(task.getDebugState().step).toBe(1);
    await flush(TASK_REMIND_MS);
    expect(h.said[h.said.length - 1].text).toBe(PLAN.steps[1].instruction);
    // "done" on the last step finishes the task.
    task.advance();
    expect(task.getDebugState().step).toBe(2);
    await task.onVoiceOutcome({ output: { intent: 'help', item: null, reply: 'x' }, transcript: 'done' });
    expect(h.deps.store.getState().mode).toBe('DONE');
    expect(task.isActive()).toBe(false);
    task.dispose();
  });

  it('abort mid-task ends the loop; a request outside IDLE is ignored; the planner miss uses the local template for the context', async () => {
    const h = harness({ plannerImpl: async () => { throw new Error('plan: deadline'); } });
    const task = createGuidedTask(h.deps);
    h.deps.bus.emit({ type: 'TASK_REQUESTED', goal: 'eggs', context: 'store', source: 'voice' });
    await flush();
    expect(task.getDebugState()).toMatchObject({ plannerFallback: true, total: 3 });
    expect(h.said[1].text).toBe('Turn slowly so I can see the aisle signs.');
    h.deps.store.getState().abort();
    expect(h.deps.store.getState().mode).toBe('IDLE');
    expect(task.isActive()).toBe(false);
    const asksBefore = h.asks.mock.calls.length;
    await flush(TASK_TICK_MS * 2);
    expect(h.asks).toHaveBeenCalledTimes(asksBefore);
    // Not IDLE (ONBOARDING): the store refuses the request, so nothing is spoken.
    h.deps.store.getState().setMode('ONBOARDING');
    const before = h.said.length;
    h.deps.bus.emit({ type: 'TASK_REQUESTED', goal: 'eggs', context: 'home', source: 'voice' });
    await flush();
    expect(h.said).toHaveLength(before);
    task.dispose();
  });

  it('a moderate done reading asks "It looks like <thing>. Is that right?" once per step; yes advances, no keeps watching', async () => {
    const readings: Array<VisionResponse['task']> = [
      { done: true, confidence: 0.6 },   // ask
      { done: true, confidence: 0.6 },   // already asked this step: no second question
    ];
    const h = harness({ askImpl: async () => applied(readings.shift() ?? { done: true, confidence: 0.6 }) });
    const task = createGuidedTask(h.deps);
    h.deps.bus.emit({ type: 'TASK_REQUESTED', goal: 'eggs in my fridge', context: 'home', source: 'voice' });
    await flush();
    await flush(TASK_TICK_MS);
    expect(h.said[h.said.length - 1].text).toBe('It looks like a door frame close ahead. Is that right?');
    expect(task.getDebugState()).toMatchObject({ checkOpen: true, checks: 1, step: 0 });
    // While the check is open the loop keeps asking silently and does not re-ask the user.
    await flush(TASK_TICK_MS);
    expect(task.getDebugState().checks).toBe(1);
    expect(h.asks.mock.calls[1][1]).toMatchObject({ silent: true });
    // "No": the step is repeated and the camera keeps watching; the same step is not checked again.
    expect(task.intercept('no')).toBe(true);
    expect(h.said[h.said.length - 1].text).toBe(PLAN.steps[0].instruction);
    expect(task.getDebugState().checkOpen).toBe(false);
    await flush(TASK_TICK_MS);
    expect(task.getDebugState()).toMatchObject({ checks: 1, step: 0 });
    // Step two: the check opens and "yes" closes the step.
    task.advance();
    expect(task.getDebugState().step).toBe(1);
    await flush(TASK_TICK_MS);
    expect(task.getDebugState()).toMatchObject({ checkOpen: true, checks: 2 });
    expect(task.intercept('eggs')).toBe(false);
    expect(task.intercept('Yes.')).toBe(true);
    expect(task.getDebugState().step).toBe(2);
    expect(h.said.slice(-2).map((r) => r.text)).toEqual([PHRASES.task_step_done, PLAN.steps[2].instruction]);
    // Nothing open: intercept passes.
    expect(task.intercept('yes')).toBe(false);
    task.dispose();
  });

  it('a look-around step closes on the first done reading of any confidence, or after eight seconds; the place rides along in the ask', async () => {
    const h = harness({ plan: OBSERVE_PLAN, askImpl: async () => applied({ done: true, confidence: 0.3 }) });
    const task = createGuidedTask({ ...h.deps, scene: () => 'in a kitchen by a refrigerator' });
    h.deps.bus.emit({ type: 'TASK_REQUESTED', goal: 'eggs in my fridge', context: 'home', source: 'voice' });
    await flush();
    expect(task.getDebugState().step).toBe(0);
    await flush(TASK_TICK_MS);
    expect(task.getDebugState().step).toBe(1);
    expect(h.said.slice(-2).map((r) => r.text)).toEqual([PHRASES.task_step_done, PLAN.steps[0].instruction]);
    expect(h.asks.mock.calls[0][1].userText).toBe('Goal: eggs in my fridge. Place: in a kitchen by a refrigerator. Step 1 of 4: Turn slowly so I can see the room. Look for: the room layout.');
    task.dispose();

    // No done reading at all: the timeout closes it.
    const h2 = harness({ plan: OBSERVE_PLAN, askImpl: async () => applied({ done: false, confidence: 0 }) });
    const task2 = createGuidedTask(h2.deps);
    h2.deps.bus.emit({ type: 'TASK_REQUESTED', goal: 'eggs in my fridge', context: 'home', source: 'voice' });
    await flush();
    await flush(TASK_TICK_MS * 2);
    expect(task2.getDebugState().step).toBe(0);
    await flush(TASK_TICK_MS);
    expect(task2.getDebugState().step).toBe(1);
    task2.dispose();
  });

  it('the reach step steers the hand word by word — "Hold out your hand." … "Higher." "Left." "Grab it." — then closes the task (round 6c)', async () => {
    const h = harness({ handHints: ['not_seen', 'not_seen', 'higher', 'left', 'forward', 'touching'] });
    const task = createGuidedTask({ ...h.deps, tickMs: 200 });
    h.deps.bus.emit({ type: 'TASK_REQUESTED', goal: 'eggs in my fridge', context: 'home', source: 'voice' });
    await flush();
    task.advance();           // → step two (open the fridge door)
    task.advance();           // → step three: "Reach for the eggs on the door shelf."
    expect(task.getDebugState().step).toBe(2);
    await flush(200);         // the tick hands over to the hand guide
    expect(h.said.map((r) => r.text)).toContain(PHRASES.hold_out_hand);
    // 2 s per hand reading: not_seen, not_seen (camera down), Higher., Left., Reach forward., Grab it.
    await flush(2000 * 6 + 100);
    const hand = h.said.map((r) => r.text).filter((s) => [PHRASES.higher, PHRASES.left, PHRASES.reach_forward, PHRASES.grab_it, 'Tilt the camera down.'].includes(s));
    expect(hand).toEqual(['Tilt the camera down.', PHRASES.higher, PHRASES.left, PHRASES.reach_forward, PHRASES.grab_it]);
    expect(h.asks.mock.calls.filter((c) => c[0] === 'hand_guidance')[0]![1]).toMatchObject({ targetItem: 'eggs', image: 640, silent: true });
    expect(h.deps.store.getState().mode).toBe('DONE');
    expect(h.haptic.filter((p) => p === 'CONFIRM').length).toBeGreaterThanOrEqual(2);
    task.dispose();
  });

  it('a failed look and a vision error do not stop the task', async () => {
    const h = harness({ askImpl: async () => { throw new Error('vision down'); } });
    h.describe.mockImplementation(async () => { throw new Error('no camera'); });
    const task = createGuidedTask(h.deps);
    h.deps.bus.emit({ type: 'TASK_REQUESTED', goal: 'eggs in my fridge', context: 'home', source: 'voice' });
    await flush();
    expect(task.isActive()).toBe(true);
    await flush(TASK_TICK_MS * 2);
    expect(h.asks).toHaveBeenCalledTimes(2);
    expect(task.isActive()).toBe(true);
    task.dispose();
    expect(task.isActive()).toBe(false);
  });

  it('store context: "find the pasta" → look → aisle-sign step → walk to the aisle → shelf → complete', async () => {
    const seen: string[] = [];
    const h = harness({ plan: STORE_PLAN, askImpl: async (userText) => { seen.push(userText); return applied({ done: true, confidence: 0.9 }); } });
    const task = createGuidedTask({ ...h.deps, scene: () => 'in a store aisle' });
    h.deps.bus.emit({ type: 'TASK_REQUESTED', goal: 'pasta', context: 'store', source: 'voice' });
    expect(h.deps.store.getState().mode).toBe('GUIDED_TASK');
    expect(h.deps.store.getState().taskGoal).toBe('pasta');
    await flush();
    // The look feeds the planner the store context and what the camera saw.
    expect(h.planner).toHaveBeenCalledWith('taskPlan', expect.objectContaining({ goal: 'pasta', context: 'store' }));
    expect(h.said.map((r) => r.text)).toEqual([PHRASES.let_me_see, STORE_PLAN.steps[0].instruction]);
    // Step one is a look-around ("Turn slowly so I can see the aisle signs."): it closes on the first camera reading.
    await flush(TASK_TICK_MS);
    expect(task.getDebugState().step).toBe(1);
    expect(h.said.slice(-2).map((r) => r.text)).toEqual([PHRASES.task_step_done, STORE_PLAN.steps[1].instruction]);
    // The store aisle rides along in the ask so Claude grounds its hint on where the shopper is.
    await flush(TASK_TICK_MS);
    expect(seen.some((u) => u.includes('Place: in a store aisle.') && u.includes('Step 2 of 3: Walk to the pasta aisle.'))).toBe(true);
    expect(task.getDebugState().step).toBe(1);
    // Walk-to-aisle then the shelf each close on two confident readings.
    await flush(TASK_TICK_MS);
    expect(task.getDebugState().step).toBe(2);
    await flush(TASK_TICK_MS * 2);
    expect(h.deps.store.getState().mode).toBe('DONE');
    expect(h.bus.history().filter((r) => r.event.type === 'TASK_COMPLETED')).toHaveLength(1);
    expect(h.said[h.said.length - 1].text).toBe(PHRASES.task_done);
    task.dispose();
  });

  it('fills the quiet between step reminders with a reassurance nudge at INFO', async () => {
    const h = harness({ askImpl: async () => applied({ done: false, confidence: 0.2 }) });
    const task = createGuidedTask({ ...h.deps, reassureMs: 5000 });
    h.deps.bus.emit({ type: 'TASK_REQUESTED', goal: 'eggs in my fridge', context: 'home', source: 'voice' });
    await flush();   // step one spoken; the step does not auto-close (readings are never done)
    await flush(5000);
    const nudge = h.said[h.said.length - 1];
    expect(nudge.text).toBe(PHRASES.task_still_looking);
    expect(nudge.priority).toBe('INFO');
    expect(h.log).toContain(PHRASES.task_still_looking);
    task.dispose();
  });

  it('gives up gracefully after a long stall: "Ask staff…" and the task completes', async () => {
    const h = harness({ askImpl: async () => applied({ done: false, confidence: 0.1 }) });
    const task = createGuidedTask({ ...h.deps, giveUpMs: 30_000 });
    h.deps.bus.emit({ type: 'TASK_REQUESTED', goal: 'pasta', context: 'store', source: 'voice' });
    await flush();
    expect(task.isActive()).toBe(true);
    // The step never confirms; after the give-up window the task ends with "ask staff".
    await flush(30_000);
    expect(h.said.map((r) => r.text)).toContain(PHRASES.ask_staff);
    expect(h.bus.history().filter((r) => r.event.type === 'TASK_COMPLETED')).toHaveLength(1);
    expect(h.deps.store.getState().mode).toBe('DONE');
    expect(task.isActive()).toBe(false);
    task.dispose();
  });

  it('isAdvanceRequest matches the hands-free confirmations only', () => {
    for (const t of ['next', 'Next step.', 'done', 'I did it', 'okay, next', 'skip this step', 'got it', 'continue']) expect(isAdvanceRequest(t)).toBe(true);
    for (const t of ['what is next to me', 'is it done yet', 'eggs', 'the door is open', '']) expect(isAdvanceRequest(t)).toBe(false);
  });
});
