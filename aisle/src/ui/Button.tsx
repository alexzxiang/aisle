/**
 * The one secondary control: a glass target with a label. No icons, three
 * sizes: 'secondary' (56 pt, the pair under the talk button), 'compact'
 * (44 pt, everything else) and 'pill' (44 pt, fully rounded, inline). Press
 * scales the target to 0.96 (DESIGN.md, Motion), skipped under reduce-motion.
 */
import React from 'react';
import { Animated, Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';
import { usePressScale, useResolvedReduceMotion } from './hooks';
import { colors, fontScaleCap, glass, sizes, space, type } from './theme';

export interface ButtonProps {
  label: string;
  onPress?: () => void;
  onLongPress?: () => void;
  delayLongPress?: number;
  hint?: string;
  disabled?: boolean;
  /** 'secondary' = 56 pt, 'compact' = 44 pt, 'pill' = 44 pt fully rounded. */
  size?: 'secondary' | 'compact' | 'pill';
  /** Visually quieter, same size. */
  quiet?: boolean;
  /** The one filled button on a screen (Find it). */
  primary?: boolean;
  selected?: boolean;
  /** Announced as in progress; the label stays. */
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  reduceMotion?: boolean;
}

export function Button(props: ButtonProps): React.JSX.Element {
  const { label, onPress, onLongPress, delayLongPress, hint, disabled, size = 'secondary', quiet, primary, selected, busy, style, testID } = props;
  const reduceMotion = useResolvedReduceMotion(props.reduceMotion);
  const press = usePressScale(reduceMotion);
  return (
    <Animated.View style={[styles.wrap, { transform: [{ scale: press.scale }] }, style]}>
      <Pressable
        onPress={onPress}
        onLongPress={onLongPress}
        delayLongPress={delayLongPress}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={hint}
        accessibilityState={{ disabled: disabled === true, selected: selected === true, busy: busy === true }}
        testID={testID}
        style={({ pressed }) => [
          styles.base,
          size === 'compact' ? styles.compact : size === 'pill' ? styles.pill : styles.secondary,
          quiet && styles.quiet,
          primary && styles.primary,
          selected && styles.selected,
          pressed && !primary && styles.pressed,
          pressed && primary && styles.primaryPressed,
          disabled && styles.disabled,
        ]}
      >
        <Text
          allowFontScaling
          maxFontSizeMultiplier={fontScaleCap.body}
          style={[styles.label, size === 'pill' && styles.pillLabel, quiet && styles.quietLabel, primary && styles.primaryLabel]}
        >
          {label}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    shadowColor: glass.shadow.color,
    shadowOpacity: glass.shadow.opacity / 2,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 8,
    elevation: 2,
  },
  base: {
    backgroundColor: colors.control,
    borderWidth: glass.borderWidth,
    borderColor: glass.border,
    borderRadius: sizes.radiusControl,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: space.l,
    paddingVertical: space.m,
  },
  secondary: {
    minHeight: sizes.secondaryHeight,
  },
  compact: {
    minHeight: sizes.minTarget,
  },
  pill: {
    minHeight: sizes.minTarget,
    borderRadius: sizes.radiusPill,
    paddingHorizontal: space.xl,
    alignSelf: 'flex-start',
  },
  quiet: {
    backgroundColor: 'transparent',
    borderColor: 'transparent',
  },
  primary: {
    backgroundColor: colors.text,
    borderColor: colors.text,
  },
  primaryPressed: {
    opacity: 0.85,
  },
  selected: {
    borderWidth: 2,
    borderColor: colors.text,
  },
  pressed: {
    backgroundColor: colors.controlPressed,
  },
  disabled: {
    opacity: 0.4,
  },
  label: {
    ...type.body,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'center',
  },
  pillLabel: {
    ...type.meta,
    fontWeight: '700',
    color: colors.text,
  },
  quietLabel: {
    color: colors.secondary,
  },
  primaryLabel: {
    color: colors.white,
  },
});
