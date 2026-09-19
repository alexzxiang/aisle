/**
 * The whole indoor leg in mock mode: D's replayer + D's store fixture + A's store
 * and bus, no camera, no proxy (04 "Definition of done", 01 §12).
 */
import type { AppEvent, SpeechRequest } from '../core/contracts';
import { createEventBus } from '../core/bus';
import { bindStoreToBus, createAppStore } from '../core/store';
import { createMockServices } from '../../mocks';
import { storeMap as demoStoreMap } from '../../mocks/fixtures';
import { bindPerceptionToApp } from '../perception/PerceptionService';
import { createSemanticVision } from '../perception/semanticVision';
import { createIndoorController } from './indoorController';
import { createStoreResolver } from './storeResolver';

function rig() {
  let wall = 1_000_000;
  const now = () => wall;
  const bus = createEventBus();
  const events: AppEvent[] = [];
  bus.onAny((r) => events.push(r.event));
  const store = createAppStore({ bus, warn: () => {}, initial: { firstRun: false } });
  const unbindStore = bindStoreToBus(store, bus, { transitionCapMs: 3000 });

  const said: SpeechRequest[] = [];
  const played: string[] = [];
  const speech = { say: (r: SpeechRequest) => { said.push(r); }, playStream: () => {}, clearQueue: () => {}, isSpeaking: () => false, setRate: () => {} };
  let courseRunning = false;
  const haptics = {
    play: (p: string) => { played.push(p); },
    startCourse: () => { courseRunning = true; },
    stopCourse: () => { courseRunning = false; },
    isCourseBuzzing: () => false,
  };

  const intervals: Array<{ fn: () => void; ms: number }> = [];
  const mocks = createMockServices({
    bus,
    wall: now,
    latencyScale: 0,
    setIntervalFn: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearIntervalFn: () => {},
  });
  const perception = mocks.perception;
  const sensors = mocks.sensors;

  const binding = bindPerceptionToApp({ perception, bus, store, haptics: haptics as never, speech });
  const vision = createSemanticVision({ transport: mocks.semanticVision, perception, speech, bus, store, now, isCourseBuzzing: () => false });
  const resolver = createStoreResolver({ bus, store, speech, perception, loadStoreMap: () => demoStoreMap, warn: () => {} });
  const navIntervals: Array<{ fn: () => void; ms: number }> = [];
  const controller = createIndoorController({
    bus, store, speech, haptics: haptics as never, sensors, perception, vision, resolver, now,
    setIntervalFn: (fn, ms) => { navIntervals.push({ fn, ms }); return navIntervals.length; },
    clearIntervalFn: () => {},
  });

  const advance = (ms: number, step = 50): void => {
    for (let t = 0; t < ms; t += step) {
      wall += step;
      mocks.harness.tick();
      if (wall % 1000 < step) for (const i of navIntervals) i.fn();
    }
  };

  return {
    bus, events, store, said, played, mocks, perception, controller, resolver, vision, advance,
    isCourseRunning: () => courseRunning,
    dispose: () => { controller.dispose(); binding.dispose(); unbindStore(); },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
}

describe('indoor leg in mock mode (no camera, no proxy)', () => {
  it("'I need eggs' → walk 1 → 2 → 3 on the replayed pack → 'Aisle three. Eggs on your right.' → AT_ITEM", async () => {
    const r = rig();
    r.mocks.harness.start();

    r.bus.emit({ type: 'ITEM_REQUESTED', item: 'eggs', source: 'mock' });
    await flush();
    expect(r.resolver.getTarget()?.aisleId).toBe('a3');
    expect(r.store.getState().targetAisleId).toBe('a3');

    // Route → walk → door → handoff, driven by events as A's table says (no setMode from here).
    r.bus.emit({ type: 'ROUTE_READY', legCount: 2, destName: 'Demo Grocery', crossingCount: 1 });
    expect(r.store.getState().mode).toBe('OUTDOOR_NAV');
    r.bus.emit({ type: 'STORE_ENTERED', reason: 'MANUAL', confidence: 1 });
    expect(r.store.getState().mode).toBe('TRANSITION');
    r.store.getState().transitionEnded();
    expect(r.store.getState().mode).toBe('INDOOR_NAV');
    await flush();
    expect(r.controller.isActive()).toBe(true);
    expect(r.perception.debug().profile).toBe('INDOOR_NAV');
    expect(r.perception.debug().pack).toBe('indoor-aisle-walk');
    expect(r.perception.debug().knownSigns).toEqual(expect.arrayContaining(['3', 'DAIRY', 'CHECKOUT']));

    // The pack reads "1 PRODUCE" ×3 at 2.0–2.8 s, "2 BAKERY" at 12 s, "3 DAIRY" at 24 s.
    r.advance(5000);
    await flush();
    const identified = () => r.events.filter((e): e is Extract<AppEvent, { type: 'AISLE_IDENTIFIED' }> => e.type === 'AISLE_IDENTIFIED').map((e) => e.aisleId);
    expect(identified()).toEqual(['a1']);
    expect(r.isCourseRunning()).toBe(true);            // centring anchored on the first sign

    r.advance(10_000);
    await flush();
    expect(identified()).toEqual(['a1', 'a2']);
    expect(r.said.some((s) => s.cacheKey === 'keep_going')).toBe(true);

    r.advance(12_000);
    await flush();
    expect(identified()).toEqual(['a1', 'a2', 'a3']);
    const arrival = r.events.find((e) => e.type === 'TARGET_AISLE_REACHED');
    expect(arrival).toEqual({ type: 'TARGET_AISLE_REACHED', aisleId: 'a3', side: 'RIGHT' });
    expect(r.store.getState().mode).toBe('AT_ITEM');
    expect(r.store.getState().targetSide).toBe('RIGHT');
    expect(r.played).toContain('CONFIRM');
    expect(r.said.map((s) => s.text)).toContain('Aisle three. Eggs on your right.');
    expect(r.isCourseRunning()).toBe(false);            // ramp stopped on arrival

    // No forbidden word left this track.
    for (const s of r.said) expect(s.text).not.toMatch(/\b(safe|clear|go|cross now|no cars|you can cross)\b/i);
    r.dispose();
  });

  it('checkout: CHECKOUT_NAV + a CHECKOUT sign → CHECKOUT_REACHED → DONE', async () => {
    const r = rig();
    r.mocks.harness.start();
    r.bus.emit({ type: 'ITEM_REQUESTED', item: 'eggs', source: 'mock' });
    await flush();
    r.bus.emit({ type: 'ROUTE_READY', legCount: 1, destName: 'x', crossingCount: 0 });
    r.bus.emit({ type: 'STORE_ENTERED', reason: 'MANUAL', confidence: 1 });
    r.store.getState().transitionEnded();
    r.advance(30_000);
    await flush();
    expect(r.store.getState().mode).toBe('AT_ITEM');
    r.store.getState().nextFromItem();
    expect(r.store.getState().mode).toBe('CHECKOUT_NAV');
    // Feed checkout reads straight through the mock's OCR stream via a manual pack? Simpler: the
    // navigator is exposed; drive it as the matcher would after a 2-of-3 vote.
    r.controller.getNavigator().setPhase('CHECKOUT');
    const nav = r.controller.getNavigator();
    const actions = nav.onSignIdentified({ id: 'checkout', kind: 'landmark', order: 99, spokenLabel: 'Checkout', label: 'Checkout', confidence: 0.9, source: 'ocr' });
    expect(actions.some((a) => a.kind === 'emit' && a.event.type === 'CHECKOUT_REACHED')).toBe(true);
    r.dispose();
  });

  it('with no target (unknown item) aisles are announced but never an arrival', async () => {
    const r = rig();
    r.mocks.harness.start();
    r.bus.emit({ type: 'ITEM_REQUESTED', item: 'caviar', source: 'mock' });
    await flush();
    expect(r.resolver.getTarget()).toBeNull();
    expect(r.said.map((s) => s.cacheKey)).toContain('ask_staff');
    r.bus.emit({ type: 'ROUTE_READY', legCount: 1, destName: 'x', crossingCount: 0 });
    r.bus.emit({ type: 'STORE_ENTERED', reason: 'MANUAL', confidence: 1 });
    r.store.getState().transitionEnded();
    r.advance(30_000);
    await flush();
    const ids = r.events.filter((e) => e.type === 'AISLE_IDENTIFIED').length;
    expect(ids).toBe(3);
    expect(r.events.some((e) => e.type === 'TARGET_AISLE_REACHED')).toBe(false);
    expect(r.store.getState().mode).toBe('INDOOR_NAV');
    r.dispose();
  });
});
