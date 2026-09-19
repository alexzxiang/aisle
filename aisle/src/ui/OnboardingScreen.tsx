/**
 * Onboarding / practice (02 Task 8): one pattern per step, spoken by the
 * speech service and demonstrated through haptics, beacon and ticker. Two big
 * targets per step: "Play it again" and "Next". Never cut.
 *
 * Exit: on the first run, "Done" completes onboarding and the trip continues
 * once ROUTE_READY arrives; from the practice button (no target item) it
 * returns to IDLE through the abort edge, the only legal exit (01 section 1).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { StateBand } from './StateBand';
import { Button } from './Button';
import { useBus, useMode, useOptionalService, useStoreSlice } from './hooks';
import { heroFor, spokenLines, stepsFor, type OnboardingStep, type StepServices } from './onboardingSteps';
import type { OnboardingPorts } from './ports';
import { colors, fontScaleCap, sizes, space, type } from './theme';
import { services } from '../core/services';

export const PLAY_AGAIN_LABEL = 'Play it again';
export const NEXT_LABEL = 'Next';
export const DONE_LABEL = 'Done';
export const SKIP_LABEL = 'Skip practice';

export interface OnboardingScreenProps {
  onOpenDebug?: () => void;
  ports?: OnboardingPorts;
  reduceMotion?: boolean;
}

export function OnboardingScreen({ onOpenDebug, ports, reduceMotion }: OnboardingScreenProps): React.JSX.Element {
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

  const waitingForRoute = last && targetItem !== null;

  return (
    <View style={styles.screen}>
      <StateBand
        mode={mode}
        modeWord={step.modeWord}
        hero={heroFor(step)}
        onLongPressMode={onOpenDebug}
        reduceMotion={reduceMotion}
        style={styles.band}
      />
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
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
            When you press Done, guidance starts as soon as the route is ready.
          </Text>
        ) : null}
      </ScrollView>
      <View style={styles.controls}>
        <View style={styles.row}>
          <Button label={PLAY_AGAIN_LABEL} onPress={again} hint="Repeats this step" style={styles.half} />
          <Button label={last ? DONE_LABEL : NEXT_LABEL} onPress={next} hint={last ? 'Finishes practice' : 'Moves to the next step'} style={styles.half} />
        </View>
        {!firstRun ? (
          <Button label={SKIP_LABEL} onPress={finish} size="compact" quiet hint="Leaves practice now" />
        ) : null}
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
  scroll: {
    flexGrow: 0,
  },
  content: {
    paddingHorizontal: sizes.gutter,
    paddingTop: space.l,
    gap: space.s,
  },
  detail: {
    ...type.body,
    color: colors.text,
  },
  progress: {
    ...type.meta,
    color: colors.meta,
    fontVariant: ['tabular-nums'],
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
