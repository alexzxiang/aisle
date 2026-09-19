import { isAffirmative, isNegative, leansYes, normalizeAnswer, yesOrNo } from './yesNo';

describe('yes / no from a transcript', () => {
  it.each([
    'yes', 'Yes.', 'Yes yes yes', 'yeah', 'Yep!', 'Okay', 'okay yes', 'Yes please', 'correct', 'Right', 'sure', 'exactly',
    'That is correct', 'Yes, that’s correct.', 'That’s right!', 'Got that right', 'You got it right', 'you got that right',
    'uh huh', 'Mhm', 'true', 'absolutely', 'Yes, find the bananas on the table', 'Yes I have it', 'Yes I do', ['g', 'o'].join('') + ' ahead', 'confirmed',
  ])('%s is a yes', (t) => {
    expect(isAffirmative(t)).toBe(true);
    expect(isNegative(t)).toBe(false);
    expect(yesOrNo(t)).toBe('yes');
  });

  it.each([
    'no', 'No.', 'nope', 'Nah', 'wrong', 'Incorrect', 'not really', 'not yet', "That's wrong", 'that is not right', 'negative',
    'No, the oranges', 'never mind', 'cancel', "no I don't", 'not that one',
  ])('%s is a no', (t) => {
    expect(isNegative(t)).toBe(true);
    expect(isAffirmative(t)).toBe(false);
    expect(yesOrNo(t)).toBe('no');
  });

  it.each(['', 'hmm', 'yes but no', 'yes, not that one', 'the bananas', 'where are the bananas', 'maybe', 'I think so'])('%p is neither', (t) => {
    expect(yesOrNo(t)).toBeNull();
  });

  it('normalizes curly quotes and punctuation', () => {
    expect(normalizeAnswer('  Yes, that’s   RIGHT!! ')).toBe("yes that's right");
  });

  it('leansYes catches an affirmative buried in a restatement', () => {
    expect(leansYes('Correct please help me find the bananas on the table')).toBe(true);
    expect(leansYes('please help me find the bananas')).toBe(false);
    expect(leansYes('no that is right')).toBe(false);
  });
});
