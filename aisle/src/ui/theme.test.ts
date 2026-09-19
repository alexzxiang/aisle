import { APP_MODES } from '../core/store';
import type { SignalState } from '../core/contracts';
import {
  MIN_BAND_CONTRAST,
  MIN_SECONDARY_CONTRAST,
  accentFor,
  accents,
  backdropSurface,
  bandColorFor,
  bandSurface,
  blend,
  cameraMaxHeight,
  cameraStripSurface,
  colors,
  contrastRatio,
  glass,
  glassSurface,
  motion,
  relativeLuminance,
  signalColors,
  sizes,
  tintOf,
  type,
} from './theme';

const SIGNALS: SignalState[] = ['WALK', 'DONT_WALK', 'COUNTDOWN', 'UNKNOWN'];

describe('colour arithmetic', () => {
  it('computes WCAG luminance and ratio', () => {
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 5);
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 3);
    expect(() => relativeLuminance('#FFF')).toThrow();
  });

  it('composites the way the compositor does', () => {
    expect(blend('#FFFFFF', '#000000', 1)).toBe('#FFFFFF');
    expect(blend('#FFFFFF', '#000000', 0)).toBe('#000000');
    expect(blend('#FFFFFF', '#000000', 0.5)).toBe('#808080');
    expect(tintOf('#2563EB', 0.18)).toBe('rgba(37,99,235,0.18)');
  });
});

describe('glass contrast', () => {
  it('primary text on a plain glass panel clears 7:1', () => {
    expect(contrastRatio(colors.text, glassSurface())).toBeGreaterThanOrEqual(MIN_BAND_CONTRAST);
  });

  it('primary text on every accent-tinted band clears 7:1 (every mode x signal)', () => {
    for (const mode of APP_MODES) {
      for (const s of SIGNALS) {
        const surface = bandSurface(accentFor(mode, s));
        expect({ mode, s, ratio: contrastRatio(colors.text, surface) }).toEqual({ mode, s, ratio: expect.any(Number) });
        expect(contrastRatio(colors.text, surface)).toBeGreaterThanOrEqual(MIN_BAND_CONTRAST);
      }
    }
  });

  it('a band over the tinted top of the page still clears 7:1', () => {
    for (const hex of [...Object.values(accents), ...Object.values(signalColors)]) {
      expect(contrastRatio(colors.text, bandSurface(hex, backdropSurface(hex)))).toBeGreaterThanOrEqual(MIN_BAND_CONTRAST);
    }
  });

  it('secondary text clears 4.5:1 on the page, on glass and on every band', () => {
    expect(contrastRatio(colors.secondary, colors.bg)).toBeGreaterThanOrEqual(MIN_SECONDARY_CONTRAST);
    expect(contrastRatio(colors.secondary, glassSurface())).toBeGreaterThanOrEqual(MIN_SECONDARY_CONTRAST);
    for (const hex of [...Object.values(accents), ...Object.values(signalColors)]) {
      expect(contrastRatio(colors.secondary, bandSurface(hex))).toBeGreaterThanOrEqual(MIN_SECONDARY_CONTRAST);
      expect(contrastRatio(colors.secondary, backdropSurface(hex))).toBeGreaterThanOrEqual(MIN_SECONDARY_CONTRAST);
    }
  });

  it('primary text on the page background and the viewfinder text on the viewfinder clear 7:1', () => {
    expect(contrastRatio(colors.text, colors.bg)).toBeGreaterThanOrEqual(MIN_BAND_CONTRAST);
    expect(contrastRatio(colors.viewfinderText, colors.viewfinder)).toBeGreaterThanOrEqual(MIN_BAND_CONTRAST);
  });

  it('the glass recipe matches DESIGN.md', () => {
    expect(glass.fillAlpha).toBe(0.58);
    expect(glass.fill).toBe('rgba(255,255,255,0.58)');
    expect(glass.blurIntensity).toBe(40);
    expect(glass.blurTint).toBe('light');
    expect(glass.border).toBe('rgba(255,255,255,0.75)');
    expect(glass.radius).toBe(24);
    expect(glass.shadow).toEqual({ color: '#0F172A', opacity: 0.08, offsetY: 8, blur: 24 });
  });
});

