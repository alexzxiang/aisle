import type { AppEvent } from '../core/contracts';
import {
  SILENCE_CAMERA_MS,
  SILENCE_INFO_MS,
  arrivalText,
  createNavigator,
  sideFor,
  targetBehind,
  type IdentifiedSign,
  type NavAction,
  type NavigatorTarget,
} from './navigator';
import { fakeClock } from './testing';

const EGGS: NavigatorTarget = { aisleId: 'a3', order: 3, spokenLabel: 'Aisle three', item: 'eggs', sideWhenAscending: 'RIGHT' };

function aisle(n: number, source: 'ocr' | 'claude' = 'ocr'): IdentifiedSign {
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
  return { id: `a${n}`, kind: 'aisle', order: n, spokenLabel: `Aisle ${words[n]}`, label: `Aisle ${n}`, confidence: 0.9, source };
}

const says = (a: NavAction[]) => a.filter((x): x is Extract<NavAction, { kind: 'say' }> => x.kind === 'say');
const emits = (a: NavAction[]) => a.filter((x): x is Extract<NavAction, { kind: 'emit' }> => x.kind === 'emit').map((x) => x.event);
const keys = (a: NavAction[]) => says(a).map((s) => s.cacheKey ?? s.text);
const eventTypes = (a: NavAction[]) => emits(a).map((e) => e.type);

describe('pure helpers', () => {
  it('sideFor inverts when travelling DESC and is null when unknown', () => {
    expect(sideFor(EGGS, 'ASC')).toBe('RIGHT');
    expect(sideFor(EGGS, 'DESC')).toBe('LEFT');
    expect(sideFor(EGGS, null)).toBeNull();
    expect(sideFor({ ...EGGS, sideWhenAscending: null }, 'ASC')).toBeNull();
  });
  it('arrivalText is the one 01 §6 template', () => {
    expect(arrivalText(EGGS, 'RIGHT')).toBe('Aisle three. Eggs on your right.');
    expect(arrivalText(EGGS, null)).toBe('Aisle three.');
    expect(arrivalText({ ...EGGS, item: null }, 'RIGHT')).toBe('Aisle three.');
  });
  it('targetBehind', () => {
    expect(targetBehind(5, 3, 'ASC')).toBe(true);
    expect(targetBehind(2, 3, 'ASC')).toBe(false);
    expect(targetBehind(2, 3, 'DESC')).toBe(true);
    expect(targetBehind(5, 3, null)).toBe(false);
  });
});

describe('navigator — forward walk (the demo beat)', () => {
  it('1 → 3 arrives with CONFIRM and "Eggs on your right"', () => {
    const clock = fakeClock();
    const nav = createNavigator({ now: clock.now });
    nav.setTarget(EGGS);
    const first = nav.onSignIdentified(aisle(1));
    expect(eventTypes(first)).toEqual(['AISLE_IDENTIFIED']);
    // First read: direction unknown → orient only (INFO label), no keep_going command.
    expect(says(first).map((s) => s.priority)).toEqual(['INFO']);
    clock.advance(4000);
    const second = nav.onSignIdentified(aisle(2));
    expect(nav.getState().direction).toBe('ASC');
    expect(keys(second)).toEqual(['keep_going']);
    expect(second.some((a) => a.kind === 'anchorCourse')).toBe(true);
    clock.advance(4000);
    const third = nav.onSignIdentified(aisle(3));
    const ev = emits(third);
    expect(ev).toContainEqual<AppEvent>({ type: 'TARGET_AISLE_REACHED', aisleId: 'a3', side: 'RIGHT' });
    expect(third.some((a) => a.kind === 'haptic' && a.pattern === 'CONFIRM')).toBe(true);
    expect(says(third).map((s) => s.text)).toEqual(['Aisle three. Eggs on your right.']);
    expect(nav.getState().arrived).toBe(true);
    // After arrival the navigator is quiet.
    clock.advance(30_000);
    expect(nav.tick()).toEqual([]);
  });
});

describe('navigator — backward walk with side inversion', () => {
  it('5 → 4 → 3 arrives with the side inverted', () => {
    const clock = fakeClock();
    const nav = createNavigator({ now: clock.now });
    nav.setTarget(EGGS);
    nav.onSignIdentified(aisle(5));
    clock.advance(4000);
    const a4 = nav.onSignIdentified(aisle(4));
    expect(nav.getState().direction).toBe('DESC');
    expect(keys(a4)).toEqual(['keep_going']);
    clock.advance(4000);
    const a3 = nav.onSignIdentified(aisle(3));
    expect(emits(a3)).toContainEqual<AppEvent>({ type: 'TARGET_AISLE_REACHED', aisleId: 'a3', side: 'LEFT' });
    expect(says(a3).map((s) => s.text)).toEqual(['Aisle three. Eggs on your left.']);
  });
});

