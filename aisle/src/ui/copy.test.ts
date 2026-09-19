import {
  DISCLAIMER_TEXT,
  FORBIDDEN_PHRASES,
  HEADPHONE_NOTE,
  PRIVACY_TEXT,
  WALKING_BETA_FALLBACK,
  assertUtterance,
  findForbidden,
  hasForbidden,
  itemAcknowledgement,
  normalizeTypedItem,
  wordCount,
} from './copy';

describe('forbidden phrases', () => {
  it('lists the six from 00 principle 7 plus the bare "go" from 01 §3', () => {
    expect(FORBIDDEN_PHRASES).toEqual(expect.arrayContaining(['safe', 'clear', 'go', 'go now', 'cross now', 'no cars', 'you can cross']));
  });

  it.each(FORBIDDEN_PHRASES)('catches "%s" as text, in any case', (p) => {
    expect(hasForbidden(`It is ${p}.`)).toBe(true);
    expect(hasForbidden(p.toUpperCase())).toBe(true);
  });

  it('matches on word boundaries only', () => {
    expect(hasForbidden('clearQueue')).toBe(false);
    expect(hasForbidden('Keep going')).toBe(false);
    expect(hasForbidden('safety device')).toBe(false);
    expect(hasForbidden('Crossing ahead')).toBe(false);
    expect(hasForbidden('cargo')).toBe(false);
    expect(hasForbidden('You can  cross')).toBe(true);
  });

  it('reports every hit in order', () => {
    expect(findForbidden('Safe to go, no cars')).toEqual(['safe', 'go', 'no cars']);
    expect(findForbidden('Walk signal on')).toEqual([]);
  });

  it('is not tripped up by regex state between calls', () => {
    expect(hasForbidden('safe')).toBe(true);
    expect(hasForbidden('safe')).toBe(true);
  });
});

describe('assertUtterance', () => {
  it('accepts twelve words and rejects thirteen', () => {
    expect(() => assertUtterance('one two three four five six seven eight nine ten eleven twelve', 't')).not.toThrow();
    expect(() => assertUtterance('one two three four five six seven eight nine ten eleven twelve thirteen', 't')).toThrow(/13 words/);
  });
  it('names the forbidden word', () => {
    expect(() => assertUtterance('All clear', 't')).toThrow(/clear/);
  });
  it('counts words', () => {
    expect(wordCount('')).toBe(0);
    expect(wordCount('  a  b ')).toBe(2);
  });
});

describe('fixed copy', () => {
  it.each([
    ['disclaimer', DISCLAIMER_TEXT],
    ['privacy', PRIVACY_TEXT],
    ['headphones', HEADPHONE_NOTE],
    ['beta', WALKING_BETA_FALLBACK],
  ])('%s contains no forbidden word', (_n, text) => {
    expect(findForbidden(text)).toEqual([]);
  });

  it('disclaimer is verbatim from 02 Task 10', () => {
    expect(DISCLAIMER_TEXT).toBe(
      'Aisle is a prototype, not a safety device. Keep using your cane or guide dog. Aisle reads walk signals and warns about vehicles it can see; it cannot see everything and never decides when to cross.',
    );
  });
});

describe('typed input', () => {
  it('strips the request prefix and filler, keeps the item', () => {
    expect(normalizeTypedItem('Eggs')).toBe('eggs');
    expect(normalizeTypedItem('  I need eggs.  ')).toBe('eggs');
    expect(normalizeTypedItem("I'm looking for some oat milk, please")).toBe('oat milk');
    expect(normalizeTypedItem('Where is the bread?')).toBe('bread');
    expect(normalizeTypedItem('take me to checkout')).toBe('checkout');
    expect(normalizeTypedItem('find me a dozen eggs')).toBe('dozen eggs');
    expect(normalizeTypedItem('2% milk')).toBe('2% milk');
  });

  it('returns null when nothing is left', () => {
    expect(normalizeTypedItem('')).toBeNull();
    expect(normalizeTypedItem('   ')).toBeNull();
    expect(normalizeTypedItem('please')).toBeNull();
    expect(normalizeTypedItem('?!')).toBeNull();
  });

  it('acknowledges an item in a short clean sentence, or not at all when it has digits', () => {
    expect(itemAcknowledgement('eggs')).toBe('Eggs. Planning the route.');
    expect(itemAcknowledgement('oat milk')).toBe('Oat milk. Planning the route.');
    expect(itemAcknowledgement('2% milk')).toBeNull();
    expect(itemAcknowledgement('a b c d e f g h i j k l')).toBeNull();
    expect(itemAcknowledgement('safe razors')).toBeNull();
  });
});
