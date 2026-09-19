/**
 * Composition root (02 Task 1, 06 "Integration rules"). The one place that
 * reads `EXPO_PUBLIC_MOCK`, constructs every service once, registers them in
 * `src/core/services.ts` and renders the screens.
 *
 *   platform edges (expo backends | D's mocks)  ─▶  composeApp()  ─▶  <Root/>
 *
 * The graph itself lives in `src/core/composeApp.ts` so it runs under Jest;
 * this file only supplies what needs a device: expo-haptics, expo-audio,
 * expo-speech, expo-location / expo-sensors, expo-speech-recognition,
 * expo-file-system, the linked `Perception` native module, and the screen.
 *
 * Mock mode: `createMockServices()` from `mocks/` replaces sensors, perception,
 * the Tier-1 transport and the planner, and the route comes from the track
 * fixture. The real perception factory is never called in that branch, so
 * `requireNativeModule('Perception')` never runs (05 Part 1).
 */
import React, { useEffect, useState } from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';
import { useKeepAwake } from 'expo-keep-awake';
import demoStore from './fixtures/stores/demo-store-01.json';
import { MockControls } from './mocks/debug/MockControls';
import { bridgeAppStore, createMockServices } from './mocks';
import { track as fixtureTrack } from './mocks/fixtures';
import { createExpoAudioChannelBackend } from './src/core/audio';
import { composeApp, type AppComposition, type AppPlatform } from './src/core/composeApp';
import { config } from './src/core/config';
import { createExpoHapticBackend } from './src/core/haptics';
import { createExpoPrefsStorage } from './src/core/prefs';
import { createExpoSpeechBackend } from './src/core/speechBackend';
import { appBus, appStore } from './src/core/store';
import { createExpoRecognizer, createExpoSttUpload } from './src/core/voice';
import { Root, audioPortsFrom, voicePortFrom, type VoicePort } from './src/ui';
import { IntegrationControls } from './src/ui/IntegrationControls';

interface Composed {
  app: AppComposition | null;
  voicePort: VoicePort | null;
  error: string | null;
}

let composed: Composed | null = null;

function tryCreate<T>(make: () => T): T | undefined {
  try {
    return make();
  } catch {
    return undefined;
  }
}

/** Built once per JS runtime (survives fast refresh); never rebuilt per render. */
function composeOnce(): Composed {
  if (composed) return composed;
  try {
    const platform: AppPlatform = {
      hapticBackend: createExpoHapticBackend(),
      speechBackend: createExpoSpeechBackend({ proxyUrl: config.proxyUrl }),
      audioBackend: createExpoAudioChannelBackend(),
      recognizer: tryCreate(createExpoRecognizer),
      sttUpload: createExpoSttUpload(config.proxyUrl),
      prefsStorage: tryCreate(createExpoPrefsStorage),
    };
    const mocks = config.mock ? createMockServices({ bus: appBus, store: bridgeAppStore(appStore) }) : null;
    const app = composeApp({
      config,
      bus: appBus,
      store: appStore,
      platform,
      mocks,
      fixtureTrack: config.mock ? fixtureTrack : null,
      loadStoreMap: () => demoStore,
    });
    // Press-in → begin, press-out → end; the parsed intent is routed after A's reply.
    const voicePort = voicePortFrom(
      {
        begin: () => app.voice.begin(),
        end: async () => {
          const outcome = await app.voice.end();
          void app.trip.onVoiceOutcome(outcome);
          return outcome;
        },
        cancel: () => app.voice.cancel(),
      },
      { onError: (stage, err) => appBus.emit({ type: 'ERROR', scope: 'voice', message: `${stage}: ${err instanceof Error ? err.message : String(err)}` }) },
    );
    composed = { app, voicePort, error: null };
  } catch (e) {
    composed = { app: null, voicePort: null, error: e instanceof Error ? e.message : String(e) };
  }
  return composed;
}

export default function App(): React.JSX.Element {
  useKeepAwake();
  const [{ app, voicePort, error }] = useState<Composed>(composeOnce);

  useEffect(() => {
    if (!app) return undefined;
    void app.start();
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') void app.prefs.flush();
    });
    return () => sub.remove();
  }, [app]);

  if (!app) return <FailedToStart message={error ?? 'unknown error'} />;

  const mockControls = (
    <>
      <MockControls
        bus={app.bus}
        harness={app.harness ?? undefined}
        perception={app.mockPerception ?? undefined}
        transition={app.transitionPort}
        crossing={app.crossingPort}
      />
      <IntegrationControls trip={app.trip} proxyUrl={config.proxyUrl} mock={config.mock} />
    </>
  );

  return (
    <Root
      voice={voicePort ?? undefined}
      audio={audioPortsFrom(app.audio)}
      metrics={app.metrics}
      mockControls={mockControls}
      betaNotice={app.betaNotice}
    />
  );
}

/** Shown instead of a blank screen when a service cannot be built (e.g. the native module is not linked). */
function FailedToStart({ message }: { message: string }): React.JSX.Element {
  return (
    <View style={styles.failed} accessibilityRole="alert">
      <Text style={styles.failedTitle}>Aisle could not start.</Text>
      <Text style={styles.failedBody}>{message}</Text>
      <Text style={styles.failedBody}>
        Rebuild the development client after a native change, or run with EXPO_PUBLIC_MOCK=1 to use the fixtures.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  failed: { flex: 1, backgroundColor: '#000', padding: 24, justifyContent: 'center', gap: 12 },
  failedTitle: { color: '#fff', fontSize: 24, fontWeight: '700' },
  failedBody: { color: '#ddd', fontSize: 16, lineHeight: 22 },
});
