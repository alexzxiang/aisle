import { createEventBus, type AppEventBus } from './bus';
import type { AppMode, SpeechRequest } from './contracts';
import {
  APP_MODES,
  appBus,
  appStore,
  LEGAL_TRANSITIONS,
  LAST_EVENTS_SIZE,
  bindStoreToBus,
  clampSpeechRate,
  createAppStore,
  isLegalTransition,
  selectIsCrossingPhase,
  selectIsIndoorPhase,
  selectIsOutdoorPhase,
  selectIsTripActive,
  type AppStore,
} from './store';

// Every arrow in 01 §1 (plus abort, tested separately).
const ARROWS: Array<[AppMode, AppMode]> = [
  ['IDLE', 'ONBOARDING'],
  ['IDLE', 'OUTDOOR_NAV'],          // returning user: ROUTE_READY while firstRun is false
  ['ONBOARDING', 'OUTDOOR_NAV'],
  ['OUTDOOR_NAV', 'APPROACH_CROSSING'],
  ['APPROACH_CROSSING', 'AT_CURB'],
  ['AT_CURB', 'CROSSING'],
  ['AT_CURB', 'OUTDOOR_NAV'],       // CROSSING_ABORTED
  ['CROSSING', 'OUTDOOR_NAV'],
  ['APPROACH_CROSSING', 'OUTDOOR_NAV'],
  ['OUTDOOR_NAV', 'TRANSITION'],
  ['TRANSITION', 'INDOOR_NAV'],
  ['INDOOR_NAV', 'AT_ITEM'],
  ['AT_ITEM', 'CHECKOUT_NAV'],
  ['CHECKOUT_NAV', 'DONE'],
  ['AT_ITEM', 'ITEM_PICKUP'],
  ['ITEM_PICKUP', 'CHECKOUT_NAV'],
  ['IDLE', 'GUIDED_TASK'],          // TASK_REQUESTED
  ['GUIDED_TASK', 'DONE'],          // TASK_COMPLETED
  ['TRANSITION', 'DONE'],           // destination-only trip ends at the door
];

function make(initialMode: AppMode = 'IDLE', extra: Parameters<typeof createAppStore>[0] = {}) {
  const bus = createEventBus();
  const warn = jest.fn();
  const store = createAppStore({ bus, warn, initial: { mode: initialMode }, ...extra });
  return { bus, warn, store };
}

describe('legal transition table', () => {
  it('lists all thirteen modes', () => {
    expect(APP_MODES).toHaveLength(13);
    expect(Object.keys(LEGAL_TRANSITIONS).sort()).toEqual([...APP_MODES].sort());
  });

  it.each(ARROWS)('%s → %s is legal', (from, to) => {
    expect(isLegalTransition(from, to)).toBe(true);
  });

  it.each(APP_MODES.map((m) => [m]))('%s → IDLE (abort) is legal', (from) => {
    expect(isLegalTransition(from, 'IDLE')).toBe(true);
  });

  it('everything not in the table is illegal', () => {
    const legal = new Set(ARROWS.map(([a, b]) => `${a}>${b}`));
    for (const from of APP_MODES) {
      for (const to of APP_MODES) {
        if (from === to || to === 'IDLE') continue;
        expect(isLegalTransition(from, to)).toBe(legal.has(`${from}>${to}`));
      }
    }
  });
});