describe('accentFor', () => {
  it('encodes mode: blue walking, amber approach and curb, sky transition, violet indoors, cyan item, teal checkout, green done', () => {
    expect(accentFor('OUTDOOR_NAV')).toBe(accents.outdoor);
    expect(accentFor('APPROACH_CROSSING')).toBe(accents.curb);
    expect(accentFor('AT_CURB')).toBe(accents.curb);
    expect(accentFor('TRANSITION')).toBe(accents.transition);
    expect(accentFor('INDOOR_NAV')).toBe(accents.indoor);
    expect(accentFor('AT_ITEM')).toBe(accents.item);
    expect(accentFor('ITEM_PICKUP')).toBe(accents.item);
    expect(accentFor('CHECKOUT_NAV')).toBe(accents.checkout);
    expect(accentFor('IDLE')).toBe(accents.idle);
    expect(accentFor('ONBOARDING')).toBe(accents.idle);
    expect(accentFor('DONE')).toBe(accents.done);
    expect(bandColorFor).toBe(accentFor);
  });

  it("uses OKO's convention while crossing: green walk, red hand, orange countdown, grey unknown", () => {
    expect(accentFor('CROSSING', 'WALK')).toBe(signalColors.WALK);
    expect(accentFor('CROSSING', 'DONT_WALK')).toBe(signalColors.DONT_WALK);
    expect(accentFor('CROSSING', 'COUNTDOWN')).toBe(signalColors.COUNTDOWN);
    expect(accentFor('CROSSING', 'UNKNOWN')).toBe(signalColors.UNKNOWN);
    expect(accentFor('CROSSING')).toBe(signalColors.UNKNOWN);
    expect(signalColors).toEqual({ WALK: '#16A34A', DONT_WALK: '#DC2626', COUNTDOWN: '#EA580C', UNKNOWN: '#6B7280' });
  });

  it('at the curb a known signal state takes over from amber', () => {
    expect(accentFor('AT_CURB', 'WALK')).toBe(signalColors.WALK);
    expect(accentFor('AT_CURB', 'UNKNOWN')).toBe(accents.curb);
  });

  it('ignores the signal anywhere else', () => {
    expect(accentFor('OUTDOOR_NAV', 'WALK')).toBe(accents.outdoor);
    expect(accentFor('INDOOR_NAV', 'DONT_WALK')).toBe(accents.indoor);
  });
});

