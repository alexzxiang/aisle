import { createSearchExplorer } from './searchExplorer';
import type { SearchObservation } from './searchObservation';
import { coerceSearchObservation } from './searchObservation';
import { foodSection, sectionFromFoods } from './foodCatalog';
import type { GuideInstruction } from './guide';
import { checkPhrase } from './phrases';

const observation = (patch: Partial<SearchObservation> = {}): SearchObservation => ({
  sign: null, items: [], view: 'overview', quality: 'usable', confidence: 0.9, barrier: 'none',
  landmarks: [{ name: 'produce display', kind: 'section', section: 'produce', box: [0.4, 0.2, 0.2, 0.4], confidence: 0.9 }], ...patch,
});

function setup(context: 'store' | 'home' = 'store') {
  let t = 100000;
  let steps = 0;
  let seq = 0;
  const said: string[] = [];
  const guide = jest.fn((_name, box): GuideInstruction => ({ kind: 'forward', targetVisible: true, text: 'Walk forward.', relativeDeg: 0, steps: 3, box }));
  const search = createSearchExplorer({ item: 'bananas', context, guide: { instructionFor: guide }, now: () => t, steps: () => steps });
  const tick = (patch: Partial<SearchObservation> = {}, opts: { confined?: boolean; surface?: boolean } = {}) => {
    t += 6000;
    search.observe(observation(patch), ++seq, t);
    const result = search.tick('bananas', null, opts);
    if (result?.text) said.push(result.text);
    return result;
  };
  const permission = () => { for (let i = 0; i < 5; i++) tick(); };
  return { search, tick, permission, said, guide, step: () => { steps++; }, time: () => t, wait: (ms: number) => { t += ms; } };
}

describe('active search with trip memory', () => {
  it('scans first, asks permission for produce, and never walks on silence', () => {
    const h = setup(); h.permission();
    expect(h.said).toContain('May I guide you toward the produce section?');
    expect(h.search.pending()).toBe(true);
    for (let i = 0; i < 6; i++) h.tick();
    expect(h.guide).not.toHaveBeenCalled();
    expect(h.search.intercept('yes').consumed).toBe(true);
    expect(h.tick()?.text).toMatch(/Walk one step/);
    expect(h.guide).toHaveBeenLastCalledWith('produce display', expect.any(Object), { modelOnly: true, maxAgeMs: 6000 });
  });

  it('waits for actual steps, then inspects a new view without declaring an aisle arrival', () => {
    const h = setup(); h.permission(); h.search.intercept('yes'); h.tick();
    expect(h.tick()?.text).toMatch(/Pause/);
    expect(h.search.memory()).toHaveLength(1);
    h.step(); h.tick(); h.step(); h.tick(); h.step();
    expect(h.tick()?.text).toBe('Pause here. Let me inspect this view.');
    expect(h.search.memory()).toHaveLength(2);
    expect(h.search.memory()[1]!.sign).toBeNull();
  });

  it('stops walking when the landmark leaves view and honors refusal', () => {
    const h = setup(); h.permission(); h.search.intercept('yes');
    expect(h.tick({ landmarks: [] })?.text).toMatch(/Pause walking/);
    const n = setup(); n.permission();
    expect(n.search.intercept('no').text).toMatch(/stay here/);
    for (let i = 0; i < 6; i++) n.tick();
    expect(n.guide).not.toHaveBeenCalled();
    expect(n.search.target()).toBeNull();
  });

  it('records partial coverage, not absence from a whole aisle, and ignores unusable views', () => {
    const h = setup();
    h.tick({ view: 'upper', sign: 'Dairy', items: ['milk', 'yogurt'] });
    h.tick({ view: 'upper', sign: 'Dairy', items: ['milk', 'yogurt'] });
    expect(h.search.memory()[0]).toMatchObject({ sign: 'Dairy', section: 'dairy', outcome: 'partly_searched', views: ['upper'] });
    h.tick({ view: 'lower', quality: 'blurred' });
    expect(h.search.memory()[0]!.views).toEqual(['upper']);
    h.tick({ view: 'middle' }); h.tick({ view: 'lower' });
    expect(h.search.memory()[0]!.outcome).toBe('not_seen_in_scanned_views');
    expect(h.search.context()).toContain('Unseen is not absent');
    expect(h.search.context()).toContain('Likely category: produce');
  });

  it('narrates milk and yogurt as evidence for dairy', () => {
    const h = setup();
    h.tick({ items: ['milk', 'yogurt'] });
    expect(h.said).toContain('milk and yogurt. This seems to be dairy.');
  });

  it('does not leave an open fridge to chase another aisle', () => {
    const h = setup();
    for (let i = 0; i < 5; i++) h.tick({}, { confined: true });
    expect(h.search.target()).toBeNull();
    expect(h.said.at(-1)).toMatch(/Item still unconfirmed/);
    expect(h.search.intercept('yes').consumed).toBe(false);
    expect(h.search.intercept('search again').consumed).toBe(true);
    expect(h.tick({}, { confined: true })?.text).toMatch(/upper shelf/);
  });

  it('resumes target approach immediately if the item appears during consent', () => {
    const h = setup(); h.permission();
    const direct = h.guide('banana', { box: [0.4, 0.2, 0.2, 0.4], at: h.time() });
    expect(h.search.tick('bananas', direct)).toBeNull();
    expect(h.search.pending()).toBe(false);
  });

  it('bounds fruitless scans and keeps every generated instruction speakable', () => {
    const h = setup('home');
    for (let i = 0; i < 10; i++) h.tick({ landmarks: [] });
    expect(h.said.some((s) => s.includes('No route landmark'))).toBe(true);
    expect(h.search.pending()).toBe(true);
    for (const text of h.said) expect(checkPhrase(text)).toEqual([]);
  });
});

describe('food and observation evidence', () => {
  it('supports groceries without treating packaging or a category as identity', () => {
    expect(foodSection('organic brown eggs')).toBe('dairy');
    expect(foodSection('wrapped chicken breast')).toBe('meat');
    expect(foodSection('cheddar cheese in a bag')).toBe('dairy');
    expect(foodSection('frozen bananas')).toBe('frozen');
    expect(foodSection('opaque container')).toBe('unknown');
    expect(sectionFromFoods(['milk', 'milk'])).toBe('unknown');
    expect(sectionFromFoods(['milk', 'yogurt'])).toBe('dairy');
  });
  it('rejects invalid and off-image landmark boxes on both sides of the wire', () => {
    const raw = observation({ landmarks: [
      { name: 'door', kind: 'doorway', section: 'unknown', box: [0.9, 0.1, 0.4, 0.4], confidence: 1 },
    ] });
    expect(coerceSearchObservation(raw)?.landmarks).toEqual([]);
    expect(coerceSearchObservation(null)).toBeUndefined();
  });
});
