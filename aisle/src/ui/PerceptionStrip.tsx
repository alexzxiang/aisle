/**
 * What the phone currently perceives: three fixed slots (DESIGN.md rule 6).
 *
 * The slots never move and never disappear -- an empty one says "not seen" --
 * so position alone identifies them, and each row reads as a sentence:
 * "Signal: walk, seen 1 s ago".
 */
import React from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors, fontScaleCap, sizes, space, tabular, type } from './theme';
import type { StripSlot } from './derive';

export interface PerceptionStripProps {
  slots: StripSlot[];
  style?: StyleProp<ViewStyle>;
}

export function PerceptionStrip({ slots, style }: PerceptionStripProps): React.JSX.Element {
  return (
    <View
      style={[styles.strip, style]}
      accessibilityRole="summary"
      accessibilityLabel="What Aisle perceives"
    >
      {slots.map((slot) => (
        <View key={slot.key} style={styles.row} accessible accessibilityRole="text" accessibilityLabel={`${slot.label}: ${slot.value}`}>
          <Text allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={styles.line}>
            <Text style={styles.label}>{slot.label}: </Text>
            <Text style={styles.value}>{slot.value}</Text>
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    width: '100%',
    paddingHorizontal: sizes.gutter,
    paddingVertical: space.m,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
  },
  row: {
    minHeight: 32,
    justifyContent: 'center',
    paddingVertical: space.xs,
  },
  line: {
    ...type.body,
    color: colors.text,
  },
  label: {
    color: colors.meta,
  },
  value: {
    color: colors.text,
    ...tabular,
  },
});
