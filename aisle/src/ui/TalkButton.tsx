/**
 * Push-to-talk: an 88 pt round glass button with its label beneath, the
 * largest and most recognisable target on the screen (DESIGN.md, Targets).
 * Held = "Listening" with a pulsing ring; released = "Hold to talk".
 *
 * Two gestures, chosen by whether a screen reader is running:
 *   - Direct touch: press-in opens the mic, press-out closes it.
 *   - VoiceOver / TalkBack: a standard double-tap delivers press-in and
 *     press-out milliseconds apart, so the mic would open and close at once.
 *     The button becomes a toggle instead: activate to start, activate again
 *     to stop, with `accessibilityState.busy` while listening.
 *
 * Motion: the press scales the disc to 0.96; while listening a ring pulses
 * outward on a 1.2 s loop. Under reduce-motion the disc does not scale and
 * the ring is a still halo, so the listening state is still visible.
 *
 * The mic is closed on unmount either way, so a screen change can never leave
 * a recording session (and therefore suppressed haptics) behind.
 */
import { hasNativeBlur } from './Glass';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors, fontScaleCap, glass, motion, signalColors, sizes, space, type } from './theme';
import type { VoicePort } from './ports';
import { useLatest, useOptionalService, usePressScale, useResolvedReduceMotion, useScreenReader } from './hooks';

export const TALK_LABEL = 'Hold to talk';
export const TALK_HELD_LABEL = 'Listening';
/** Toggle mode (screen reader on). */
export const TALK_TOGGLE_LABEL = 'Tap to talk';
export const TALK_TOGGLE_HELD_LABEL = 'Listening. Tap to stop';
export const TALK_HINT_HOLD = 'Hold while you say what you need, then release';
export const TALK_HINT_TOGGLE = 'Double-tap to start listening, say what you need, then double-tap to stop';

export interface TalkButtonProps {
  voice?: VoicePort;
  /** Called after the mic is asked to start / stop, for screens that care. */
  onStart?: () => void;
  onStop?: () => void;
  hint?: string;
  style?: StyleProp<ViewStyle>;
  /** Tests: force toggle (true) or hold (false) mode without stubbing AccessibilityInfo. */
  screenReader?: boolean;
  reduceMotion?: boolean;
}

let blurView: React.ComponentType<{ intensity?: number; tint?: string; style?: StyleProp<ViewStyle> }> | null = null;
try {
  blurView = hasNativeBlur() ? (require('expo-blur') as { BlurView: typeof blurView }).BlurView : null;
} catch {
  blurView = null;
}

