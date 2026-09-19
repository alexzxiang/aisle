/**
 * Design tokens (src/ui/DESIGN.md): the white "liquid glass" system.
 *
 * Pure data plus pure helpers, so the contrast rule stays testable:
 * `theme.test.ts` composites every band surface (accent tint over the glass
 * fill over the page) exactly as the screens layer it, and fails below 7:1
 * against `colors.text`. No component defines a colour, a radius or a font
 * size of its own.
 */
import { Platform, type TextStyle } from 'react-native';
import type { AppMode, SignalState } from '../core/contracts';

export const colors = {
  /** Page background. A very soft accent tint sits over its top edge (`Backdrop`). */
  bg: '#F5F7FA',
  /** Primary text everywhere, including on every band (>= 7:1 on every surface). */
  text: '#0B1220',
  /** Secondary and meta text (>= 4.5:1 on every surface). */
  secondary: '#4B5563',
  /** Hairline separators on glass. */
  hairline: 'rgba(15,23,42,0.08)',
  /** Secondary control fill on top of the page (the glass buttons). */
  control: 'rgba(255,255,255,0.72)',
  /** Pressed / selected control fill. */
  controlPressed: 'rgba(255,255,255,0.92)',
  /** Text field fill. */
  field: 'rgba(255,255,255,0.80)',
  /** "You" transcript bubble. */
  youBubble: 'rgba(15,23,42,0.06)',
  /** Placeholder text in the field. */
  placeholder: '#6B7280',
  white: '#FFFFFF',
  /** Camera placeholder panel (a dark viewfinder, so the page reads as a camera app). */
  viewfinder: '#111827',
  viewfinderText: '#E5E7EB',
} as const;

/** The glass recipe every panel is built from. */
export const glass = {
  /** White fill over the blur. Lowering it lets more colour through; the contrast test guards it. */
  fillAlpha: 0.58,
  fill: 'rgba(255,255,255,0.58)',
  blurIntensity: 40,
  blurTint: 'light',
  border: 'rgba(255,255,255,0.75)',
  borderWidth: 1,
  radius: 24,
  shadow: { color: '#0F172A', opacity: 0.08, offsetY: 8, blur: 24 },
  /** Accent tint laid over the fill on the state band and the perception strip. */
  bandTintAlpha: 0.18,
  /** Accent tint on the page's top edge (`Backdrop`), fading to nothing. */
  backdropTintAlpha: 0.12,
} as const;

/** One accent per mode (01 §5 for the crossing states). Never the only carrier of meaning. */
export const accents = {
  idle: '#475569',
  outdoor: '#2563EB',
  curb: '#D97706',
  transition: '#0EA5E9',
  indoor: '#7C3AED',
  item: '#0891B2',
  checkout: '#0D9488',
  done: '#16A34A',
  task: '#4F46E5',   // guided task: indigo, distinct from indoor violet and outdoor blue
} as const;

/** OKO's convention, stated in words as well as colour. */
export const signalColors: Readonly<Record<SignalState, string>> = {
  WALK: '#16A34A',
  DONT_WALK: '#DC2626',
  COUNTDOWN: '#EA580C',
  UNKNOWN: '#6B7280',
};

export const type = {
  hero: { fontSize: 38, fontWeight: '800', letterSpacing: -0.9, lineHeight: 42 },
  body: { fontSize: 18, fontWeight: '500', letterSpacing: -0.1, lineHeight: 24 },
  meta: { fontSize: 15, fontWeight: '600', letterSpacing: 0.1, lineHeight: 20 },
} as const;

/** Applied to any run of digits (distances, latencies, clock values). */
export const tabular: { fontVariant: TextStyle['fontVariant'] } = { fontVariant: ['tabular-nums'] };

export const space = { xs: 4, s: 8, m: 12, l: 16, xl: 24, xxl: 32 } as const;

export const sizes = {
  /** The round hold-to-talk button. */
  talkDiameter: 88,
  /** "Repeat" / "Stop guidance". */
  secondaryHeight: 56,
  /** Nothing in the app is smaller than this. */
  minTarget: 44,
  /** Side gutter. */
  gutter: 16,
  /** Glass panels. */
  radius: 24,
  /** Buttons and fields. */
  radiusControl: 18,
  /** Pills. */
  radiusPill: 22,
  /** The camera panel's aspect (width : height). */
  /** Portrait: the phone is held upright and the frame should show what is ahead, floor to head height. */
  cameraAspect: 3 / 4,
} as const;

