import {
  createAisleMatcher,
  createPlausibilityGate,
  createVoter,
  editDistance,
  entryMatchesTokens,
  fixDigitConfusions,
  matchRead,
  normalizeText,
  normalizeTokens,
  pickLargestRead,
  priceTagReason,
  rejectReason,
  toleranceFor,
} from './ocrMatcher';
import { fakeClock, makeTestMap, read } from './testing';

describe('normalization (04 Task 3 step 1, 09 §10 cases)', () => {
  it('uppercases, strips punctuation, collapses whitespace, idempotent', () => {
    expect(normalizeText('  aisle-3 : dairy!! ')).toBe('AISLE 3 DAIRY');
    expect(normalizeText(normalizeText('  aisle-3 : dairy!! '))).toBe('AISLE 3 DAIRY');
  });
  it('"AISLE 3" / "Aisle3" / "A1SLE 3" / "c001"', () => {
    expect(normalizeTokens('AISLE 3')).toEqual(['AISLE', '3']);
    expect(normalizeTokens('Aisle3')).toEqual(['AISLE3']);
    expect(normalizeTokens('A1SLE 3')).toEqual(['A1SLE', '3']);
    // "c001" is a mixed token; the map is not applied to it (it is not otherwise numeric)
    expect(normalizeTokens('c001')).toEqual(['C001']);
  });
  it('digit-confusion map applies only to otherwise-numeric tokens', () => {
    expect(fixDigitConfusions('I')).toBe('1');
    expect(fixDigitConfusions('l')).toBe('l'); // lower case never reaches it (normalize first)
    expect(fixDigitConfusions('1O')).toBe('10');
    expect(fixDigitConfusions('B')).toBe('8');
    expect(fixDigitConfusions('DAIRY')).toBe('DAIRY');
    expect(fixDigitConfusions('DA1RY')).toBe('DA1RY');
    expect(fixDigitConfusions('IS')).toBe('IS'); // no digit, not single glyph → left alone
    expect(normalizeTokens('I PRODUCE')).toEqual(['1', 'PRODUCE']);
  });
});

describe('price-tag rejection (step 2)', () => {
  it('rejects $, decimals and the price words', () => {
    expect(priceTagReason('$3.99')).toBe('price');
    expect(priceTagReason('2 FOR 5')).toBe('price');
    expect(priceTagReason('SAVE 1.00')).toBe('price');
    expect(priceTagReason('12 OZ')).toBe('price');
    expect(priceTagReason('3 DAIRY')).toBeNull();
  });
  it('rejects boxes below the hanging-sign height and empty reads', () => {
    expect(rejectReason(read('3 DAIRY', 0, [0.4, 0.1, 0.1, 0.005]))).toBe('small_box');
    expect(rejectReason(read('   '))).toBe('empty');
    expect(rejectReason(read('3 DAIRY'))).toBeNull();
  });
});

describe('fuzzy match (step 3)', () => {
  const map = makeTestMap();
  it('edit distance and tolerances', () => {
    expect(editDistance('DAIRY', 'DA1RY')).toBe(1);
    expect(editDistance('BAKERY', 'BAKRY')).toBe(1);
    expect(toleranceFor('DELI')).toBe(1);
    expect(toleranceFor('PRODUCE')).toBe(2);
  });
  it('numeric entries need an exact digit: a 3 is never an 8', () => {
    expect(entryMatchesTokens('3', ['3'])).toBe(true);
    expect(entryMatchesTokens('3', ['8'])).toBe(false);
    expect(entryMatchesTokens('3', ['33'])).toBe(false);
    expect(entryMatchesTokens('8', ['B'].map(fixDigitConfusions))).toBe(true);
  });
  it('alphabetic entries fuzzy-match tokens of ≥ 3 chars, tighter for short words', () => {
    expect(entryMatchesTokens('DAIRY', ['DA1RY'])).toBe(true);
    expect(entryMatchesTokens('PRODUCE', ['PRODUC'])).toBe(true);
    expect(entryMatchesTokens('PRODUCE', ['PRO'])).toBe(false);
    expect(entryMatchesTokens('DELI', ['DELL'])).toBe(true);
    expect(entryMatchesTokens('DELI', ['DEAL'])).toBe(false); // distance 2 > 1 for a 4-letter word
    expect(entryMatchesTokens('DAIRY', ['DA'])).toBe(false);
  });
  it('a clean sign is one match', () => {
    const r = matchRead(read('3 DAIRY'), map);
    expect(r.kind).toBe('match');
    if (r.kind === 'match') expect(r.candidate.id).toBe('a3');
  });
  it('OCR noise still resolves: "3 DA1RY", "I PRODUCE"', () => {
    const a = matchRead(read('3 DA1RY'), map);
    expect(a.kind === 'match' && a.candidate.id).toBe('a3');
    const b = matchRead(read('I PRODUCE'), map);
    expect(b.kind === 'match' && b.candidate.id).toBe('a1');
  });
  it("one aisle's number and another aisle's word is a two-match, not a match", () => {
    const r = matchRead(read('3 BAKERY'), map);
    expect(r.kind).toBe('two_match');
  });
  it('a landmark matches on its words', () => {
    const r = matchRead(read('CHECKOUT'), map);
    expect(r.kind === 'match' && r.candidate.kind).toBe('landmark');
    const r2 = matchRead(read('REGISTER'), map); // REGISTERS with one deletion
    expect(r2.kind === 'match' && r2.candidate.id).toBe('checkout');
  });
  it('unrelated text is no match', () => {
    expect(matchRead(read('EXIT'), map).kind).toBe('none');
    expect(matchRead(read('BEVERAGES'), map).kind).toBe('none');
  });
  it('a price tag is rejected before matching', () => {
    expect(matchRead(read('3 FOR $5'), map).kind).toBe('rejected');
  });
});

