/**
 * Push-to-talk: full width, 96 pt, the largest target on the screen
 * (DESIGN.md rule 7). Held = "Listening"; released = "Hold to talk".
 *
 * The mic is opened on press-in and closed on press-out and on unmount, so a
 * screen change can never leave a recording session (and therefore suppressed
 * haptics) behind.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors, fontScaleCap, sizes, space, type } from './theme';
import type { VoicePort } from './ports';
import { useLatest } from './hooks';

export const TALK_LABEL = 'Hold to talk';
export const TALK_HELD_LABEL = 'Listening';

export interface TalkButtonProps {
  voice?: VoicePort;
  /** Called after the mic is asked to start / stop, for screens that care. */
  onStart?: () => void;
  onStop?: () => void;
  hint?: string;
  style?: StyleProp<ViewStyle>;
}

export function TalkButton({ voice, onStart, onStop, hint, style }: TalkButtonProps): React.JSX.Element {
  const [held, setHeld] = useState(false);
  const heldRef = useLatest(held);
  const voiceRef = useLatest(voice);

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

  const label = held ? TALK_HELD_LABEL : TALK_LABEL;

  return (
    <Pressable
      onPressIn={start}
      onPressOut={stop}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ busy: held }}
      accessibilityHint={hint ?? 'Hold while you say what you need, then release'}
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
