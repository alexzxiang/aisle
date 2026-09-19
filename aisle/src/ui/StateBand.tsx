/**
 * The state band: the one memorable element (src/ui/DESIGN.md rules 1-3).
 *
 * Full-bleed, colour-coded by mode (and by signal state while crossing), with
 * the mode word above and the current instruction as the hero. The hero is the
 * single live region in the app, so VoiceOver announces exactly one changing
 * thing. The only animation in Aisle is this band's 250 ms colour cross-fade,
 * and it is skipped under reduce-motion.
 *
 * The mode word is also the DebugPanel's door: a 1.5 s long-press, never a
 * three-finger tap (VoiceOver) or a shake (Expo dev menu).
 */
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import type { AppMode, SignalState } from '../core/contracts';
import { bandColorFor, colors, fontScaleCap, motion, sizes, space, type } from './theme';
import { modeWord as modeWordFor } from './derive';
import { useReduceMotion } from './hooks';

export const DEBUG_LONG_PRESS_MS = 1500;

export interface StateBandProps {
  mode: AppMode;
  /** The one instruction, at most twelve words. */
  hero: string;
  /** Only read at the curb and while crossing; pass the last known state. */
  signal?: SignalState;
  /** 1.5 s long-press on the mode word. */
  onLongPressMode?: () => void;
  /** Overrides the word derived from the mode (onboarding says "Practice"). */
  modeWord?: string;
  style?: StyleProp<ViewStyle>;
  /** Tests: skip the animation without stubbing AccessibilityInfo. */
  reduceMotion?: boolean;
}

export function StateBand(props: StateBandProps): React.JSX.Element {
  const { mode, hero, signal = 'UNKNOWN', onLongPressMode, style } = props;
  const word = props.modeWord ?? modeWordFor(mode);
  const target = bandColorFor(mode, signal);

  const systemReduceMotion = useReduceMotion();
  const reduceMotion = props.reduceMotion ?? systemReduceMotion;

  // Two layers: the settled colour underneath, the incoming colour fading in.
  const [base, setBase] = useState(target);
  const [incoming, setIncoming] = useState<string | null>(null);
  const fade = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (target === base) return;
    if (reduceMotion) {
      setBase(target);
      setIncoming(null);
      fade.setValue(0);
      return;
    }
    setIncoming(target);
    fade.setValue(0);
    const anim = Animated.timing(fade, {
      toValue: 1,
      duration: motion.bandFadeMs,
      useNativeDriver: false,
    });
    anim.start(({ finished }) => {
      if (!finished) return;
      setBase(target);
      setIncoming(null);
      fade.setValue(0);
    });
    return () => anim.stop();
  }, [target, base, reduceMotion, fade]);

  return (
    <View style={[styles.band, { backgroundColor: base }, style]}>
      {incoming !== null ? (
        <Animated.View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { backgroundColor: incoming, opacity: fade }]}
        />
      ) : null}

      <View style={styles.content}>
        <Pressable
          onLongPress={onLongPressMode}
          delayLongPress={DEBUG_LONG_PRESS_MS}
          disabled={onLongPressMode === undefined}
          accessibilityRole="button"
          accessibilityLabel={`Mode: ${word}`}
          accessibilityHint={onLongPressMode ? 'Press and hold to open the debug panel' : undefined}
          style={styles.modeTarget}
        >
          <Text
            allowFontScaling
            maxFontSizeMultiplier={fontScaleCap.body}
            style={styles.modeWord}
          >
            {word}
          </Text>
        </Pressable>

        <Text
          accessibilityRole="header"
          accessibilityLiveRegion="polite"
          accessible
          allowFontScaling
          maxFontSizeMultiplier={fontScaleCap.hero}
          style={styles.hero}
        >
          {hero}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  band: {
    width: '100%',
    overflow: 'hidden',
    justifyContent: 'flex-end',
    minHeight: 220,
    paddingTop: space.xxl + space.xl,
    paddingBottom: space.xl,
    paddingHorizontal: sizes.gutter,
  },
  content: {
    width: '100%',
  },
  modeTarget: {
    minHeight: sizes.minTarget,
    justifyContent: 'flex-end',
    paddingBottom: space.s,
  },
  modeWord: {
    ...type.meta,
    color: colors.text,
  },
  hero: {
    ...type.hero,
    color: colors.text,
    textAlign: 'left',
  },
});
