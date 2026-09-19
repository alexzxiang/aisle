/**
 * The trip screen (DESIGN.md, Layout): state band / camera panel with the
 * perception strip / transcript with "Describe surroundings" / hold-to-talk /
 * Repeat + Stop guidance. It shows every mode from OUTDOOR_NAV to DONE; the
 * accent and hero come from the store's mode and the bus.
 *
 * "Stop guidance" is two taps or one two-second hold, never a single stray
 * tap -- it aborts the trip (02 Task 2: "big button hold 2 s"). With a screen
 * reader running the hold is gone (VoiceOver's activate delivers press-in and
 * press-out together), so the armed window is longer and announced.
 *
 * The conversation log and the describer arrive as props from the
 * composition root (`Root` forwards them); without them the transcript shows
 * its empty line and the pill is hidden.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { AccessibilityInfo, Platform, StyleSheet, View, useWindowDimensions } from 'react-native';
import { StateBand } from './StateBand';
import { CameraPanel, isCameraLive } from './CameraPanel';
import { ScenePanel } from './ScenePanel';
import { TranscriptPanel } from './TranscriptPanel';
import { TalkButton } from './TalkButton';
import { Button } from './Button';
import { Backdrop } from './Glass';
import { AWARENESS_STRIP_MODES, awarenessSlots, bandSignal, heroText, needsClock, showSceneLine, stripSlots } from './derive';
import { useBus, useConversationEntries, useMode, useNow, useOptionalService, useResolvedReduceMotion, useScreenReader, useStoreSlice, useUiFacts, useDetections } from './hooks';
import { assertUtterance } from './copy';
import type { ConversationLogPort, DescribeNow, VoicePort } from './ports';
import { accentFor, cameraMaxHeight, colors, sizes, space } from './theme';

export const STOP_HOLD_MS = 2000;
/** A first "Stop guidance" tap arms for this long; a second tap inside it aborts. */
export const STOP_ARM_MS = 5000;
/**
 * Armed window with a screen reader on. VoiceOver navigation between the two
 * taps costs swipes and a focus change, so five seconds disarms under the
 * user; the confirmation is explicit either way, so waiting longer is safe.
 */
export const STOP_ARM_SCREEN_READER_MS = 12000;
export const STOP_LABEL = 'Stop guidance';
export const STOP_ARMED_LABEL = 'Tap again to stop';
export const STOP_HINT = 'Tap twice, or hold for two seconds, to end guidance';
/** VoiceOver delivers press-in and press-out together, so hold never arrives: say so. */
export const STOP_HINT_SCREEN_READER = 'Double-tap, then double-tap again to end guidance';
export const REPEAT_LABEL = 'Repeat';
export const FINISH_LABEL = 'Finish';
/** Transcript lines on the trip screen. */
/** The whole log, scrollable (record keeping): the conversation keeps fifty lines. */
export const NAV_TRANSCRIPT_MAX = 50;
/**
 * The camera panel never takes more than this share of the window. Portrait since round 5;
 * 0.46 squeezed the transcript to its minimum during guided tasks ("can't see the chat"), so
 * the camera now stops at a third and the transcript keeps at least eight lines (round 6c).
 */
export const CAMERA_MAX_HEIGHT_SHARE = 0.34;
/**
 * Points the trip screen needs below the camera whatever the phone: the band,
 * the transcript at its minimum, the talk button and the two secondary
 * targets. On a short window the camera gives this back rather than pushing
 * the talk button off the bottom.
 */
export const CAMERA_RESERVE_PT = 550;

export interface NavScreenProps {
  onOpenDebug?: () => void;
  voice?: VoicePort;
  /** The conversation log (src/core/conversation.ts) the transcript follows. */
  conversation?: ConversationLogPort;
  /** The describer's `describeNow`; the "Describe surroundings" pill is hidden without it. */
  describeNow?: DescribeNow;
  /** Tests: freeze the clock the "seen n s ago" ages are computed against. */
  now?: number;
  reduceMotion?: boolean;
  /** Tests: force the screen-reader branch of "Stop guidance" without stubbing AccessibilityInfo. */
  screenReader?: boolean;
}