describe('two signs in one frame (step 4)', () => {
  it('takes the read with the larger box', () => {
    const small = read('4 CEREAL', 0, [0.1, 0.1, 0.08, 0.03]);
    const big = read('3 DAIRY', 0, [0.4, 0.1, 0.2, 0.06]);
    expect(pickLargestRead([small, big])?.text).toBe('3 DAIRY');
    expect(pickLargestRead([read('  ')])).toBeNull();
  });
});

describe('2-of-3 vote (step 5)', () => {
  it('needs two agreeing reads out of the last three, within 3 s', () => {
    const v = createVoter();
    expect(v.push({ id: 'a3', confidence: 0.9, t: 0 })).toBeNull();
    const w = v.push({ id: 'a3', confidence: 0.7, t: 300 });
    expect(w).toEqual({ id: 'a3', confidence: 0.8, agreeing: 2 });
  });
  it('a single disagreeing read between two agreeing reads still wins', () => {
    const v = createVoter();
    v.push({ id: 'a3', confidence: 0.9, t: 0 });
    v.push({ id: 'a8', confidence: 0.9, t: 300 });
    expect(v.push({ id: 'a3', confidence: 0.9, t: 600 })?.id).toBe('a3');
  });
  it('reads older than the window drop out', () => {
    const v = createVoter();
    v.push({ id: 'a3', confidence: 0.9, t: 0 });
    expect(v.push({ id: 'a3', confidence: 0.9, t: 3500 })).toBeNull();
  });
});

describe('plausibility gate (step 6)', () => {
  it('holds an implausible candidate until three in a row agree', () => {
    const g = createPlausibilityGate();
    expect(g.admit('a8', false)).toBe(false);
    expect(g.admit('a8', false)).toBe(false);
    expect(g.admit('a8', false)).toBe(true);
  });
  it('a plausible candidate is admitted at once and resets the streak', () => {
    const g = createPlausibilityGate();
    expect(g.admit('a8', false)).toBe(false);
    expect(g.admit('a3', true)).toBe(true);
    expect(g.admit('a8', false)).toBe(false);
  });
});

describe('createAisleMatcher (steps 1–7 together)', () => {
  it('identifies after 2-of-3 and dedupes the same sign for 10 s', () => {
    const clock = fakeClock();
    const m = createAisleMatcher({ map: makeTestMap(), isPlausible: () => true, now: clock.now });
    expect(m.process([read('3 DAIRY')]).identified).toBeNull();
    clock.advance(330);
    const out = m.process([read('3 DA1RY')]);
    expect(out.identified?.id).toBe('a3');
    expect(out.identified?.label).toBe('Aisle 3');
    clock.advance(330);
    expect(m.process([read('3 DAIRY')]).identified).toBeNull(); // 10 s dedupe
    clock.advance(10_000);
    // After the dedupe window the sign is re-voted from scratch: 2-of-3 again.
    expect(m.process([read('3 DAIRY')]).identified).toBeNull();
    clock.advance(300);
    expect(m.process([read('3 DAIRY')]).identified?.id).toBe('a3');
  });
  it('holds a cross-aisle skip (implausible) until three reads in a row', () => {
    const clock = fakeClock();
    const m = createAisleMatcher({ map: makeTestMap(), isPlausible: (o) => o <= 4, now: clock.now });
    m.process([read('8 PAPER')]);
    clock.advance(300);
    expect(m.process([read('8 PAPER')]).identified).toBeNull();  // vote won, gate holds (streak 1)
    clock.advance(300);
    expect(m.process([read('8 PAPER')]).identified).toBeNull();  // streak 2
    clock.advance(300);
    expect(m.process([read('8 PAPER')]).identified?.id).toBe('a8'); // streak 3 → accepted
  });
  it('hands off to Claude on no-match with real text and on two-match, ≤ 1 per 4 s', () => {
    const clock = fakeClock();
    const m = createAisleMatcher({ map: makeTestMap(), isPlausible: () => true, now: clock.now });
    expect(m.process([read('BEVERAGES')]).handoff).toBe('no_match');
    clock.advance(1000);
    expect(m.process([read('3 BAKERY')]).handoff).toBeNull(); // inside the 4 s
    clock.advance(4000);
    expect(m.process([read('3 BAKERY')]).handoff).toBe('two_match');
  });
  it('never hands off for a rejected price tag or a two-character fragment', () => {
    const clock = fakeClock();
    const m = createAisleMatcher({ map: makeTestMap(), isPlausible: () => true, now: clock.now });
    expect(m.process([read('$4.99')]).handoff).toBeNull();
    expect(m.process([read('XY')]).handoff).toBeNull();
  });
  it('digits are never fuzzy-matched across the vote', () => {
    const clock = fakeClock();
    const m = createAisleMatcher({ map: makeTestMap(), isPlausible: () => true, now: clock.now });
    m.process([read('8')]);
    clock.advance(300);
    const out = m.process([read('3')]);
    expect(out.identified).toBeNull();
  });
});
