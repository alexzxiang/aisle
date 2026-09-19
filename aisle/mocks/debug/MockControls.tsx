/**
 * DebugPanel mock controls (05 Part 5). A mounts this through DebugPanel's
 * `mockControls` slot; D owns the contents. Every control is a large labelled
 * button — the panel is used with a cane in the other hand.
 *
 * Sections render only when their dependency is wired, so the same component works
 * on the live build (manual signal state via B's `CrossingController.setManualSignal`,
 * `forceEnter`, scan-result override, network toggle) and in mock mode (plus
 * jump-to-mode, the track scrubber, the perception pack).
 *
 * Nothing here calls `setMode()`: jumps emit the legal event chain (mocks/phases.ts),
 * overrides inject the events the real emitters would have produced (01 §5).
 */
import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { CrossingController, EventBus, TransitionSignals } from '../../src/core/contracts';
import type { MockHarness } from '../index';
import type { MockPerceptionService } from '../perception';
import type { ReplayPhase } from '../track';
import {
  JUMP_TARGETS,
  SCAN_RESULTS,
  SCAN_SIDES,
  SIGNAL_OPTIONS,
  SKIP_TO_AISLE_PHASE,
  type SignalOption,
  formatSeconds,
  formatTransitionSignals,
  networkLabel,
  playLabel,
  scanResultEvent,
  signalStateEvent,
  speedLabel,
} from './controlsModel';

export interface TransitionPort {
  forceEnter(): void;
  /** Last TransitionSignals with the running sum (createTransitionDetector().trace()). */
  trace?(): { signals: TransitionSignals; confidence: number } | null;
}

export interface ReplayModePort {
  enabled: boolean;
  toggle(): void;
}

export interface MockControlsProps {
  bus: Pick<EventBus, 'emit'>;
  /** Mock-mode harness (createMockServices().harness). Absent on the live build. */
  harness?: MockHarness;
  perception?: Pick<MockPerceptionService, 'debug'>;
  transition?: TransitionPort;
  /** B's controller — rung 4 must work on the live build, not only in mock. */
  crossing?: Pick<CrossingController, 'setManualSignal'>;
  replayMode?: ReplayModePort;
  /** Refresh interval for the readouts. Default 500 ms; 0 disables (tests). */
  pollMs?: number;
}

export const MOCK_CONTROLS_TITLE = 'Mock controls';
export const FORCE_ENTER_LABEL = 'FORCE ENTER STORE';
export const SKIP_TO_AISLE_LABEL = 'SKIP TO AISLE';