describe('type scale, targets and motion', () => {
  it('has exactly three sizes: hero 36-40 at weight 800 with tight tracking, body 18-20, meta 15', () => {
    expect(type.hero.fontSize).toBeGreaterThanOrEqual(36);
    expect(type.hero.fontSize).toBeLessThanOrEqual(40);
    expect(type.hero.fontWeight).toBe('800');
    expect(type.hero.letterSpacing).toBeLessThan(0);
    expect(type.body.fontSize).toBeGreaterThanOrEqual(18);
    expect(type.body.fontSize).toBeLessThanOrEqual(20);
    expect(type.meta.fontSize).toBe(15);
    expect(Object.keys(type)).toEqual(['hero', 'body', 'meta']);
  });

  it('nothing is smaller than 44 pt and the talk button is 88 pt round', () => {
    expect(sizes.minTarget).toBe(44);
    expect(sizes.secondaryHeight).toBeGreaterThanOrEqual(44);
    expect(sizes.talkDiameter).toBe(88);
    expect(sizes.cameraAspect).toBeCloseTo(3 / 4);   // portrait viewfinder
  });

  it('motion tokens match DESIGN.md', () => {
    expect(motion.bandFadeMs).toBe(250);
    expect(motion.panelSlidePx).toBe(8);
    expect(motion.pressScale).toBe(0.96);
    expect(motion.listenPulseMs).toBe(1200);
  });

  describe('text over the camera, not over the page', () => {
    // The perception strip floats on live video. Every other panel composites
    // against colors.bg, so the suite above is blind to this surface: at the
    // page fill the slot labels measured 2.81:1 over the viewfinder and 2.49:1
    // over a black frame, both below AA, and nothing failed.
    const BLACK = '#000000';

    it('the strip stays legible over the darkest frame the lens can produce', () => {
      const surface = cameraStripSurface(BLACK);
      expect(contrastRatio(colors.secondary, surface)).toBeGreaterThanOrEqual(MIN_SECONDARY_CONTRAST);
      expect(contrastRatio(colors.text, surface)).toBeGreaterThanOrEqual(MIN_BAND_CONTRAST);
    });

    it('holds over the viewfinder placeholder and over white', () => {
      for (const under of [colors.viewfinder, BLACK, colors.white, '#7F7F7F']) {
        const surface = cameraStripSurface(under);
        expect({ under, ratio: contrastRatio(colors.secondary, surface) >= MIN_SECONDARY_CONTRAST }).toEqual({ under, ratio: true });
        expect({ under, ratio: contrastRatio(colors.text, surface) >= MIN_SECONDARY_CONTRAST }).toEqual({ under, ratio: true });
      }
    });

    it('holds with any mode accent tinting the strip', () => {
      for (const accent of Object.values(accents)) {
        const surface = cameraStripSurface(BLACK, accent);
        expect({ accent, ok: contrastRatio(colors.secondary, surface) >= MIN_SECONDARY_CONTRAST }).toEqual({ accent, ok: true });
      }
      for (const signal of SIGNALS) {
        const surface = cameraStripSurface(BLACK, signalColors[signal]);
        expect({ signal, ok: contrastRatio(colors.secondary, surface) >= MIN_SECONDARY_CONTRAST }).toEqual({ signal, ok: true });
      }
    });

    it('the page fill would have failed — the reason the dense fill exists', () => {
      const pageFill = blend(colors.white, BLACK, glass.fillAlpha);
      expect(contrastRatio(colors.secondary, pageFill)).toBeLessThan(MIN_SECONDARY_CONTRAST);
      expect(glass.overCameraFillAlpha).toBeGreaterThan(glass.fillAlpha);
    });
  });

  describe('cameraMaxHeight', () => {
    // The two screens' numbers, so a change to either is caught here.
    const NAV = { share: 0.46, reserve: 430 };
    const HOME = { share: 0.42, reserve: 420 };

    it('a tall phone is governed by the share, not the reserve', () => {
      // iPhone 16: 852 pt. 46 % = 392, and 852 - 430 = 422 is roomier, so the share wins.
      expect(cameraMaxHeight(852, NAV.share, NAV.reserve)).toBe(392);
      expect(cameraMaxHeight(852, HOME.share, HOME.reserve)).toBe(358);
    });

    it('a short phone gives the space back so the controls still fit', () => {
      // iPhone SE: 667 pt. The flat share would take 307 and push the talk button off.
      expect(cameraMaxHeight(667, NAV.share, NAV.reserve)).toBe(237);
      expect(cameraMaxHeight(667, NAV.share, NAV.reserve)).toBeLessThan(Math.round(667 * NAV.share));
      expect(cameraMaxHeight(667, HOME.share, HOME.reserve)).toBe(247);
    });

    it('never collapses the viewfinder below its floor', () => {
      expect(cameraMaxHeight(480, NAV.share, NAV.reserve)).toBe(sizes.cameraMinHeight);
      expect(cameraMaxHeight(0, NAV.share, NAV.reserve)).toBe(sizes.cameraMinHeight);
    });

    it('grows with the window and never exceeds the share', () => {
      for (const h of [568, 667, 736, 812, 844, 852, 932]) {
        const px = cameraMaxHeight(h, NAV.share, NAV.reserve);
        expect(px).toBeLessThanOrEqual(Math.max(sizes.cameraMinHeight, Math.round(h * NAV.share)));
        expect(px).toBeGreaterThanOrEqual(sizes.cameraMinHeight);
      }
    });
  });
});
