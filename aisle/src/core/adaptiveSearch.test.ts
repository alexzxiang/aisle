import { createEventBus } from './bus';
import { bindStoreToBus, createAppStore } from './store';
import { createGuidedTask } from './guidedTask';
import { emptyVisionResponse, type AskOptions, type AskOutcome } from '../perception/semanticVision';
import type { Guide, GuideInstruction, TargetBox } from './guide';
import type { SearchObservation } from './searchObservation';
import type { TaskContext, VisionQuestion } from './contracts';
import { createExplorationMap } from './explorationMap';
import { GIVE_UP_PULSE_MS, OPENING_EXHAUSTED, OPENING_SWEEP, OPENING_SWEEP_MS } from './searchExplorer';

function setup(context: TaskContext, goal = 'bananas', track = false, pathCenter: number | null = 0.1) {
  const bus = createEventBus();
  const store = createAppStore({ bus, warn: () => undefined, initial: { firstRun: false } });
  bindStoreToBus(store, bus);
  let steps = 0;
  let seq = 0;
  let lowConfidence = false;
  let tracking = false;
  const map = createExplorationMap();
  const said: string[] = [];
  let observation: SearchObservation = {
    items: ['milk', 'yogurt'], sign: 'Dairy', view: 'overview', quality: 'usable', confidence: 0.9, barrier: 'none',
    landmarks: [{ name: 'produce display', kind: 'section', section: 'produce', box: [0.4, 0.1, 0.2, 0.3], confidence: 0.9 }],
  };
  const instructionFor = jest.fn((name: string, box?: TargetBox | null): GuideInstruction | null => {
    if (!box) return null;
    return { kind: name === 'bananas' ? 'arrived' : 'forward', text: 'Landmark ahead.', relativeDeg: 0, steps: name === 'bananas' ? 0 : 4, targetVisible: true, box };
  });
  const guide: Guide = { instructionFor, changed: () => true };
  const ask = jest.fn(async (_q: VisionQuestion, _opts?: AskOptions): Promise<AskOutcome> => {
    const n = ++seq;
    const response = emptyVisionResponse(n);
    response.confidence = lowConfidence ? 0.3 : 0.9;
    response.search = observation;
    response.task = { done: true, confidence: 0.99 }; // A cloud completion cannot skip the search.
    return { seq: n, status: lowConfidence ? 'low_confidence' : 'applied', capturedAt: Date.now(), response, streamed: false, latencyMs: 100 };
  });
  const planner = jest.fn();
  const hand = { start: jest.fn(async () => ({ done: 'touching' as const, steps: 1 })), stop: jest.fn(), isRunning: () => false };
  const task = createGuidedTask({
    bus, store, guide, adaptiveSearch: true, steps: () => steps, heading: () => 0,
    path: () => pathCenter === null ? null : ({ center: pathCenter }),
    ...(track ? { map, pose: () => {
      if (!tracking) return null;
      const p = { x: 0, y: 1.4, z: 0, yawDeg: 0, timestamp: Date.now(), trackingState: 'NORMAL' as const };
      map.ingestPose(p); return p;
    }, path: () => ({ center: 0.1 }) } : {}),
    speech: { say: (r) => { said.push(r.text); } }, haptics: { play: () => undefined },
    vision: { ask }, planner: { run: planner }, handGuide: hand as never,
  });
  bus.emit({ type: 'TASK_REQUESTED', goal, context, source: 'voice' });
  return { task, store, bus, said, ask, planner, hand, guide, lowConfidence: () => { lowConfidence = true; }, recoverTracking: () => { tracking = true; }, walk: () => { steps += 3; }, setObservation: (o: Partial<SearchObservation>) => { observation = { ...observation, ...o }; } };
}