export function MockControls(props: MockControlsProps): React.JSX.Element {
  const { bus, harness, perception, transition, crossing, replayMode } = props;
  const [, setTick] = useState(0);
  const [activeSignal, setActiveSignal] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<string>('');

  useEffect(() => {
    const ms = props.pollMs ?? 500;
    if (ms <= 0) return undefined;
    const h = setInterval(() => setTick((t) => (t + 1) % 1_000_000), ms);
    return () => clearInterval(h);
  }, [props.pollMs]);

  const note = (s: string): void => setLastAction(s);

  const onSignal = (o: SignalOption): void => {
    setActiveSignal(o.state === null ? null : o.label);
    if (crossing) {
      crossing.setManualSignal(o.state);
    } else if (harness) {
      harness.forceSignalState(o.state, o.fresh);
    } else {
      const e = signalStateEvent(o);
      if (e) bus.emit(e);
    }
    note(`signal → ${o.label}`);
  };

  const onJump = (phase: ReplayPhase): void => {
    if (!harness) return;
    const spec = harness.jumpToPhase(phase);
    note(spec ? `jump → ${phase} (t=${spec.t}s, ${spec.pack})` : `jump → ${phase}: no track entry`);
  };

  const trace = transition?.trace?.() ?? null;
  const pdebug = perception?.debug();
  const timeS = harness?.getTimeS() ?? 0;
  const durationS = harness?.getDurationS() ?? 0;

  return (
    <View style={styles.root} accessibilityRole="summary" accessibilityLabel={MOCK_CONTROLS_TITLE}>
      <Text style={styles.title}>{MOCK_CONTROLS_TITLE}</Text>

      <Row>
        {transition && <Big label={FORCE_ENTER_LABEL} onPress={() => { transition.forceEnter(); note('forceEnter'); }} testID="mock-force-enter" />}
        {harness && <Big label={SKIP_TO_AISLE_LABEL} onPress={() => onJump(SKIP_TO_AISLE_PHASE)} testID="mock-skip-aisle" />}
      </Row>

      <Text style={styles.mono}>{formatTransitionSignals(trace?.signals, trace?.confidence)}</Text>

      <Section title="Manual signal state (rung 4)">
        <Wrap>
          {SIGNAL_OPTIONS.map((o) => (
            <Big key={o.label} label={o.label} selected={activeSignal === o.label} onPress={() => onSignal(o)} testID={`mock-signal-${o.label}`} />
          ))}
        </Wrap>
        {!crossing && <Text style={styles.hint}>{harness ? 'via perception mock (no CrossingController wired)' : 'via SIGNAL_STATE on the bus (no controller, no mock)'}</Text>}
      </Section>

      <Section title="Scan-result override (source: claude)">
        {SCAN_SIDES.map((side) => (
          <Wrap key={side}>
            {SCAN_RESULTS.map((v) => (
              <Big
                key={`${side}-${v}`}
                label={`${side} ${v}`}
                onPress={() => { bus.emit(scanResultEvent(side, v)); note(`SCAN_RESULT ${side} ${v}`); }}
                testID={`mock-scan-${side}-${v}`}
              />
            ))}
          </Wrap>
        ))}
      </Section>

      {harness && (
        <Section title="Replay track">
          <Text style={styles.mono}>
            {`${formatSeconds(timeS)} / ${formatSeconds(durationS)}  ${speedLabel(harness.getSpeed())}  pack: ${pdebug?.pack ?? harness.packNames()[0] ?? '—'}`}
          </Text>
          <Wrap>
            <Big label={playLabel(harness.isPlaying())} onPress={() => { if (harness.isPlaying()) harness.pause(); else harness.play(); note(harness.isPlaying() ? 'play' : 'pause'); }} testID="mock-play" />
            <Big label="−10 s" onPress={() => { harness.scrub(Math.max(0, timeS - 10)); note('scrub −10'); }} testID="mock-back" />
            <Big label="+10 s" onPress={() => { harness.scrub(timeS + 10); note('scrub +10'); }} testID="mock-fwd" />
            <Big label={harness.getSpeed() === 4 ? 'SPEED 1×' : 'SPEED 4×'} onPress={() => { harness.setSpeed(harness.getSpeed() === 4 ? 1 : 4); note('speed'); }} testID="mock-speed" />
          </Wrap>
          <Text style={styles.hint}>Jump to mode (emits the legal event chain from IDLE)</Text>
          <Wrap>
            {JUMP_TARGETS.map((j) => (
              <Big key={j.phase} label={j.label} onPress={() => onJump(j.phase)} testID={`mock-jump-${j.phase}`} />
            ))}
          </Wrap>
          {pdebug && (
            <Text style={styles.mono}>
              {`perception: ${pdebug.running ? 'running' : 'stopped'} ${pdebug.profile} t=${Math.round(pdebug.packTimeMs / 1000)}s emitted ${pdebug.emitted} skipped ${pdebug.skippedLines} unknown ${pdebug.unknownEvents}\n` +
                `crossingBearing ${pdebug.crossingBearingDeg ?? '—'} courseRef ${pdebug.courseReference?.bearingDeg ?? '—'} bodyOffset ${pdebug.bodyOffsetDeg} knownSigns ${pdebug.knownSigns.length} tracking ${pdebug.trackingState}` +
                (pdebug.forcedSignal ? ` forced ${pdebug.forcedSignal.state}` : '')}
            </Text>
          )}
        </Section>
      )}

      <Section title="Network and replay">
        <Wrap>
          {harness && (
            <Big label={networkLabel(harness.network.isOnline())} selected={!harness.network.isOnline()} onPress={() => { harness.network.toggle(); note(networkLabel(harness.network.isOnline())); }} testID="mock-network" />
          )}
          {replayMode && (
            <Big label={replayMode.enabled ? 'REPLAY MODE: ON' : 'REPLAY MODE: OFF'} selected={replayMode.enabled} onPress={() => { replayMode.toggle(); note('replay mode'); }} testID="mock-replay" />
          )}
        </Wrap>
        {replayMode && <Text style={styles.hint}>Takes effect at the next trip start (services are built per session).</Text>}
      </Section>

      {lastAction !== '' && <Text style={styles.mono} accessibilityLiveRegion="polite">{`last: ${lastAction}`}</Text>}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Small local primitives (no dependency on A's ui/ so this file cannot break their tests)
// ---------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <View style={styles.section} accessibilityRole="summary" accessibilityLabel={title}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Row({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <View style={styles.row}>{children}</View>;
}

function Wrap({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <View style={styles.wrap}>{children}</View>;
}

function Big({ label, onPress, selected, testID }: { label: string; onPress: () => void; selected?: boolean; testID?: string }): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: selected === true }}
      testID={testID}
      style={({ pressed }) => [styles.btn, selected && styles.btnSelected, pressed && styles.btnPressed]}
    >
      <Text style={styles.btnLabel} allowFontScaling maxFontSizeMultiplier={1.6}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { paddingVertical: 12, gap: 8 },
  title: { fontSize: 18, fontWeight: '700', color: '#ffffff' },
  section: { gap: 6, marginTop: 8 },
  sectionTitle: { fontSize: 14, fontWeight: '600', color: '#c9c9c9' },
  row: { flexDirection: 'row', gap: 8 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  btn: {
    minHeight: 64,
    minWidth: 120,
    paddingHorizontal: 14,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 10,
    backgroundColor: '#2a2a2e',
    borderWidth: 2,
    borderColor: '#3a3a40',
  },
  btnSelected: { borderColor: '#ffd166', backgroundColor: '#3b3520' },
  btnPressed: { opacity: 0.7 },
  btnLabel: { fontSize: 16, fontWeight: '700', color: '#ffffff', textAlign: 'center' },
  mono: { fontFamily: 'Menlo', fontSize: 12, color: '#d0d0d0' },
  hint: { fontSize: 12, color: '#9a9a9a' },
});

export default MockControls;
