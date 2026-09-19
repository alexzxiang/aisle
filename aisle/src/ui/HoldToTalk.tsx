/**
 * HoldToTalk — press and hold anywhere on the screen to talk (round 6c).
 *
 * A blind user cannot find the talk button by sight, and a screen full of glass
 * panels is a poor target. This layer sits behind every screen: a long press
 * (`HOLD_MS`) on any spot that is not a control starts listening, releasing
 * stops. Controls keep winning: React Native's responder system hands a touch
 * to the deepest pressable, so buttons, the text field and the transcript's
 * scroll still work; only presses on empty background reach this layer.
 *
 * Feedback while held: a pulsing ring with "Listening — release to send"
 * (respecting reduce-motion), a CONFIRM tap at the start, and VoiceOver reads
 * the layer as one hint ("Hold anywhere to talk"). The TalkButton remains for
 * users who prefer a fixed target and for screen-reader toggle mode.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import type { VoicePort } from './ports';
import { useLatest, useResolvedReduceMotion } from './hooks';
import { colors, fontScaleCap, type } from './theme';

export const HOLD_MS = 350;
export const HOLD_HINT = 'Hold anywhere to talk';
export const LISTENING_TEXT = 'Listening';
export const RELEASE_TEXT = 'Release to send';

export interface HoldToTalkProps {
  voice: VoicePort | null | undefined;
  /** Something that says "I heard you": the haptic CONFIRM. */
  onStart?: () => void;
  children: React.ReactNode;
  reduceMotion?: boolean;
  testID?: string;
}

export function HoldToTalk({ voice, onStart, children, reduceMotion: reduceMotionProp, testID = 'hold-to-talk' }: HoldToTalkProps): React.JSX.Element {
  const reduceMotion = useResolvedReduceMotion(reduceMotionProp);
  const [held, setHeld] = useState(false);
  const [ready, setReady] = useState(false);
  const capture = useRef(0);
  const heldRef = useLatest(held);
  const voiceRef = useLatest(voice);
  const pulse = useRef(new Animated.Value(0)).current;

  const begin = useCallback(() => {
    if (heldRef.current || !voiceRef.current) return;
    setHeld(true);
    setReady(false);
    const attempt = ++capture.current;
    const listening = (): void => {
      if (capture.current !== attempt) return;
      setReady(true);
      onStart?.();
      AccessibilityInfo.announceForAccessibility(LISTENING_TEXT);
    };
    try {
      const started = voiceRef.current.start();
      if (started) void started.then(listening).catch(() => { if (capture.current === attempt) setHeld(false); });
      else listening();
    } catch {
      setHeld(false);
    }
  }, [heldRef, voiceRef, onStart]);

  const end = useCallback(() => {
    if (!heldRef.current) return;
    capture.current += 1;
    setHeld(false);
    setReady(false);
    try {
      void voiceRef.current?.stop();
    } catch {
      // the port reports its own errors
    }
  }, [heldRef, voiceRef]);

  // Never leave the mic open: a release we missed (navigation, unmount) still stops.
  useEffect(() => () => { if (heldRef.current) void voiceRef.current?.stop(); }, [heldRef, voiceRef]);

  useEffect(() => {
    if (!held) {
      pulse.stopAnimation();
      pulse.setValue(0);
      return undefined;
    }
    if (reduceMotion) {
      pulse.setValue(1);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 700, easing: Easing.in(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [held, reduceMotion, pulse]);

  const ringScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1.15] });
  const ringOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0.9] });

  return (
    <Pressable
      style={styles.layer}
      onLongPress={begin}
      delayLongPress={HOLD_MS}
      onPressOut={end}
      accessible={false}
      testID={testID}
    >
      {children}
      {held ? (
        <View style={styles.overlay} pointerEvents="none" accessible accessibilityRole="text" accessibilityLabel={ready ? `${LISTENING_TEXT}. ${RELEASE_TEXT}.` : 'Starting microphone. Wait for listening.'} testID={`${testID}-overlay`}>
          <Animated.View style={[styles.ring, { transform: [{ scale: ringScale }], opacity: ringOpacity }]} />
          <View style={styles.dot} />
          <Text allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={styles.title}>{ready ? LISTENING_TEXT : 'Starting microphone'}</Text>
          <Text allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={styles.hint}>{RELEASE_TEXT}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const RING = 168;

const styles = StyleSheet.create({
  layer: {
    flex: 1,
  },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(245,247,250,0.72)',
  },
  ring: {
    position: 'absolute',
    width: RING,
    height: RING,
    borderRadius: RING / 2,
    borderWidth: 6,
    borderColor: colors.text,
  },
  dot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.text,
    marginBottom: RING / 2 + 12,
  },
  title: {
    ...type.hero,
    fontSize: 28,
    lineHeight: 32,
    color: colors.text,
    marginTop: RING / 2 - 40,
  },
  hint: {
    ...type.meta,
    color: colors.secondary,
    marginTop: 6,
  },
});
