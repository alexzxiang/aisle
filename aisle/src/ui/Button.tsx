/**
 * The one secondary control: a plain, tall, labelled target. No icons, no
 * variants beyond size. 64 pt for the two under the talk button, 44 pt minimum
 * for everything else (DESIGN.md rule 7).
 */
import React from 'react';
import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';
import { colors, fontScaleCap, sizes, space, type } from './theme';

export interface ButtonProps {
  label: string;
  onPress?: () => void;
  onLongPress?: () => void;
  delayLongPress?: number;
  hint?: string;
  disabled?: boolean;
  /** 'secondary' = 64 pt, 'compact' = 44 pt. */
  size?: 'secondary' | 'compact';
  /** Visually quieter, same size. */
  quiet?: boolean;
  selected?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Button(props: ButtonProps): React.JSX.Element {
  const { label, onPress, onLongPress, delayLongPress, hint, disabled, size = 'secondary', quiet, selected, style, testID } = props;
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={delayLongPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: disabled === true, selected: selected === true }}
      testID={testID}
      style={({ pressed }) => [
        styles.base,
        size === 'compact' ? styles.compact : styles.secondary,
        quiet && styles.quiet,
        selected && styles.selected,
        pressed && styles.pressed,
        disabled && styles.disabled,
        style,
      ]}
    >
      <Text allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={[styles.label, quiet && styles.quietLabel]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    backgroundColor: colors.control,
    borderRadius: sizes.radius,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: space.l,
  },
  secondary: {
    minHeight: sizes.secondaryHeight,
  },
  compact: {
    minHeight: sizes.minTarget,
  },
  quiet: {
    backgroundColor: 'transparent',
  },
  selected: {
    borderWidth: 2,
    borderColor: colors.text,
  },
  pressed: {
    opacity: 0.7,
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
  quietLabel: {
    color: colors.meta,
  },
});
