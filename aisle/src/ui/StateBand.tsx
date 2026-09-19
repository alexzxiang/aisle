/**
 * The state band: the one memorable element (src/ui/DESIGN.md, "The band").
 *
 * An accent-tinted glass panel, colour-coded by mode (and by signal state
 * while crossing), with the mode word above and the current instruction as
 * the hero. The hero is the single live region in the app, so a screen reader
 * announces exactly one changing thing. The accent cross-fades over 250 ms on
 * a mode or signal change (inside `GlassPanel`), skipped under reduce-motion.
 *
 * Screen readers (DESIGN.md rule 9): `accessibilityLiveRegion` is honoured by
 * TalkBack only. On iOS the app's own speech carries the meaning, and reading
 * every hero on top of it would be the double-speaking 08 warns about (R22).
 * So with VoiceOver on, a hero change is announced through
 * `announceForAccessibility` only when app speech did not carry it: nothing
 * started speaking within HERO_ANNOUNCE_GRACE_MS of the change (the speech
 * policy dropped it, or there is no speech service). A newer hero cancels the
 * pending check, so a burst of changes announces at most its last member.
 *
 * The mode word is also the DebugPanel's door: a 1.5 s long-press, never a
 * three-finger tap (VoiceOver) or a shake (Expo dev menu).
 */
import React, { useEffect, useRef } from 'react';
import { AccessibilityInfo, Platform, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import type { AppMode, SignalState } from '../core/contracts';
import { accentFor, colors, fontScaleCap, sizes, space, type } from './theme';
import { modeWord as modeWordFor } from './derive';
import { GlassPanel } from './Glass';
import { useLatest, useOptionalService, useResolvedReduceMotion, useScreenReader } from './hooks';

export const DEBUG_LONG_PRESS_MS = 1500;
/** How long app speech gets to pick up a hero change before VoiceOver reads it. */
export const HERO_ANNOUNCE_GRACE_MS = 1500;

/** What the announcement rule needs from the speech service (structural: stubs qualify). */
export interface SpeechCarrier {
  isSpeaking(): boolean;
  getStats?(): { spoken: number };
}

export interface HeroAnnounceInput {
  platform: string;
  screenReader: boolean;
  /** Something is playing right now. */
  speaking: boolean;
  /** Utterances that started since the hero changed. */
  spokenSince: number;
}

/** Pure: read the hero aloud only where the live region is inert and app speech stayed silent. */
export function shouldAnnounceHero(i: HeroAnnounceInput): boolean {
  return i.platform === 'ios' && i.screenReader && !i.speaking && i.spokenSince <= 0;
}

function spokenCount(speech: SpeechCarrier | undefined): number {
  try {
    return speech?.getStats?.().spoken ?? 0;
  } catch {
    return 0;
  }
}

/**
 * iOS-only fallback for the live region. Skips the first render (the screen
 * mounting is not a change) and cancels when the hero moves on.
 */
export function useHeroAnnouncement(hero: string, opts: { screenReader: boolean; speech: SpeechCarrier | undefined; announce?: (text: string) => void }): void {
  const first = useRef(true);
  const speechRef = useLatest(opts.speech);
  const announceRef = useLatest(opts.announce);
  const { screenReader } = opts;
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return undefined;
    }
    if (!shouldAnnounceHero({ platform: Platform.OS, screenReader, speaking: false, spokenSince: 0 })) return undefined;
    const speech = speechRef.current;
    const before = spokenCount(speech);
    const id = setTimeout(() => {
      let speaking = false;
      try {
        speaking = speech?.isSpeaking() ?? false;
      } catch {
        speaking = false;
      }
      if (!shouldAnnounceHero({ platform: Platform.OS, screenReader, speaking, spokenSince: spokenCount(speech) - before })) return;
      try {
        (announceRef.current ?? AccessibilityInfo.announceForAccessibility)(hero);
      } catch {
        // an announcement is a courtesy, never a crash
      }
    }, HERO_ANNOUNCE_GRACE_MS);
    return () => clearTimeout(id);
  }, [hero, screenReader, speechRef, announceRef]);
}

export interface StateBandProps {
  mode: AppMode;
  /** The one instruction, at most twelve words. */
  hero: string;
  /** Only read at the curb and while crossing; pass the last known state. */
  signal?: SignalState;
  /** 1.5 s long-press on the mode word. */
  onLongPressMode?: () => void;
  /** Overrides the word derived from the mode (onboarding says "Practice"). */
  modeWord?: string;
  style?: StyleProp<ViewStyle>;
  /** Tests: skip the animation without stubbing AccessibilityInfo. */
  reduceMotion?: boolean;
  /** Tests: force the screen-reader path without stubbing AccessibilityInfo. */
  screenReader?: boolean;
  /** Tests: capture announcements instead of calling AccessibilityInfo. */
  announce?: (text: string) => void;
}

export function StateBand(props: StateBandProps): React.JSX.Element {
  const { mode, hero, signal = 'UNKNOWN', onLongPressMode, style } = props;
  const word = props.modeWord ?? modeWordFor(mode);
  const accent = accentFor(mode, signal);

  const reduceMotion = useResolvedReduceMotion(props.reduceMotion);
  const systemScreenReader = useScreenReader();
  const screenReader = props.screenReader ?? systemScreenReader;
  const speech = useOptionalService('speech') as SpeechCarrier | undefined;
  useHeroAnnouncement(hero, { screenReader, speech, announce: props.announce });

  return (
    <GlassPanel tint={accent} reduceMotion={reduceMotion} style={[styles.band, style]} contentStyle={styles.content} testID="state-band">
      <View style={[styles.accentBar, { backgroundColor: accent }]} pointerEvents="none" />
      <Pressable
        onLongPress={onLongPressMode}
        delayLongPress={DEBUG_LONG_PRESS_MS}
        disabled={onLongPressMode === undefined}
        accessibilityRole="button"
        accessibilityLabel={`Mode: ${word}`}
        accessibilityHint={onLongPressMode ? 'Press and hold to open the debug panel' : undefined}
        style={styles.modeTarget}
      >
        <View style={[styles.modeDot, { backgroundColor: accent }]} />
        <Text
          allowFontScaling
          maxFontSizeMultiplier={fontScaleCap.body}
          style={styles.modeWord}
        >
          {word}
        </Text>
      </Pressable>

      <Text
        accessibilityRole="header"
        accessibilityLiveRegion="polite"
        accessible
        allowFontScaling
        maxFontSizeMultiplier={fontScaleCap.hero}
        style={styles.hero}
      >
        {hero}
      </Text>
    </GlassPanel>
  );
}

const styles = StyleSheet.create({
  band: {
    marginHorizontal: sizes.gutter,
  },
  content: {
    paddingTop: space.l,
    paddingBottom: space.xl,
    paddingHorizontal: space.xl,
    justifyContent: 'flex-end',
  },
  accentBar: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 5,
  },
  modeTarget: {
    minHeight: sizes.minTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s,
    alignSelf: 'flex-start',
    paddingRight: space.m,
  },
  modeDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  modeWord: {
    ...type.meta,
    fontWeight: '700',
    color: colors.text,
    textTransform: 'uppercase',
    letterSpacing: 1.1,
  },
  hero: {
    ...type.hero,
    color: colors.text,
    textAlign: 'left',
  },
});
