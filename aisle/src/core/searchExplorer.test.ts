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
  it('chooses a related-products sign over an unrelated sign in the same broad department', () => {
    let t = 100000;
    const search = createSearchExplorer({ item: 'spaghetti', context: 'store', guide: { instructionFor: () => null }, now: () => t });
    let target = '';
    for (let seq = 1; seq <= 5; seq++) {
      t += 6000;
      search.observe(observation({ landmarks: [
        { name: 'Coffee and tea sign', kind: 'section', section: 'pantry', box: [0.1, 0.1, 0.2, 0.2], confidence: 0.95 },
        { name: 'Pasta and sauces sign', kind: 'section', section: 'pantry', box: [0.6, 0.1, 0.2, 0.2], confidence: 0.85 },
      ] }), seq, t);
      target = search.tick('spaghetti', null)?.target ?? target;
    }
    expect(target).toBe('Pasta and sauces sign');
    expect(search.context()).toContain('Related products:');
    expect(search.memory().some((a) => a.outcome === 'item_seen')).toBe(false);
  });

  it('scans first (three poses), asks permission for produce, walks on "yes" — or after ten silent seconds, saying so', () => {
    const h = setup(); h.permission();
    // In a store the look-around is along the aisle; at home it is left, right, behind.
    expect(h.said.slice(0, 3)).toEqual(['Face the shelf on your left. Pan slowly top to bottom.', 'Now face the right shelf and pan slowly top to bottom.', 'Turn to look along the aisle for signs and displays.']);
    const home = setup('home'); home.permission();
    expect(home.said.slice(0, 3)).toEqual(['Turn the camera slowly left.', 'Now turn the camera slowly right.', 'Turn around slowly so I can see behind you.']);
    expect(h.said).toContain('May I guide you toward the produce section?');
    expect(h.search.pending()).toBe(true);
    expect(h.guide).not.toHaveBeenCalled();
    expect(h.search.intercept('yes')).toEqual({ consumed: true, text: 'Okay. Heading for the produce display.' });
    expect(h.tick()?.text).toBe('Produce display ahead. Walk forward three steps.');
    expect(h.guide).toHaveBeenLastCalledWith('produce display', expect.any(Object), { modelOnly: true, maxAgeMs: 12000 });
    // Unanswered: after ten seconds it goes anyway and says so (the person can still say stop).
    const quiet = setup(); quiet.permission();
    expect(quiet.said).toContain('May I guide you toward the produce section?');
    const lines: string[] = [];
    for (let i = 0; i < 3; i++) { const r = quiet.tick(); if (r?.text) lines.push(r.text); }
    expect(lines).toContain('No answer. Heading for the produce display. Say stop to stay.');
    expect(quiet.search.busy()).toBe(true);
  });

  it('a landmark that comes back under another name, or a door the detector sees, is a candidate too (round 16)', () => {
    let t = 100000; let seq = 0;
    const guide = jest.fn((_name, box): GuideInstruction => ({ kind: 'forward', targetVisible: true, text: '', relativeDeg: 0, steps: 3, box }));
    const search = createSearchExplorer({ item: 'bananas', context: 'store', guide: { instructionFor: guide }, now: () => t });
    const box: [number, number, number, number] = [0.6, 0.2, 0.2, 0.5];
    const one = (name: string) => { t += 6000; search.observe(observation({ landmarks: [{ name, kind: 'aisle_end', section: 'unknown', box, confidence: 0.7 }] }), ++seq, t); return search.tick('bananas', null, {}); };
    one('aisle end'); one('end of the aisle'); one('aisle opening');
    const asked = one('aisle end ahead');
    expect(asked?.text).toBe('May I take you out of this aisle to look elsewhere?');
    expect(asked?.target).toBe('aisle end');                 // the first name sticks
    const home = createSearchExplorer({ item: 'keys', context: 'home', guide: { instructionFor: guide }, now: () => t, doorway: () => ({ box: [0.7, 0.1, 0.2, 0.7], at: t }) });
    const lines: string[] = [];
    for (let i = 0; i < 8; i++) { t += 6000; home.observe(observation({ landmarks: [] }), ++seq, t); const r = home.tick('keys', null, {}); if (r?.text) lines.push(r.text); }
    expect(lines).toContain('May I guide you through the doorway to search elsewhere?');
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

describe('the right section gets a close search before moving on (round 12)', () => {
  it('apples and oranges in view while hunting bananas → search these shelves closely, then propose elsewhere', () => {
    const h = setup();
    const lines: string[] = [];
    for (let i = 0; i < 9; i += 1) { const r = h.tick({ items: ['apples', 'oranges'], landmarks: [] }); if (r?.text) lines.push(r.text); }
    expect(lines).toContain('Apples and oranges here. This seems to be produce.');
    const close = lines.indexOf('This section looks promising. Let me search these shelves closely.');
    expect(close).toBeGreaterThan(0);
    expect(lines.slice(close + 1, close + 4)).toEqual(['Pan slowly across the upper shelf.', 'Now pan across the middle shelf.', 'Tilt down and scan the lower shelf.']);
    expect(h.search.memory()[0]?.closeSearched).toBe(true);
  });
});

describe('exploring a big space by coverage (round 12)', () => {
  function rig() {
    let t = 100000; let seq = 0;
    const pose = { x: 0, z: 0, y: 0, yawDeg: 0, trackingState: 'NORMAL' as const, timestamp: t };
    let path: { center: number; left?: number; right?: number } | null = { center: 0.1, left: 0.1, right: 0.1 };
    const guide = jest.fn((): GuideInstruction | null => null);
    const search = createSearchExplorer({ item: 'bananas', context: 'store', guide: { instructionFor: guide }, now: () => t, pose: () => ({ ...pose, timestamp: t }), path: () => path });
    const tick = (ms = 6000) => {
      t += ms;
      search.observe(observation({ landmarks: [] }), ++seq, t);
      return search.tick('bananas', null, {});
    };
    return { search, tick, pose, setPath: (p: typeof path) => { path = p; }, texts: [] as string[] };
  }

  /** The heading a leg line asks for, so a test can "turn" the phone onto it. */
  const headingOf = (line: string): number => (/^Turn around/.test(line) ? 180 : /^Turn half left/.test(line) ? 315 : /^Turn half right/.test(line) ? 45 : /^Turn left/.test(line) ? 270 : /^Turn right/.test(line) ? 90 : 0);

  it('with no landmark it walks a leg into ground no view has touched, holds the heading, stops after the leg and looks again', () => {
    const h = rig();
    const lines: string[] = [];
    for (let i = 0; i < 4; i += 1) { const r = h.tick(); if (r?.text) lines.push(r.text); }
    // Looking north painted the ground ahead as seen; the first leg goes where no view reached.
    expect(lines.at(-1)).toMatch(/New ground/);
    expect(lines.at(-1)).not.toMatch(/^Walk forward/);
    expect(h.search.status()).toBe('advance');
    const heading = headingOf(lines.at(-1)!);
    h.pose.yawDeg = heading;
    expect(h.tick(3000)?.text).toBe('Keep walking forward. I am looking as you walk.');
    // Drifting right of the heading earns a nudge to the left.
    h.pose.yawDeg = heading + 40;
    expect(h.tick(3000)?.text).toBe('Drifting right. A little to the left.');
    h.pose.yawDeg = heading;
    // Six metres on: the leg is done, look around here.
    h.pose.x = 6.5 * Math.sin((heading * Math.PI) / 180);
    h.pose.z = -6.5 * Math.cos((heading * Math.PI) / 180);
    expect(h.tick(3000)?.text).toBe('Stop here. Let me look around.');
    expect(h.search.status()).toBe('scan');
    expect(h.search.coverage()).toMatchObject({ visited: 2, scanned: 2 });
    expect(h.search.coverage()!.viewed).toBeGreaterThan(5);
  });

  it('a blocked way stops the leg — once the person faces the heading — and is remembered; the next leg goes another way', () => {
    const h = rig();
    const first: string[] = [];
    for (let i = 0; i < 4; i += 1) { const r = h.tick(); if (r?.text) first.push(r.text); }
    expect(h.search.status()).toBe('advance');
    h.pose.yawDeg = headingOf(first.at(-1)!);
    h.tick(2000);                                   // aligned and settled
    h.setPath({ center: 0.9, left: 0.2, right: 0.2 });
    const stop = h.tick(2000);
    expect(stop?.text).toBe('Something ahead. Stop. Let me look around.');
    expect(stop?.haptic).toBe('STOP');
    h.setPath({ center: 0.1, left: 0.1, right: 0.1 });
    const lines: string[] = [];
    for (let i = 0; i < 4; i += 1) { const r = h.tick(); if (r?.text) lines.push(r.text); }
    expect(lines.at(-1)).toMatch(/New ground/);
    expect(headingOf(lines.at(-1)!)).not.toBe(0);   // not the blocked way again
    // Until the person has turned onto the heading, the nudge is "keep turning", not "drifting".
    h.pose.yawDeg = headingOf(first.at(-1)!);
    const nudge = h.tick(3000)?.text;
    expect(nudge === null || nudge === undefined || /^Keep turning (?:left|right)\.$|^Keep walking forward/.test(nudge)).toBe(true);
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