describe('adaptive search in the actual guided-task loop', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(1700000000000); });
  afterEach(() => jest.useRealTimers());

  it('escalates fast item candidates but does not reach for an item rejected by verification', async () => {
    const h = setup('store');
    h.setObservation({ item: { box: [0.4, 0.3, 0.2, 0.3], confidence: 0.95 } });
    const original = h.ask.getMockImplementation()!;
    h.ask.mockImplementation(async (q, opts) => {
      const result = await original(q, opts);
      if (!opts?.searchMode) result.response!.search = { ...result.response!.search!, item: { box: null, confidence: 0 } };
      return result;
    });
    await jest.advanceTimersByTimeAsync(10000);
    expect(h.ask.mock.calls.some(([, opts]) => opts?.searchMode === 'explore')).toBe(true);
    expect(h.ask.mock.calls.some(([, opts]) => opts?.searchMode === undefined)).toBe(true);
    expect(h.hand.start).not.toHaveBeenCalled();
    expect(h.task.getDebugState().stage).not.toBe('reach');
    h.task.dispose();
  });

  it('uses independently confident search evidence from low-confidence overall results', async () => {
    const h = setup('store'); h.lowConfidence();
    await jest.advanceTimersByTimeAsync(20000);
    expect(h.said).toContain('May I guide you toward the produce section?');
    expect(h.hand.start).not.toHaveBeenCalled();
    h.task.dispose();
  });

  it.each([false, true])('corrects inferred context but preserves explicit context (explicit=%s)', async explicit => {
    const h = setup('classroom');
    if (explicit) h.store.setState({ scene: { setting: 'classroom', label: 'in a classroom', source: 'user', confirmed: true, confidence: 1, at: Date.now() } });
    const original = h.ask.getMockImplementation()!;
    h.ask.mockImplementation(async (q, opts) => {
      const result = await original(q, opts);
      result.response!.scene = { setting: 'store', label: 'in a grocery store', confidence: 0.95 };
      return result;
    });
    await jest.advanceTimersByTimeAsync(10000);
    expect(h.task.getDebugState().context).toBe(explicit ? 'classroom' : 'store');
    expect(h.task.getDebugState().goal).toBe('bananas');
    h.task.dispose();
  });

  it('continues camera requests during tracking loss and resumes observation after recovery', async () => {
    const h = setup('store', 'bananas', true);
    await jest.advanceTimersByTimeAsync(12000);
    expect(h.ask.mock.calls.length).toBeGreaterThan(1);
    expect(h.said.join(' ')).not.toMatch(/Walk forward/);
    const before = h.ask.mock.calls.length;
    h.recoverTracking();
    await jest.advanceTimersByTimeAsync(18000);
    expect(h.ask.mock.calls.length).toBeGreaterThan(before);
    expect(h.task.getDebugState().searchAreas?.[0]?.items).toContain('milk');
    h.task.dispose();
  });

  it('recovers when neither bananas nor table is visible, without asking for visual confirmation', async () => {
    const h = setup('home', 'bananas on the table');
    await jest.advanceTimersByTimeAsync(45000);
    expect(h.planner).not.toHaveBeenCalled();
    expect(h.said.some((t) => /camera slowly left/.test(t))).toBe(true);
    expect(h.said.some((t) => /May I guide/.test(t))).toBe(true);
    // The room question only comes after looking around, never as the first thing.
    expect(h.said[0]).not.toMatch(/Is that right|another room\?/);
    expect(h.store.getState().mode).toBe('GUIDED_TASK');
    expect(h.hand.start).not.toHaveBeenCalled();
    h.task.dispose();
  });

  it('narrates dairy, asks to seek produce, remembers visits, then requires identity and pickup confirmation', async () => {
    const h = setup('store');
    for (let i = 0; i < 60 && !h.said.includes('May I guide you toward the produce section?'); i += 1) await jest.advanceTimersByTimeAsync(1000);
    expect(h.said.some((t) => /Dairy|dairy/.test(t))).toBe(true);
    expect(h.said).toContain('Bananas should be in produce. Let me find the way.');
    expect(h.said).toContain('May I guide you toward the produce section?');
    expect(h.task.intercept('yes')).toBe(true);
    await jest.advanceTimersByTimeAsync(6000);
    expect(h.said).toContain('Produce display ahead. Walk forward three steps.');
    // Arrival: the landmark's box fills the view on two frames; the new spot has its own sign.
    h.setObservation({ sign: 'Produce', items: ['apples', 'oranges'] });
    h.guide.instructionFor = jest.fn((name: string, box?: TargetBox | null): GuideInstruction | null => (box ? { kind: 'arrived', text: '', relativeDeg: 0, steps: 0, targetVisible: true, box } : null));
    await jest.advanceTimersByTimeAsync(8000);
    expect(h.said).toContain('Produce display just ahead. Slow down.');
    expect(h.said).toContain('Here. Let me look around this spot.');
    expect(h.task.getDebugState().searchAreas?.length).toBe(2);
    expect(h.ask.mock.calls.some(([, o]) => o?.userText?.includes('Memory:'))).toBe(true);
    h.setObservation({ sign: 'Produce', items: ['bananas'], item: { box: [0.4, 0.5, 0.2, 0.2], confidence: 0.95 }, landmarks: [] });
    await jest.advanceTimersByTimeAsync(7000);
    expect(h.hand.start).toHaveBeenCalledWith('bananas', expect.any(Object));
    expect(h.store.getState().mode).toBe('GUIDED_TASK');
    expect(h.task.intercept('yes')).toBe(true);
    expect(h.store.getState().mode).toBe('DONE');
    h.task.dispose();
  });

  it('does not insert a household freezer-opening mission in a store', async () => {
    const h = setup('store', 'ice cream');
    h.setObservation({ barrier: 'closed_freezer', item: { box: [0.4, 0.5, 0.2, 0.2], confidence: 0.95 }, landmarks: [{ name: 'freezer', kind: 'appliance', section: 'frozen', box: [0.1, 0.1, 0.7, 0.8], confidence: 0.9 }] });
    await jest.advanceTimersByTimeAsync(3500);
    expect(h.task.getDebugState()).toMatchObject({ stage: 'find_place', step: 0, total: 3 });
    expect(h.hand.start).not.toHaveBeenCalled();
    expect(h.task.getDebugState().goal).toBe('ice cream');
    await jest.advanceTimersByTimeAsync(6500);
    expect(h.said.join(' ')).not.toMatch(/Open the (?:fridge|freezer)/);
    h.task.dispose();
  });

  it('lets an explicit explore request leave a home container without reinserting it on the next frame', async () => {
    const h = setup('home', 'bananas');
    h.setObservation({ barrier: 'closed_freezer', landmarks: [{ name: 'freezer', kind: 'appliance', section: 'frozen', box: [0.1, 0.1, 0.7, 0.8], confidence: 0.9 }] });
    await jest.advanceTimersByTimeAsync(6500); // fast observation, then strong container verification
    expect(h.task.getDebugState().total).toBe(5);
    h.task.advance();
    expect(h.task.intercept('explore')).toBe(true);
    await jest.advanceTimersByTimeAsync(10000);
    expect(h.task.getDebugState().total).toBe(3);
    expect(h.task.getDebugState().goal).toBe('bananas');
    h.task.dispose();
  });

  it('the detector steers the approach at once, but the reach waits for Claude to confirm the food', async () => {
    const h = setup('home', 'bananas');
    h.setObservation({ items: [], sign: null, landmarks: [], item: { box: null, confidence: 0 } });
    // The detector (through the guide) sees bananas within reach from the first tick.
    h.guide.instructionFor = jest.fn((name: string, box?: TargetBox | null): GuideInstruction | null =>
      (name === 'bananas' ? { kind: 'arrived', text: '', relativeDeg: 0, steps: 0, targetVisible: true, box: box ?? { box: [0.3, 0.3, 0.4, 0.4], at: Date.now() } } : null));
    await jest.advanceTimersByTimeAsync(1200);
    expect(h.said).toContain('Bananas right in front of you. Reach out.');
    expect(h.said).toContain('Hold the camera on it. Let me confirm it is the bananas.');
    expect(h.hand.start).not.toHaveBeenCalled();
    // Claude confirms the item; the hand loop starts.
    h.setObservation({ item: { box: [0.3, 0.3, 0.4, 0.4], confidence: 0.95 } });
    await jest.advanceTimersByTimeAsync(4000);
    expect(h.hand.start).toHaveBeenCalledWith('bananas', expect.any(Object));
    h.task.dispose();
  });

  it('aborts while a search observation is pending without reviving the task', async () => {
    const h = setup('home');
    h.store.getState().abort();
    await jest.advanceTimersByTimeAsync(45000);
    expect(h.store.getState().mode).toBe('IDLE');
    expect(h.task.isActive()).toBe(false);
    expect(h.ask).not.toHaveBeenCalled();
    h.task.dispose();
  });
});

