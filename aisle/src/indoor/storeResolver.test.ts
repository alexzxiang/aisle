import type { AppEvent, SpeechRequest } from '../core/contracts';
import { createEventBus } from '../core/bus';
import { createAppStore } from '../core/store';
import {
  categoryFallback,
  createStoreResolver,
  normalizeItem,
  prefetchTexts,
  resolveFromIndex,
  runBatched,
  speakableItem,
} from './storeResolver';
import { makeTestMap } from './testing';

function rig(opts: { map?: unknown; disambiguate?: Parameters<typeof createStoreResolver>[0]['disambiguate']; prefetch?: (t: string) => Promise<unknown> } = {}) {
  const bus = createEventBus();
  const events: AppEvent[] = [];
  bus.onAny((r) => events.push(r.event));
  const store = createAppStore({ bus, warn: () => {} });
  const said: SpeechRequest[] = [];
  const knownSigns: string[][] = [];
  const warnings: string[] = [];
  const resolver = createStoreResolver({
    bus,
    store,
    speech: { say: (r) => { said.push(r); } },
    perception: { setKnownSigns: (w) => { knownSigns.push(w); } },
    loadStoreMap: () => opts.map ?? makeTestMap(),
    disambiguate: opts.disambiguate,
    prefetch: opts.prefetch,
    warn: (m) => warnings.push(m),
  });
  return { bus, events, store, said, knownSigns, warnings, resolver };
}

