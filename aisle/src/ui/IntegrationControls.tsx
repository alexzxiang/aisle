/**
 * The integrator's DebugPanel add-on (02 Task 9 overrides that belong to no
 * track's component): mounted next to D's MockControls in the `mockControls`
 * slot, so no existing screen changes.
 *
 * - `At curb` (B's request): `CrossingController.curbReached()` while approaching.
 * - `Start hand guidance` (the stretch beat, 04 Task 9) at the item.
 * - `Next: checkout` (01 §1 "user next"): AT_ITEM / ITEM_PICKUP → CHECKOUT_NAV.
 *
 * Plus one monospace line with the proxy URL, mock/live, and the trip session's
 * state (runner leg, crossing state, last error) read at the panel's own 1 Hz.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { Trip } from '../core/trip';
import { Button } from './Button';
import { useMode, useNow } from './hooks';
import { colors, monoFontFamily, space } from './theme';

export const INTEGRATION_TITLE = 'Integration';
export const AT_CURB_LABEL = 'At curb';
export const START_PICKUP_LABEL = 'Start hand guidance';
export const NEXT_CHECKOUT_LABEL = 'Next: checkout';

export interface IntegrationControlsProps {
  trip: Pick<Trip, 'curbReached' | 'startPickup' | 'nextFromItem' | 'getDebugState'>;
  proxyUrl: string;
  mock: boolean;
  /** Tests: freeze the clock. */
  now?: number;
  pollMs?: number;
}

export function tripLine(d: ReturnType<Trip['getDebugState']>): string {
  const runner = d.runner ? `leg ${d.runner.legIndex + 1}/${d.runner.legCount}  ${d.runner.remainingM === null ? '—' : `${Math.round(d.runner.remainingM)} m`}` : 'no route';
  const crossing = d.crossing ? `crossing ${d.crossing.state.toLowerCase()} rung ${d.crossing.ladderRung}` : 'crossing —';
  return `trip ${d.active ? 'active' : 'idle'} (${d.starts})  ${runner}  ${crossing}${d.manualSignal ? `  manual ${d.manualSignal}` : ''}`;
}

export function IntegrationControls(props: IntegrationControlsProps): React.JSX.Element {
  const { trip, proxyUrl, mock, now: nowOverride, pollMs = 1000 } = props;
  const mode = useMode();
  useNow(pollMs, nowOverride);
  const d = trip.getDebugState();

  return (
    <View style={styles.root} accessibilityRole="summary" accessibilityLabel={INTEGRATION_TITLE}>
      <Text style={styles.title}>{INTEGRATION_TITLE}</Text>
      <Text style={styles.mono}>{`proxy ${proxyUrl}  ${mock ? 'MOCK' : 'LIVE'}`}</Text>
      <Text style={styles.mono}>{tripLine(d)}</Text>
      {d.lastError ? <Text style={styles.mono}>{`last error ${d.lastError}`}</Text> : null}
      <View style={styles.row}>
        {mode === 'APPROACH_CROSSING' ? (
          <Button label={AT_CURB_LABEL} onPress={() => trip.curbReached()} size="compact" hint="Tells the crossing controller you stopped at the curb" testID="integration-at-curb" />
        ) : null}
        {mode === 'AT_ITEM' ? (
          <Button label={START_PICKUP_LABEL} onPress={() => void trip.startPickup()} size="compact" hint="Runs the hand guidance loop on the item" testID="integration-pickup" />
        ) : null}
        {mode === 'AT_ITEM' || mode === 'ITEM_PICKUP' ? (
          <Button label={NEXT_CHECKOUT_LABEL} onPress={() => trip.nextFromItem()} size="compact" hint="Moves on to checkout" testID="integration-next" />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { paddingVertical: space.m, gap: space.s },
  title: { fontSize: 18, fontWeight: '700', color: colors.text },
  mono: { fontFamily: monoFontFamily, fontSize: 12, color: colors.meta },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s },
});
