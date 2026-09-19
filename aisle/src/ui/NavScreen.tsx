/**
 * The trip screen (DESIGN.md, Layout): state band / camera panel with the
 * perception strip / transcript with "Describe surroundings" / hold-to-talk /
 * Repeat + Stop guidance. It shows every mode from OUTDOOR_NAV to DONE; the
 * accent and hero come from the store's mode and the bus.
 *
 * "Stop guidance" is two taps or one two-second hold, never a single stray
 * tap -- it aborts the trip (02 Task 2: "big button hold 2 s").
 *
 * The conversation log and the describer arrive as props from the
 * composition root (`Root` forwards them); without them the transcript shows
 * its empty line and the pill is hidden.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Platform, StyleSheet, View, useWindowDimensions } from 'react-native';
import { StateBand } from './StateBand';
import { CameraPanel, isCameraLive } from './CameraPanel';
import { ScenePanel } from './ScenePanel';
import { TranscriptPanel } from './TranscriptPanel';
import { TalkButton } from './TalkButton';
import { Button } from './Button';
import { Backdrop } from './Glass';
import { AWARENESS_STRIP_MODES, awarenessSlots, bandSignal, heroText, stripSlots } from './derive';
import { useBus, useConversationEntries, useMode, useNow, useOptionalService, useResolvedReduceMotion, useStoreSlice, useUiFacts, useDetections } from './hooks';
import { assertUtterance } from './copy';
import type { ConversationLogPort, DescribeNow, VoicePort } from './ports';
import { accentFor, colors, sizes, space } from './theme';

export const STOP_HOLD_MS = 2000;
/** A first "Stop guidance" tap arms for this long; a second tap inside it aborts. */
export const STOP_ARM_MS = 5000;
export const STOP_LABEL = 'Stop guidance';
export const STOP_ARMED_LABEL = 'Tap again to stop';
export const REPEAT_LABEL = 'Repeat';
export const FINISH_LABEL = 'Finish';
/** Transcript lines on the trip screen. */
export const NAV_TRANSCRIPT_MAX = 4;
/** The camera panel never takes more than this share of the window. */
export const CAMERA_MAX_HEIGHT_SHARE = 0.34;

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
  const facts = useUiFacts();
  const now = useNow(1000, nowOverride);
  const bus = useBus();
  const speech = useOptionalService('speech');
  const haptics = useOptionalService('haptics');
  const entries = useConversationEntries(conversation);
  const { height: windowHeight } = useWindowDimensions();

  const signal = bandSignal(facts);
  const accent = accentFor(mode, signal);
  const hero = heroText(mode, facts, now, { item, side, destinationOnly, taskGoal });
  const detections = useDetections();
  // Walking and in the store the strip reports signal / vehicles / aisle; otherwise the room and the camera.
  const slots = AWARENESS_STRIP_MODES.has(mode) ? awarenessSlots({ scene, cameraLive: isCameraLive(), detections }) : stripSlots(facts, now);

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
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return undefined;
    const id = setTimeout(() => setArmed(false), STOP_ARM_MS);
    return () => clearTimeout(id);
  }, [armed]);

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
      <CameraPanel slots={slots} accent={accent} maxHeight={Math.round(windowHeight * CAMERA_MAX_HEIGHT_SHARE)} reduceMotion={reduceMotion} style={styles.camera} />
      {mode === 'GUIDED_TASK' || mode === 'DONE' ? <ScenePanel scene={scene} reduceMotion={reduceMotion} style={styles.scene} /> : null}
      <TranscriptPanel
        entries={entries}
        max={NAV_TRANSCRIPT_MAX}
        onDescribe={describeNow}
        reduceMotion={reduceMotion}
        style={styles.transcript}
      />
      <View style={styles.controls}>
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
            onLongPress={stopNow}
            delayLongPress={STOP_HOLD_MS}
            hint={isDone ? 'Ends the trip' : 'Tap twice, or hold for two seconds, to end guidance'}
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
    minHeight: 96,
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
