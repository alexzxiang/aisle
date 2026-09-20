import type { Detection, PlannerResult, SpeechRequest, TaskPlanOutput, VisionResponse } from './contracts';
import { createEventBus } from './bus';
import { bindStoreToBus, createAppStore } from './store';
import { PHRASES } from './phrases';
import { createGuide } from './guide';
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
    target: { box: null, confidence: 0 },
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
    r.target = { box: [0.2, 0.3, 0.2, 0.15], confidence: 0.9 };
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

  it('continues camera checks after an adaptive search pauses and recovers when frames return', async () => {
    let recovered = false;
    let seq = 0;
    const h = harness({ askImpl: async () => {
      const response = visionResponse({ done: false, confidence: 0 });
      if (recovered) response.search = { sign: null, items: [], view: 'overview', quality: 'usable', confidence: 0.9, barrier: 'none', landmarks: [] };
      return { status: 'applied', seq: ++seq, capturedAt: Date.now(), response, streamed: false, latencyMs: 0 };
    } });
    const guide = createGuide({ detections: () => [], memory: { whereIs: () => 'unseen', facing: () => 0 }, hfovDeg: () => 56, now: () => Date.now() });
    const task = createGuidedTask({ ...h.deps, guide, adaptiveSearch: true });
    h.bus.emit({ type: 'TASK_REQUESTED', goal: 'bananas', context: 'store', source: 'keyboard' });
    await flush(35000);
    expect(h.said.some(r => r.text.includes('Waiting for camera analysis'))).toBe(true);
    const count = h.asks.mock.calls.length;
    await flush(6000);
    expect(h.asks.mock.calls.length).toBeGreaterThan(count);
    recovered = true;
    const spoken = h.said.length;
    await flush(10000);
    expect(h.said.slice(spoken).some(r => /Point along the aisle|Hold steady for a quick look/.test(r.text))).toBe(true);
    task.dispose();
  });

  it('starts an unseen egg search at a hypothesized fridge without claiming eggs are visible', async () => {
    const h = harness();
    h.deps.guide = createGuide({
      detections: () => [], memory: { whereIs: () => 'unseen', facing: () => 0 },
      hfovDeg: () => 60, now: () => Date.now(),
    });
    const task = createGuidedTask(h.deps);
    h.bus.emit({ type: 'TASK_REQUESTED', goal: 'eggs', context: 'home', source: 'voice' });
    await flush();
    expect(h.planner).not.toHaveBeenCalled();
    expect(h.said.some(r => r.text === 'It may be in the fridge. Find the fridge first.')).toBe(true);
    expect(task.getDebugState()).toMatchObject({ goal: 'eggs', step: 0, total: 5 });
    task.dispose();
  });

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
    expect(seen[0]).toBe('Setting: home. Goal: eggs in my fridge. Step 1 of 3: Walk to the kitchen door frame. Look for: a door frame close ahead.');
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
      PHRASES.hold_out_hand, PHRASES.mission_hand_aligned,
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
    expect(h.asks.mock.calls[0][1].userText).toBe('Setting: home. Goal: eggs in my fridge. Step 1 of 4: Turn slowly so I can see the room. Look for: the room layout. Place: in a kitchen by a refrigerator.');
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
    const hand = h.said.map((r) => r.text).filter((s) => [PHRASES.higher, PHRASES.left, PHRASES.reach_forward, PHRASES.mission_hand_aligned, 'Tilt the camera down.'].includes(s));
    expect(hand).toEqual(['Tilt the camera down.', PHRASES.higher, PHRASES.left, PHRASES.reach_forward, PHRASES.mission_hand_aligned]);
    expect(h.asks.mock.calls.filter((c) => c[0] === 'hand_guidance')[0]![1]).toMatchObject({ targetItem: 'eggs', image: 768, silent: true });
    expect(h.deps.store.getState().mode).toBe('DONE');
    expect(h.haptic.filter((p) => p === 'CONFIRM').length).toBeGreaterThanOrEqual(2);
    task.dispose();
  });

  it('round 7: with the fridge in view the walking step says forward with steps, off to the side it says turn, and arrival closes the step', async () => {
    const detections: { list: Detection[] } = { list: [] };
    const guide = createGuide({
      detections: () => detections.list,
      memory: { whereIs: () => 'unseen', facing: () => 0 },
      hfovDeg: () => 56,
      now: () => Date.now(),
    });
    const h = harness({ askImpl: async () => applied({ done: false, confidence: 0.1 }) });
    const task = createGuidedTask({ ...h.deps, guide, tickMs: 500 });
    h.deps.bus.emit({ type: 'TASK_REQUESTED', goal: 'eggs in my fridge', context: 'home', source: 'voice' });
    await flush();
    // Step one ("Walk to the kitchen door frame.") is spoken; geometry waits four seconds.
    await flush(3500);
    expect(h.said.map((r) => r.text)).not.toContainEqual(expect.stringMatching(/Walk forward|Turn right/));
    // The fridge is in view, off to the right, mid-frame height.
    detections.list = [{ cls: 'fridge', box: [0.65, 0.3, 0.25, 0.4], score: 0.9, trackId: 1 }];
    await flush(1000);
    const first = h.said[h.said.length - 1].text;
    expect(first).toMatch(/right/i);
    expect(first).toMatch(/fridge/i);
    // Facing it now: forward with a step count.
    detections.list = [{ cls: 'fridge', box: [0.38, 0.3, 0.25, 0.4], score: 0.9, trackId: 1 }];
    await flush(3000);
    const second = h.said[h.said.length - 1].text;
    expect(second).toMatch(/ahead|forward/i);
    expect(second).toMatch(/steps/);
    expect(second).not.toMatch(/\d/);
    // Same instruction again within six seconds: silence.
    const count = h.said.length;
    await flush(1000);
    expect(h.said.length).toBe(count);
    // At the fridge (tall box, depth says close): the step closes and the next one is announced.
    detections.list = [{ cls: 'fridge', box: [0.01, 0.005, 0.98, 0.99], score: 0.9, trackId: 1, near: 0.9 }];
    await flush(1500);
    expect(h.said.map((r) => r.text)).toContain('Fridge close ahead. Stop here.');
    expect(task.getDebugState().step).toBe(1);
    // The model's prose was muted while geometry spoke.
    expect(h.asks.mock.calls.filter((c) => c[0] === 'task_step').slice(-3).every((c) => c[1].silent === true)).toBe(true);
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

  it.each(['fridge', 'freezer'])('%s mission starts without a planner, keeps geometry alive during stalled vision, and rejects an old step reply', async (appliance) => {
    let finishAsk!: (v: AskOutcome) => void;
    const h = harness({ askImpl: () => new Promise((resolve) => { finishAsk = resolve; }) });
    let detections: Detection[] = [{ cls: 'fridge', box: [0.6, 0.2, 0.3, 0.4], score: 0.9, trackId: 1 }];
    const guide = createGuide({ detections: () => detections, memory: { whereIs: () => 'unseen', facing: () => 0 }, hfovDeg: () => 56 });
    const task = createGuidedTask({ ...h.deps, guide });
    h.bus.emit({ type: 'TASK_REQUESTED', goal: `eggs from my ${appliance}`, context: 'home', source: 'voice' });
    expect(h.planner).not.toHaveBeenCalled();
    expect(h.describe).not.toHaveBeenCalled();
    expect(h.said[0].text).toMatch(/Turn right about .* degrees toward the (fridge|freezer)/);
    await flush(3000); // cloud request hangs
    detections = [{ cls: 'fridge', box: [0.3, 0.2, 0.4, 0.4], score: 0.9, trackId: 1 }];
    await flush(500);
    expect(h.said.at(-1)?.text).toMatch(/(?:Fridge|Freezer) ahead.*steps/);
    detections = [{ cls: 'fridge', box: [0.01, 0.005, 0.98, 0.99], near: 0.9, score: 0.9, trackId: 1 }];
    await flush(1000);
    expect(task.getDebugState()).toMatchObject({ stage: 'open', goal: `eggs from my ${appliance}` });
    const old = applied({ done: true, confidence: 0.99 });
    old.response!.speech = 'Old walking instruction.';
    finishAsk(old);
    await flush();
    expect(task.getDebugState()).toMatchObject({ stage: 'open', doneReadings: 0 });
    expect(h.said.some((r) => r.text === 'Old walking instruction.')).toBe(false);
    await flush(5000);
    expect(task.getDebugState().stage).toBe('open'); // closeness does not open a door
    expect(h.asks.mock.calls.at(-1)![1].userText).toContain('Stage: open');
    task.dispose();
  });

  it('bananas on the table, bananas in view: guides at once from geometry (no planner, no description), reaches, confirms', async () => {
    const h = harness();
    let dets: Detection[] = [
      { cls: 'banana', box: [0.7, 0.4, 0.1, 0.1], score: 0.9, trackId: 1 },
      { cls: 'table', box: [0.1, 0.3, 0.4, 0.4], score: 0.9, trackId: 2 },
    ];
    const guide = createGuide({ detections: () => dets, memory: { whereIs: () => 'unseen', facing: () => 0 }, hfovDeg: () => 56, now: () => Date.now() });
    const task = createGuidedTask({ ...h.deps, guide });
    h.bus.emit({ type: 'TASK_REQUESTED', goal: 'bananas on the table', context: 'home', source: 'voice' });
    expect(h.planner).not.toHaveBeenCalled();
    expect(h.describe).not.toHaveBeenCalled();
    expect(h.said[0].text).toMatch(/^Bananas slightly right\. Turn right a little, then walk/);
    expect(h.haptic).toContain('TURN');
    expect(task.getDebugState()).toMatchObject({ stage: 'approach_item', goal: 'bananas on the table', total: 3, step: 0 });
    // The model is asked silently for the item's box; its words stay muted while geometry speaks.
    await flush(TASK_TICK_MS);
    expect(h.asks.mock.calls.some(([q, o]: [string, { userText?: string; silent?: boolean }]) => q === 'task_step' && /Look for: bananas/.test(o.userText ?? '') && o.silent)).toBe(true);
    // Walk up: within reach → the hand loop → touching → the pickup question → "yes" → done.
    dets = [{ cls: 'banana', box: [0.3, 0.2, 0.4, 0.7], score: 0.9, trackId: 1 }];
    await flush(2500);
    expect(h.said.map((s) => s.text)).toContain('Bananas right in front of you. Reach out.');
    expect(task.getDebugState().step).toBeGreaterThanOrEqual(1);
    await flush(4000);
    expect(task.getDebugState()).toMatchObject({ stage: 'confirm', step: 2 });
    expect(h.said.map((s) => s.text)).toContain('Have you picked it up? Say yes when you have it.');
    expect(task.intercept('yes I have them')).toBe(true);
    expect(h.said[h.said.length - 1].text).toBe(PHRASES.task_done);
    task.dispose();
  });

  it('bananas on the table, only the table in view: walks to the table, then scans it; "where are they" repeats', async () => {
    const h = harness();
    let dets: Detection[] = [{ cls: 'table', box: [0.05, 0.3, 0.3, 0.3], score: 0.9, trackId: 2 }];
    const guide = createGuide({ detections: () => dets, memory: { whereIs: () => 'unseen', facing: () => 0 }, hfovDeg: () => 56, now: () => Date.now() });
    const task = createGuidedTask({ ...h.deps, guide });
    h.bus.emit({ type: 'TASK_REQUESTED', goal: 'bananas on the table', context: 'home', source: 'voice' });
    expect(h.said[0].text).toMatch(/^Table at (?:eleven|ten) o'clock\. Turn left/);
    expect(task.getDebugState().stage).toBe('approach_place');
    dets = [{ cls: 'table', box: [0.1, 0.1, 0.8, 0.9], score: 0.9, trackId: 2 }];
    await flush(2500);
    expect(h.said.map((s) => s.text)).toContain('At the table. Tilt the camera down and pan slowly.');
    expect(task.getDebugState().stage).toBe('scan_place');
    expect(task.intercept('where are the bananas')).toBe(true);
    expect(h.said[h.said.length - 1].text).toMatch(/Still looking for the bananas|At the table/);
    task.dispose();
  });

  it('bananas on the table, nothing in view: asks whether the table is elsewhere, keeps the mission, then hunts a doorway from the model\'s box', async () => {
    const h = harness({ askImpl: async (userText) => {
      const r = applied({ done: false, confidence: 0.1 });
      if (/Look for: the doorway/.test(userText)) r.response!.target = { box: [0.62, 0.3, 0.12, 0.4], confidence: 0.9 };
      return r;
    } });
    const guide = createGuide({ detections: () => [], memory: { whereIs: () => 'unseen', facing: () => 0 }, hfovDeg: () => 56, now: () => Date.now() });
    const task = createGuidedTask({ ...h.deps, guide, scene: () => 'in a bedroom' });
    h.bus.emit({ type: 'TASK_REQUESTED', goal: 'bananas on the table', context: 'home', source: 'voice' });
    expect(h.said[0].text).toBe('Turn slowly all the way around so I can find the table.');   // look around first
    await flush(13_000);
    expect(h.said.map((s) => s.text)).toContain('I think the table is in the kitchen. Is that right?');
    expect(task.intercept('yes')).toBe(true);
    expect(h.said[h.said.length - 1].text).toBe('Turn slowly until I see a doorway.');
    expect(task.getDebugState()).toMatchObject({ active: true, stage: 'find_door', goal: 'bananas on the table' });
    await flush(TASK_TICK_MS + 3000);
    expect(h.asks.mock.calls.some(([, o]: [string, { userText?: string }]) => /Look for: the doorway/.test(o.userText ?? ''))).toBe(true);
    expect(h.said.map((s) => s.text).some((x) => /^Doorway slightly right\. Turn right a little, then walk (?:four|five|six) steps\.$/.test(x))).toBe(true);
    expect(h.said.filter((r) => r.text === 'I think the table is in the kitchen. Is that right?')).toHaveLength(1);
    task.dispose();
  });

  it('keeps eggs through opening, item localization, hand steering and explicit pickup confirmation', async () => {
    let eggBox: [number, number, number, number] = [0.45, 0.3, 0.1, 0.02];
    const h = harness({ askImpl: async (text) => {
      const out = applied({ done: false, confidence: 0 });
      if (text.includes('Stage: find_item')) out.response!.target = { box: eggBox, confidence: 0.9 };
      return out;
    } });
    const guide = createGuide({ detections: () => [{ cls: 'fridge', box: [0.01, 0.005, 0.98, 0.99], near: 0.9, score: 0.9, trackId: 1 }], memory: { whereIs: () => 'unseen', facing: () => 0 }, hfovDeg: () => 56 });
    const hand = { start: jest.fn(async () => ({ done: 'touching' as const, steps: 1, handWords: 3 })), stop: jest.fn(), isRunning: () => false };
    const task = createGuidedTask({ ...h.deps, guide, handGuide: hand, tickMs: 1000, seen: () => 'chair left, table right, '.repeat(30) });
    h.bus.emit({ type: 'TASK_REQUESTED', goal: 'eggs in my fridge', context: 'home', source: 'voice' });
    await flush(1000);
    expect(task.getDebugState().stage).toBe('open');
    await flush(6000);
    expect(task.getDebugState().stage).toBe('open');
    expect(hand.start).toHaveBeenCalledWith('fridge handle', { goal: 'eggs in my fridge', target: null });
    expect(task.intercept('the door is open')).toBe(true);
    await flush(3000);
    expect(task.getDebugState().stage).toBe('find_item');
    expect(hand.start).not.toHaveBeenCalledWith('eggs', expect.anything());
    eggBox = [0.425, 0.3, 0.15, 0.1];
    await flush(3000);
    expect(hand.start).toHaveBeenCalledWith('eggs', expect.objectContaining({ goal: 'eggs in my fridge', target: expect.objectContaining({ box: eggBox }) }));
    expect(task.getDebugState()).toMatchObject({ stage: 'confirm_pickup', active: true, goal: 'eggs in my fridge' });
    expect(h.deps.store.getState().mode).toBe('GUIDED_TASK');
    expect(h.asks.mock.calls.every((c) => c[1].userText?.length <= 500)).toBe(true);
    expect(h.asks.mock.calls.some((c) => c[1].userText?.includes('Stage: find_item'))).toBe(true);
    expect(task.intercept('yes')).toBe(true);
    expect(h.deps.store.getState().mode).toBe('DONE');
    task.dispose();
  });

  it('rejects a cloud arrival at distance and requires two different reach frames', async () => {
    let frameAt = 1;
    let box: Detection['box'] = [0.2, 0.05, 0.6, 0.9];
    const h = harness({ askImpl: async () => applied({ done: true, confidence: 0.99 }) });
    const guide = createGuide({ detections: () => [{ cls: 'fridge', box, score: 0.9, near: 1, trackId: 1 }],
      detectionTimestamp: () => frameAt, memory: { whereIs: () => 'unseen', facing: () => 0 }, hfovDeg: () => 56 });
    const task = createGuidedTask({ ...h.deps, guide });
    h.bus.emit({ type: 'TASK_REQUESTED', goal: 'eggs in my fridge', context: 'home', source: 'voice' });
    await flush(4000);
    expect(task.getDebugState().stage).toBe('approach');
    box = [0.01, 0.005, 0.98, 0.99];
    frameAt = 2;
    await flush(2000);
    expect(task.getDebugState()).toMatchObject({ stage: 'approach', doneReadings: 1 });
    frameAt = 3;
    await flush(500);
    expect(task.getDebugState().stage).toBe('open');
    task.dispose();
  });
});
