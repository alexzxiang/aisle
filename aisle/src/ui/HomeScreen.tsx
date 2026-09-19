/**
 * Home: one question, "What do you need?", answered by voice or by a text
 * field (keyboard dictation is the zero-risk fallback that always ships,
 * 02 Task 7). Below it, practice and settings, then the three sentences the
 * first launch owes the user: disclaimer, privacy, walking-routes beta.
 */
import React, { useCallback, useState } from 'react';
import { Keyboard, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { StateBand } from './StateBand';
import { TalkButton } from './TalkButton';
import { Button } from './Button';
import { heroText, visibleError } from './derive';
import { useBus, useMode, useNow, useOptionalService, useStoreSlice, useUiFacts } from './hooks';
import { DISCLAIMER_TEXT, PRIVACY_TEXT, WALKING_BETA_FALLBACK, itemAcknowledgement, normalizeTypedItem } from './copy';
import type { VoicePort } from './ports';
import { colors, fontScaleCap, sizes, space, type } from './theme';

export const ITEM_FIELD_LABEL = 'What do you need';
export const ITEM_FIELD_PLACEHOLDER = 'For example, eggs';
export const FIND_LABEL = 'Find it';
export const PRACTICE_LABEL = 'Practice the vibrations';
export const SETTINGS_LABEL = 'Settings';
export const CANCEL_LABEL = 'Cancel';
export const PENDING_NOTE = 'Guidance starts when the route is ready.';

export interface HomeScreenProps {
  onOpenDebug?: () => void;
  onOpenSettings?: () => void;
  voice?: VoicePort;
  /** Google's walking-routes beta sentence; B supplies it, we display it. */
  betaNotice?: string;
  /** Tests: freeze the clock the error line's age is computed against. */
  now?: number;
  reduceMotion?: boolean;
}

export function HomeScreen(props: HomeScreenProps): React.JSX.Element {
  const { onOpenDebug, onOpenSettings, voice, betaNotice = WALKING_BETA_FALLBACK, now: nowOverride, reduceMotion } = props;
  const mode = useMode();
  const setMode = useStoreSlice((s) => s.setMode);
  const abort = useStoreSlice((s) => s.abort);
  const targetItem = useStoreSlice((s) => s.targetItem);
  const bus = useBus();
  const haptics = useOptionalService('haptics');
  const speech = useOptionalService('speech');
  const facts = useUiFacts();
  const now = useNow(1000, nowOverride);
  const [draft, setDraft] = useState('');

  const submit = useCallback(() => {
    const item = normalizeTypedItem(draft);
    if (item === null) return;
    Keyboard.dismiss();
    setDraft('');
    haptics?.play('CONFIRM');
    bus.emit({ type: 'ITEM_REQUESTED', item, source: 'keyboard' });
    // The keyboard path has no planner reply, so acknowledge here; the voice path speaks its own.
    const ack = itemAcknowledgement(item);
    if (ack && speech) speech.say({ text: ack, priority: 'NAV', dedupeKey: 'ui_item_ack', cooldownMs: 1000 });
  }, [draft, bus, haptics, speech]);

  const practice = useCallback(() => {
    setMode('ONBOARDING');
  }, [setMode]);

  // A request is in flight: the store holds the item while we wait for ROUTE_READY.
  const pending = mode === 'IDLE' && targetItem !== null;
  const hero = heroText(mode, facts, now, { item: targetItem, side: null });
  const error = visibleError(facts, now);

  return (
    <View style={styles.screen}>
      <StateBand mode={mode} hero={hero} onLongPressMode={onOpenDebug} reduceMotion={reduceMotion} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <View style={styles.fieldRow}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={submit}
            placeholder={ITEM_FIELD_PLACEHOLDER}
            placeholderTextColor={colors.meta}
            returnKeyType="done"
            autoCapitalize="none"
            autoCorrect
            accessibilityLabel={ITEM_FIELD_LABEL}
            accessibilityHint="Type or dictate the item you are looking for"
            allowFontScaling
            maxFontSizeMultiplier={fontScaleCap.body}
            style={styles.field}
          />
          <Button label={FIND_LABEL} onPress={submit} size="compact" disabled={normalizeTypedItem(draft) === null} style={styles.find} />
        </View>

        {error ? (
          <Text accessibilityRole="alert" allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={styles.error}>
            {error}
          </Text>
        ) : null}

        <TalkButton voice={voice} />

        {pending ? (
          <View style={styles.row}>
            <Text allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={[styles.detail, styles.half]}>
              {PENDING_NOTE}
            </Text>
            <Button label={CANCEL_LABEL} onPress={abort} size="compact" quiet hint="Drops this request" />
          </View>
        ) : null}

        <View style={styles.row}>
          <Button label={PRACTICE_LABEL} onPress={practice} hint="Replays the one-minute vibration lesson" style={styles.half} />
          <Button label={SETTINGS_LABEL} onPress={onOpenSettings} hint="Speaking rate, training mode, headphones" style={styles.half} />
        </View>

        <View style={styles.notes} accessibilityRole="summary">
          <Text allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={styles.note}>
            {DISCLAIMER_TEXT}
          </Text>
          <Text allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={styles.note}>
            {PRIVACY_TEXT}
          </Text>
          <Text allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={styles.note}>
            {betaNotice}
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingHorizontal: sizes.gutter,
    paddingTop: space.l,
    paddingBottom: space.xxl,
    gap: space.m,
  },
  fieldRow: {
    flexDirection: 'row',
    gap: space.s,
  },
  field: {
    flex: 1,
    minHeight: sizes.secondaryHeight,
    ...type.body,
    color: colors.text,
    backgroundColor: colors.control,
    borderRadius: sizes.radius,
    paddingHorizontal: space.l,
  },
  find: {
    minHeight: sizes.secondaryHeight,
  },
  row: {
    flexDirection: 'row',
    gap: space.m,
  },
  half: {
    flex: 1,
  },
  notes: {
    paddingTop: space.l,
    gap: space.s,
  },
  detail: {
    ...type.body,
    color: colors.text,
    alignSelf: 'center',
  },
  error: {
    ...type.body,
    color: colors.text,
    paddingVertical: space.s,
  },
  note: {
    ...type.meta,
    fontWeight: '400',
    color: colors.meta,
    lineHeight: 22,
  },
});
