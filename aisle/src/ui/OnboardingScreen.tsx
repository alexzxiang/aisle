/**
 * Onboarding / practice (02 Task 8): one pattern per step, spoken by the
 * speech service and demonstrated through haptics, beacon and ticker. Two big
 * targets per step: "Play it again" and "Next" -- or, on the rehearsal step
 * that closes the lesson, "Yes" and "No", so the user has answered the
 * awareness loop's question once before it is asked for real. Never cut.
 *
 * Exit: on the first run, "Done" completes onboarding and the trip continues
 * once ROUTE_READY arrives; from the practice button (no target item) it
 * returns to IDLE through the abort edge, the only legal exit (01 section 1).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { StateBand } from './StateBand';
import { Button } from './Button';
import { Backdrop, GlassPanel } from './Glass';
import { useBus, useMode, useOptionalService, useResolvedReduceMotion, useStoreSlice } from './hooks';
import { heroFor, spokenLines, stepsFor, type OnboardingStep, type StepServices } from './onboardingSteps';
import { phraseText } from '../core/phrases';
import type { OnboardingPorts } from './ports';
import { accentFor, colors, fontScaleCap, sizes, space, tabular, type } from './theme';
import { services } from '../core/services';

export const PLAY_AGAIN_LABEL = 'Play it again';
export const NEXT_LABEL = 'Next';
export const DONE_LABEL = 'Done';
export const SKIP_LABEL = 'Skip practice';
export const WAITING_NOTE = 'When you press Done, guidance starts as soon as the route is ready.';
/** The yes / no rehearsal step (`practice: 'yes_no'`). */
export const YES_LABEL = 'Yes';
export const NO_LABEL = 'No';
export const YES_HINT = 'Confirms what Aisle guessed, and ends the lesson';
export const NO_HINT = 'Tells Aisle it guessed wrong, and ends the lesson';

export interface OnboardingScreenProps {
  onOpenDebug?: () => void;
  ports?: OnboardingPorts;
  reduceMotion?: boolean;
}

