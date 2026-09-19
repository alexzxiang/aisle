/**
 * The transcript (DESIGN.md, "The transcript"): the last few lines of the
 * conversation, "You" and "Aisle", newest at the bottom, plus the two pills
 * that govern what Aisle says unasked: "Describe surroundings" (one
 * description now) and Quiet / Narrate (the standing narration).
 *
 * Rows come from the conversation log (`ConversationLogPort`); the panel is
 * a list to a screen reader and each row reads as "You: I need eggs" /
 * "Aisle: Eggs. Planning the route." The role word is printed, so who spoke
 * never rests on alignment or tint alone. A new row slides up on mount.
 *
 * The hero stays the only live region; a screen reader reaches the
 * transcript by moving to it, and app speech has already said every Aisle
 * line out loud.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Button } from './Button';
import { GlassPanel } from './Glass';
import { useMountIn, useResolvedReduceMotion } from './hooks';
import type { ConversationEntryLike, DescribeNow } from './ports';
import { colors, fontScaleCap, motion, sizes, space, type } from './theme';

export const TRANSCRIPT_LABEL = 'Conversation';
export const TRANSCRIPT_EMPTY = 'What you say, and what Aisle says, appears here.';
export const DESCRIBE_LABEL = 'Describe surroundings';
export const DESCRIBE_HINT = 'Aisle says what the camera sees right now';
/** The narration toggle: each label names what pressing it does, not the state it is in. */
export const QUIET_LABEL = 'Quiet';
export const NARRATE_LABEL = 'Narrate';
export const QUIET_HINT = 'Stops Aisle narrating the scene. Directions keep talking';
export const NARRATE_HINT = 'Lets Aisle narrate the scene again';
export const YOU_WORD = 'You';
export const AISLE_WORD = 'Aisle';
/**
 * How close to the bottom still counts as "following". A few pixels of slack
 * absorbs rounding and the mount animation's last frame, so an untouched list
 * keeps following itself.
 */
export const FOLLOW_BOTTOM_SLACK_PX = 24;

/** Whether the list is scrolled to (or within a hair of) its end. */
export function isNearBottom(
  m: Pick<NativeScrollEvent, 'layoutMeasurement' | 'contentOffset' | 'contentSize'>,
  slackPx: number = FOLLOW_BOTTOM_SLACK_PX,
): boolean {
  const remaining = m.contentSize.height - m.layoutMeasurement.height - m.contentOffset.y;
  return remaining <= slackPx;
}
/** Default cap: the whole log the conversation keeps (record keeping); screens that need a glance pass less. */
export const TRANSCRIPT_MAX = 50;

export interface TranscriptPanelProps {
  entries: readonly ConversationEntryLike[];
  /** How many of the newest lines to show. */
  max?: number;
  /** The describer's `describeNow`; the pill is hidden when absent. */
  onDescribe?: DescribeNow;
  /** Hide the pill (Home, where the camera is not running). */
  showDescribe?: boolean;
  /** Narration state (`describeSurroundings`); the Quiet pill is hidden without a setter. */
  narration?: boolean;
  onSetNarration?: (on: boolean) => void;
  style?: StyleProp<ViewStyle>;
  reduceMotion?: boolean;
  testID?: string;
}

export function roleWord(role: ConversationEntryLike['role']): string {
  return role === 'you' ? YOU_WORD : AISLE_WORD;
}

/** The newest `max` entries, oldest first (so the newest renders at the bottom). */
export function visibleEntries(entries: readonly ConversationEntryLike[], max: number = TRANSCRIPT_MAX): ConversationEntryLike[] {
  const n = Math.max(0, Math.floor(max));
  return entries.slice(Math.max(0, entries.length - n));
}

function Line({ entry, reduceMotion }: { entry: ConversationEntryLike; reduceMotion: boolean }): React.JSX.Element {
  const mountIn = useMountIn(reduceMotion, { durationMs: motion.lineInMs, slidePx: motion.lineSlidePx });
  const you = entry.role === 'you';
  const who = roleWord(entry.role);
  return (
    <Animated.View
      style={[styles.line, you ? styles.lineYou : styles.lineAisle, mountIn]}
      accessible
      accessibilityRole="text"
      accessibilityLabel={`${who}: ${entry.text}`}
    >
      <Text allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={styles.who}>
        {who}
      </Text>
      <Text allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={styles.text}>
        {entry.text}
      </Text>
    </Animated.View>
  );
}

