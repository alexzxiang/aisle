/**
 * The trip screen: band / perception strip / push-to-talk / Repeat + Stop
 * guidance (DESIGN.md rule 6). It shows every mode from OUTDOOR_NAV to DONE;
 * the band colour and hero come from the store's mode and the bus.
 *
 * "Stop guidance" is two taps or one two-second hold, never a single stray
 * tap -- it aborts the trip (02 Task 2: "big button hold 2 s").
 */
import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { StateBand } from './StateBand';
import { PerceptionStrip } from './PerceptionStrip';
import { TalkButton } from './TalkButton';
import { Button } from './Button';
import { bandSignal, heroText, stripSlots } from './derive';
import { useBus, useMode, useNow, useOptionalService, useStoreSlice, useUiFacts } from './hooks';
import { assertUtterance } from './copy';
import type { VoicePort } from './ports';
import { colors, sizes, space } from './theme';

export const STOP_HOLD_MS = 2000;
/** A first "Stop guidance" tap arms for this long; a second tap inside it aborts. */
export const STOP_ARM_MS = 5000;
export const STOP_LABEL = 'Stop guidance';
export const STOP_ARMED_LABEL = 'Tap again to stop';
export const REPEAT_LABEL = 'Repeat';

export interface NavScreenProps {
  onOpenDebug?: () => void;
  voice?: VoicePort;
  /** Tests: freeze the clock the "seen n s ago" ages are computed against. */
  now?: number;
  reduceMotion?: boolean;
}

export function NavScreen({ onOpenDebug, voice, now: nowOverride, reduceMotion }: NavScreenProps): React.JSX.Element {
  const mode = useMode();
  const item = useStoreSlice((s) => s.targetItem);
  const side = useStoreSlice((s) => s.targetSide);
  const abort = useStoreSlice((s) => s.abort);
  const facts = useUiFacts();
  const now = useNow(1000, nowOverride);
  const bus = useBus();
  const speech = useOptionalService('speech');
  const haptics = useOptionalService('haptics');

  const hero = heroText(mode, facts, now, { item, side });
  const slots = stripSlots(facts, now);

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
      <StateBand
        mode={mode}
        hero={hero}
        signal={bandSignal(facts)}
        onLongPressMode={onOpenDebug}
        reduceMotion={reduceMotion}
        style={styles.band}
      />
      <PerceptionStrip slots={slots} />
      <View style={styles.controls}>
        <TalkButton voice={voice} />
        <View style={styles.row}>
          <Button
            label={REPEAT_LABEL}
            onPress={repeat}
            hint="Says the current instruction again"
            style={styles.half}
          />
          <Button
            label={isDone ? 'Finish' : armed ? STOP_ARMED_LABEL : STOP_LABEL}
            onPress={isDone ? stopNow : onStopPress}
            onLongPress={stopNow}
            delayLongPress={STOP_HOLD_MS}
            hint={isDone ? 'Ends the trip' : 'Tap twice, or hold for two seconds, to end guidance'}
            selected={armed}
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
  },
  band: {
    flexGrow: 1,
    flexShrink: 1,
  },
  controls: {
    paddingHorizontal: sizes.gutter,
    paddingTop: space.l,
    paddingBottom: space.xxl,
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
