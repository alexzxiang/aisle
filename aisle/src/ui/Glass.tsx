/**
 * The glass primitives (DESIGN.md, "The glass"): every panel in the app is a
 * `GlassPanel`, and every screen sits on a `Backdrop`.
 *
 * A panel is layered, bottom to top: an expo-blur BlurView (when the native
 * view exists; a plain View otherwise, so mock mode and tests look the same
 * minus the blur), the white fill, an optional accent tint, then the
 * content. The tint cross-fades over 250 ms when it changes (the state band
 * uses this for its mode / signal colour); the whole panel fades in and
 * slides up 8 px on mount. Both are skipped under reduce-motion.
 *
 * iOS clips a layer's shadow when it clips its children, so the shadow lives
 * on an outer view and the rounding + clipping on an inner one.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, View, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';
import { useMountIn, useResolvedReduceMotion } from './hooks';
import { colors, glass, motion, sizes, tintOf } from './theme';

interface BlurLike {
  BlurView: React.ComponentType<{ intensity?: number; tint?: string; style?: StyleProp<ViewStyle>; children?: React.ReactNode }>;
}

/** The JS package is always installed; the native `ExpoBlur` module only exists in a build made after it was added. */
export function hasNativeBlur(): boolean {
  try {
    const expo = (globalThis as { expo?: { getViewConfig?: (m: string, v?: string) => unknown } }).expo;
    if (!expo || typeof expo.getViewConfig !== 'function') return true; // Jest / no registry: trust the package
    return expo.getViewConfig('ExpoBlur', 'ExpoBlurView') != null;
  } catch {
    return false;
  }
}

let blur: BlurLike | null = null;
try {
  // Optional at runtime: a build without the native module still renders solid glass
  // (and never asks RN for a view config it cannot have: the "ExpoBlurView" warning).
  blur = hasNativeBlur() ? (require('expo-blur') as BlurLike) : null;
  if (typeof blur?.BlurView !== 'function' && typeof blur?.BlurView !== 'object') blur = null;
} catch {
  blur = null;
}

/** Whether the real blur is available in this build (tests and the DebugPanel read it). */
export function isBlurAvailable(): boolean {
  return blur !== null;
}

export interface GlassPanelProps extends Pick<ViewProps, 'accessible' | 'accessibilityRole' | 'accessibilityLabel' | 'accessibilityHint' | 'testID' | 'pointerEvents'> {
  children?: React.ReactNode;
  /** Accent hex laid over the fill at `tintAlpha`; omit for plain glass. */
  tint?: string | null;
  tintAlpha?: number;
  /** Panel radius; defaults to the 24 pt glass radius. */
  radius?: number;
  /** Skip the mount animation (a panel that re-keys often, or is already inside one). */
  animateIn?: boolean;
  /** Drop the shadow (nested panels, the strip over the camera). */
  flat?: boolean;
  /** Outer (shadow) style: layout, margins, flex. */
  style?: StyleProp<ViewStyle>;
  /** Inner (content) style: padding, alignment. */
  contentStyle?: StyleProp<ViewStyle>;
  reduceMotion?: boolean;
}

