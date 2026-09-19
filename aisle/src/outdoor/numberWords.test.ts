import { feetWords, integerToWords, ordinalToWords, roundFeet, spokenStreet } from './numberWords';

describe('integerToWords', () => {
  it('spells small and compound numbers', () => {
    expect(integerToWords(0)).toBe('zero');
    expect(integerToWords(7)).toBe('seven');
    expect(integerToWords(13)).toBe('thirteen');
    expect(integerToWords(20)).toBe('twenty');
    expect(integerToWords(45)).toBe('forty-five');
    expect(integerToWords(100)).toBe('one hundred');
    expect(integerToWords(250)).toBe('two hundred fifty');
    expect(integerToWords(1200)).toBe('one thousand two hundred');
  });
});

describe('roundFeet / feetWords', () => {
  it('rounds to ten feet under one hundred and fifty above', () => {
    expect(roundFeet(6)).toBe(20);        // 19.7 ft
    expect(roundFeet(20)).toBe(70);       // 65.6 ft
    expect(roundFeet(0)).toBe(10);        // never "zero feet"
    expect(roundFeet(50)).toBe(150);      // 164 ft
    expect(roundFeet(100)).toBe(350);     // 328 ft
  });
  it('says "about" only above one hundred feet and never emits a digit', () => {
    expect(feetWords(20)).toBe('seventy feet');
    expect(feetWords(60)).toBe('about two hundred feet');
    expect(/\d/.test(feetWords(1234))).toBe(false);
  });
});

describe('spokenStreet', () => {
  it('expands real Pittsburgh abbreviations', () => {
    expect(spokenStreet('S Bouquet St')).toBe('South Bouquet Street');
    expect(spokenStreet('Forbes Ave')).toBe('Forbes Avenue');
    expect(spokenStreet('N Craig St')).toBe('North Craig Street');
    expect(spokenStreet('Baum Blvd')).toBe('Baum Boulevard');
    expect(spokenStreet('Bigelow Blvd.')).toBe('Bigelow Boulevard');
    expect(spokenStreet('Schenley Dr')).toBe('Schenley Drive');
  });
  it('spells route numbers and ordinals', () => {
    expect(spokenStreet('US-19')).toBe('U S nineteen');
    expect(spokenStreet('PA 51')).toBe('P A fifty-one');
    expect(spokenStreet('5th Ave')).toBe('fifth Avenue');
    expect(spokenStreet('42nd St')).toBe('forty-second Street');
  });
  it('leaves no digit behind', () => {
    for (const s of ['Route 8', 'I-376 W', '3955 Forbes Ave', '']) {
      expect(/\d/.test(spokenStreet(s))).toBe(false);
    }
  });
  it('is idempotent on already-expanded names', () => {
    expect(spokenStreet('South Bouquet Street')).toBe('South Bouquet Street');
  });
  it('gives ordinal words', () => {
    expect(ordinalToWords('1')).toBe('first');
    expect(ordinalToWords('23')).toBe('twenty-third');
  });
});
