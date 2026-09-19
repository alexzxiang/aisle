/**
 * Push-to-talk: full width, 96 pt, the largest target on the screen
 * (DESIGN.md rule 7). Held = "Listening"; released = "Hold to talk".
 *
 * Two gestures, chosen by whether a screen reader is running:
 *   - Direct touch: press-in opens the mic, press-out closes it.
 *   - VoiceOver / TalkBack: a standard double-tap delivers press-in and
 *     press-out milliseconds apart, so the mic would open and close at once.
 *     The button becomes a toggle instead: activate to start, activate again
 *     to stop, with `accessibilityState.busy` while listening (DESIGN.md rule 7).
 *
 * The mic is closed on unmount either way, so a screen change can never leave
 * a recording session (and therefore suppressed haptics) behind.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors, fontScaleCap, sizes, space, type } from './theme';
import type { VoicePort } from './ports';
import { useLatest, useScreenReader } from './hooks';

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
}

export function TalkButton({ voice, onStart, onStop, hint, style, screenReader }: TalkButtonProps): React.JSX.Element {
  const [held, setHeld] = useState(false);
  const heldRef = useLatest(held);
  const voiceRef = useLatest(voice);
  const systemScreenReader = useScreenReader();
  const toggleMode = screenReader ?? systemScreenReader;

  const stop = useCallback(() => {
    if (!heldRef.current) return;
    setHeld(false);
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
    try {
      void voiceRef.current?.start();
    } catch {
      // Same: never crash the one control the user can always find.
    }
    onStart?.();
  }, [voiceRef, onStart]);

  const toggle = useCallback(() => {
    if (heldRef.current) stop();
    else start();
  }, [heldRef, start, stop]);

  // Mode flips while held (screen reader turned on mid-utterance): close the mic
  // rather than leave it open behind a gesture the user no longer has.
  useEffect(() => {
    stopRef.current();
  }, [toggleMode, stopRef]);

  const label = toggleMode
    ? (held ? TALK_TOGGLE_HELD_LABEL : TALK_TOGGLE_LABEL)
    : (held ? TALK_HELD_LABEL : TALK_LABEL);

  return (
    <Pressable
      onPressIn={toggleMode ? undefined : start}
      onPressOut={toggleMode ? undefined : stop}
      onPress={toggleMode ? toggle : undefined}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ busy: held }}
      accessibilityHint={hint ?? (toggleMode ? TALK_HINT_TOGGLE : TALK_HINT_HOLD)}
      style={({ pressed }) => [styles.button, (pressed || held) && styles.held, style]}
    >
      <View style={styles.inner}>
        <Text allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={styles.label}>
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: '100%',
    height: sizes.talkHeight,
    backgroundColor: colors.talk,
    borderRadius: sizes.radius,
    justifyContent: 'center',
    paddingHorizontal: space.l,
  },
  held: {
    backgroundColor: colors.talkHeld,
  },
  inner: {
    justifyContent: 'center',
  },
  label: {
    ...type.body,
    fontWeight: '700',
    color: colors.text,
  },
});