describe('navigator — overshoot and wrong-way flip', () => {
  it('walking past the target says passed_it once, then the flip carries the corrected side', () => {
    const clock = fakeClock();
    const nav = createNavigator({ now: clock.now });
    nav.setTarget(EGGS);
    nav.onSignIdentified(aisle(1));
    clock.advance(4000);
    nav.onSignIdentified(aisle(2));
    clock.advance(4000);
    // Missed the 3 sign, read 4: target is now behind.
    const a4 = nav.onSignIdentified(aisle(4));
    expect(keys(a4)).toEqual(['passed_it_turn_around']);
    clock.advance(4000);
    // Still ASC to 5: passed_it not repeated (same direction), no keep_going toward nowhere.
    const a5 = nav.onSignIdentified(aisle(5));
    expect(keys(a5)).toEqual([]);
    clock.advance(4000);
    // Turned around: 5 → 4 flips direction to DESC; target ahead → keep_going, silent about passing.
    const back4 = nav.onSignIdentified(aisle(4));
    expect(nav.getState().direction).toBe('DESC');
    expect(keys(back4)).toEqual(['keep_going']);
    expect(back4.some((a) => a.kind === 'anchorCourse')).toBe(true);
    clock.advance(4000);
    const arrive = nav.onSignIdentified(aisle(3));
    expect(emits(arrive)).toContainEqual<AppEvent>({ type: 'TARGET_AISLE_REACHED', aisleId: 'a3', side: 'LEFT' });
  });
  it('two reads going the other way while ASC flip direction and say passed_it only if the target is behind', () => {
    const clock = fakeClock();
    const nav = createNavigator({ now: clock.now });
    nav.setTarget({ ...EGGS, aisleId: 'a7', order: 7, spokenLabel: 'Aisle seven', item: 'chips', sideWhenAscending: 'LEFT' });
    nav.onSignIdentified(aisle(2));
    clock.advance(4000);
    nav.onSignIdentified(aisle(3));
    expect(nav.getState().direction).toBe('ASC');
    clock.advance(4000);
    const back = nav.onSignIdentified(aisle(2));
    expect(nav.getState().direction).toBe('DESC');
    expect(keys(back)).toEqual(['passed_it_turn_around']); // target 7 is behind a DESC walker at 2
  });
});

describe('navigator — mid-store entry', () => {
  it('currentOrder is unknown until the first read; direction from the first two reads, not assumed', () => {
    const clock = fakeClock();
    const nav = createNavigator({ now: clock.now });
    nav.setTarget(EGGS);
    expect(nav.getState().currentOrder).toBeNull();
    nav.onSignIdentified(aisle(6));
    expect(nav.getState().currentOrder).toBe(6);
    expect(nav.getState().direction).toBeNull();
    clock.advance(4000);
    nav.onSignIdentified(aisle(5));
    expect(nav.getState().direction).toBe('DESC');
  });
  it('first read *is* the target with no direction: arrival is announced by label only, event carries the ascending side', () => {
    const clock = fakeClock();
    const nav = createNavigator({ now: clock.now });
    nav.setTarget(EGGS);
    const a = nav.onSignIdentified(aisle(3));
    expect(emits(a)).toContainEqual<AppEvent>({ type: 'TARGET_AISLE_REACHED', aisleId: 'a3', side: 'RIGHT' });
    expect(says(a).map((s) => s.text)).toEqual(['Aisle three.']);
  });
});

describe('navigator — cross-aisle skip via the plausibility window', () => {
  it('isPlausible is true for everything before the first read and ±2 after it', () => {
    const clock = fakeClock();
    const nav = createNavigator({ now: clock.now });
    expect(nav.isPlausible(8)).toBe(true);
    nav.onSignIdentified(aisle(2));
    expect(nav.isPlausible(4)).toBe(true);
    expect(nav.isPlausible(5)).toBe(false);
    expect(nav.isPlausible(8)).toBe(false);
  });
  it('the pedometer prior widens the window in the direction of travel', () => {
    const clock = fakeClock();
    let steps = 0;
    const nav = createNavigator({ now: clock.now, getSteps: () => steps, aislePitchM: 3.5 });
    nav.onSignIdentified(aisle(1));
    clock.advance(3000);
    nav.onSignIdentified(aisle(2));
    steps = 20; // 14 m ≈ 4 aisles → estimated order ≈ 6
    expect(nav.isPlausible(7)).toBe(true);
    expect(nav.isPlausible(8)).toBe(true);
    expect(nav.isPlausible(9)).toBe(false);
  });
  it('a wall ahead widens the window by one for a cross-aisle turn', () => {
    const clock = fakeClock();
    const nav = createNavigator({ now: clock.now });
    nav.onSignIdentified(aisle(2));
    expect(nav.isPlausible(5)).toBe(false);
    nav.onWallAhead();
    expect(nav.isPlausible(5)).toBe(true);
  });
});