describe('pure pieces', () => {
  it('normalizeItem mirrors OCR normalization, lower-cased', () => {
    expect(normalizeItem('  Eggs! ')).toBe('eggs');
    expect(normalizeItem('Ice-Cream')).toBe('ice cream');
    expect(speakableItem('7up')).toBeNull();
    expect(speakableItem('eggs')).toBe('eggs');
  });
  it('resolveFromIndex takes order from the map and carries side / shelf / hint', () => {
    const t = resolveFromIndex(makeTestMap(), 'Eggs');
    expect(t).toMatchObject({ aisleId: 'a3', order: 3, spokenLabel: 'Aisle three', sideWhenAscending: 'RIGHT', shelf: 'middle', packageHint: 'yellow carton', item: 'eggs', source: 'index' });
    expect(resolveFromIndex(makeTestMap(), 'caviar')).toBeNull();
  });
  it('categoryFallback matches a unique category substring only', () => {
    expect(categoryFallback(makeTestMap(), 'yogurt')).toEqual({ aisleId: null, confidence: 0, askBack: null });
    expect(categoryFallback(makeTestMap(), 'cheese').aisleId).toBe('a3');
    expect(categoryFallback(makeTestMap(), 'vegetables').aisleId).toBe('a1');
    expect(categoryFallback(makeTestMap(), 'meat').aisleId).toBe('a5');
  });
  it('prefetchTexts covers every aisle label, both arrival sides, the pick-up openers and the hazard phrases; no digits', () => {
    const map = makeTestMap();
    const t = resolveFromIndex(map, 'eggs')!;
    const texts = prefetchTexts(map, t);
    expect(texts).toContain('Aisle three.');
    expect(texts).toContain('Aisle three. Eggs on your right.');
    expect(texts).toContain('Aisle three. Eggs on your left.');
    expect(texts).toContain('Face the shelf on your right.');
    expect(texts).toContain('Person ahead.');
    expect(texts).toContain('Checkout.');
    expect(texts.some((x) => /\d/.test(x))).toBe(false);
  });
  it('runBatched keeps at most `limit` in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    await runBatched([1, 2, 3, 4, 5, 6, 7, 8, 9], 4, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });
});

describe('createStoreResolver (04 Task 0 definition of done)', () => {
  it("ITEM_REQUESTED {item: 'eggs'} → validated map, target, setKnownSigns once, store hand-off, prefetch batch", async () => {
    const prefetched: string[] = [];
    const r = rig({ prefetch: async (t) => { prefetched.push(t); } });
    r.bus.emit({ type: 'ITEM_REQUESTED', item: 'eggs', source: 'mock' });
    await new Promise((res) => setTimeout(res, 0));
    const t = r.resolver.getTarget();
    expect(t).toMatchObject({ aisleId: 'a3', order: 3, sideWhenAscending: 'RIGHT' });
    expect(r.knownSigns).toHaveLength(1);
    expect(r.knownSigns[0]).toEqual(expect.arrayContaining(['1', 'PRODUCE', '3', 'DAIRY', 'CHECKOUT', 'REGISTERS']));
    expect(r.store.getState().storeId).toBe('test-store');
    expect(r.store.getState().targetAisleId).toBe('a3');
    expect(r.store.getState().targetSide).toBeNull();
    await new Promise((res) => setTimeout(res, 0));
    expect(prefetched).toContain('Aisle three. Eggs on your right.');
    expect(r.events.filter((e) => e.type === 'ERROR')).toEqual([]);
    // Re-runnable: a second request replaces the target without a second setKnownSigns.
    r.bus.emit({ type: 'ITEM_REQUESTED', item: 'bread', source: 'keyboard' });
    await new Promise((res) => setTimeout(res, 0));
    expect(r.resolver.getTarget()?.aisleId).toBe('a2');
    expect(r.knownSigns).toHaveLength(1);
  });
  it("'caviar' with a planner askBack → speak it once (INFO), target null, no wrong aisle", async () => {
    const r = rig({ disambiguate: async () => ({ job: 'disambiguate', output: { aisleId: null, confidence: 0.2, askBack: 'Did you mean fish or cheese?' }, fallback: false, latencyMs: 400 }) });
    const out = await r.resolver.resolve('caviar');
    expect(out.kind).toBe('ask_back');
    expect(r.resolver.getTarget()).toBeNull();
    expect(r.said.map((s) => [s.text, s.priority])).toEqual([['Did you mean fish or cheese?', 'INFO']]);
    expect(r.store.getState().targetAisleId).toBeNull();
  });
  it("'caviar' with nothing anywhere → ask_staff + ERROR {scope: 'store-resolve'}, never aisle one", async () => {
    const r = rig();
    const out = await r.resolver.resolve('caviar');
    expect(out.kind).toBe('unresolved');
    expect(r.resolver.getTarget()).toBeNull();
    expect(r.said.map((s) => s.cacheKey)).toEqual(['ask_staff']);
    expect(r.events).toContainEqual({ type: 'ERROR', scope: 'store-resolve', message: "no aisle for 'caviar'" });
  });
  it('planner aisleId (item not in the index) → target with side unknown', async () => {
    const r = rig({ disambiguate: async () => ({ job: 'disambiguate', output: { aisleId: 'a4', confidence: 0.8, askBack: null }, fallback: false, latencyMs: 300 }) });
    const out = await r.resolver.resolve('granola');
    expect(out.kind).toBe('resolved');
    expect(r.resolver.getTarget()).toMatchObject({ aisleId: 'a4', order: 4, sideWhenAscending: null, source: 'disambiguate' });
  });
  it('planner unavailable → category-substring fallback still resolves a unique category', async () => {
    const r = rig({ disambiguate: async () => { throw new Error('offline'); } });
    const out = await r.resolver.resolve('cheese');
    expect(out.kind).toBe('resolved');
    expect(r.resolver.getTarget()).toMatchObject({ aisleId: 'a3', source: 'fallback', sideWhenAscending: null });
  });
  it("a bad map is ERROR {scope: 'store-map'} plus a loud warning, never a silent null", async () => {
    const bad = { ...makeTestMap(), aisles: [{ id: 'a1', label: 'Aisle 1', spokenLabel: 'Aisle 1', signText: [], order: 1, categories: [] }] };
    const r = rig({ map: bad });
    const out = await r.resolver.resolve('eggs');
    expect(out.kind).toBe('map_error');
    expect(r.events.some((e) => e.type === 'ERROR' && e.scope === 'store-map')).toBe(true);
    expect(r.warnings.some((w) => w.includes('spokenLabel'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('signText'))).toBe(true);
  });
});
