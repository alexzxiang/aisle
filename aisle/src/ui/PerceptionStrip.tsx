/**
 * What the phone currently perceives: three fixed slots (DESIGN.md, "The
 * camera panel"), as a compact glass row that sits over the bottom edge of
 * the camera panel.
 *
 * The slots never move and never disappear -- an empty one says "not seen" --
 * so position alone identifies them, and each slot reads as a sentence to a
 * screen reader: "Signal: walk, seen 1 s ago".
 */
import React from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { GlassPanel } from './Glass';
import { colors, fontScaleCap, sizes, space, tabular, type } from './theme';
import type { StripSlot } from './derive';

export interface PerceptionStripProps {
  slots: StripSlot[];
  /** The band's accent: a faint tint on the row so it reads as part of the same state. */
  accent?: string;
  style?: StyleProp<ViewStyle>;
  reduceMotion?: boolean;
}

export function PerceptionStrip({ slots, accent, style, reduceMotion }: PerceptionStripProps): React.JSX.Element {
  return (
    <GlassPanel
      tint={accent ?? null}
      tintAlpha={0.1}
      radius={sizes.radiusControl}
      flat
      animateIn={false}
      reduceMotion={reduceMotion}
      style={style}
      contentStyle={styles.row}
      accessibilityRole="summary"
      accessibilityLabel="What Aisle perceives"
    >
      {slots.map((slot, i) => (
        <View
          key={slot.key}
          style={[styles.slot, i > 0 && styles.slotDivider]}
          accessible
          accessibilityRole="text"
          accessibilityLabel={`${slot.label}: ${slot.value}`}
        >
          <Text allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} numberOfLines={1} style={styles.label}>
            {slot.label}
          </Text>
          <Text allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} numberOfLines={2} style={styles.value}>
            {slot.value}
          </Text>
        </View>
      ))}
    </GlassPanel>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    paddingVertical: space.s,
    paddingHorizontal: space.xs,
  },
  slot: {
    flex: 1,
    minHeight: sizes.minTarget,
    justifyContent: 'center',
    paddingHorizontal: space.m,
    gap: 2,
  },
  slotDivider: {
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: colors.hairline,
  },
  label: {
    ...type.meta,
    fontWeight: '700',
    color: colors.secondary,
  },
  value: {
    ...type.meta,
    fontWeight: '600',
    color: colors.text,
    ...tabular,
  },
});