/** Every motion in the app, all gated by reduce-motion (DESIGN.md, Motion). */
export const motion = {
  /** State band accent cross-fade. */
  bandFadeMs: 250,
  /** Glass panel mount: fade in and slide up 8 px. */
  panelInMs: 320,
  panelSlidePx: 8,
  /** Transcript line mount: slide up. */
  lineInMs: 220,
  lineSlidePx: 10,
  /** Talk button press. */
  pressScale: 0.96,
  pressMs: 120,
  /** Listening ring, one loop. */
  listenPulseMs: 1200,
} as const;

/** Hero text may scale, but not so far it pushes the talk button off-screen. */
export const fontScaleCap = { hero: 1.6, body: 2.0 } as const;

/** Monospace only inside the DebugPanel. */
export const monoFontFamily: string = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'Courier' }) ?? 'Courier';

// ---------------------------------------------------------------------------
// Accent selection
// ---------------------------------------------------------------------------

/**
 * The accent for a mode. `signal` only matters at the curb and while
 * crossing; anywhere else it is ignored, so callers may pass the last known
 * state unconditionally.
 */
export function accentFor(mode: AppMode, signal: SignalState = 'UNKNOWN'): string {
  switch (mode) {
    case 'IDLE':
    case 'ONBOARDING':
      return accents.idle;
    case 'OUTDOOR_NAV':
      return accents.outdoor;
    case 'APPROACH_CROSSING':
      return accents.curb;
    case 'AT_CURB':
      // Amber is the curb's own colour; the signal word carries the state, and the
      // signal colour takes over the moment a state is known.
      return signal === 'UNKNOWN' ? accents.curb : signalColors[signal];
    case 'CROSSING':
      return signalColors[signal];
    case 'TRANSITION':
      return accents.transition;
    case 'INDOOR_NAV':
      return accents.indoor;
    case 'AT_ITEM':
    case 'ITEM_PICKUP':
      return accents.item;
    case 'CHECKOUT_NAV':
      return accents.checkout;
    case 'DONE':
      return accents.done;
    case 'GUIDED_TASK':
      return accents.task;
  }
}

/** Kept for callers that still think in "band colours": the band's accent. */
export const bandColorFor = accentFor;

// ---------------------------------------------------------------------------
// Colour arithmetic (WCAG 2.1 relative luminance, sRGB compositing) — used by
// the test and by the glass fallback, never per frame
// ---------------------------------------------------------------------------

function channel(v: number): number {
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  if (h.length !== 6) throw new Error(`expected #rrggbb, got ${hex}`);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function toHex(rgb: [number, number, number]): string {
  return `#${rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0').toUpperCase()).join('')}`;
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * channel(r / 255) + 0.7152 * channel(g / 255) + 0.0722 * channel(b / 255);
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** `over` at `alpha` composited onto the opaque `under`, the way the compositor does it. */
export function blend(over: string, under: string, alpha: number): string {
  const o = parseHex(over);
  const u = parseHex(under);
  return toHex([o[0] * alpha + u[0] * (1 - alpha), o[1] * alpha + u[1] * (1 - alpha), o[2] * alpha + u[2] * (1 - alpha)]);
}

/** A plain glass panel's effective colour over the page: white fill over the background. */
export function glassSurface(under: string = colors.bg): string {
  return blend(colors.white, under, glass.fillAlpha);
}

/** The state band's effective colour: accent tint over the glass over the page. */
export function bandSurface(accent: string, under: string = colors.bg): string {
  return blend(accent, glassSurface(under), glass.bandTintAlpha);
}

/** The page's top edge under the backdrop tint (the darkest the page itself gets). */
export function backdropSurface(accent: string): string {
  return blend(accent, colors.bg, glass.backdropTintAlpha);
}

/** Accent at an alpha, as an rgba() string for a tint layer. */
export function tintOf(accent: string, alpha: number): string {
  const [r, g, b] = parseHex(accent);
  return `rgba(${r},${g},${b},${alpha})`;
}

export const MIN_BAND_CONTRAST = 7;
export const MIN_SECONDARY_CONTRAST = 4.5;