describe('setMode', () => {
  it.each(ARROWS)('applies %s → %s', (from, to) => {
    const { store, warn } = make(from);
    expect(store.getState().setMode(to)).toBe(true);
    expect(store.getState().mode).toBe(to);
    expect(warn).not.toHaveBeenCalled();
  });

  it('rejects an illegal transition: loud warn, ERROR on the bus, no change', () => {
    const { store, warn, bus } = make('AT_CURB');
    const errors: string[] = [];
    bus.on('ERROR', (e) => errors.push(`${e.scope}:${e.message}`));
    expect(store.getState().setMode('INDOOR_NAV')).toBe(false);
    expect(store.getState().mode).toBe('AT_CURB');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/ILLEGAL MODE TRANSITION AT_CURB → INDOOR_NAV/);
    expect(errors).toEqual([expect.stringMatching(/^store:ILLEGAL MODE TRANSITION/)]);
    expect(store.getState().illegalTransitions).toBe(1);
  });

  it('rejects the classic mistakes', () => {
    const cases: Array<[AppMode, AppMode]> = [
      ['OUTDOOR_NAV', 'INDOOR_NAV'],
      ['OUTDOOR_NAV', 'AT_CURB'],
      ['CROSSING', 'TRANSITION'],
      ['INDOOR_NAV', 'CHECKOUT_NAV'],
      ['DONE', 'OUTDOOR_NAV'],
      ['ONBOARDING', 'INDOOR_NAV'],
    ];
    for (const [from, to] of cases) {
      const { store } = make(from);
      expect(store.getState().setMode(to)).toBe(false);
      expect(store.getState().mode).toBe(from);
    }
  });

  it('uses the default console.warn when no warn is injected', () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createAppStore({ initial: { mode: 'DONE' } });
    store.getState().setMode('OUTDOOR_NAV');
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('same-mode is a no-op without a warning', () => {
    const { store, warn } = make('CROSSING');
    expect(store.getState().setMode('CROSSING')).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(APP_MODES.map((m) => [m]))('abort from %s → IDLE clears the task fields', (from) => {
    const { store } = make(from, {
      initial: {
        mode: from,
        targetItem: 'eggs', storeId: 's', targetAisleId: 'a3', targetSide: 'RIGHT',
        currentAisleOrder: 2, activeCrossingId: 'c1', routeReady: true, onboardingComplete: true,
        trainingMode: false, speechRate: 1.3, bodyOffsetDeg: 4, firstRun: false,
      },
    });
    store.getState().abort();
    const s = store.getState();
    expect(s.mode).toBe('IDLE');
    expect(s.targetItem).toBeNull();
    expect(s.storeId).toBeNull();
    expect(s.targetAisleId).toBeNull();
    expect(s.targetSide).toBeNull();
    expect(s.currentAisleOrder).toBeNull();
    expect(s.activeCrossingId).toBeNull();
    expect(s.routeReady).toBe(false);
    expect(s.onboardingComplete).toBe(false);
    // Preferences and calibration survive an abort.
    expect(s.trainingMode).toBe(false);
    expect(s.speechRate).toBe(1.3);
    expect(s.bodyOffsetDeg).toBe(4);
    expect(s.firstRun).toBe(false);
  });
});

describe('simple actions', () => {
  it('clamps the speech rate to 0.8–1.6', () => {
    expect(clampSpeechRate(0.1)).toBe(0.8);
    expect(clampSpeechRate(5)).toBe(1.6);
    expect(clampSpeechRate(1.2)).toBe(1.2);
    expect(clampSpeechRate(Number.NaN)).toBe(1.0);
    const { store } = make();
    store.getState().setSpeechRate(9);
    expect(store.getState().speechRate).toBe(1.6);
  });

  it('keeps a ring of the last 10 events', () => {
    const { store } = make();
    for (let i = 0; i < 13; i += 1) {
      store.getState().pushEvent({ type: 'OUTDOOR_LEG_ADVANCED', index: i, instruction: 'x' }, i);
    }
    const ev = store.getState().lastEvents;
    expect(ev).toHaveLength(LAST_EVENTS_SIZE);
    expect(ev[0]?.ts).toBe(3);
    expect(ev[ev.length - 1]?.ts).toBe(12);
  });

  it('reset returns to the initial state', () => {
    const { store } = make('DONE');
    store.getState().setTrainingMode(false);
    store.getState().reset();
    expect(store.getState().mode).toBe('DONE'); // initial override is kept
    expect(store.getState().trainingMode).toBe(true);
  });
});

describe('selectors', () => {
  it('classify phases', () => {
    const { store } = make('AT_CURB');
    const s = store.getState();
    expect(selectIsOutdoorPhase(s)).toBe(true);
    expect(selectIsCrossingPhase(s)).toBe(true);
    expect(selectIsIndoorPhase(s)).toBe(false);
    expect(selectIsTripActive(s)).toBe(true);
    store.getState().abort();
    expect(selectIsTripActive(store.getState())).toBe(false);
    const { store: indoor } = make('AT_ITEM');
    expect(selectIsIndoorPhase(indoor.getState())).toBe(true);
    expect(selectIsOutdoorPhase(indoor.getState())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bus-driven transitions (02 Task 2 table)
// ---------------------------------------------------------------------------

describe('bindStoreToBus', () => {
  let bus: AppEventBus;
  let store: AppStore;
  let warn: jest.Mock;
  let said: SpeechRequest[];
  let unbind: () => void;

  beforeEach(() => {
    jest.useFakeTimers();
    ({ bus, store, warn } = make());
    said = [];
    unbind = bindStoreToBus(store, bus, {
      speech: () => ({
        say: (r) => { said.push(r); },
        playStream: () => {},
        clearQueue: () => {},
        isSpeaking: () => false,
        setRate: () => {},
      }),
    });
  });

  afterEach(() => {
    unbind();
    jest.useRealTimers();
  });

  const mode = () => store.getState().mode;

  function walkToOutdoor(): void {
    bus.emit({ type: 'ITEM_REQUESTED', item: 'eggs', source: 'keyboard' });
    store.getState().finishOnboarding();
    bus.emit({ type: 'ROUTE_READY', legCount: 2, destName: 'Demo Grocery', crossingCount: 1 });
    expect(mode()).toBe('OUTDOOR_NAV');
  }

  it('ITEM_REQUESTED on first run: IDLE → ONBOARDING, sets targetItem', () => {
    bus.emit({ type: 'ITEM_REQUESTED', item: 'eggs', source: 'voice' });
    expect(mode()).toBe('ONBOARDING');
    expect(store.getState().targetItem).toBe('eggs');
    expect(store.getState().onboardingComplete).toBe(false);
  });

  it('ROUTE_READY before onboarding finishes waits; finishing joins → OUTDOOR_NAV', () => {
    bus.emit({ type: 'ITEM_REQUESTED', item: 'eggs', source: 'voice' });
    bus.emit({ type: 'ROUTE_READY', legCount: 2, destName: 'd', crossingCount: 1 });
    expect(mode()).toBe('ONBOARDING');
    store.getState().finishOnboarding();
    expect(mode()).toBe('OUTDOOR_NAV');
    expect(store.getState().firstRun).toBe(false);
  });

  it('onboarding finished first, then ROUTE_READY → OUTDOOR_NAV', () => {
    walkToOutdoor();
  });

  it('returning user: ITEM_REQUESTED stays in IDLE (no tutorial); ROUTE_READY goes straight out', () => {
    store.getState().setFirstRun(false);
    bus.emit({ type: 'ITEM_REQUESTED', item: 'milk', source: 'keyboard' });
    expect(mode()).toBe('IDLE');
    expect(store.getState().onboardingComplete).toBe(true);
    bus.emit({ type: 'ROUTE_READY', legCount: 1, destName: 'd', crossingCount: 0 });
    expect(mode()).toBe('OUTDOOR_NAV');
    expect(warn).not.toHaveBeenCalled();
  });

  it('returning user: ROUTE_READY arriving in IDLE first is the ordinary IDLE → OUTDOOR_NAV edge', () => {
    store.getState().setFirstRun(false);
    bus.emit({ type: 'ROUTE_READY', legCount: 1, destName: 'd', crossingCount: 0 });
    expect(mode()).toBe('OUTDOOR_NAV');
    expect(warn).not.toHaveBeenCalled();
  });

  it('first run: ROUTE_READY arriving in IDLE is remembered until onboarding', () => {
    bus.emit({ type: 'ROUTE_READY', legCount: 1, destName: 'd', crossingCount: 0 });
    expect(mode()).toBe('IDLE');
    bus.emit({ type: 'ITEM_REQUESTED', item: 'milk', source: 'mock' });
    expect(mode()).toBe('ONBOARDING');
    store.getState().finishOnboarding();
    expect(mode()).toBe('OUTDOOR_NAV');
  });

  it('runs the crossing loop and repeats it', () => {
    walkToOutdoor();
    for (const id of ['c1', 'c2']) {
      bus.emit({ type: 'CROSSING_AHEAD', crossingId: id, street: 'Forbes', signalized: true, pushButtonLikely: false, bearingDeg: 90, distanceM: 24 });
      expect(mode()).toBe('APPROACH_CROSSING');
      expect(store.getState().activeCrossingId).toBe(id);
      bus.emit({ type: 'CURB_REACHED', crossingId: id });
      expect(mode()).toBe('AT_CURB');
      bus.emit({ type: 'CROSSING_STARTED', crossingId: id });
      expect(mode()).toBe('CROSSING');
      bus.emit({ type: 'FAR_CURB_REACHED', crossingId: id });
      expect(mode()).toBe('OUTDOOR_NAV');
      expect(store.getState().activeCrossingId).toBeNull();
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('ROUTE_READY while approaching drops the crossing (re-plan)', () => {
    walkToOutdoor();
    bus.emit({ type: 'CROSSING_AHEAD', crossingId: 'c1', street: 'Forbes', signalized: null, pushButtonLikely: false, bearingDeg: 0, distanceM: 20 });
    expect(mode()).toBe('APPROACH_CROSSING');
    bus.emit({ type: 'ROUTE_READY', legCount: 3, destName: 'd', crossingCount: 0 });
    expect(mode()).toBe('OUTDOOR_NAV');
    expect(store.getState().activeCrossingId).toBeNull();
  });

  it('out-of-order crossing events are ignored without changing mode', () => {
    walkToOutdoor();
    bus.emit({ type: 'CURB_REACHED', crossingId: 'c1' });
    bus.emit({ type: 'CROSSING_STARTED', crossingId: 'c1' });
    bus.emit({ type: 'FAR_CURB_REACHED', crossingId: 'c1' });
    expect(mode()).toBe('OUTDOOR_NAV');
  });

  it('STORE_ENTERED: OUTDOOR_NAV → TRANSITION, speaks entering_store, auto → INDOOR_NAV after the cap', () => {
    walkToOutdoor();
    bus.emit({ type: 'STORE_ENTERED', reason: 'FUSED', confidence: 0.8 });
    expect(mode()).toBe('TRANSITION');
    expect(said.map((r) => r.cacheKey)).toEqual(['entering_store']);
    jest.advanceTimersByTime(2999);
    expect(mode()).toBe('TRANSITION');
    jest.advanceTimersByTime(1);
    expect(mode()).toBe('INDOOR_NAV');
  });

  it('transitionEnded() advances early and the cap timer does nothing afterwards', () => {
    walkToOutdoor();
    bus.emit({ type: 'STORE_ENTERED', reason: 'MANUAL', confidence: 1 });
    store.getState().transitionEnded();
    expect(mode()).toBe('INDOOR_NAV');
    jest.advanceTimersByTime(5000);
    expect(mode()).toBe('INDOOR_NAV');
    expect(warn).not.toHaveBeenCalled();
  });

  it('abort during TRANSITION cancels the cap timer', () => {
    walkToOutdoor();
    bus.emit({ type: 'STORE_ENTERED', reason: 'FUSED', confidence: 0.7 });
    store.getState().abort();
    expect(mode()).toBe('IDLE');
    jest.advanceTimersByTime(5000);
    expect(mode()).toBe('IDLE');
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['APPROACH_CROSSING', 'AT_CURB', 'CROSSING'] as const)(
    'STORE_ENTERED in %s is logged and dropped — the crossing wins',
    (m) => {
      walkToOutdoor();
      bus.emit({ type: 'CROSSING_AHEAD', crossingId: 'c1', street: 'Forbes', signalized: true, pushButtonLikely: false, bearingDeg: 0, distanceM: 20 });
      if (m !== 'APPROACH_CROSSING') bus.emit({ type: 'CURB_REACHED', crossingId: 'c1' });
      if (m === 'CROSSING') bus.emit({ type: 'CROSSING_STARTED', crossingId: 'c1' });
      expect(mode()).toBe(m);
      bus.emit({ type: 'STORE_ENTERED', reason: 'FUSED', confidence: 0.9 });
      expect(mode()).toBe(m);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(said).toHaveLength(0);
      const errors = store.getState().lastEvents.filter((e) => e.type === 'ERROR');
      expect(errors).toHaveLength(1);
    },
  );

  function walkIndoors(): void {
    walkToOutdoor();
    bus.emit({ type: 'STORE_ENTERED', reason: 'FUSED', confidence: 0.8 });
    jest.advanceTimersByTime(3000);
    expect(mode()).toBe('INDOOR_NAV');
  }

  it('TARGET_AISLE_REACHED: INDOOR_NAV → AT_ITEM with side; CHECKOUT_REACHED closes the trip', () => {
    walkIndoors();
    bus.emit({ type: 'TARGET_AISLE_REACHED', aisleId: 'a3', side: 'RIGHT' });
    expect(mode()).toBe('AT_ITEM');
    expect(store.getState().targetAisleId).toBe('a3');
    expect(store.getState().targetSide).toBe('RIGHT');
    store.getState().nextFromItem();
    expect(mode()).toBe('CHECKOUT_NAV');
    bus.emit({ type: 'CHECKOUT_REACHED' });
    expect(mode()).toBe('DONE');
    expect(warn).not.toHaveBeenCalled();
  });

  it('stretch beat: first hand hint → ITEM_PICKUP, touching → CHECKOUT_NAV', () => {
    walkIndoors();
    bus.emit({ type: 'TARGET_AISLE_REACHED', aisleId: 'a3', side: 'LEFT' });
    bus.emit({ type: 'ITEM_HAND_GUIDANCE', hint: 'higher', step: 1 });
    expect(mode()).toBe('ITEM_PICKUP');
    bus.emit({ type: 'ITEM_HAND_GUIDANCE', hint: 'left', step: 2 });
    expect(mode()).toBe('ITEM_PICKUP');
    bus.emit({ type: 'ITEM_HAND_GUIDANCE', hint: 'touching', step: 3 });
    expect(mode()).toBe('CHECKOUT_NAV');
  });

  it('stretch beat gives up at step 8', () => {
    walkIndoors();
    bus.emit({ type: 'TARGET_AISLE_REACHED', aisleId: 'a3', side: 'LEFT' });
    bus.emit({ type: 'ITEM_HAND_GUIDANCE', hint: 'not_seen', step: 1 });
    bus.emit({ type: 'ITEM_HAND_GUIDANCE', hint: 'not_seen', step: 8 });
    expect(mode()).toBe('CHECKOUT_NAV');
  });

  it('user tap "next" in ITEM_PICKUP → CHECKOUT_NAV', () => {
    walkIndoors();
    bus.emit({ type: 'TARGET_AISLE_REACHED', aisleId: 'a3', side: 'LEFT' });
    bus.emit({ type: 'ITEM_HAND_GUIDANCE', hint: 'lower', step: 1 });
    store.getState().nextFromItem();
    expect(mode()).toBe('CHECKOUT_NAV');
  });

  it('indoor events outdoors are ignored silently', () => {
    walkToOutdoor();
    bus.emit({ type: 'TARGET_AISLE_REACHED', aisleId: 'a3', side: 'LEFT' });
    bus.emit({ type: 'CHECKOUT_REACHED' });
    bus.emit({ type: 'ITEM_HAND_GUIDANCE', hint: 'touching', step: 1 });
    expect(mode()).toBe('OUTDOOR_NAV');
    expect(warn).not.toHaveBeenCalled();
  });

  it('records every bus event in lastEvents', () => {
    bus.emit({ type: 'ITEM_REQUESTED', item: 'eggs', source: 'voice' });
    bus.emit({ type: 'ERROR', scope: 'x', message: 'y' });
    expect(store.getState().lastEvents.map((e) => e.type)).toEqual(['ITEM_REQUESTED', 'ERROR']);
  });

  it('unbind stops driving the store', () => {
    unbind();
    bus.emit({ type: 'ITEM_REQUESTED', item: 'eggs', source: 'voice' });
    expect(mode()).toBe('IDLE');
    unbind = () => {};
  });
});

describe('module singletons', () => {
  it('appStore is bound to appBus', () => {
    appStore.getState().reset();
    appBus.emit({ type: 'ITEM_REQUESTED', item: 'eggs', source: 'mock' });
    expect(appStore.getState().mode).toBe('ONBOARDING');
    expect(appStore.getState().targetItem).toBe('eggs');
    appStore.getState().abort();
    expect(appStore.getState().mode).toBe('IDLE');
    expect(appStore.getState().targetItem).toBeNull();
  });
});

describe('post-review edges (01 §1)', () => {
  function bound(initial: AppMode) {
    const { store, bus } = make(initial);
    const unbind = bindStoreToBus(store, bus, {
      speech: () => ({ say: () => {}, playStream: () => {}, clearQueue: () => {}, isSpeaking: () => false, setRate: () => {} }),
    });
    return { store, bus, unbind };
  }
  it('CROSSING_ABORTED at the curb returns to OUTDOOR_NAV and clears the crossing', () => {
    const { store, bus, unbind } = bound('AT_CURB');
    store.setState({ activeCrossingId: 'x1' });
    bus.emit({ type: 'CROSSING_ABORTED', crossingId: 'x1', reason: 'walked_past' });
    expect(store.getState().mode).toBe('OUTDOOR_NAV');
    expect(store.getState().activeCrossingId).toBeNull();
    unbind();
  });
  it("CROSSING_ABORTED while merely armed ('walked_past' in APPROACH_CROSSING) returns to OUTDOOR_NAV", () => {
    const { store, bus, unbind } = bound('APPROACH_CROSSING');
    store.setState({ activeCrossingId: 'x1' });
    bus.emit({ type: 'CROSSING_ABORTED', crossingId: 'x1', reason: 'walked_past' });
    expect(store.getState().mode).toBe('OUTDOOR_NAV');
    expect(store.getState().activeCrossingId).toBeNull();
    unbind();
  });
  it('CROSSING_ABORTED mid-crossing returns to OUTDOOR_NAV, never AT_CURB', () => {
    const { store, bus, unbind } = bound('CROSSING');
    bus.emit({ type: 'CROSSING_ABORTED', crossingId: 'x1', reason: 'user' });
    expect(store.getState().mode).toBe('OUTDOOR_NAV');
    unbind();
  });
});

describe('destinations and guided tasks (round 4)', () => {
  function bound(initial: AppMode) {
    const { store, bus } = make(initial);
    const unbind = bindStoreToBus(store, bus, {
      speech: () => ({ say: () => {}, playStream: () => {}, clearQueue: () => {}, isSpeaking: () => false, setRate: () => {} }),
    });
    return { store, bus, unbind };
  }
  it('DESTINATION_REQUESTED records a destination-only trip; TRANSITION then ends in DONE', () => {
    jest.useFakeTimers();
    const { store, bus, unbind } = bound('IDLE');
    store.setState({ firstRun: false });
    bus.emit({ type: 'DESTINATION_REQUESTED', name: 'CVS', source: 'voice' });
    expect(store.getState().targetItem).toBe('CVS');
    expect(store.getState().destinationOnly).toBe(true);
    bus.emit({ type: 'ROUTE_READY', legCount: 1, destName: 'CVS', crossingCount: 0 });
    expect(store.getState().mode).toBe('OUTDOOR_NAV');
    bus.emit({ type: 'STORE_ENTERED', reason: 'MANUAL', confidence: 1 });
    expect(store.getState().mode).toBe('TRANSITION');
    jest.advanceTimersByTime(4000);
    expect(store.getState().mode).toBe('DONE');
    unbind();
    jest.useRealTimers();
  });
  it('TASK_REQUESTED → GUIDED_TASK with the goal; TASK_STEP updates progress; TASK_COMPLETED → DONE; abort clears', () => {
    const { store, bus, unbind } = bound('IDLE');
    bus.emit({ type: 'TASK_REQUESTED', goal: 'eggs in my fridge', context: 'home', source: 'voice' });
    expect(store.getState().mode).toBe('GUIDED_TASK');
    expect(store.getState().taskGoal).toBe('eggs in my fridge');
    bus.emit({ type: 'TASK_STEP', index: 2, total: 4, instruction: 'Open the fridge.' });
    expect(store.getState().taskStep).toBe(2);
    expect(store.getState().taskStepCount).toBe(4);
    bus.emit({ type: 'TASK_COMPLETED', goal: 'eggs in my fridge' });
    expect(store.getState().mode).toBe('DONE');
    store.getState().abort();
    expect(store.getState().taskGoal).toBeNull();
    expect(store.getState().mode).toBe('IDLE');
    unbind();
  });
});
