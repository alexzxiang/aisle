import { checkedLine, hypothesisLine, rankHypotheses, statedPlaceIn, usualPlaces } from './hypotheses';
import { checkPhrase } from './phrases';

describe('where things usually are (round 11)', () => {
  it('knows the usual places and marks containers', () => {
    expect(usualPlaces('eggs')[0]).toMatchObject({ place: 'fridge', opens: true });
    expect(usualPlaces('bananas').map((h) => h.place)).toEqual(['countertop', 'table', 'bowl', 'fridge']);
    expect(usualPlaces('remote')[0].place).toBe('couch');
    expect(usualPlaces('forks')[0]).toMatchObject({ place: 'drawer', opens: true });
    expect(usualPlaces('ice cream')[0].place).toBe('freezer');
    expect(usualPlaces('widget')).toEqual([]);
  });

  it('ranks the stated place first, then usual places by prior and what the phone can act on, dropping tried ones', () => {
    const seen = (p: string) => (p === 'table' ? 'visible' as const : p === 'countertop' ? 'remembered' as const : 'unseen' as const);
    expect(rankHypotheses('bananas', null, [], seen).map((h) => h.place)).toEqual(['table', 'countertop', 'bowl', 'fridge']);
    expect(rankHypotheses('bananas', 'counter', [], seen).map((h) => h.place)).toEqual(['counter', 'table', 'bowl', 'fridge']);
    expect(rankHypotheses('bananas', 'counter', ['counter', 'table'], seen).map((h) => h.place)).toEqual(['bowl', 'fridge']);
    expect(rankHypotheses('bananas', null, [], () => 'unseen').map((h) => h.place)).toEqual(['countertop', 'table', 'bowl', 'fridge']);
  });

  it('says the reason in twelve words or fewer, and lists what was checked', () => {
    const [first, second] = rankHypotheses('keys', null, [], () => 'unseen');
    const a = hypothesisLine('keys', true, first!, true, null);
    const b = hypothesisLine('keys', true, second!, false, 'table');
    expect(a).toBe('No keys in view. They are usually on the table.');
    expect(b).toBe('Not on the table. Maybe on the counter.');
    expect(hypothesisLine('milk', false, usualPlaces('milk')[0]!, true, null)).toBe('No milk in view. It is usually in the fridge.');
    expect(checkedLine(['table', 'countertop', 'drawer'])).toBe('Checked the table, counter and drawer.');
    for (const s of [a, b, checkedLine(['table']), checkedLine([])]) expect(checkPhrase(s)).toEqual([]);
  });

  it('understands a redirect from the person', () => {
    expect(statedPlaceIn('try the cabinet')).toBe('cabinet');
    expect(statedPlaceIn("It's on the table.")).toBe('table');
    expect(statedPlaceIn('check the fridge')).toBe('fridge');
    expect(statedPlaceIn('look in the freezer')).toBe('freezer');
    expect(statedPlaceIn('maybe the counter')).toBe('countertop');
    expect(statedPlaceIn('yes')).toBeNull();
    expect(statedPlaceIn('try harder')).toBeNull();
  });
});
