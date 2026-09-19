import { DASH, eventLines, fmtDeg, fmtFix, fmtFps, fmtHeading, fmtMs, fmtNum, fmtPayload, formatEventLine } from './debugFormat';

describe('debug formatters', () => {
  it('prints dashes for missing numbers', () => {
    expect(fmtNum(null)).toBe(DASH);
    expect(fmtNum(Number.NaN)).toBe(DASH);
    expect(fmtNum(3.14159, 2, ' m')).toBe('3.14 m');
    expect(fmtMs(undefined)).toBe(DASH);
    expect(fmtMs(123.6)).toBe('124 ms');
    expect(fmtFps(14.96)).toBe('15.0 fps');
  });

  it('wraps and pads degrees', () => {
    expect(fmtDeg(-10)).toBe('350°');
    expect(fmtDeg(365)).toBe('  5°');
    expect(fmtDeg(null)).toBe(DASH);
  });

  it('formats heading and fix', () => {
    expect(fmtHeading(null)).toBe(`${DASH}  acc ${DASH}`);
    expect(fmtHeading({ trueHeadingDeg: 90, accuracy: 3, timestamp: 0 })).toBe(' 90°  acc 3');
    expect(fmtFix(null)).toEqual([`gps      ${DASH}`]);
    const lines = fmtFix({ lat: 40.44431, lng: -79.94361, accuracyM: 8.2, courseDeg: null, speedMps: 1.25, timestamp: 0 });
    expect(lines[0]).toBe('gps      40.44431, -79.94361');
    expect(lines[1]).toBe(`accuracy 8 m   course ${DASH}   speed 1.3 m/s`);
  });

  it('formats an event line: clock, padded type, compact payload, newest first', () => {
    const ts = new Date(2026, 8, 19, 12, 3, 4, 56).getTime();
    const line = formatEventLine({ type: 'SIGNAL_STATE', state: 'WALK', fresh: true, confidence: 0.987, ts });
    expect(line).toBe('12:03:04.056  SIGNAL_STATE         state=WALK fresh=true confidence=0.99');
    expect(fmtPayload({ type: 'CHECKOUT_REACHED' })).toBe('');
    expect(fmtPayload({ type: 'OUTDOOR_LEG_ADVANCED', index: 0, instruction: 'x'.repeat(100) }).length).toBeLessThanOrEqual(60);
    const lines = eventLines([
      { type: 'CHECKOUT_REACHED', ts },
      { type: 'CURB_REACHED', crossingId: 'c', ts: ts + 1 },
    ]);
    expect(lines[0]).toContain('CURB_REACHED');
    expect(lines[1]).toContain('CHECKOUT_REACHED');
  });
});