describe('leaving an area the camera shows nothing in', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(1700000000000); });
  afterEach(() => jest.useRealTimers());

  // The reported failure: unrelated shelves and two empty bowls, no bananas anywhere near.
  const barren = { items: ['bowl', 'bowl'], sign: undefined, landmarks: [], quality: 'usable' as const, confidence: 0.9 };

  it.each(['home', 'store', 'classroom'] as const)('keeps delayed model narration coherent in %s', async context => {
    const h = setup(context, 'red scarf');
    h.setObservation(barren);
    const original = h.ask.getMockImplementation()!;
    const line = 'Let me inspect another camera angle for an opening.';
    h.ask.mockImplementation(async (q, opts) => {
      const result = await original(q, opts);
      await new Promise(resolve => setTimeout(resolve, 6000));
      result.response!.speech = line;
      result.latencyMs = 6000;
      return result;
    });
    await jest.advanceTimersByTimeAsync(23000);
    expect(h.said).toContain(line);
    expect(h.said.filter(s => s.includes('I need a current view.')).length).toBeLessThanOrEqual(1);
    expect(h.said).not.toContain('Waiting for camera analysis. Hold steady; I am retrying.');
    h.task.dispose();
  });

  it('does not speak exploration from a rejected stale response', async () => {
    const h = setup('store');
    h.setObservation(barren);
    const original = h.ask.getMockImplementation()!;
    h.ask.mockImplementation(async (q, opts) => {
      const result = await original(q, opts);
      result.capturedAt = Date.now() - 20000;
      result.response!.speech = 'Walk forward toward the doorway.';
      return result;
    });
    await jest.advanceTimersByTimeAsync(20000);
    expect(h.said).not.toContain('Walk forward toward the doorway.');
    expect(h.said.filter(s => s.includes('while I process this view.'))).toHaveLength(1);
    h.task.dispose();
  });

  it('discards an in-flight reply when the user requests a different view', async () => {
    const h = setup('store');
    h.setObservation(barren);
    const original = h.ask.getMockImplementation()!;
    let release!: (result: AskOutcome) => void;
    let result!: AskOutcome;
    h.ask.mockImplementationOnce(async (q, opts) => {
      result = await original(q, opts);
      result.response!.speech = 'The old view has a doorway on your right.';
      return new Promise(resolve => { release = resolve; });
    });
    await jest.advanceTimersByTimeAsync(1000);
    expect(h.task.intercept('explore a different view')).toBe(true);
    release(result);
    await jest.advanceTimersByTimeAsync(500);
    expect(h.said).not.toContain('The old view has a doorway on your right.');
    expect(h.said).toContain('Stay here. Turn the camera slowly left for another view.');
    h.task.dispose();
  });

  it('proposes moving on inside the weak-area budget instead of studying the containers', async () => {
    const h = setup('store', 'bananas');
    h.setObservation(barren);
    await jest.advanceTimersByTimeAsync(16000);
    const transcript = h.said.join(' | ');
    expect(transcript).toMatch(/May I|another (?:part|way)|elsewhere|Turn slowly/);
    // It must not have talked the user into inspecting the bowls it can plainly see.
    expect(transcript).not.toMatch(/bowl/i);
    h.task.dispose();
  });

  it('lets the model narrate a generic store look-around instead of a canned scan line', async () => {
    const h = setup('store', 'bananas');
    h.setObservation(barren);
    const original = h.ask.getMockImplementation()!;
    h.ask.mockImplementation(async (q, opts) => {
      const result = await original(q, opts);
      result.response!.speech = 'Produce is at the back, walk forward.';
      return result;
    });
    await jest.advanceTimersByTimeAsync(5000);
    const transcript = h.said.join(' | ');
    expect(transcript).toContain('Produce is at the back, walk forward.');
    expect(transcript).not.toMatch(/Point along the aisle|Turn the camera (?:left|right)\. Hold steady/);
    h.task.dispose();
  });

  it('speaks a fifteen-word model exploration line that the twelve-word cap would have dropped', async () => {
    const h = setup('store', 'bananas');
    h.setObservation(barren);
    const fourteen = 'Produce is at the very back of the store, so keep walking straight forward.';
    const original = h.ask.getMockImplementation()!;
    h.ask.mockImplementation(async (q, opts) => {
      const result = await original(q, opts);
      result.response!.speech = fourteen;
      return result;
    });
    await jest.advanceTimersByTimeAsync(5000);
    expect(h.said).toContain(fourteen);
    h.task.dispose();
  });

  it.each([null, 0.9, NaN])('withholds model walking suggestions without usable path evidence (%s)', async pathCenter => {
    const h = setup('store', 'bananas', false, pathCenter);
    h.setObservation(barren);
    const original = h.ask.getMockImplementation()!;
    h.ask.mockImplementation(async (q, opts) => {
      const result = await original(q, opts);
      result.response!.speech = 'Walk forward toward produce.';
      return result;
    });
    await jest.advanceTimersByTimeAsync(5000);
    expect(h.said).not.toContain('Walk forward toward produce.');
    expect(h.said).toContain('Hold still while I check the path ahead.');
    h.task.dispose();
  });

  it('leaves a barren store area within about six seconds, not twelve', async () => {
    const h = setup('store', 'bananas');
    h.setObservation(barren);
    await jest.advanceTimersByTimeAsync(9000);
    expect(h.said.join(' | ')).toMatch(/No opening seen|May I|another (?:part|way)|elsewhere/);
    h.task.dispose();
  });

  it('sweeps the person through new viewpoints instead of one line and silence', async () => {
    const h = setup('store', 'bananas');
    h.setObservation(barren);
    await jest.advanceTimersByTimeAsync(16000);
    // Nothing but a view the camera has not had can lift an opening pause, so it must ask
    // for one — a different quarter each time, not the same sentence into the silence.
    await jest.advanceTimersByTimeAsync(OPENING_SWEEP_MS * OPENING_SWEEP.length + 2000);
    for (const line of OPENING_SWEEP) expect(h.said).toContain(line);
    expect(new Set(h.said).size).toBe(h.said.length);           // no sentence repeated
    h.task.dispose();
  });

  it('ends the sweep with a way out rather than repeating itself forever', async () => {
    const h = setup('store', 'bananas');
    h.setObservation(barren);
    await jest.advanceTimersByTimeAsync(16000 + OPENING_SWEEP_MS * (OPENING_SWEEP.length + 1) + GIVE_UP_PULSE_MS);
    expect(h.said).toContain(OPENING_EXHAUSTED);
    h.task.dispose();
  });
});
