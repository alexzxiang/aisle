/**
 * The state band: the one memorable element (src/ui/DESIGN.md rules 1-3).
 *
 * Full-bleed, colour-coded by mode (and by signal state while crossing), with
 * the mode word above and the current instruction as the hero. The hero is the
 * single live region in the app, so a screen reader announces exactly one
 * changing thing. The only animation in Aisle is this band's 250 ms colour
 * cross-fade, and it is skipped under reduce-motion.
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
import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Platform, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import type { AppMode, SignalState } from '../core/contracts';
import { bandColorFor, colors, fontScaleCap, motion, sizes, space, type } from './theme';
import { modeWord as modeWordFor } from './derive';
import { useLatest, useOptionalService, useReduceMotion, useScreenReader } from './hooks';

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
  const target = bandColorFor(mode, signal);

  const systemReduceMotion = useReduceMotion();
  const reduceMotion = props.reduceMotion ?? systemReduceMotion;
  const systemScreenReader = useScreenReader();
  const screenReader = props.screenReader ?? systemScreenReader;
  const speech = useOptionalService('speech') as SpeechCarrier | undefined;
  useHeroAnnouncement(hero, { screenReader, speech, announce: props.announce });

  // Two layers: the settled colour underneath, the incoming colour fading in.
  const [base, setBase] = useState(target);
  const [incoming, setIncoming] = useState<string | null>(null);
  const fade = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (target === base) return;
    if (reduceMotion) {
      setBase(target);
      setIncoming(null);
      fade.setValue(0);
      return;
    }
    setIncoming(target);
    fade.setValue(0);
    const anim = Animated.timing(fade, {
      toValue: 1,
      duration: motion.bandFadeMs,
      useNativeDriver: false,
    });
    anim.start(({ finished }) => {
      if (!finished) return;
      setBase(target);
      setIncoming(null);
      fade.setValue(0);
    });
    return () => anim.stop();
  }, [target, base, reduceMotion, fade]);

  return (
    <View style={[styles.band, { backgroundColor: base }, style]}>
      {incoming !== null ? (
        <Animated.View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { backgroundColor: incoming, opacity: fade }]}
        />
      ) : null}

      <View style={styles.content}>
        <Pressable
          onLongPress={onLongPressMode}
          delayLongPress={DEBUG_LONG_PRESS_MS}
          disabled={onLongPressMode === undefined}
          accessibilityRole="button"
          accessibilityLabel={`Mode: ${word}`}
          accessibilityHint={onLongPressMode ? 'Press and hold to open the debug panel' : undefined}
          style={styles.modeTarget}
        >
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
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  band: {
    width: '100%',
    overflow: 'hidden',
    justifyContent: 'flex-end',
    minHeight: 220,
    paddingTop: space.xxl + space.xl,
    paddingBottom: space.xl,
    paddingHorizontal: sizes.gutter,
  },
  content: {
    width: '100%',
  },
  modeTarget: {
    minHeight: sizes.minTarget,
    justifyContent: 'flex-end',
    paddingBottom: space.s,
  },
  modeWord: {
    ...type.meta,
    color: colors.text,
  },
  hero: {
    ...type.hero,
    color: colors.text,
    textAlign: 'left',
  },
});