export function NavScreen(props: NavScreenProps): React.JSX.Element {
  const { onOpenDebug, voice, conversation, describeNow, now: nowOverride } = props;
  const reduceMotion = useResolvedReduceMotion(props.reduceMotion);
  const mode = useMode();
  const item = useStoreSlice((s) => s.targetItem);
  const side = useStoreSlice((s) => s.targetSide);
  const destinationOnly = useStoreSlice((s) => s.destinationOnly);
  const taskGoal = useStoreSlice((s) => s.taskGoal);
  const scene = useStoreSlice((s) => s.scene);
  const abort = useStoreSlice((s) => s.abort);
  const narration = useStoreSlice((s) => s.describeSurroundings);
  const setNarration = useStoreSlice((s) => s.setDescribeSurroundings);
  const facts = useUiFacts();
  // The awareness strip prints no ages, so outside those modes the clock has
  // nothing to advance unless a transient hero is waiting to expire.
  const showsAwareness = AWARENESS_STRIP_MODES.has(mode);
  const now = useNow(1000, nowOverride, (t) => needsClock(mode, facts, t, !showsAwareness));
  const bus = useBus();
  const speech = useOptionalService('speech');
  const haptics = useOptionalService('haptics');
  const entries = useConversationEntries(conversation);
  const { height: windowHeight } = useWindowDimensions();

  const signal = bandSignal(facts);
  const accent = accentFor(mode, signal);
  const hero = heroText(mode, facts, now, { item, side, destinationOnly, taskGoal });
  // Only the awareness strip renders detections; subscribing during the walk
  // re-rendered the whole screen twice a second for something never shown.
  const detections = useDetections(500, showsAwareness);
  // Walking and in the store the strip reports signal / vehicles / aisle; otherwise the room and the camera.
  const slots = showsAwareness ? awarenessSlots({ scene, cameraLive: isCameraLive(), detections }) : stripSlots(facts, now);

  // ---- Repeat: say the hero again, through the queue like everything else ----
  const repeat = useCallback(() => {
    if (!speech) return;
    try {
      assertUtterance(hero, 'NavScreen.repeat');
      speech.say({ text: hero, priority: 'NAV', dedupeKey: 'ui_repeat', cooldownMs: 1000 });
    } catch (err) {
      bus.emit({ type: 'ERROR', scope: 'ui', message: err instanceof Error ? err.message : String(err) });
    }
  }, [speech, hero, bus]);

  // ---- Stop guidance: arm, then confirm (or hold two seconds) ----
  // With VoiceOver on there is no hold gesture and the armed label is not
  // re-read on its own, so the window is longer and the change is announced.
  const systemScreenReader = useScreenReader();
  const screenReader = props.screenReader ?? systemScreenReader;
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return undefined;
    if (screenReader) AccessibilityInfo.announceForAccessibility(STOP_ARMED_LABEL);
    const id = setTimeout(() => setArmed(false), screenReader ? STOP_ARM_SCREEN_READER_MS : STOP_ARM_MS);
    return () => clearTimeout(id);
  }, [armed, screenReader]);

  const stopNow = useCallback(() => {
    setArmed(false);
    haptics?.play('CONFIRM');
    abort();
  }, [abort, haptics]);

  const onStopPress = useCallback(() => {
    if (armed) {
      stopNow();
      return;
    }
    setArmed(true);
  }, [armed, stopNow]);

  const isDone = mode === 'DONE';

  return (
    <View style={styles.screen}>
      <Backdrop accent={accent} reduceMotion={reduceMotion} />
      <StateBand
        mode={mode}
        hero={hero}
        signal={signal}
        onLongPressMode={onOpenDebug}
        reduceMotion={reduceMotion}
        style={styles.band}
      />
      <CameraPanel
        slots={slots}
        accent={accent}
        maxHeight={cameraMaxHeight(windowHeight, CAMERA_MAX_HEIGHT_SHARE, CAMERA_RESERVE_PT)}
        reduceMotion={reduceMotion}
        style={styles.camera}
      />
      {showSceneLine(mode, scene) ? <ScenePanel scene={scene} reduceMotion={reduceMotion} style={styles.scene} /> : null}
      <TranscriptPanel
        entries={entries}
        max={NAV_TRANSCRIPT_MAX}
        onDescribe={describeNow}
        narration={narration}
        onSetNarration={setNarration}
        reduceMotion={reduceMotion}
        style={styles.transcript}
      />
      <View style={styles.controls}>
        <View style={styles.row}>
          {mode === 'GUIDED_TASK' && voice?.submitText ? <Button label="Search again" size="compact" onPress={() => {
            void Promise.resolve(voice.submitText?.('search again')).catch((err: unknown) => bus.emit({ type: 'ERROR', scope: 'voice', message: err instanceof Error ? err.message : String(err) }));
          }} hint="Resumes a paused search from this area" reduceMotion={reduceMotion} style={styles.half} /> : null}
          <Button label="Stop speaking" size="compact" onPress={() => speech?.clearQueue()} hint="Stops the current spoken message" reduceMotion={reduceMotion} style={styles.half} />
        </View>
        <TalkButton voice={voice} reduceMotion={reduceMotion} />
        <View style={styles.row}>
          <Button
            label={REPEAT_LABEL}
            onPress={repeat}
            hint="Says the current instruction again"
            reduceMotion={reduceMotion}
            style={styles.half}
          />
          <Button
            label={isDone ? FINISH_LABEL : armed ? STOP_ARMED_LABEL : STOP_LABEL}
            onPress={isDone ? stopNow : onStopPress}
            onLongPress={screenReader ? undefined : stopNow}
            delayLongPress={screenReader ? undefined : STOP_HOLD_MS}
            hint={isDone ? 'Ends the trip' : screenReader ? STOP_HINT_SCREEN_READER : STOP_HINT}
            selected={armed}
            reduceMotion={reduceMotion}
            style={styles.half}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingTop: Platform.OS === 'ios' ? 60 : space.xl,
    gap: space.m,
  },
  band: {
    flexGrow: 0,
  },
  camera: {
    flexGrow: 0,
    flexShrink: 0,
  },
  scene: {
    flexGrow: 0,
    flexShrink: 0,
  },
  transcript: {
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 200,
  },
  controls: {
    paddingHorizontal: sizes.gutter,
    paddingTop: space.xs,
    paddingBottom: space.xl,
    gap: space.m,
  },
  row: {
    flexDirection: 'row',
    gap: space.m,
  },
  half: {
    flex: 1,
  },
});
