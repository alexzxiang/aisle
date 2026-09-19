import type { HandHint } from '../core/contracts';
import type { AskOutcome, SemanticVision } from '../perception/semanticVision';
import { emptyVisionResponse } from '../perception/semanticVision';
import {
  INITIAL_PICKUP_STATE,
  PICKUP_MAX_STEPS,
  createItemPickup,
  faceShelfText,
  reducePickup,
  type PickupAction,
} from './itemPickup';

const keys = (a: PickupAction[]) => a.filter((x): x is Extract<PickupAction, { kind: 'say' }> => x.kind === 'say').map((s) => s.cacheKey ?? s.text);
const events = (a: PickupAction[]) => a.filter((x): x is Extract<PickupAction, { kind: 'emit' }> => x.kind === 'emit').map((x) => x.event);

describe('reducePickup (pure)', () => {
  it('a hint becomes ITEM_HAND_GUIDANCE {hint, step} and one cached word', () => {
    const r = reducePickup(INITIAL_PICKUP_STATE, 'higher');
    expect(events(r.actions)).toEqual([{ type: 'ITEM_HAND_GUIDANCE', hint: 'higher', step: 1 }]);
    expect(keys(r.actions)).toEqual(['higher']);
    expect(r.state.step).toBe(1);
    expect(r.state.done).toBeNull();
  });
  it('touching → CONFIRM + touching, done', () => {
    const r = reducePickup({ ...INITIAL_PICKUP_STATE, step: 3 }, 'touching');
    expect(r.actions.some((a) => a.kind === 'haptic' && a.pattern === 'CONFIRM')).toBe(true);
    expect(keys(r.actions)).toEqual(['touching']);
    expect(r.state.done).toBe('touching');
    // Nothing after done.
    expect(reducePickup(r.state, 'left').actions).toEqual([]);
  });
  it('not_seen twice in a row → one CAMERA_REQUEST down, then continue', () => {
    const r1 = reducePickup(INITIAL_PICKUP_STATE, 'not_seen');
    expect(events(r1.actions).map((e) => e.type)).toEqual(['ITEM_HAND_GUIDANCE']);
    const r2 = reducePickup(r1.state, 'not_seen');
    expect(events(r2.actions).map((e) => e.type)).toEqual(['ITEM_HAND_GUIDANCE', 'CAMERA_REQUEST']);
    expect(events(r2.actions)[1]).toEqual({ type: 'CAMERA_REQUEST', direction: 'down' });
    const r3 = reducePickup(r2.state, 'not_seen');
    expect(events(r3.actions).map((e) => e.type)).toEqual(['ITEM_HAND_GUIDANCE']); // once only
    // A real hint resets the streak; two more not_seen do not re-request (already requested once).
    const r4 = reducePickup(r3.state, 'left');
    expect(r4.state.consecutiveNotSeen).toBe(0);
  });
  it('a null hint (low confidence / stale / error) counts as not_seen', () => {
    const r = reducePickup(INITIAL_PICKUP_STATE, null);
    expect(events(r.actions)).toEqual([{ type: 'ITEM_HAND_GUIDANCE', hint: 'not_seen', step: 1 }]);
  });
  it('step 8 without touching → ask_staff, gave_up', () => {
    let s = INITIAL_PICKUP_STATE;
    for (let i = 1; i < PICKUP_MAX_STEPS; i += 1) {
      const r = reducePickup(s, 'left');
      s = r.state;
      expect(r.state.done).toBeNull();
    }
    const last = reducePickup(s, 'lower');
    expect(last.state.step).toBe(8);
    expect(last.state.done).toBe('gave_up');
    expect(keys(last.actions)).toEqual(['lower', 'ask_staff']);
    expect(events(last.actions)[0]).toEqual({ type: 'ITEM_HAND_GUIDANCE', hint: 'lower', step: 8 });
  });
  it('faceShelfText', () => {
    expect(faceShelfText('RIGHT')).toBe('Face the shelf on your right.');
    expect(faceShelfText(null)).toBe('Face the shelf.');
  });
});

describe('createItemPickup (runner)', () => {
  function visionWith(hints: Array<HandHint | null>): Pick<SemanticVision, 'ask'> & { calls: number } {
    let i = 0;
    const v = {
      calls: 0,
      async ask(): Promise<AskOutcome> {
        v.calls += 1;
        const h = hints[Math.min(i, hints.length - 1)] ?? null;
        i += 1;
        if (h === null) return { status: 'low_confidence', seq: i, response: emptyVisionResponse(i), streamed: false, latencyMs: 100 };
        const response = { ...emptyVisionResponse(i), confidence: 0.9, hand: { hint: h } };
        return { status: 'applied', seq: i, response, streamed: false, latencyMs: 100 };
      },
    };
    return v;
  }

  it('gives up after 8 steps with ask_staff', async () => {
    const performed: PickupAction[] = [];
    const vision = visionWith(['left']);
    const p = createItemPickup({ vision, perform: (a) => performed.push(a), now: () => 0, sleep: async () => {} });
    const final = await p.start({ item: 'eggs', side: 'RIGHT', packageHint: 'yellow carton' });
    expect(vision.calls).toBe(8);
    expect(final.done).toBe('gave_up');
    expect(final.step).toBe(8);
    const said = keys(performed);
    expect(said[0]).toBe('Face the shelf on your right.');
    expect(said[1]).toBe('reach_out');
    expect(said[said.length - 1]).toBe('ask_staff');
    const steps = events(performed).filter((e) => e.type === 'ITEM_HAND_GUIDANCE').map((e) => (e.type === 'ITEM_HAND_GUIDANCE' ? e.step : 0));
    expect(steps).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
  it('stops on touching with CONFIRM', async () => {
    const performed: PickupAction[] = [];
    const vision = visionWith(['higher', 'higher', 'touching']);
    const p = createItemPickup({ vision, perform: (a) => performed.push(a), now: () => 0, sleep: async () => {} });
    const final = await p.start({ item: 'eggs', side: 'RIGHT' });
    expect(vision.calls).toBe(3);
    expect(final.done).toBe('touching');
    expect(performed.some((a) => a.kind === 'haptic' && a.pattern === 'CONFIRM')).toBe(true);
    expect(keys(performed)).toEqual(['Face the shelf on your right.', 'reach_out', 'higher', 'higher', 'touching']);
  });
  it('paces the loop to the speech gap and can be stopped', async () => {
    const sleeps: number[] = [];
    let t = 0;
    const vision = visionWith(['left']);
    const p = createItemPickup({
      vision,
      perform: () => {},
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
        if (sleeps.length === 2) p.stop();
      },
      stepIntervalMs: 4000,
    });
    const final = await p.start({ item: 'eggs', side: null });
    expect(sleeps).toEqual([4000, 4000]);
    expect(final.done).toBe('stopped');
    expect(p.isRunning()).toBe(false);
  });
});
