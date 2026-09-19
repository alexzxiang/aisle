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
  it('scans first (three poses), asks permission for produce, and never walks on silence', () => {
    const h = setup(); h.permission();
    // In a store the look-around is along the aisle; at home it is left, right, behind.
    expect(h.said.slice(0, 3)).toEqual(['Face the shelf on your left. Pan slowly top to bottom.', 'Now face the right shelf and pan slowly top to bottom.', 'Turn to look along the aisle for signs and displays.']);
    const home = setup('home'); home.permission();
    expect(home.said.slice(0, 3)).toEqual(['Turn the camera slowly left.', 'Now turn the camera slowly right.', 'Turn around slowly so I can see behind you.']);
    expect(h.said).toContain('May I guide you toward the produce section?');
    expect(h.search.pending()).toBe(true);
    for (let i = 0; i < 6; i++) h.tick();
    expect(h.guide).not.toHaveBeenCalled();
    expect(h.search.intercept('yes')).toEqual({ consumed: true, text: 'Okay. Heading for the produce display.' });
    expect(h.tick()?.text).toBe('Produce display ahead. Walk forward three steps.');
    expect(h.guide).toHaveBeenLastCalledWith('produce display', expect.any(Object), { modelOnly: true, maxAgeMs: 8000 });
  });

  it('walks by geometry — "keep going" as the count drops — and inspects the new place on arrival', () => {
    const h = setup(); h.permission(); h.search.intercept('yes');
    expect(h.tick()?.text).toBe('Produce display ahead. Walk forward three steps.');
    h.guide.mockImplementation((_name, box) => ({ kind: 'forward', targetVisible: true, text: '', relativeDeg: 0, steps: 1, box }));
    expect(h.tick()?.text).toBe('Keep going. One step more.');
    expect(h.search.memory()).toHaveLength(1);
    h.guide.mockImplementation((_name, box) => ({ kind: 'arrived', targetVisible: true, text: '', relativeDeg: 0, steps: 0, box }));
    h.tick();                                                    // one arrival frame is not enough
    const here = h.tick();
    expect(here?.text).toBe('Here. Let me look around this spot.');
    expect(here?.haptic).toBe('CONFIRM');
    expect(h.search.memory()).toHaveLength(2);
    expect(h.search.memory()[1]!.landmark).toBe('produce display');
    expect(h.search.status()).toBe('scan');
  });

  it('keeps walking briefly when the landmark leaves view, then stops to look; refusal is honoured', () => {
    const h = setup(); h.permission(); h.search.intercept('yes'); h.tick();
    expect(h.tick({ landmarks: [] })?.text).toBe('Keep walking. Hold the camera level to find the produce display.');
    expect(h.tick({ landmarks: [] })?.text).toBe('Stop. Turn slowly until I see the produce display again.');
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

  it('narrates milk and yogurt as evidence for dairy, then where the bananas should be', () => {
    const h = setup();
    h.tick({ items: ['milk', 'yogurt'] });
    h.tick({ items: ['milk', 'yogurt'] });
    expect(h.said.slice(0, 2)).toEqual(['Milk and yogurt here. This seems to be dairy.', 'Bananas should be in produce. Let me find the way.']);
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

  it('with no landmark anywhere it walks on a few steps and looks again, three times, then asks for help', () => {
    const h = setup('home');
    const texts: string[] = [];
    for (let i = 0; i < 70; i++) { const r = h.tick({ landmarks: [] }); if (r?.text) texts.push(r.text); }
    expect(texts).toContain('No landmark yet. Walk forward five steps, then I will look again.');
    expect(texts.filter((s) => s === 'Stop here. Let me look around again.')).toHaveLength(3);
    expect(texts).toContain('No way on from here. Ask someone nearby, or say search again.');
    expect(h.search.pending()).toBe(true);
    expect(h.search.status()).toBe('paused');
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
