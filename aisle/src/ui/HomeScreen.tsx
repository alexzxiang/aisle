/**
 * Home: one question, "What do you need?", answered by voice or by a text
 * field (keyboard dictation is the zero-risk fallback that always ships,
 * 02 Task 7). Below it, practice and settings, the conversation so far, then
 * the three sentences the first launch owes the user: disclaimer, privacy,
 * walking-routes beta.
 */
import React, { useCallback, useState } from 'react';
import { Keyboard, Platform, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { CameraPanel, isCameraLive } from './CameraPanel';
import { ScenePanel } from './ScenePanel';
import { StateBand } from './StateBand';
import { TalkButton } from './TalkButton';
import { TranscriptPanel } from './TranscriptPanel';
import { Button } from './Button';
import { Backdrop, GlassPanel } from './Glass';
import { awarenessSlots, heroText, visibleError } from './derive';
import { useBus, useConversationEntries, useDetections, useMode, useNow, useOptionalService, useResolvedReduceMotion, useStoreSlice, useUiFacts } from './hooks';
import { DISCLAIMER_TEXT, PRIVACY_TEXT, WALKING_BETA_FALLBACK, itemAcknowledgement, normalizeTypedItem } from './copy';
import type { ConversationLogPort, VoicePort } from './ports';
import { accentFor, colors, fontScaleCap, sizes, space, type } from './theme';

export const ITEM_FIELD_LABEL = 'What do you need';
export const ITEM_FIELD_PLACEHOLDER = 'For example, eggs';
export const FIND_LABEL = 'Find it';
export const PRACTICE_LABEL = 'Practice the vibrations';
export const SETTINGS_LABEL = 'Settings';
export const CANCEL_LABEL = 'Cancel';
export const PENDING_NOTE = 'Guidance starts when the route is ready.';
export const HOME_TRANSCRIPT_MAX = 50;

export interface HomeScreenProps {
  onOpenDebug?: () => void;
  onOpenSettings?: () => void;
  voice?: VoicePort;
  /** The conversation log; the last lines show once there are any. */
  conversation?: ConversationLogPort;
  /** Google's walking-routes beta sentence; B supplies it, we display it. */
  betaNotice?: string;
  /** Tests: freeze the clock the error line's age is computed against. */
  now?: number;
  reduceMotion?: boolean;
}

/** The Home camera is a viewfinder, not the page: about a quarter of the window at most. */
export const HOME_CAMERA_MAX_HEIGHT_SHARE = 0.42;

export function HomeScreen(props: HomeScreenProps): React.JSX.Element {
  const { onOpenDebug, onOpenSettings, voice, conversation, betaNotice = WALKING_BETA_FALLBACK, now: nowOverride } = props;
  const reduceMotion = useResolvedReduceMotion(props.reduceMotion);
  const mode = useMode();
  const setMode = useStoreSlice((s) => s.setMode);
  const abort = useStoreSlice((s) => s.abort);
  const targetItem = useStoreSlice((s) => s.targetItem);
  const destinationOnly = useStoreSlice((s) => s.destinationOnly);
  const scene = useStoreSlice((s) => s.scene);
  const { height: windowHeight } = useWindowDimensions();
  const bus = useBus();
  const haptics = useOptionalService('haptics');
  const speech = useOptionalService('speech');
  const facts = useUiFacts();
  const now = useNow(1000, nowOverride);
  const entries = useConversationEntries(conversation);
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
  const hero = heroText(mode, facts, now, { item: targetItem, side: null, destinationOnly });
  const error = visibleError(facts, now);
  const accent = accentFor(mode);
  const detections = useDetections();
  const slots = awarenessSlots({ scene, cameraLive: isCameraLive(), detections });

  return (
    <View style={styles.screen}>
      <Backdrop accent={accent} reduceMotion={reduceMotion} />
      <StateBand mode={mode} hero={hero} onLongPressMode={onOpenDebug} reduceMotion={reduceMotion} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        {/* The camera is up from launch (the awareness loop): show it, and what the app makes of it. */}
        <CameraPanel slots={slots} accent={accent} maxHeight={Math.round(windowHeight * HOME_CAMERA_MAX_HEIGHT_SHARE)} reduceMotion={reduceMotion} style={styles.camera} />
        <ScenePanel scene={scene} reduceMotion={reduceMotion} />

        <GlassPanel reduceMotion={reduceMotion} contentStyle={styles.fieldRow}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={submit}
            placeholder={ITEM_FIELD_PLACEHOLDER}
            placeholderTextColor={colors.placeholder}
            returnKeyType="done"
            autoCapitalize="none"
            autoCorrect
            accessibilityLabel={ITEM_FIELD_LABEL}
            accessibilityHint="Type or dictate the item you are looking for"
            allowFontScaling
            maxFontSizeMultiplier={fontScaleCap.body}
            style={styles.field}
          />
          <Button label={FIND_LABEL} onPress={submit} size="compact" primary disabled={normalizeTypedItem(draft) === null} reduceMotion={reduceMotion} style={styles.find} />
        </GlassPanel>

        {error ? (
          <Text accessibilityRole="alert" allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={styles.error}>
            {error}
          </Text>
        ) : null}

        <TalkButton voice={voice} reduceMotion={reduceMotion} />

        {pending ? (
          <GlassPanel reduceMotion={reduceMotion} contentStyle={styles.pendingRow}>
            <Text allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={[styles.detail, styles.half]}>
              {PENDING_NOTE}
            </Text>
            <Button label={CANCEL_LABEL} onPress={abort} size="compact" quiet hint="Drops this request" reduceMotion={reduceMotion} />
          </GlassPanel>
        ) : null}

        <View style={styles.row}>
          <Button label={PRACTICE_LABEL} onPress={practice} hint="Replays the one-minute vibration lesson" reduceMotion={reduceMotion} style={styles.half} />
          <Button label={SETTINGS_LABEL} onPress={onOpenSettings} hint="Speaking rate, training mode, describing, headphones" reduceMotion={reduceMotion} style={styles.half} />
        </View>

        {entries.length > 0 ? (
          <TranscriptPanel entries={entries} max={HOME_TRANSCRIPT_MAX} showDescribe={false} reduceMotion={reduceMotion} style={styles.transcript} />
        ) : null}

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
    paddingTop: Platform.OS === 'ios' ? 60 : space.xl,
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingHorizontal: sizes.gutter,
    paddingTop: space.m,
    paddingBottom: space.xxl,
    gap: space.m,
  },
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s,
    padding: space.s,
  },
  field: {
    flex: 1,
    minHeight: sizes.secondaryHeight,
    ...type.body,
    color: colors.text,
    backgroundColor: colors.field,
    borderRadius: sizes.radiusControl,
    paddingHorizontal: space.l,
  },
  find: {
    minHeight: sizes.secondaryHeight,
  },
  pendingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.m,
    paddingVertical: space.s,
    paddingHorizontal: space.l,
  },
  row: {
    flexDirection: 'row',
    gap: space.m,
  },
  half: {
    flex: 1,
  },
  transcript: {
    marginHorizontal: 0,
  },
  camera: {
    flexGrow: 0,
    flexShrink: 0,
  },
  notes: {
    paddingTop: space.l,
    paddingHorizontal: space.xs,
    gap: space.s,
  },
  detail: {
    ...type.body,
    color: colors.text,
  },
  error: {
    ...type.body,
    color: colors.text,
    paddingVertical: space.s,
    paddingHorizontal: space.xs,
  },
  note: {
    ...type.meta,
    fontWeight: '400',
    color: colors.secondary,
  },
});
