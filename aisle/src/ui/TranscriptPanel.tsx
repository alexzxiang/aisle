/**
 * The transcript (DESIGN.md, "The transcript"): the last few lines of the
 * conversation, "You" and "Aisle", newest at the bottom, plus the
 * "Describe surroundings" pill.
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
import { Animated, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Button } from './Button';
import { GlassPanel } from './Glass';
import { useMountIn, useResolvedReduceMotion } from './hooks';
import type { ConversationEntryLike, DescribeNow } from './ports';
import { colors, fontScaleCap, motion, sizes, space, type } from './theme';

export const TRANSCRIPT_LABEL = 'Conversation';
export const TRANSCRIPT_EMPTY = 'What you say, and what Aisle says, appears here.';
export const DESCRIBE_LABEL = 'Describe surroundings';
export const DESCRIBE_HINT = 'Aisle says what the camera sees right now';
export const YOU_WORD = 'You';
export const AISLE_WORD = 'Aisle';
export const TRANSCRIPT_MAX = 5;

export interface TranscriptPanelProps {
  entries: readonly ConversationEntryLike[];
  /** How many of the newest lines to show. */
  max?: number;
  /** The describer's `describeNow`; the pill is hidden when absent. */
  onDescribe?: DescribeNow;
  /** Hide the pill (Home, where the camera is not running). */
  showDescribe?: boolean;
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
  const { entries, max = TRANSCRIPT_MAX, onDescribe, showDescribe = true, style, testID } = props;
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

  return (
    <GlassPanel reduceMotion={reduceMotion} style={[styles.panel, style]} contentStyle={styles.content} testID={testID ?? 'transcript-panel'}>
      <View style={styles.list} accessibilityRole="list" accessibilityLabel={TRANSCRIPT_LABEL}>
        {visible.length === 0 ? (
          <Text accessible accessibilityRole="text" allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={styles.empty}>
            {TRANSCRIPT_EMPTY}
          </Text>
        ) : (
          visible.map((e) => <Line key={e.id} entry={e} reduceMotion={reduceMotion} />)
        )}
      </View>
      {pill ? (
        <View style={styles.pillRow}>
          <Button label={DESCRIBE_LABEL} hint={DESCRIBE_HINT} onPress={describe} busy={busy} size="pill" reduceMotion={reduceMotion} testID="describe-pill" />
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
  list: {
    flex: 1,
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
  },
});