export function TranscriptPanel(props: TranscriptPanelProps): React.JSX.Element {
  const { entries, max = TRANSCRIPT_MAX, onDescribe, showDescribe = true, narration = true, onSetNarration, style, testID } = props;
  const reduceMotion = useResolvedReduceMotion(props.reduceMotion);
  const visible = visibleEntries(entries, max);

  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const describe = useCallback(() => {
    if (!onDescribe || busy) return;
    setBusy(true);
    Promise.resolve()
      .then(async () => {
        await onDescribe();
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive.current) setBusy(false);
      });
  }, [onDescribe, busy]);

  const pill = showDescribe && onDescribe !== undefined;
  const quietPill = showDescribe && onSetNarration !== undefined;
  const toggleNarration = useCallback(() => onSetNarration?.(!narration), [onSetNarration, narration]);

  // Newest at the bottom, and the list follows it -- but only while the reader
  // is already there. Following unconditionally fought the reader: the
  // awareness loop adds a line every few seconds, and each one yanked the view
  // back to the bottom, so scrolling up to re-read something failed until the
  // narration happened to pause. Standard transcript behaviour instead: at the
  // bottom, follow; scrolled up, stay put and let the new lines pile below.
  const scroller = useRef<ScrollView | null>(null);
  const following = useRef(true);
  const touching = useRef(false);
  const moving = useRef(false);
  const lastId = visible.length > 0 ? visible[visible.length - 1].id : null;

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    following.current = isNearBottom(e.nativeEvent);
  }, []);

  const followIfAtBottom = useCallback((animated: boolean) => {
    if (!following.current || touching.current || moving.current) return;
    scroller.current?.scrollToEnd({ animated });
  }, []);

  useEffect(() => {
    if (lastId === null) return undefined;
    const id = setTimeout(() => followIfAtBottom(false), 30);
    return () => clearTimeout(id);
  }, [lastId, reduceMotion, followIfAtBottom]);

  return (
    <GlassPanel reduceMotion={reduceMotion} style={[styles.panel, style]} contentStyle={styles.content} testID={testID ?? 'transcript-panel'}>
      {/* The list owns every touch that lands on it, so a finger resting here while
          reading never reaches the hold-anywhere-to-talk layer behind the screen (which
          would open the microphone, freeze the UI for the audio-session switch and then
          say "No speech recorded"). A drag still hands over to the native scroll. */}
      <View style={styles.scrollHost} onStartShouldSetResponder={() => true} onResponderTerminationRequest={() => true} testID="transcript-touch-guard">
      <ScrollView
        ref={scroller}
        style={styles.scroll}
        contentContainerStyle={styles.list}
        accessibilityRole="list"
        accessibilityLabel={TRANSCRIPT_LABEL}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator
        onScroll={onScroll}
        onTouchStart={() => { touching.current = true; }}
        onTouchEnd={() => { touching.current = false; }}
        onTouchCancel={() => { touching.current = false; }}
        onScrollBeginDrag={() => { moving.current = true; }}
        onScrollEndDrag={() => { moving.current = false; }}
        onMomentumScrollBegin={() => { moving.current = true; }}
        onMomentumScrollEnd={() => { moving.current = false; }}
        scrollEventThrottle={64}
        onContentSizeChange={() => followIfAtBottom(false)}
      >
        {visible.length === 0 ? (
          <Text accessible accessibilityRole="text" allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={styles.empty}>
            {TRANSCRIPT_EMPTY}
          </Text>
        ) : (
          visible.map((e) => <Line key={e.id} entry={e} reduceMotion={reduceMotion} />)
        )}
      </ScrollView>
      </View>
      {pill || quietPill ? (
        <View style={styles.pillRow}>
          {pill ? (
            <Button label={DESCRIBE_LABEL} hint={DESCRIBE_HINT} onPress={describe} busy={busy} size="pill" reduceMotion={reduceMotion} testID="describe-pill" />
          ) : null}
          {quietPill ? (
            <Button
              label={narration ? QUIET_LABEL : NARRATE_LABEL}
              hint={narration ? QUIET_HINT : NARRATE_HINT}
              onPress={toggleNarration}
              selected={!narration}
              size="pill"
              reduceMotion={reduceMotion}
              testID="quiet-pill"
            />
          ) : null}
        </View>
      ) : null}
    </GlassPanel>
  );
}

const styles = StyleSheet.create({
  panel: {
    marginHorizontal: sizes.gutter,
  },
  content: {
    flex: 1,
    paddingHorizontal: space.l,
    paddingTop: space.m,
    paddingBottom: space.m,
    gap: space.m,
  },
  scrollHost: {
    flex: 1,
    minHeight: 0,
  },
  scroll: {
    flex: 1,
  },
  list: {
    flexGrow: 1,
    justifyContent: 'flex-end',
    gap: space.s,
  },
  empty: {
    ...type.meta,
    fontWeight: '500',
    color: colors.secondary,
    paddingVertical: space.s,
  },
  line: {
    maxWidth: '88%',
    borderRadius: sizes.radiusControl,
    paddingHorizontal: space.m,
    paddingVertical: space.s,
    gap: 2,
  },
  lineYou: {
    alignSelf: 'flex-end',
    backgroundColor: colors.youBubble,
    borderBottomRightRadius: 6,
  },
  lineAisle: {
    alignSelf: 'flex-start',
    backgroundColor: colors.white,
    borderBottomLeftRadius: 6,
  },
  who: {
    ...type.meta,
    fontWeight: '700',
    color: colors.secondary,
  },
  text: {
    ...type.body,
    color: colors.text,
  },
  pillRow: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
    flexWrap: 'wrap',
    gap: space.s,
  },
});
