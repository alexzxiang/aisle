import { createEventBus } from './bus';
import { bindStoreToBus, createAppStore } from './store';
import { createGuidedTask } from './guidedTask';
import { emptyVisionResponse, type AskOptions, type AskOutcome } from '../perception/semanticVision';
import type { Guide, GuideInstruction, TargetBox } from './guide';
import type { SearchObservation } from './searchObservation';
import type { VisionQuestion } from './contracts';

function setup(context: 'home' | 'store', goal = 'bananas') {
  const bus = createEventBus();
  const store = createAppStore({ bus, warn: () => undefined, initial: { firstRun: false } });
  bindStoreToBus(store, bus);
  let steps = 0;
  let seq = 0;
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
    response.confidence = 0.9;
    response.search = observation;
    response.task = { done: true, confidence: 0.99 }; // A cloud completion cannot skip the search.
    return { seq: n, status: 'applied', response, streamed: false, latencyMs: 100 };
  });
  const planner = jest.fn();
  const hand = { start: jest.fn(async () => ({ done: 'touching' as const, steps: 1 })), stop: jest.fn(), isRunning: () => false };
  const task = createGuidedTask({
    bus, store, guide, adaptiveSearch: true, steps: () => steps, heading: () => 0,
    speech: { say: (r) => { said.push(r.text); } }, haptics: { play: () => undefined },
    vision: { ask }, planner: { run: planner }, handGuide: hand as never,
  });
  bus.emit({ type: 'TASK_REQUESTED', goal, context, source: 'voice' });
  return { task, store, bus, said, ask, planner, hand, guide, walk: () => { steps += 3; }, setObservation: (o: Partial<SearchObservation>) => { observation = { ...observation, ...o }; } };
}

describe('adaptive search in the actual guided-task loop', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(1700000000000); });
  afterEach(() => jest.useRealTimers());

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
    expect(h.said).toContain('Produce display ahead. Walk forward four steps.');
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

  it('inserts approach and opening when a requested item is behind a closed freezer door', async () => {
    const h = setup('store', 'ice cream');
    h.setObservation({ barrier: 'closed_freezer', item: { box: [0.4, 0.5, 0.2, 0.2], confidence: 0.95 }, landmarks: [{ name: 'freezer', kind: 'appliance', section: 'frozen', box: [0.1, 0.1, 0.7, 0.8], confidence: 0.9 }] });
    await jest.advanceTimersByTimeAsync(3500);
    expect(h.task.getDebugState()).toMatchObject({ stage: 'approach', step: 0, total: 5 });
    expect(h.hand.start).not.toHaveBeenCalled();
    expect(h.task.getDebugState().goal).toBe('ice cream in the freezer');
    await jest.advanceTimersByTimeAsync(6500);
    expect(h.task.getDebugState().stage).toBe('approach');
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
