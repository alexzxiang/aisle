/** Camera-first guidance with conversation below and a hold-to-talk dock. */
import React from 'react';
import { Platform, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { StateBand } from './StateBand';
import { CameraPanel, isCameraLive } from './CameraPanel';
import { ScenePanel } from './ScenePanel';
import { TranscriptPanel } from './TranscriptPanel';
import { TalkButton } from './TalkButton';
import { Backdrop } from './Glass';
import { AWARENESS_STRIP_MODES, awarenessSlots, bandSignal, heroText, needsClock, showSceneLine, stripSlots } from './derive';
import { useConversationEntries, useMode, useNow, useResolvedReduceMotion, useStoreSlice, useUiFacts, useDetections } from './hooks';
import { parseMissionGoal } from '../core/itemMission';
import type { ConversationLogPort, DescribeNow, VoicePort } from './ports';
import { accentFor, cameraMaxHeight, colors, sizes, space } from './theme';

/** The whole conversation remains available by scrolling. */
export const NAV_TRANSCRIPT_MAX = 50;
/**
 * Larger viewfinder in the upper scroll area; the talk/chat dock remains independent.
 */
export const CAMERA_MAX_HEIGHT_SHARE = 0.6;
/** Reserve space for the task header and talk dock. */
export const CAMERA_RESERVE_PT = 280;

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
  const narration = useStoreSlice((s) => s.describeSurroundings);
  const setNarration = useStoreSlice((s) => s.setDescribeSurroundings);
  const facts = useUiFacts();
  // The awareness strip prints no ages, so outside those modes the clock has
  // nothing to advance unless a transient hero is waiting to expire.
  const showsAwareness = AWARENESS_STRIP_MODES.has(mode);
  const now = useNow(1000, nowOverride, (t) => needsClock(mode, facts, t, !showsAwareness));
  const entries = useConversationEntries(conversation);
  const { height: windowHeight, fontScale } = useWindowDimensions();
  // Large text and landscape need one scroll surface, including the controls.
  const scrollControls = windowHeight < 600 || fontScale > 1.3;

  const signal = bandSignal(facts);
  const accent = accentFor(mode, signal);
  const hero = heroText(mode, facts, now, { item, side, destinationOnly, taskGoal });
  // Only the awareness strip renders detections; subscribing during the walk
  // re-rendered the whole screen twice a second for something never shown.
  const detections = useDetections(500, showsAwareness);
  // Walking and in the store the strip reports signal / vehicles / aisle; otherwise the room and the camera.
  const slots = showsAwareness ? awarenessSlots({ scene, cameraLive: isCameraLive(), detections }) : stripSlots(facts, now);

  const controls = (
    <View style={styles.controls}>
      <TalkButton voice={voice} reduceMotion={reduceMotion} />
    </View>
  );

  return (
    <View style={styles.screen}>
      <Backdrop accent={accent} reduceMotion={reduceMotion} />
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content} testID="guidance-scroll" nestedScrollEnabled>
      <View style={{ minHeight: Math.max(280, windowHeight - (scrollControls ? 80 : 370)), gap: space.m }} testID="search-overview">
      {mode === 'GUIDED_TASK' ? <StateBand mode={mode} modeWord="Task"
        hero={parseMissionGoal(taskGoal ?? '')?.item ?? taskGoal ?? item ?? 'Find an item'}
        instruction={hero} onLongPressMode={onOpenDebug} reduceMotion={reduceMotion} style={styles.band} /> : null}
      {showSceneLine(mode, scene) ? <ScenePanel scene={scene} reduceMotion={reduceMotion} style={styles.scene} /> : null}
      {mode !== 'GUIDED_TASK' ? <StateBand
        mode={mode}
        hero={hero}
        signal={signal}
        onLongPressMode={onOpenDebug}
        reduceMotion={reduceMotion}
        style={styles.band}
      /> : null}
      <CameraPanel
        slots={slots}
        accent={accent}
        maxHeight={cameraMaxHeight(windowHeight, CAMERA_MAX_HEIGHT_SHARE, CAMERA_RESERVE_PT)}
        reduceMotion={reduceMotion}
        style={styles.camera}
      />
      {scrollControls ? controls : null}
      </View>
      <TranscriptPanel entries={entries} max={NAV_TRANSCRIPT_MAX} onDescribe={describeNow}
        narration={narration} onSetNarration={setNarration} reduceMotion={reduceMotion} style={styles.transcript} />
      </ScrollView>
      {scrollControls ? null : controls}
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
    height: 160,
    marginHorizontal: 0,
    flexShrink: 0,
  },
  scroll: {
    flex: 1,
  },
  content: {
    gap: space.m,
    paddingBottom: space.m,
  },
  controls: {
    paddingHorizontal: sizes.gutter,
    paddingTop: space.xs,
    paddingBottom: space.xl,
    gap: space.m,
    backgroundColor: colors.bg,
    borderTopWidth: 1,
    borderTopColor: colors.hairline,
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
});
