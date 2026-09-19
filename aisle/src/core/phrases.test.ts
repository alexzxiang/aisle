import {
  A_SIDE_KEYS,
  CONTRACT_CACHE_KEYS,
  FORBIDDEN_TERMS,
  LONG_PHRASE_ALLOWLIST,
  MAX_PROMPT_WORDS,
  MAX_UTTERANCE_WORDS,
  PHRASES,
  PHRASE_CATEGORY,
  PHRASE_KEYS,
  PHRASE_LIST,
  TIER1_PROMPT_KEYS,
  checkPhrase,
  countWords,
  findForbiddenTerm,
  hasDigit,
  isPhraseKey,
  lintPhraseTable,
  phraseCategory,
  truncateWords,
} from './phrases';

describe('the closed phrase table', () => {
  it('covers every cache key in 01 §3 exactly once', () => {
    for (const key of CONTRACT_CACHE_KEYS) expect(PHRASES[key]).toEqual(expect.any(String));
    const dupes = PHRASE_KEYS.filter((k, i) => PHRASE_KEYS.indexOf(k) !== i);
    expect(dupes).toEqual([]);
  });

  it('marks every non-01 key as an A-side addition and nothing else', () => {
    const contract = new Set<string>(CONTRACT_CACHE_KEYS);
    for (const p of PHRASE_LIST) {
      expect(Boolean(p.aSide)).toBe(!contract.has(p.key));
    }
    expect(A_SIDE_KEYS).toEqual(expect.arrayContaining(['course_hint_left', 'course_hint_right', 'looking_for_signs']));
  });

  it('passes the lint: ≤ 12 words (6 for prompts), digits as words, no forbidden term', () => {
    expect(lintPhraseTable()).toEqual([]);
    for (const p of PHRASE_LIST) {
      if (LONG_PHRASE_ALLOWLIST.has(p.key)) continue;
      expect(countWords(p.text)).toBeLessThanOrEqual(p.category === 'prompt' ? MAX_PROMPT_WORDS : MAX_UTTERANCE_WORDS);
      expect(hasDigit(p.text)).toBe(false);
    }
  });

  it('never exempts the forbidden-word check, even for the disclaimer', () => {
    for (const p of PHRASE_LIST) expect(findForbiddenTerm(p.text)).toBeNull();
    expect(checkPhrase('This is a clear path', { allowLong: true })).toEqual([{ kind: 'forbidden', term: 'clear' }]);
  });

  it('has the allow-list with exactly one member and it is the long one', () => {
    expect([...LONG_PHRASE_ALLOWLIST]).toEqual(['disclaimer']);
    expect(countWords(PHRASES.disclaimer)).toBeGreaterThan(MAX_UTTERANCE_WORDS);
  });

  it('pins the strings 07 §2 says other docs quote loosely', () => {
    expect(PHRASES.turn_left_soon).toBe('Turn left in sixty feet.');
    expect(PHRASES.turn_right_soon).toBe('Turn right in sixty feet.');
    expect(PHRASES.entering_store).toBe('Entering the store.');
    expect(PHRASES.looking_for_signs).toBe('Looking for aisle signs.');
    expect(PHRASES.disclaimer).toBe(
      'Aisle is a prototype, not a safety device. Keep using your cane or guide dog. ' +
      'Aisle reads walk signals and warns about vehicles it can see; it cannot see everything and never decides when to cross.',
    );
  });

  it('classifies keys the way the mode policy needs', () => {
    expect(PHRASE_CATEGORY.walk_signal_on).toBe('signal');
    expect(PHRASE_CATEGORY.vehicle_left).toBe('vehicle');
    expect(PHRASE_CATEGORY.no_vehicles_left).toBe('scan');
    expect(PHRASE_CATEGORY.far_curb).toBe('far_curb');
    expect(PHRASE_CATEGORY.countdown).toBe('countdown');
    expect(PHRASE_CATEGORY.turn_left_now).toBe('leg');
    expect(PHRASE_CATEGORY.entering_store).toBe('indoor');
    expect(PHRASE_CATEGORY.disclaimer).toBe('always');
    expect(PHRASE_CATEGORY.offline_notice).toBe('always');
    expect(PHRASE_CATEGORY.course_hint_left).toBe('course_hint');
    for (const k of TIER1_PROMPT_KEYS) expect(phraseCategory(k)).toBe('prompt');
    expect(phraseCategory('nope')).toBeNull();
    expect(isPhraseKey('walk_signal_on')).toBe(true);
    expect(isPhraseKey('toString')).toBe(false);
  });
});

describe('language rules', () => {
  it('lists exactly the six forbidden terms from 00 principle 7', () => {
    expect(FORBIDDEN_TERMS).toEqual(['safe', 'clear', 'go', 'cross now', 'no cars', 'you can cross']);
  });

  it.each([
    ['It is safe to cross', 'safe'],
    ['The way is CLEAR', 'clear'],
    ['Go now', 'go'],
    ['You may cross now', 'cross now'],
    ['There are no cars', 'no cars'],
    ['You can   cross', 'you can cross'],
    ['Safely home', null],           // word boundary: "safely" is not "safe"
    ['Keep going, looking for a sign.', null],
    ['clearQueue', null],
    ['Gopher', null],
    ['Cargo ship', null],
  ])('findForbiddenTerm(%p) → %p', (text, term) => {
    expect(findForbiddenTerm(text)).toBe(term);
  });

  it('counts words as a listener hears them', () => {
    expect(countWords("Don't walk.")).toBe(2);
    expect(countWords('Use open-ear headphones')).toBe(3);
    expect(countWords('one — two … three')).toBe(3);
    expect(countWords('   ')).toBe(0);
    expect(countWords('Turn right in twenty feet')).toBe(5);
  });

  it('truncates to the first N words keeping punctuation tokens attached', () => {
    expect(truncateWords('a b c d e f g h i j k l m n', 12)).toBe('a b c d e f g h i j k l');
    expect(truncateWords('short one', 12)).toBe('short one');
  });

  it('checkPhrase reports forbidden first, then length, then digits', () => {
    const long = 'go one two three four five six seven eight nine ten eleven 12';
    expect(checkPhrase(long).map((v) => v.kind)).toEqual(['forbidden', 'too_long', 'digit']);
    expect(checkPhrase('')).toEqual([{ kind: 'empty' }]);
    expect(checkPhrase('Aisle 3')).toEqual([{ kind: 'digit' }]);
    expect(checkPhrase('Tilt the camera up a little please', { maxWords: MAX_PROMPT_WORDS })).toEqual([
      { kind: 'too_long', words: 7, max: 6 },
    ]);
    expect(checkPhrase(PHRASES.disclaimer, { allowLong: true })).toEqual([]);
    expect(checkPhrase(PHRASES.disclaimer).map((v) => v.kind)).toEqual(['too_long']);
  });
});
