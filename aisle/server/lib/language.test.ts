import { describe, expect, it } from 'vitest';
import { WALKING_BETA_WARNING } from '../../src/outdoor/types';
import { TTS_ALLOWLIST, WALKING_BETA_WARNING_SHA256, checkLanguage, sanitizeSpeech, sha256Hex, trimToBudget } from './language';

// Tests may reference the forbidden words only as the forbidden list under test.
const FORBIDDEN_SAMPLES = ['It is safe to cross.', 'The road is clear.', 'Go.', 'Cross now.', 'No cars coming.', 'You can cross now.'];

describe('checkLanguage — speech lane (Claude)', () => {
  it('passes a terse fact', () => {
    const c = checkLanguage('Vehicle approaching from the right.', { lane: 'speech' });
    expect(c.verdict).toBe('pass');
    expect(c.text).toBe('Vehicle approaching from the right.');
  });

  it.each(FORBIDDEN_SAMPLES)('blanks %j', (s) => {
    const c = checkLanguage(s, { lane: 'speech' });
    expect(c.verdict).toBe('blanked');
    expect(c.text).toBe('');
    expect(c.reason).toBe('forbidden');
  });

  it('repairs more than twelve words: whole sentences that fit, else the first twelve (round 6)', () => {
    const c = checkLanguage('one two three four five six seven eight nine ten eleven twelve thirteen', { lane: 'speech' });
    expect(c.verdict).toBe('repaired');
    expect(c.text).toBe('One two three four five six seven eight nine ten eleven twelve.');
    expect(c.words).toBe(12);
    const s = checkLanguage('You are at a street crossing. Tall buildings ahead, crosswalk beneath you, a bus far right.', { lane: 'speech' });
    expect(s.verdict).toBe('repaired');
    expect(s.text).toBe('You are at a street crossing.');
    expect(trimToBudget('Short one.', 12)).toBe('Short one.');
  });

  it('allows exactly twelve words', () => {
    expect(checkLanguage('one two three four five six seven eight nine ten eleven twelve', { lane: 'speech' }).verdict).toBe('pass');
  });

  it('spells digits out instead of blanking (round 6; the client sanitizeSpeech still refuses a raw digit)', () => {
    expect(checkLanguage('Aisle 3, dairy.', { lane: 'speech' })).toMatchObject({ verdict: 'repaired', text: 'Aisle three, dairy.' });
    expect(checkLanguage('2 people ahead.', { lane: 'speech' })).toMatchObject({ verdict: 'repaired', text: 'Two people ahead.' });
    for (const s of ['Aisle 3, dairy.', 'Walk in 12 seconds.', '2 people ahead.']) {
      const c = checkLanguage(s, { lane: 'speech' });
      expect(c.text, s).not.toMatch(/\d/);
    }
    expect(checkLanguage('Aisle three, dairy.', { lane: 'speech' }).verdict).toBe('pass');
  });

  it('reports forbidden before digit when both apply', () => {
    expect(checkLanguage('Clear in 3.', { lane: 'speech' }).reason).toBe('forbidden');
  });

  it('never allow-lists the walking-beta sentence on the speech lane (it is trimmed like any long line)', () => {
    const c = checkLanguage(WALKING_BETA_WARNING, { lane: 'speech' });
    expect(c.verdict).not.toBe('allowlisted');
    expect(c.words).toBeLessThanOrEqual(12);
  });

  it('matches on word boundaries, not substrings', () => {
    expect(checkLanguage('Nuclear power plant ahead.', { lane: 'speech' }).verdict).toBe('pass'); // "clear" inside "Nuclear"
    expect(checkLanguage('Cargo bay ahead.', { lane: 'speech' }).verdict).toBe('pass');          // "go" inside "Cargo"
  });
});

describe('checkLanguage — tts lane', () => {
  it.each(FORBIDDEN_SAMPLES)('rejects %j with 422', (s) => {
    const c = checkLanguage(s, { lane: 'tts' });
    expect(c.verdict).toBe('rejected_422');
  });

  it('allow-lists the exact walking-beta sentence and skips both rules', () => {
    const c = checkLanguage(WALKING_BETA_WARNING, { lane: 'tts' });
    expect(c.verdict).toBe('allowlisted');
    expect(c.text).toBe(WALKING_BETA_WARNING);
    expect(c.words).toBeGreaterThan(12);
    expect(TTS_ALLOWLIST.get(WALKING_BETA_WARNING_SHA256)).toBe('google_walking_beta');
    expect(sha256Hex(WALKING_BETA_WARNING)).toBe(WALKING_BETA_WARNING_SHA256);
  });

  it('rejects a paraphrase, a truncation, a re-cased copy and a trailing-space variant', () => {
    const variants = [
      WALKING_BETA_WARNING.replace('beta', 'preview'),
      WALKING_BETA_WARNING.slice(0, -1),
      WALKING_BETA_WARNING.toUpperCase(),
      `${WALKING_BETA_WARNING} `,
    ];
    for (const v of variants) {
      const c = checkLanguage(v, { lane: 'tts' });
      expect(c.verdict, v).toBe('rejected_422');
    }
  });

  it('still rejects every other sentence containing an allow-listed word', () => {
    expect(checkLanguage('The sidewalks are clear.', { lane: 'tts' }).verdict).toBe('rejected_422');
  });

  it('leaves digits to the client on the tts lane (the digit rule is a speech-lane mirror)', () => {
    expect(checkLanguage('Aisle 3.', { lane: 'tts' }).verdict).toBe('pass');
  });
});

describe('sanitizeSpeech', () => {
  it('empty and non-string speech become "" with verdict pass', () => {
    expect(sanitizeSpeech('')).toEqual({ speech: '', verdict: 'pass' });
    expect(sanitizeSpeech(undefined)).toEqual({ speech: '', verdict: 'pass' });
  });
  it('blanks a violation', () => {
    expect(sanitizeSpeech('Go.')).toEqual({ speech: '', verdict: 'blanked' });
    expect(sanitizeSpeech('Aisle 3.')).toEqual({ speech: '', verdict: 'blanked' });
  });
});
