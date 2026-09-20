/**
 * Home: one question, "What do you need?", answered by voice or by a text
 * field. Camera and task sit above a thumb-accessible talk/chat/type dock.
 * Small screens and large text use a single scroll surface.
 */
import React, { useCallback, useState } from 'react';
import { Keyboard, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { CameraPanel, isCameraLive } from './CameraPanel';
import { ScenePanel } from './ScenePanel';
import { StateBand } from './StateBand';
import { TalkButton } from './TalkButton';
import { TranscriptPanel } from './TranscriptPanel';
import { Button } from './Button';
import { Backdrop, GlassPanel } from './Glass';
import { awarenessSlots, heroText, needsClock, visibleError } from './derive';
import { useBus, useConversationEntries, useDetections, useMode, useNow, useOptionalService, useResolvedReduceMotion, useStoreSlice, useUiFacts } from './hooks';
import {
  PRIVACY_TEXT,
  SAY_CARD_EXAMPLES,
  SAY_CARD_NOTE,
  SAY_CARD_TITLE,
  itemAcknowledgement,
  normalizeTypedItem,
} from './copy';
import type { ConversationLogPort, VoicePort } from './ports';
import { accentFor, cameraMaxHeight, colors, fontScaleCap, sizes, space, type } from './theme';

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

/** Large viewfinder in the scroll area above the independent talk/chat/type dock. */
export const HOME_CAMERA_MAX_HEIGHT_SHARE = 0.6;
/**
 * Reserve room on short windows; the upper area scrolls independently of the dock.
 */
export const HOME_CAMERA_RESERVE_PT = 280;

export function HomeScreen(props: HomeScreenProps): React.JSX.Element {
  const { onOpenDebug, voice, conversation, now: nowOverride } = props;
  const reduceMotion = useResolvedReduceMotion(props.reduceMotion);
  const mode = useMode();
  const abort = useStoreSlice((s) => s.abort);
  const targetItem = useStoreSlice((s) => s.targetItem);
  const destinationOnly = useStoreSlice((s) => s.destinationOnly);
  const scene = useStoreSlice((s) => s.scene);
  const { height: windowHeight, fontScale } = useWindowDimensions();
  const scrollControls = windowHeight < 600 || fontScale > 1.3;
  const bus = useBus();
  const haptics = useOptionalService('haptics');
  const speech = useOptionalService('speech');
  const facts = useUiFacts();
  // Home shows the awareness strip, which prints no ages: the clock is needed
  // only to retire an error line or a transient hero.
  const now = useNow(1000, nowOverride, (t) => needsClock(mode, facts, t, false));
  const entries = useConversationEntries(conversation);
  const [draft, setDraft] = useState('');

  const submit = useCallback(() => {
    const item = normalizeTypedItem(draft);
    if (item === null) return;
    Keyboard.dismiss();
    setDraft('');
    haptics?.play('CONFIRM');
    if (voice?.submitText) {
      void Promise.resolve(voice.submitText(item)).catch((err: unknown) => {
        bus.emit({ type: 'ERROR', scope: 'voice', message: err instanceof Error ? err.message : String(err) });
      });
      return;
    }
    bus.emit({ type: 'ITEM_REQUESTED', item, source: 'keyboard' });
    // The keyboard path has no planner reply, so acknowledge here; the voice path speaks its own.
    const ack = itemAcknowledgement(item);
    if (ack && speech) speech.say({ text: ack, priority: 'NAV', dedupeKey: 'ui_item_ack', cooldownMs: 1000 });
  }, [draft, bus, haptics, speech, voice]);

  // A request is in flight: the store holds the item while we wait for ROUTE_READY.
  const pending = mode === 'IDLE' && targetItem !== null;
  const hero = heroText(mode, facts, now, { item: targetItem, side: null, destinationOnly });
  const error = visibleError(facts, now);
  const accent = accentFor(mode);
  const detections = useDetections();
  const slots = awarenessSlots({ scene, cameraLive: isCameraLive(), detections });

  const typedRequest = (
    <View style={styles.controls}>
      <Text allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={styles.sectionLabel}>Type your request</Text>
      <GlassPanel reduceMotion={reduceMotion} contentStyle={styles.fieldRow}>
        <TextInput value={draft} onChangeText={setDraft} onSubmitEditing={submit}
          placeholder={ITEM_FIELD_PLACEHOLDER} placeholderTextColor={colors.placeholder}
          returnKeyType="done" autoCapitalize="none" autoCorrect
          accessibilityLabel={ITEM_FIELD_LABEL} accessibilityHint="Type or dictate the item you are looking for"
          allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={styles.field} />
        <Button label={FIND_LABEL} onPress={submit} size="compact" primary
          disabled={normalizeTypedItem(draft) === null} reduceMotion={reduceMotion} style={styles.find} />
      </GlassPanel>
    </View>
  );

  const controls = <View style={styles.controls}><TalkButton voice={voice} reduceMotion={reduceMotion} /></View>;

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Backdrop accent={accent} reduceMotion={reduceMotion} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        automaticallyAdjustKeyboardInsets
      >
        <View style={{ minHeight: Math.max(280, windowHeight - (scrollControls ? 80 : 370)), gap: space.m }}>
        <StateBand mode={mode} modeWord="Task" hero={targetItem ?? 'Choose an item'}
          instruction={hero} onLongPressMode={onOpenDebug} reduceMotion={reduceMotion} style={styles.scene} />
        <ScenePanel scene={scene} reduceMotion={reduceMotion} style={styles.scene} />
        <CameraPanel slots={slots} accent={accent}
          maxHeight={cameraMaxHeight(windowHeight, HOME_CAMERA_MAX_HEIGHT_SHARE, HOME_CAMERA_RESERVE_PT)}
          reduceMotion={reduceMotion} style={styles.camera} />

        {error ? (
          <Text accessibilityRole="alert" allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={styles.error}>
            {error}
          </Text>
        ) : null}

        {pending ? (
          <GlassPanel reduceMotion={reduceMotion} contentStyle={styles.pendingRow}>
            <Text allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={[styles.detail, styles.half]}>
              {PENDING_NOTE}
            </Text>
            <Button label={CANCEL_LABEL} onPress={abort} size="compact" quiet hint="Drops this request" reduceMotion={reduceMotion} />
          </GlassPanel>
        ) : null}

        {entries.length === 0 ? (
          <GlassPanel
            reduceMotion={reduceMotion}
            contentStyle={styles.sayCard}
            accessible
            accessibilityRole="summary"
            accessibilityLabel={`${SAY_CARD_TITLE}: ${SAY_CARD_EXAMPLES.join('. ')}. ${SAY_CARD_NOTE}`}
            testID="say-card"
          >
            <Text allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={styles.sayTitle}>
              {SAY_CARD_TITLE}
            </Text>
            {SAY_CARD_EXAMPLES.map((example) => (
              <Text key={example} allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={styles.sayExample}>
                {`“${example}”`}
              </Text>
            ))}
            <Text allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={styles.note}>
              {SAY_CARD_NOTE}
            </Text>
          </GlassPanel>
        ) : null}

        {scrollControls ? controls : null}
        </View>
        <TranscriptPanel entries={entries} max={HOME_TRANSCRIPT_MAX} showDescribe={false} reduceMotion={reduceMotion} style={styles.transcript} />
        {typedRequest}
        <Text style={styles.note}>{PRIVACY_TEXT}</Text>
      </ScrollView>
      {scrollControls ? null : controls}
    </KeyboardAvoidingView>
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
    flexGrow: 1,
    paddingHorizontal: sizes.gutter,
    paddingTop: space.m,
    paddingBottom: space.xxl,
    gap: space.m,
  },
  fieldRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.s,
    padding: space.s,
  },
  field: {
    flex: 1,
    minWidth: 150,
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
    flexWrap: 'wrap',
    gap: space.m,
  },
  half: {
    flex: 1,
    minWidth: 140,
  },
  transcript: {
    marginHorizontal: 0,
    height: 160,
  },
  controls: {
    paddingHorizontal: sizes.gutter,
    paddingBottom: space.l,
    gap: space.s,
  },
  sectionLabel: {
    ...type.meta,
    color: colors.secondary,
    marginTop: space.s,
    paddingHorizontal: space.xs,
  },
  scene: {
    marginHorizontal: 0,
  },
  sayCard: {
    paddingHorizontal: space.l,
    paddingVertical: space.l,
    gap: space.xs,
  },
  sayTitle: {
    ...type.meta,
    fontWeight: '700',
    color: colors.secondary,
    paddingBottom: space.xs,
  },
  sayExample: {
    ...type.body,
    fontWeight: '600',
    color: colors.text,
  },
  camera: {
    marginHorizontal: 0,
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