describe('navigator — same sign re-read, no target, side unknown', () => {
  it('re-reading the same sign inside 10 s produces nothing and does not touch the step prior', () => {
    const clock = fakeClock();
    let steps = 0;
    const nav = createNavigator({ now: clock.now, getSteps: () => steps });
    nav.setTarget(EGGS);
    nav.onSignIdentified(aisle(1));
    steps = 10;
    clock.advance(5000);
    expect(nav.onSignIdentified(aisle(1))).toEqual([]);
    expect(nav.getState().stepsAtLastRead).toBe(0);
  });
  it('targetOrder null: announces identified aisles, never an arrival', () => {
    const clock = fakeClock();
    const nav = createNavigator({ now: clock.now });
    const a = nav.onSignIdentified(aisle(3));
    expect(eventTypes(a)).toEqual(['AISLE_IDENTIFIED']);
    expect(says(a).map((s) => s.text)).toEqual(['Aisle three.']);
    clock.advance(4000);
    const b = nav.onSignIdentified(aisle(4));
    expect(eventTypes(b)).toEqual(['AISLE_IDENTIFIED']);
    expect(nav.getState().arrived).toBe(false);
  });
  it('item side unknown (aisle from disambiguate): says the aisle label only', () => {
    const clock = fakeClock();
    const nav = createNavigator({ now: clock.now });
    nav.setTarget({ ...EGGS, item: 'caviar', sideWhenAscending: null });
    nav.onSignIdentified(aisle(1));
    clock.advance(4000);
    nav.onSignIdentified(aisle(2));
    clock.advance(4000);
    const a = nav.onSignIdentified(aisle(3));
    expect(says(a).map((s) => s.text)).toEqual(['Aisle three.']);
    expect(emits(a).some((e) => e.type === 'TARGET_AISLE_REACHED')).toBe(true);
  });
  it('non-numeric labels: order comes from the map, never the text', () => {
    const clock = fakeClock();
    const nav = createNavigator({ now: clock.now });
    nav.setTarget({ aisleId: 'dairy', order: 12, spokenLabel: 'Dairy', item: 'milk', sideWhenAscending: 'LEFT' });
    nav.onSignIdentified({ id: 'produce', kind: 'aisle', order: 10, spokenLabel: 'Produce', label: 'PRODUCE', confidence: 0.9, source: 'ocr' });
    clock.advance(4000);
    nav.onSignIdentified({ id: 'bakery', kind: 'aisle', order: 11, spokenLabel: 'Bakery', label: 'BAKERY', confidence: 0.9, source: 'ocr' });
    clock.advance(4000);
    const a = nav.onSignIdentified({ id: 'dairy', kind: 'aisle', order: 12, spokenLabel: 'Dairy', label: 'DAIRY', confidence: 0.9, source: 'ocr' });
    expect(says(a).map((s) => s.text)).toEqual(['Dairy. Milk on your left.']);
  });
});

