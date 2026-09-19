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
  return { task, store, bus, said, ask, planner, hand, guide, setObservation: (o: Partial<SearchObservation>) => { observation = { ...observation, ...o }; }, walk: () => { steps += 3; } };
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
    expect(h.said.some((t) => /Is that right|another room\?/.test(t))).toBe(false);
    expect(h.store.getState().mode).toBe('GUIDED_TASK');
    expect(h.hand.start).not.toHaveBeenCalled();
    h.task.dispose();
  });

  it('narrates dairy, asks to seek produce, remembers visits, then requires identity and pickup confirmation', async () => {
    const h = setup('store');
    await jest.advanceTimersByTimeAsync(45000);
    expect(h.said.some((t) => /Dairy|dairy/.test(t))).toBe(true);
    expect(h.said).toContain('May I guide you toward the produce section?');
    expect(h.task.intercept('yes')).toBe(true);
    await jest.advanceTimersByTimeAsync(6000);
    expect(h.said).toContain('Walk one step toward the visible landmark, then pause.');
    h.walk();
    await jest.advanceTimersByTimeAsync(500);
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
