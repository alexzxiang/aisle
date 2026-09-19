/**
 * Settings: speaking rate, training mode, the open-ear headphones note.
 *
 * The rate control is a VoiceOver "adjustable" with increment / decrement
 * actions plus two plain buttons, which is the accessible form of a slider
 * without a native slider dependency. Values land in the store; the
 * SpeechService follows the store (02 Task 4), so nothing here calls it.
 */
import React, { useCallback } from 'react';
import { Modal, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { Button } from './Button';
import { useOptionalService, useStoreSlice } from './hooks';
import { SPEECH_RATE_MAX, SPEECH_RATE_MIN } from '../core/store';
import { HEADPHONE_NOTE } from './copy';
import { colors, fontScaleCap, sizes, space, tabular, type } from './theme';

export const RATE_STEP = 0.1;
export const SLOWER_LABEL = 'Slower';
export const FASTER_LABEL = 'Faster';
export const TRAINING_LABEL = 'Training mode';
export const CLOSE_LABEL = 'Close settings';

export function formatRate(rate: number): string {
  return `${rate.toFixed(1)}×`;
}

export interface SettingsSheetProps {
  visible: boolean;
  onClose: () => void;
}

export function SettingsSheet({ visible, onClose }: SettingsSheetProps): React.JSX.Element {
  const rate = useStoreSlice((s) => s.speechRate);
  const setSpeechRate = useStoreSlice((s) => s.setSpeechRate);
  const training = useStoreSlice((s) => s.trainingMode);
  const setTrainingMode = useStoreSlice((s) => s.setTrainingMode);
  const speech = useOptionalService('speech');

  const apply = useCallback(
    (next: number) => {
      const clamped = Math.min(SPEECH_RATE_MAX, Math.max(SPEECH_RATE_MIN, Math.round(next * 10) / 10));
      setSpeechRate(clamped);
      speech?.setRate(clamped);
    },
    [setSpeechRate, speech],
  );
  const slower = useCallback(() => apply(rate - RATE_STEP), [apply, rate]);
  const faster = useCallback(() => apply(rate + RATE_STEP), [apply, rate]);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.sheet}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text accessibilityRole="header" allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={styles.title}>
            Settings
          </Text>

          <View
            accessible
            accessibilityRole="adjustable"
            accessibilityLabel="Speaking rate"
            accessibilityValue={{ text: formatRate(rate), min: SPEECH_RATE_MIN * 10, max: SPEECH_RATE_MAX * 10, now: Math.round(rate * 10) }}
            accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
            onAccessibilityAction={(e) => {
              if (e.nativeEvent.actionName === 'increment') faster();
              else if (e.nativeEvent.actionName === 'decrement') slower();
            }}
            style={styles.group}
          >
            <Text allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={styles.label}>
              Speaking rate
            </Text>
            <Text allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={styles.value}>
              {formatRate(rate)}
            </Text>
          </View>
          <View style={styles.row}>
            <Button label={SLOWER_LABEL} onPress={slower} disabled={rate <= SPEECH_RATE_MIN + 1e-6} style={styles.half} />
            <Button label={FASTER_LABEL} onPress={faster} disabled={rate >= SPEECH_RATE_MAX - 1e-6} style={styles.half} />
          </View>

          <View style={styles.switchRow}>
            <View style={styles.switchText}>
              <Text allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={styles.label}>
                {TRAINING_LABEL}
              </Text>
              <Text allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={styles.note}>
                Says the name of each vibration as it plays.
              </Text>
            </View>
            <Switch
              value={training}
              onValueChange={setTrainingMode}
              accessibilityRole="switch"
              accessibilityLabel={TRAINING_LABEL}
              trackColor={{ true: colors.talkHeld, false: colors.control }}
              thumbColor={colors.text}
            />
          </View>

          <View style={styles.group} accessible accessibilityLabel={`Headphones. ${HEADPHONE_NOTE}`}>
            <Text allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={styles.label}>
              Headphones
            </Text>
            <Text allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={styles.note}>
              {HEADPHONE_NOTE}
            </Text>
          </View>
        </ScrollView>
        <View style={styles.footer}>
          <Button label={CLOSE_LABEL} onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    paddingHorizontal: sizes.gutter,
    paddingTop: space.xxl,
    paddingBottom: space.xl,
    gap: space.l,
  },
  title: {
    ...type.hero,
    fontSize: 44,
    color: colors.text,
  },
  group: {
    gap: space.xs,
    paddingTop: space.s,
  },
  label: {
    ...type.body,
    fontWeight: '700',
    color: colors.text,
  },
  value: {
    ...type.body,
    color: colors.text,
    ...tabular,
  },
  note: {
    ...type.meta,
    fontWeight: '400',
    color: colors.meta,
    lineHeight: 22,
  },
  row: {
    flexDirection: 'row',
    gap: space.m,
  },
  half: {
    flex: 1,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.l,
    minHeight: sizes.secondaryHeight,
  },
  switchText: {
    flex: 1,
    gap: space.xs,
  },
  footer: {
    paddingHorizontal: sizes.gutter,
    paddingBottom: space.xxl,
    paddingTop: space.m,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
  },
});
