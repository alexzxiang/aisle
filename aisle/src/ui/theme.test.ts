import { APP_MODES } from '../core/store';
import type { SignalState } from '../core/contracts';
import {
  MIN_BAND_CONTRAST,
  bandColorFor,
  bandColors,
  colors,
  contrastRatio,
  relativeLuminance,
  signalColors,
  type,
} from './theme';

const SIGNALS: SignalState[] = ['WALK', 'DONT_WALK', 'COUNTDOWN', 'UNKNOWN'];

describe('theme contrast', () => {
  it('computes WCAG luminance and ratio', () => {
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 5);
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 3);
    expect(() => relativeLuminance('#FFF')).toThrow();
  });

  it.each(Object.entries(bandColors))('band %s carries hero text at >= 7:1', (_name, hex) => {
    expect(contrastRatio(colors.text, hex)).toBeGreaterThanOrEqual(MIN_BAND_CONTRAST);
  });

  it.each(SIGNALS)('signal colour %s carries hero text at >= 7:1', (s) => {
    expect(contrastRatio(colors.text, signalColors[s])).toBeGreaterThanOrEqual(MIN_BAND_CONTRAST);
  });

  it('every mode x signal resolves to a band that clears 7:1', () => {
    for (const mode of APP_MODES) {
      for (const s of SIGNALS) {
        const hex = bandColorFor(mode, s);
        expect(contrastRatio(colors.text, hex)).toBeGreaterThanOrEqual(MIN_BAND_CONTRAST);
      }
    }
  });

  it('meta text on the page background clears 7:1 too', () => {
    expect(contrastRatio(colors.meta, colors.bg)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(colors.text, colors.bg)).toBeGreaterThanOrEqual(7);
  });
});

describe('bandColorFor', () => {
  it('encodes mode: night-blue walking, amber curb, teal indoors', () => {
    expect(bandColorFor('OUTDOOR_NAV')).toBe(bandColors.outdoor);
    expect(bandColorFor('APPROACH_CROSSING')).toBe(bandColors.outdoor);
    expect(bandColorFor('AT_CURB')).toBe(bandColors.curb);
    expect(bandColorFor('INDOOR_NAV')).toBe(bandColors.indoor);
    expect(bandColorFor('TRANSITION')).toBe(bandColors.indoor);
    expect(bandColorFor('IDLE')).toBe(bandColors.idle);
    expect(bandColorFor('DONE')).toBe(bandColors.done);
  });

  it("uses OKO's convention while crossing: green walk, red hand, orange countdown, grey unknown", () => {
    expect(bandColorFor('CROSSING', 'WALK')).toBe(signalColors.WALK);
    expect(bandColorFor('CROSSING', 'DONT_WALK')).toBe(signalColors.DONT_WALK);
    expect(bandColorFor('CROSSING', 'COUNTDOWN')).toBe(signalColors.COUNTDOWN);
    expect(bandColorFor('CROSSING', 'UNKNOWN')).toBe(signalColors.UNKNOWN);
    expect(bandColorFor('CROSSING')).toBe(signalColors.UNKNOWN);
  });

  it('at the curb a known signal state takes over from amber', () => {
    expect(bandColorFor('AT_CURB', 'WALK')).toBe(signalColors.WALK);
    expect(bandColorFor('AT_CURB', 'UNKNOWN')).toBe(bandColors.curb);
  });

  it('ignores the signal anywhere else', () => {
    expect(bandColorFor('OUTDOOR_NAV', 'WALK')).toBe(bandColors.outdoor);
    expect(bandColorFor('INDOOR_NAV', 'DONT_WALK')).toBe(bandColors.indoor);
  });
});

describe('type scale', () => {
  it('has exactly three sizes: hero 44, body 20, meta 16', () => {
    expect(type.hero.fontSize).toBe(44);
    expect(type.hero.fontWeight).toBe('800');
    expect(type.body.fontSize).toBe(20);
    expect(type.meta.fontSize).toBe(16);
    expect(Object.keys(type)).toEqual(['hero', 'body', 'meta']);
  });
});
