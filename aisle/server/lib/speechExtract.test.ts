import { describe, expect, it } from 'vitest';
import { chunk } from '../test/fakes';
import { createSpeechScanner, parseFinalJson } from './speechExtract';

describe('createSpeechScanner', () => {
  it('extracts speech and closes exactly once, however the deltas are split', () => {
    const json = '{"speech":"Aisle three. Eggs on your right.","cameraRequest":"none","confidence":0.9}';
    for (const n of [1, 3, 7, 20, json.length]) {
      const s = createSpeechScanner();
      let closedAt = -1;
      const parts = chunk(json, n);
      parts.forEach((p, i) => {
        const step = s.feed(p);
        if (step.closed && closedAt < 0) closedAt = i;
      });
      expect(s.speech(), `n=${n}`).toBe('Aisle three. Eggs on your right.');
      expect(s.state()).toBe('closed');
      expect(closedAt).toBeGreaterThanOrEqual(0);
      expect(s.raw()).toBe(json);
    }
  });

  it('closes before the rest of the JSON arrives', () => {
    const s = createSpeechScanner();
    expect(s.feed('{"speech":"Doors ahead."').closed).toBe(true);
    expect(s.feed(',"cameraRequest":"none"}').text).toBe('');
    expect(s.speech()).toBe('Doors ahead.');
  });

  it('decodes escapes, including ones split across deltas', () => {
    const s = createSpeechScanner();
    s.feed('{"speech":"Can\\');
    s.feed('u0027t see the signal.\\n"');
    expect(s.speech()).toBe("Can't see the signal.\n");
    expect(s.state()).toBe('closed');
  });

  it('handles an escaped quote inside the string', () => {
    const s = createSpeechScanner();
    s.feed('{"speech":"say \\"hi\\" now"}');
    expect(s.speech()).toBe('say "hi" now');
  });

  it('empty speech closes immediately with no text', () => {
    const s = createSpeechScanner();
    const step = s.feed('{"speech":"","cameraRequest":"up"}');
    expect(step.closed).toBe(true);
    expect(s.speech()).toBe('');
  });

  it('tolerates whitespace around the colon and key split across deltas', () => {
    const s = createSpeechScanner();
    s.feed('{ "spe');
    s.feed('ech" : "Hi."');
    expect(s.speech()).toBe('Hi.');
    expect(s.state()).toBe('closed');
  });

  it('never closes when the stream stops mid-string', () => {
    const s = createSpeechScanner();
    s.feed('{"speech":"Half a sen');
    expect(s.state()).toBe('in_string');
    expect(s.speech()).toBe('Half a sen');
  });
});

describe('parseFinalJson', () => {
  it('parses a clean object and rescues a fenced one', () => {
    expect(parseFinalJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseFinalJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('returns null for arrays, scalars and garbage', () => {
    expect(parseFinalJson('[1]')).toBeNull();
    expect(parseFinalJson('42')).toBeNull();
    expect(parseFinalJson('nope')).toBeNull();
    expect(parseFinalJson('')).toBeNull();
  });
});
