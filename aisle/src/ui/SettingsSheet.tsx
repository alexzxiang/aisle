/**
 * Settings: speaking rate, training mode, describe surroundings, the
 * open-ear headphones note.
 *
 * The rate control is a VoiceOver "adjustable" with increment / decrement
 * actions plus two plain buttons, which is the accessible form of a slider
 * without a native slider dependency. Values land in the store; the
 * SpeechService follows the store (02 Task 4), so nothing here calls it.
 *
 * "Describe surroundings" is the store's `describeSurroundings` flag (A-core
 * persists it under the same pref key, default true). It is read and written
 * by name so the sheet compiles and works before that field is declared: the
 * store's setter is used when present, a plain merge otherwise.
 */
import React, { useCallback } from 'react';
import { Modal, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { Button } from './Button';
import { GlassPanel } from './Glass';
import { useAppServiceStore, useOptionalService, useResolvedReduceMotion, useStoreSlice } from './hooks';
import { SPEECH_RATE_MAX, SPEECH_RATE_MIN } from '../core/store';
import { HEADPHONE_NOTE } from './copy';
import { accents, colors, fontScaleCap, sizes, space, tabular, type } from './theme';

export const RATE_STEP = 0.1;
export const SLOWER_LABEL = 'Slower';
export const FASTER_LABEL = 'Faster';
export const TRAINING_LABEL = 'Training mode';
export const TRAINING_NOTE = 'Says the name of each vibration as it plays.';
export const DESCRIBE_SETTING_LABEL = 'Describe surroundings';
export const DESCRIBE_SETTING_NOTE = 'Aisle describes what the camera sees when the scene changes.';
export const CLOSE_LABEL = 'Close settings';
export const DESCRIBE_PREF_KEY = 'describeSurroundings';

export function formatRate(rate: number): string {
  return `${rate.toFixed(1)}×`;
}

interface DescribeSlice {
  describeSurroundings?: boolean;
  setDescribeSurroundings?: (v: boolean) => void;
}

export interface SettingsSheetProps {
  visible: boolean;
  onClose: () => void;
  reduceMotion?: boolean;
}

export function SettingsSheet({ visible, onClose, reduceMotion: reduceMotionProp }: SettingsSheetProps): React.JSX.Element {
  const reduceMotion = useResolvedReduceMotion(reduceMotionProp);
  const store = useAppServiceStore();
  const rate = useStoreSlice((s) => s.speechRate);
  const setSpeechRate = useStoreSlice((s) => s.setSpeechRate);
  const training = useStoreSlice((s) => s.trainingMode);
  const setTrainingMode = useStoreSlice((s) => s.setTrainingMode);
  const describe = useStoreSlice((s) => (s as unknown as DescribeSlice).describeSurroundings ?? true);
  const speech = useOptionalService('speech');

  const setDescribe = useCallback(
    (v: boolean) => {
      const st = store.getState() as unknown as DescribeSlice;
      if (typeof st.setDescribeSurroundings === 'function') st.setDescribeSurroundings(v);
      else (store.setState as unknown as (partial: Record<string, unknown>) => void)({ [DESCRIBE_PREF_KEY]: v });
    },
    [store],
  );

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
    <Modal visible={visible} animationType={reduceMotion ? 'none' : 'slide'} presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.sheet}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text accessibilityRole="header" allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={styles.title}>
            Settings
          </Text>

          <GlassPanel reduceMotion={reduceMotion} contentStyle={styles.card}>
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
              style={styles.rateRow}
            >
              <Text allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={styles.label}>
                Speaking rate
              </Text>
              <Text allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={styles.value}>
                {formatRate(rate)}
              </Text>
            </View>
            <View style={styles.row}>
              <Button label={SLOWER_LABEL} onPress={slower} disabled={rate <= SPEECH_RATE_MIN + 1e-6} reduceMotion={reduceMotion} style={styles.half} />
              <Button label={FASTER_LABEL} onPress={faster} disabled={rate >= SPEECH_RATE_MAX - 1e-6} reduceMotion={reduceMotion} style={styles.half} />
            </View>
          </GlassPanel>

          <GlassPanel reduceMotion={reduceMotion} contentStyle={styles.card}>
            <View style={styles.switchRow}>
              <View style={styles.switchText}>
                <Text allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={styles.label}>
                  {TRAINING_LABEL}
                </Text>
                <Text allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={styles.note}>
                  {TRAINING_NOTE}
                </Text>
              </View>
              <Switch
                value={training}
                onValueChange={setTrainingMode}
                accessibilityRole="switch"
                accessibilityLabel={TRAINING_LABEL}
                trackColor={{ true: accents.outdoor, false: colors.hairline }}
                thumbColor={colors.white}
              />
            </View>
            <View style={styles.divider} />
            <View style={styles.switchRow}>
              <View style={styles.switchText}>
                <Text allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={styles.label}>
                  {DESCRIBE_SETTING_LABEL}
                </Text>
                <Text allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={styles.note}>
                  {DESCRIBE_SETTING_NOTE}
                </Text>
              </View>
              <Switch
                value={describe}
                onValueChange={setDescribe}
                accessibilityRole="switch"
                accessibilityLabel={DESCRIBE_SETTING_LABEL}
                trackColor={{ true: accents.outdoor, false: colors.hairline }}
                thumbColor={colors.white}
                testID="describe-switch"
              />
            </View>
          </GlassPanel>

          <GlassPanel reduceMotion={reduceMotion} contentStyle={styles.card} accessible accessibilityLabel={`Headphones. ${HEADPHONE_NOTE}`}>
            <Text allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={styles.label}>
              Headphones
            </Text>
            <Text allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={styles.note}>
              {HEADPHONE_NOTE}
            </Text>
          </GlassPanel>
        </ScrollView>
        <View style={styles.footer}>
          <Button label={CLOSE_LABEL} onPress={onClose} reduceMotion={reduceMotion} />
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
    color: colors.text,
    paddingHorizontal: space.xs,
  },
  card: {
    paddingHorizontal: space.l,
    paddingVertical: space.l,
    gap: space.m,
  },
  rateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: sizes.minTarget,
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
    color: colors.secondary,
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
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.hairline,
  },
  footer: {
    paddingHorizontal: sizes.gutter,
    paddingBottom: space.xxl,
    paddingTop: space.m,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
  },
});
