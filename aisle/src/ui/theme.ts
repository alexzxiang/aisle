/**
 * Design tokens (src/ui/DESIGN.md).
 *
 * Pure data plus two pure helpers, so the contrast rule is testable:
 * `theme.test.ts` recomputes every band ratio against `colors.text` and fails
 * below 7:1. No component defines a colour or a font size of its own.
 */
import { Platform, type TextStyle } from 'react-native';
import type { AppMode, SignalState } from '../core/contracts';

export const colors = {
  /** Near-black page. */
  bg: '#0A0C10',
  /** Off-white text; the only text colour used on a band. */
  text: '#F2F4F7',
  /** Meta text on the page background (8.96:1). Never on a band. */
  meta: '#A8B0BD',
  /** Hairline separators. */
  hairline: '#1E232C',
  /** Secondary control fill. */
  control: '#151A22',
  /** Push-to-talk fill (idle) and its held state. */
  talk: '#1B2430',
  talkHeld: '#2C3A4C',
} as const;

/** Band colour per mode. Crossing is overridden by the signal colour (01 §5). */
export const bandColors = {
  idle: '#1A1F2A',
  outdoor: '#0E2450',
  curb: '#6B3D00',
  indoor: '#08403B',
  done: '#18323F',
} as const;

/** OKO's convention, stated in words as well as colour. */
export const signalColors: Readonly<Record<SignalState, string>> = {
  WALK: '#0B4A26',
  DONT_WALK: '#7C1220',
  COUNTDOWN: '#7A3A00',
  UNKNOWN: '#262B33',
};

export const type = {
  hero: { fontSize: 44, fontWeight: '800', letterSpacing: -0.8, lineHeight: 48 },
  body: { fontSize: 20, fontWeight: '500', letterSpacing: 0 },
  meta: { fontSize: 16, fontWeight: '600', letterSpacing: 0.2 },
} as const;

/** Applied to any run of digits (distances, latencies, clock values). */
export const tabular: { fontVariant: TextStyle['fontVariant'] } = { fontVariant: ['tabular-nums'] };

export const space = { xs: 4, s: 8, m: 12, l: 16, xl: 24, xxl: 32 } as const;

export const sizes = {
  /** Full-width push-to-talk. */
  talkHeight: 96,
  /** "Repeat" / "Stop guidance". */
  secondaryHeight: 64,
  /** Nothing in the app is smaller than this. */
  minTarget: 44,
  /** Side gutter. */
  gutter: 16,
  radius: 14,
} as const;

/** The one animation in the app (DESIGN.md rule 8). */
export const motion = { bandFadeMs: 250 } as const;

/** Hero text may scale, but not so far it pushes the talk button off-screen. */
export const fontScaleCap = { hero: 1.6, body: 2.0 } as const;

/** Monospace only inside the DebugPanel. */
export const monoFontFamily: string = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'Courier' }) ?? 'Courier';

// ---------------------------------------------------------------------------
// Band selection
// ---------------------------------------------------------------------------

/**
 * The band colour for a mode. `signal` only matters at the curb and while
 * crossing; anywhere else it is ignored, so callers may pass the last known
 * state unconditionally.
 */
export function bandColorFor(mode: AppMode, signal: SignalState = 'UNKNOWN'): string {
  switch (mode) {
    case 'IDLE':
    case 'ONBOARDING':
      return bandColors.idle;
    case 'OUTDOOR_NAV':
    case 'APPROACH_CROSSING':
      return bandColors.outdoor;
    case 'AT_CURB':
      // Amber is the curb's own colour; the signal word carries the state, and the
      // signal colour takes over the moment the user is in the roadway.
      return signal === 'UNKNOWN' ? bandColors.curb : signalColors[signal];
    case 'CROSSING':
      return signalColors[signal];
    case 'TRANSITION':
    case 'INDOOR_NAV':
    case 'AT_ITEM':
    case 'ITEM_PICKUP':
    case 'CHECKOUT_NAV':
      return bandColors.indoor;
    case 'DONE':
      return bandColors.done;
  }
}

// ---------------------------------------------------------------------------
// Contrast (WCAG 2.1 relative luminance) — used by the test, not at runtime
// ---------------------------------------------------------------------------

function channel(v: number): number {
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(hex: string): number {
  const h = hex.replace('#', '');
  if (h.length !== 6) throw new Error(`expected #rrggbb, got ${hex}`);
  const r = channel(parseInt(h.slice(0, 2), 16) / 255);
  const g = channel(parseInt(h.slice(2, 4), 16) / 255);
  const b = channel(parseInt(h.slice(4, 6), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

export const MIN_BAND_CONTRAST = 7;
