import { digitsToWords, validateFor } from './plannerJobs';
import { describe, expect, it } from '@jest/globals';

describe('digitsToWords + answer validation', () => {
  it('spells bare integers out and leaves decimals, times and codes alone', () => {
    expect(digitsToWords('About 400 feet to the turn.')).toBe('About four hundred feet to the turn.');
    expect(digitsToWords('Turn in 60 feet, then 2 blocks.')).toBe('Turn in sixty feet, then two blocks.');
    expect(digitsToWords('Bus 61C at 3:15, aisle A7.')).toBe('Bus 61C at 3:15, aisle A7.');
  });
  it('accepts a model reply whose only fault was a digit, and reports it as not a fallback', () => {
    const v = validateFor('answer', { reply: 'About 400 feet to the turn.' }, { question: 'how_far', context: { metersToManeuver: 120 } });
    expect(v.output.reply).toBe('About four hundred feet to the turn.');
    expect(v.usedFallback).toBe(false);
  });
  it('still templates a reply that is too long', () => {
    const long = 'You are on Fifth Avenue. The next turn is four hundred feet away on Forbes Avenue.';
    const v = validateFor('answer', { reply: long }, { question: 'how_far', context: { metersToManeuver: 120 } });
    expect(v.usedFallback).toBe(true);
    expect(v.output.reply.split(/\s+/).length).toBeLessThanOrEqual(12);
  });
});