describe('navigator — time-based prompts (tick)', () => {
  it('unknown position: keep_going as INFO once per 15 s', () => {
    const clock = fakeClock();
    const nav = createNavigator({ now: clock.now });
    nav.setTarget(EGGS);
    expect(nav.tick()).toEqual([]);
    clock.advance(15_000);
    const a = nav.tick();
    expect(keys(a)).toEqual(['keep_going']);
    expect(says(a)[0]!.priority).toBe('INFO');
    clock.advance(5000);
    expect(nav.tick()).toEqual([]);
    clock.advance(10_000);
    expect(keys(nav.tick())).toEqual(['keep_going']);
  });
  it('20 s of silence → one INFO; 40 s → one CAMERA_REQUEST up + tilt_camera_up; then quiet', () => {
    const clock = fakeClock();
    const nav = createNavigator({ now: clock.now });
    nav.setTarget(EGGS);
    nav.onSignIdentified(aisle(1));
    clock.advance(4000);
    nav.onSignIdentified(aisle(2));
    clock.advance(SILENCE_INFO_MS);
    const a = nav.tick();
    expect(keys(a)).toEqual(['keep_going']);
    expect(says(a)[0]!.priority).toBe('INFO');
    clock.advance(1000);
    expect(nav.tick()).toEqual([]);
    clock.advance(SILENCE_CAMERA_MS - SILENCE_INFO_MS);
    const b = nav.tick();
    expect(eventTypes(b)).toEqual(['CAMERA_REQUEST']);
    expect(keys(b)).toEqual(['tilt_camera_up']);
    clock.advance(30_000);
    expect(nav.tick()).toEqual([]);
  });
  it('pedometer cadence: keep_going when the next sign is due and none was read', () => {
    const clock = fakeClock();
    let steps = 0;
    const nav = createNavigator({ now: clock.now, getSteps: () => steps, aislePitchM: 3.5 });
    nav.setTarget({ ...EGGS, aisleId: 'a7', order: 7, spokenLabel: 'Aisle seven', item: 'chips', sideWhenAscending: 'LEFT' });
    nav.onSignIdentified(aisle(1));
    clock.advance(3000);
    nav.onSignIdentified(aisle(2)); // says keep_going (NAV) here
    clock.advance(9000);
    steps = 3;                      // 2.1 m: not yet a pitch
    expect(nav.tick()).toEqual([]);
    steps = 6;                      // 4.2 m ≥ 3.5 m pitch → due
    expect(keys(nav.tick())).toEqual(['keep_going']);
  });
  it('early overshoot from the prior: passed_it once plus a camera request, then quiet', () => {
    const clock = fakeClock();
    let steps = 0;
    const nav = createNavigator({ now: clock.now, getSteps: () => steps, aislePitchM: 3.5 });
    nav.setTarget(EGGS);
    nav.onSignIdentified(aisle(1));
    clock.advance(3000);
    nav.onSignIdentified(aisle(2));
    clock.advance(9000);
    steps = 20; // estimated order 2 + 14/3.5 = 6 > target + 1
    const a = nav.tick();
    expect(keys(a)).toEqual(['passed_it_turn_around', 'tilt_camera_up']);
    expect(eventTypes(a)).toEqual(['CAMERA_REQUEST']);
    clock.advance(1000);
    steps = 25;
    expect(keys(nav.tick())).toEqual([]);
  });
});

describe('navigator — checkout landmark (Task 10)', () => {
  it('CHECKOUT_REACHED + CONFIRM + checkout_ahead on the checkout sign in the CHECKOUT phase only', () => {
    const clock = fakeClock();
    const nav = createNavigator({ now: clock.now });
    nav.setTarget(EGGS);
    nav.onSignIdentified(aisle(3));
    const checkout: IdentifiedSign = { id: 'checkout', kind: 'landmark', order: 99, spokenLabel: 'Checkout', label: 'Checkout', confidence: 0.9, source: 'ocr' };
    // In the AISLE phase the landmark is noted, not an arrival.
    const early = nav.onSignIdentified(checkout);
    expect(eventTypes(early)).toEqual(['AISLE_IDENTIFIED']);
    nav.setPhase('CHECKOUT');
    clock.advance(11_000);
    const a = nav.onSignIdentified(checkout);
    expect(eventTypes(a)).toEqual(['AISLE_IDENTIFIED', 'CHECKOUT_REACHED']);
    expect(a.some((x) => x.kind === 'haptic' && x.pattern === 'CONFIRM')).toBe(true);
    expect(keys(a)).toEqual(['checkout_ahead']);
    expect(nav.getState().checkoutReached).toBe(true);
  });
  it('in the CHECKOUT phase aisle reads guide toward afterAisleOrder', () => {
    const clock = fakeClock();
    const nav = createNavigator({ now: clock.now, checkoutOrder: 99 });
    nav.setTarget(EGGS);
    nav.onSignIdentified(aisle(3));
    nav.setPhase('CHECKOUT');
    clock.advance(4000);
    nav.onSignIdentified(aisle(4));
    clock.advance(4000);
    expect(nav.getState().direction).toBe('ASC');
    const back = nav.onSignIdentified(aisle(3));
    expect(nav.getState().direction).toBe('DESC');
    expect(keys(back)).toEqual(['passed_it_turn_around']); // checkout (99) is behind a DESC walker
  });
});