export function TalkButton({ voice, onStart, onStop, hint, style, screenReader, reduceMotion: reduceMotionProp }: TalkButtonProps): React.JSX.Element {
  const [held, setHeld] = useState(false);
  const [ready, setReady] = useState(false);
  const attempt = useRef(0);
  const heldRef = useLatest(held);
  const voiceRef = useLatest(voice);
  const systemScreenReader = useScreenReader();
  const toggleMode = screenReader ?? systemScreenReader;
  const reduceMotion = useResolvedReduceMotion(reduceMotionProp);
  const press = usePressScale(reduceMotion);
  // The one cue a blind user gets that the microphone is actually live: a tap when the
  // recogniser reports it is listening, not when the finger lands (startup is a few
  // hundred milliseconds; speaking before the tap is what "cut off my first word").
  const haptics = useOptionalService('haptics');

  const stop = useCallback(() => {
    if (!heldRef.current) return;
    attempt.current += 1;
    setHeld(false);
    setReady(false);
    try {
      void voiceRef.current?.stop();
    } catch {
      // A failed stop must not take the screen down; the session closes on unmount too.
    }
    onStop?.();
  }, [heldRef, voiceRef, onStop]);

  const stopRef = useLatest(stop);
  const unmounting = useRef(false);
  useEffect(() => {
    unmounting.current = false;
    return () => {
      unmounting.current = true;
      stopRef.current();
    };
  }, [stopRef]);

  const start = useCallback(() => {
    setHeld(true);
    setReady(false);
    const id = ++attempt.current;
    const started = (): void => {
      if (attempt.current !== id || unmounting.current) return;
      setReady(true);
      try { haptics?.play('CONFIRM'); } catch { /* a missing haptic engine is not an error */ }
      onStart?.();
    };
    try {
      const promise = voiceRef.current?.start();
      if (promise) void promise.then(started).catch(() => { if (attempt.current === id) setHeld(false); });
      else started();
    } catch {
      // Same: never crash the one control the user can always find.
    }
  }, [voiceRef, onStart, haptics]);

  const toggle = useCallback(() => {
    if (heldRef.current) stop();
    else start();
  }, [heldRef, start, stop]);

  // Mode flips while held (screen reader turned on mid-utterance): close the mic
  // rather than leave it open behind a gesture the user no longer has.
  useEffect(() => {
    stopRef.current();
  }, [toggleMode, stopRef]);

  // ---- The listening ring: one 1.2 s loop while held ----
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!held || reduceMotion) {
      pulse.stopAnimation();
      pulse.setValue(0);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.timing(pulse, { toValue: 1, duration: motion.listenPulseMs, useNativeDriver: true }),
      { resetBeforeIteration: true },
    );
    loop.start();
    return () => loop.stop();
  }, [held, reduceMotion, pulse]);

  const ringStyle = reduceMotion
    ? { opacity: held ? 0.35 : 0, transform: [{ scale: 1.18 }] }
    : {
      opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }),
      transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.55] }) }],
    };

  const onPressIn = toggleMode
    ? press.onPressIn
    : () => {
      press.onPressIn();
      start();
    };
  const onPressOut = toggleMode
    ? press.onPressOut
    : () => {
      press.onPressOut();
      stop();
    };

  const label = held && !ready ? 'Starting microphone' : toggleMode
    ? (held ? TALK_TOGGLE_HELD_LABEL : TALK_TOGGLE_LABEL)
    : (held ? TALK_HELD_LABEL : TALK_LABEL);

  const Blur = blurView;

  return (
    <Pressable
      onPressIn={toggleMode ? undefined : onPressIn}
      onPressOut={toggleMode ? undefined : onPressOut}
      onPress={toggleMode ? toggle : undefined}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ busy: held }}
      accessibilityHint={hint ?? (toggleMode ? TALK_HINT_TOGGLE : TALK_HINT_HOLD)}
      style={[styles.wrap, style]}
    >
      <View style={styles.discArea}>
        <Animated.View pointerEvents="none" style={[styles.ring, held && styles.ringHeld, ringStyle]} testID="talk-ring" />
        <Animated.View style={[styles.discShadow, { transform: [{ scale: press.scale }] }]}>
          <View style={[styles.disc, held && styles.discHeld]}>
            {Blur ? <Blur intensity={glass.blurIntensity} tint={glass.blurTint} style={StyleSheet.absoluteFill} /> : null}
            <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.discFill, held && styles.discFillHeld]} />
            <View style={[styles.dot, held && styles.dotHeld]} />
          </View>
        </Animated.View>
      </View>
      <Text allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={styles.label}>
        {label}
      </Text>
    </Pressable>
  );
}

const RING_PAD = 18;

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: space.s,
    gap: space.s,
  },
  discArea: {
    width: sizes.talkDiameter + RING_PAD * 2,
    height: sizes.talkDiameter + RING_PAD * 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ring: {
    position: 'absolute',
    width: sizes.talkDiameter,
    height: sizes.talkDiameter,
    borderRadius: sizes.talkDiameter / 2,
    borderWidth: 3,
    borderColor: colors.text,
    opacity: 0,
  },
  ringHeld: {
    borderColor: signalColors.DONT_WALK,
  },
  discShadow: {
    shadowColor: glass.shadow.color,
    shadowOpacity: glass.shadow.opacity * 1.5,
    shadowOffset: { width: 0, height: glass.shadow.offsetY },
    shadowRadius: glass.shadow.blur / 2,
    elevation: 6,
    borderRadius: sizes.talkDiameter / 2,
  },
  disc: {
    width: sizes.talkDiameter,
    height: sizes.talkDiameter,
    borderRadius: sizes.talkDiameter / 2,
    overflow: 'hidden',
    borderWidth: glass.borderWidth,
    borderColor: glass.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  discHeld: {
    borderColor: signalColors.DONT_WALK,
    borderWidth: 2,
  },
  discFill: {
    backgroundColor: 'rgba(255,255,255,0.72)',
  },
  discFillHeld: {
    backgroundColor: 'rgba(255,255,255,0.9)',
  },
  dot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.text,
  },
  dotHeld: {
    backgroundColor: signalColors.DONT_WALK,
    width: 26,
    height: 26,
    borderRadius: 6,
  },
  label: {
    ...type.body,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'center',
  },
});