export function OnboardingScreen({ onOpenDebug, ports, reduceMotion: reduceMotionProp }: OnboardingScreenProps): React.JSX.Element {
  const reduceMotion = useResolvedReduceMotion(reduceMotionProp);
  const mode = useMode();
  const firstRun = useStoreSlice((s) => s.firstRun);
  const targetItem = useStoreSlice((s) => s.targetItem);
  const finishOnboarding = useStoreSlice((s) => s.finishOnboarding);
  const abort = useStoreSlice((s) => s.abort);
  const setBodyOffsetDeg = useStoreSlice((s) => s.setBodyOffsetDeg);
  const bus = useBus();
  const speech = useOptionalService('speech');
  const haptics = useOptionalService('haptics');
  const sensors = useOptionalService('sensors');

  const steps = useMemo(() => stepsFor(firstRun), [firstRun]);
  const [index, setIndex] = useState(0);
  const [replay, setReplay] = useState(0);
  const step: OnboardingStep = steps[Math.min(index, steps.length - 1)];
  const last = index >= steps.length - 1;

  const stepServices = useMemo<StepServices | null>(() => {
    if (!haptics || !sensors) return null;
    return {
      haptics,
      sensors,
      beacon: ports?.beacon,
      ticker: ports?.ticker,
      onCalibrated: (r) => {
        setBodyOffsetDeg(r.offsetDeg);
        if (r.ok) services.tryGet('perception')?.setBodyOffsetDeg(r.offsetDeg);
      },
    };
  }, [haptics, sensors, ports?.beacon, ports?.ticker, setBodyOffsetDeg]);

  // Speak and demonstrate on every step change and on "Play it again". Every
  // line goes out under its pre-generated key (offline, one voice); a step has
  // at most two lines because NAV keeps one pending slot.
  useEffect(() => {
    for (const line of spokenLines(step)) {
      speech?.say({
        text: line.text,
        priority: 'NAV',
        cacheKey: line.cacheKey,
        dedupeKey: `onboarding_${step.id}_${line.cacheKey}_${replay}`,
        cooldownMs: 0,
      });
    }
    let cleanup: (() => void) | void;
    if (stepServices && step.run) {
      try {
        cleanup = step.run(stepServices);
      } catch (err) {
        bus.emit({ type: 'ERROR', scope: 'ui', message: `onboarding ${step.id}: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    return () => {
      if (typeof cleanup === 'function') cleanup();
    };
  }, [step, replay, speech, stepServices, bus]);

  const finish = useCallback(() => {
    finishOnboarding();
    // Practice from Home has no item: the only way out of ONBOARDING is the abort edge.
    if (targetItem === null && services.get('store').getState().mode === 'ONBOARDING') abort();
  }, [finishOnboarding, targetItem, abort]);

  const next = useCallback(() => {
    if (last) {
      finish();
      return;
    }
    setIndex((i) => i + 1);
  }, [last, finish]);

  const again = useCallback(() => setReplay((n) => n + 1), []);

  // The yes / no rehearsal: answer, hear what the real loop answers, move on.
  // Both answers advance — the lesson teaches the gesture, not the room.
  const answer = useCallback(
    (yes: boolean) => {
      haptics?.play('CONFIRM');
      const key = yes ? 'noted' : 'tell_me_where';
      speech?.say({ text: phraseText(key), priority: 'NAV', cacheKey: key, dedupeKey: `onboarding_answer_${key}`, cooldownMs: 0 });
      next();
    },
    [haptics, speech, next],
  );

  const waitingForRoute = last && targetItem !== null;

  return (
    <View style={styles.screen}>
      <Backdrop accent={accentFor(mode)} reduceMotion={reduceMotion} />
      <StateBand
        mode={mode}
        modeWord={step.modeWord}
        hero={heroFor(step)}
        onLongPressMode={onOpenDebug}
        reduceMotion={reduceMotion}
      />
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <GlassPanel key={step.id} reduceMotion={reduceMotion} contentStyle={styles.card}>
          {step.detail ? (
            <Text allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={styles.detail}>
              {step.detail}
            </Text>
          ) : null}
          <Text allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={styles.progress}>
            {`Step ${index + 1} of ${steps.length}`}
          </Text>
          {waitingForRoute ? (
            <Text allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={styles.detail}>
              {WAITING_NOTE}
            </Text>
          ) : null}
        </GlassPanel>
      </ScrollView>
      <View style={styles.controls}>
        {step.practice === 'yes_no' ? (
          <View style={styles.row}>
            <Button label={YES_LABEL} onPress={() => answer(true)} hint={YES_HINT} reduceMotion={reduceMotion} style={styles.half} testID="practice-yes" />
            <Button label={NO_LABEL} onPress={() => answer(false)} hint={NO_HINT} reduceMotion={reduceMotion} style={styles.half} testID="practice-no" />
          </View>
        ) : (
          <View style={styles.row}>
            <Button label={PLAY_AGAIN_LABEL} onPress={again} hint="Repeats this step" reduceMotion={reduceMotion} style={styles.half} />
            <Button label={last ? DONE_LABEL : NEXT_LABEL} onPress={next} hint={last ? 'Finishes practice' : 'Moves to the next step'} reduceMotion={reduceMotion} style={styles.half} />
          </View>
        )}
        {!firstRun ? (
          <Button label={SKIP_LABEL} onPress={finish} size="compact" quiet hint="Leaves practice now" reduceMotion={reduceMotion} />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingTop: Platform.OS === 'ios' ? 60 : space.xl,
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingHorizontal: sizes.gutter,
    paddingTop: space.m,
    paddingBottom: space.m,
    gap: space.s,
  },
  card: {
    paddingHorizontal: space.xl,
    paddingVertical: space.l,
    gap: space.s,
  },
  detail: {
    ...type.body,
    color: colors.text,
  },
  progress: {
    ...type.meta,
    color: colors.secondary,
    ...tabular,
  },
  controls: {
    paddingHorizontal: sizes.gutter,
    paddingTop: space.s,
    paddingBottom: space.xl,
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