export function GlassPanel(props: GlassPanelProps): React.JSX.Element {
  const {
    children, tint = null, tintAlpha = glass.bandTintAlpha, radius = glass.radius, animateIn = true, flat = false,
    style, contentStyle, reduceMotion: reduceMotionProp,
    accessible, accessibilityRole, accessibilityLabel, accessibilityHint, testID, pointerEvents,
  } = props;
  const reduceMotion = useResolvedReduceMotion(reduceMotionProp);
  const mountIn = useMountIn(reduceMotion);
  const mountStyle = animateIn ? mountIn : undefined;

  // Two tint layers: the settled colour underneath, the incoming colour fading in.
  const [base, setBase] = useState<string | null>(tint);
  const [incoming, setIncoming] = useState<string | null>(null);
  const fade = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (tint === base) return undefined;
    if (reduceMotion || tint === null || base === null) {
      setBase(tint);
      setIncoming(null);
      fade.setValue(0);
      return undefined;
    }
    setIncoming(tint);
    fade.setValue(0);
    const anim = Animated.timing(fade, { toValue: 1, duration: motion.bandFadeMs, useNativeDriver: true });
    anim.start(({ finished }) => {
      if (!finished) return;
      setBase(tint);
      setIncoming(null);
      fade.setValue(0);
    });
    return () => anim.stop();
  }, [tint, base, reduceMotion, fade]);

  const Blur = blur?.BlurView;
  const rounded = { borderRadius: radius };

  return (
    <Animated.View
      style={[styles.outer, !flat && styles.shadow, rounded, mountStyle, style]}
      accessible={accessible}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      testID={testID}
      pointerEvents={pointerEvents}
    >
      <View style={[styles.inner, rounded, contentStyle]}>
        {Blur ? <Blur intensity={glass.blurIntensity} tint={glass.blurTint} style={StyleSheet.absoluteFill} /> : null}
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.fill]} />
        {base !== null ? (
          <View pointerEvents="none" testID="glass-tint" style={[StyleSheet.absoluteFill, { backgroundColor: tintOf(base, tintAlpha) }]} />
        ) : null}
        {incoming !== null ? (
          <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: tintOf(incoming, tintAlpha), opacity: fade }]} />
        ) : null}
        {children}
      </View>
    </Animated.View>
  );
}

export interface BackdropProps {
  /** The current accent; the page's top edge takes a soft tint of it. */
  accent: string;
  reduceMotion?: boolean;
}

/** Soft top-to-bottom accent tint over the page background, cross-fading with the accent. */
const BACKDROP_STEPS = [1, 0.72, 0.48, 0.28, 0.12] as const;
const BACKDROP_STEP_HEIGHT = 56;

export function Backdrop({ accent, reduceMotion: reduceMotionProp }: BackdropProps): React.JSX.Element {
  const reduceMotion = useResolvedReduceMotion(reduceMotionProp);
  const [base, setBase] = useState(accent);
  const [incoming, setIncoming] = useState<string | null>(null);
  const fade = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (accent === base) return undefined;
    if (reduceMotion) {
      setBase(accent);
      setIncoming(null);
      fade.setValue(0);
      return undefined;
    }
    setIncoming(accent);
    fade.setValue(0);
    const anim = Animated.timing(fade, { toValue: 1, duration: motion.bandFadeMs, useNativeDriver: true });
    anim.start(({ finished }) => {
      if (!finished) return;
      setBase(accent);
      setIncoming(null);
      fade.setValue(0);
    });
    return () => anim.stop();
  }, [accent, base, reduceMotion, fade]);

  const strips = (hex: string): React.JSX.Element[] =>
    BACKDROP_STEPS.map((k, i) => (
      <View key={`${hex}-${i}`} style={{ height: BACKDROP_STEP_HEIGHT, backgroundColor: tintOf(hex, glass.backdropTintAlpha * k) }} />
    ));

  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.backdrop]} testID="backdrop">
      <View style={StyleSheet.absoluteFill}>{strips(base)}</View>
      {incoming !== null ? (
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: fade }]}>{strips(incoming)}</Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  outer: {
    backgroundColor: 'transparent',
  },
  shadow: {
    shadowColor: glass.shadow.color,
    shadowOpacity: glass.shadow.opacity,
    shadowOffset: { width: 0, height: glass.shadow.offsetY },
    shadowRadius: glass.shadow.blur / 2,
    elevation: 4,
  },
  inner: {
    overflow: 'hidden',
    borderWidth: glass.borderWidth,
    borderColor: glass.border,
    borderRadius: sizes.radius,
  },
  fill: {
    backgroundColor: glass.fill,
  },
  backdrop: {
    backgroundColor: colors.bg,
  },
});
