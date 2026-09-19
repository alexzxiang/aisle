/**
 * Screen switch by mode, plus the two sheets. The composition root (App.tsx,
 * written by the integrator) registers the services, then renders <Root/>
 * with whatever optional ports exist in that build:
 *
 *   <Root voice={voicePortFrom(voiceInput)} audio={audioPortsFrom(channels)}
 *         conversation={services.get('conversation')} describeNow={describer.describeNow}
 *         metrics={metrics} mockControls={<MockControls/>} betaNotice={routeNotice} />
 *
 * (`adapters.ts` has the two helpers.) When no `conversation` prop is given,
 * Root looks for a log registered under 'conversation' in the service
 * registry, so an App.tsx that registers it needs no extra wiring.
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
import { HoldToTalk } from './HoldToTalk';
import { SettingsSheet } from './SettingsSheet';
import { useMode, useOptionalService, useRegisteredConversation } from './hooks';
import type { AudioPorts, ConversationLogPort, DebugMetrics, DescribeNow, VoicePort } from './ports';
import { colors } from './theme';

export interface RootProps {
  /** D's DebugPanel controls (05 Part 5): jump-to-mode, manual signal, forceEnter, fixtures. */
  mockControls?: React.ReactNode;
  /** Push-to-talk (02 Task 7). Absent = the talk button is inert and the text field carries. */
  voice?: VoicePort;
  /** Beacon and ticker: onboarding demonstrations (02 Task 5) and the DebugPanel mutes (Task 9). */
  audio?: AudioPorts;
  /** The conversation log the transcript follows (src/core/conversation.ts). Falls back to the registry. */
  conversation?: ConversationLogPort;
  /** The scene describer's `describeNow` (src/core/describer.ts); drives the "Describe surroundings" pill. */
  describeNow?: DescribeNow;
  /** Tier latencies and speech counters for the DebugPanel. */
  metrics?: DebugMetrics;
  /** Google's walking-routes beta sentence, supplied by B. */
  betaNotice?: string;
  /** Tests: freeze the clock and skip the animations. */
  now?: number;
  reduceMotion?: boolean;
}

export function Root(props: RootProps): React.JSX.Element {
  const { mockControls, voice, audio, describeNow, metrics, betaNotice, now, reduceMotion } = props;
  const registered = useRegisteredConversation();
  const conversation = props.conversation ?? registered;
  const mode = useMode();
  const [debugOpen, setDebugOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const haptics = useOptionalService('haptics');

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
        conversation={conversation}
        betaNotice={betaNotice}
        now={now}
        reduceMotion={reduceMotion}
      />
    );
  } else if (mode === 'ONBOARDING') {
    screen = <OnboardingScreen onOpenDebug={openDebug} ports={audio} reduceMotion={reduceMotion} />;
  } else {
    screen = (
      <NavScreen
        onOpenDebug={openDebug}
        voice={voice}
        conversation={conversation}
        describeNow={describeNow}
        now={now}
        reduceMotion={reduceMotion}
      />
    );
  }

  return (
    <View style={styles.root}>
      <StatusBar barStyle="dark-content" backgroundColor={colors.bg} />
      {/* Press and hold anywhere that is not a control to talk (round 6c). */}
      <HoldToTalk voice={voice} onStart={() => haptics?.play('CONFIRM')} reduceMotion={reduceMotion}>
        {screen}
      </HoldToTalk>
      <DebugPanel visible={debugOpen} onClose={closeDebug} metrics={metrics} audio={audio} mockControls={mockControls} />
      <SettingsSheet visible={settingsOpen} onClose={closeSettings} reduceMotion={reduceMotion} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
});
