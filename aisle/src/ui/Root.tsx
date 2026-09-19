/**
 * Screen switch by mode, plus the two sheets. The composition root (App.tsx,
 * written by the integrator) registers the services, then renders <Root/>
 * with whatever optional ports exist in that build:
 *
 *   <Root voice={voicePortFrom(voiceInput)} audio={audioPortsFrom(channels)}
 *         metrics={metrics} mockControls={<MockControls/>} betaNotice={routeNotice} />
 *
 * (`adapters.ts` has the two helpers.)
 *
 * IDLE -> HomeScreen; ONBOARDING -> OnboardingScreen; everything else,
 * including DONE, -> NavScreen. The DebugPanel is reachable from every screen
 * through the mode word.
 */
import React, { useCallback, useState } from 'react';
import { StatusBar, StyleSheet, View } from 'react-native';
import { HomeScreen } from './HomeScreen';
import { NavScreen } from './NavScreen';
import { OnboardingScreen } from './OnboardingScreen';
import { DebugPanel } from './DebugPanel';
import { SettingsSheet } from './SettingsSheet';
import { useMode } from './hooks';
import type { AudioPorts, DebugMetrics, VoicePort } from './ports';
import { colors } from './theme';

export interface RootProps {
  /** D's DebugPanel controls (05 Part 5): jump-to-mode, manual signal, forceEnter, fixtures. */
  mockControls?: React.ReactNode;
  /** Push-to-talk (02 Task 7). Absent = the talk button is inert and the text field carries. */
  voice?: VoicePort;
  /** Beacon and ticker: onboarding demonstrations (02 Task 5) and the DebugPanel mutes (Task 9). */
  audio?: AudioPorts;
  /** Tier latencies and speech counters for the DebugPanel. */
  metrics?: DebugMetrics;
  /** Google's walking-routes beta sentence, supplied by B. */
  betaNotice?: string;
  /** Tests: freeze the clock and skip the band animation. */
  now?: number;
  reduceMotion?: boolean;
}

export function Root(props: RootProps): React.JSX.Element {
  const { mockControls, voice, audio, metrics, betaNotice, now, reduceMotion } = props;
  const mode = useMode();
  const [debugOpen, setDebugOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const openDebug = useCallback(() => setDebugOpen(true), []);
  const closeDebug = useCallback(() => setDebugOpen(false), []);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  let screen: React.JSX.Element;
  if (mode === 'IDLE') {
    screen = (
      <HomeScreen
        onOpenDebug={openDebug}
        onOpenSettings={openSettings}
        voice={voice}
        betaNotice={betaNotice}
        reduceMotion={reduceMotion}
      />
    );
  } else if (mode === 'ONBOARDING') {
    screen = <OnboardingScreen onOpenDebug={openDebug} ports={audio} reduceMotion={reduceMotion} />;
  } else {
    screen = <NavScreen onOpenDebug={openDebug} voice={voice} now={now} reduceMotion={reduceMotion} />;
  }

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
      {screen}
      <DebugPanel visible={debugOpen} onClose={closeDebug} metrics={metrics} audio={audio} mockControls={mockControls} />
      <SettingsSheet visible={settingsOpen} onClose={closeSettings} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
});
