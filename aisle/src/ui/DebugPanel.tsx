/**
 * DebugPanel (02 Task 9): a slide-up sheet, monospace inside, opened by a
 * 1.5 s long-press on the mode word. Every other agent debugs through it.
 *
 * Readouts come from the store, the sensors and perception services and the
 * optional `metrics` prop (tier latencies and speech counters live in modules
 * the integrator wires). Overrides that belong to B and D -- jump-to-mode,
 * manual signal state, forceEnter, scan-result override, fixture picks --
 * mount through the `mockControls` slot.
 */
import React, { useEffect, useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { PerceptionService, TrackingState } from '../core/contracts';
import { SPEECH_RATE_MAX, SPEECH_RATE_MIN } from '../core/store';
import { Button } from './Button';
import { useBus, useNow, useOptionalService, useStoreSlice, useUiFacts } from './hooks';
import { DASH, eventLines, fmtDeg, fmtFix, fmtFps, fmtHeading, fmtMs, fmtNum } from './debugFormat';
import { ageText } from './derive';
import type { AudioPorts, DebugMetrics } from './ports';
import { colors, monoFontFamily, sizes, space } from './theme';

export const DEBUG_TITLE = 'Debug';
export const DEBUG_CLOSE_LABEL = 'Close debug panel';
export const DEBUG_ABORT_LABEL = 'Abort to idle';
export const DEBUG_POLL_MS = 1000;

type Stats = ReturnType<PerceptionService['getStats']>;

/** What the real SpeechService (src/core/speech.ts) exposes; read by duck-typing so stubs still work. */
interface SpeechStatsLike {
  utterancesPerMinute: number;
  policyDropped: number;
  lastBackend: string | null;
}

function speechStatsOf(speech: unknown): SpeechStatsLike | null {
  if (!speech || typeof speech !== 'object') return null;
  const fn = (speech as { getStats?: unknown }).getStats;
  if (typeof fn !== 'function') return null;
  try {
    return fn.call(speech) as SpeechStatsLike;
  } catch {
    return null;
  }
}

/** What the real HapticService (src/core/haptics.ts) exposes about COURSE; duck-typed like speech. */
interface CourseStateLike {
  running: boolean;
  buzzing: boolean;
  suspended: boolean;
  schedule: { e: number; intervalMs: number | null; style: string | null; correction: string | null; roadward: boolean } | null;
  lastPattern: string | null;
}

function courseStateOf(haptics: unknown): CourseStateLike | null {
  if (!haptics || typeof haptics !== 'object') return null;
  const fn = (haptics as { getDebugState?: unknown }).getDebugState;
  if (typeof fn !== 'function') return null;
  try {
    return fn.call(haptics) as CourseStateLike;
  } catch {
    return null;
  }
}

function fmtCourse(c: CourseStateLike | null): string[] {
  if (!c) return [`course    ${DASH}`];
  const state = c.suspended ? 'suspended' : !c.running ? 'off' : c.buzzing ? 'buzzing' : 'silent';
  const sch = c.schedule;
  const err = sch ? `e ${sch.e.toFixed(0)}°  ${sch.intervalMs === null ? DASH : `${sch.intervalMs} ms`} ${sch.style ?? ''}`.trimEnd() : DASH;
  const turn = sch?.correction ? `turn ${sch.correction.toLowerCase()}` : '';
  const road = sch?.roadward ? 'roadward' : '';
  return [
    `course    ${state}   last ${c.lastPattern ?? DASH}`,
    `error     ${err}   ${[turn, road].filter(Boolean).join('  ')}`.trimEnd(),
  ];
}

interface Live {
  fused: number | null;
  stats: Stats | null;
  tracking: TrackingState | null;
  speech: SpeechStatsLike | null;
  course: CourseStateLike | null;
  beaconMuted: boolean | null;
  tickerMuted: boolean | null;
}

const EMPTY_LIVE: Live = { fused: null, stats: null, tracking: null, speech: null, course: null, beaconMuted: null, tickerMuted: null };

export interface DebugPanelProps {
  visible: boolean;
  onClose: () => void;
  metrics?: DebugMetrics;
  /** Beacon / ticker, for the mute overrides. */
  audio?: AudioPorts;
  /** D's mock controls (05 Part 5). Rendered below the readouts. */
  mockControls?: React.ReactNode;
}

function Line({ children }: { children: string }): React.JSX.Element {
  return (
    <Text style={styles.mono} allowFontScaling maxFontSizeMultiplier={1.4}>
      {children}
    </Text>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <View style={styles.section} accessibilityRole="summary" accessibilityLabel={title}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

export function DebugPanel({ visible, onClose, metrics, audio, mockControls }: DebugPanelProps): React.JSX.Element {
  const mode = useStoreSlice((s) => s.mode);
  const illegal = useStoreSlice((s) => s.illegalTransitions);
  const heading = useStoreSlice((s) => s.heading);
  const lastFix = useStoreSlice((s) => s.lastFix);
  const bodyOffsetDeg = useStoreSlice((s) => s.bodyOffsetDeg);
  const lastEvents = useStoreSlice((s) => s.lastEvents);
  const targetItem = useStoreSlice((s) => s.targetItem);
  const activeCrossingId = useStoreSlice((s) => s.activeCrossingId);
  const training = useStoreSlice((s) => s.trainingMode);
  const setTrainingMode = useStoreSlice((s) => s.setTrainingMode);
  const speechRate = useStoreSlice((s) => s.speechRate);
  const setSpeechRate = useStoreSlice((s) => s.setSpeechRate);
  const abort = useStoreSlice((s) => s.abort);
  const setBodyOffsetDeg = useStoreSlice((s) => s.setBodyOffsetDeg);

  const bus = useBus();
  const sensors = useOptionalService('sensors');
  const perception = useOptionalService('perception');
  const speech = useOptionalService('speech');
  const haptics = useOptionalService('haptics');
  const facts = useUiFacts();
  const now = useNow(DEBUG_POLL_MS);

  const [live, setLive] = useState<Live>(EMPTY_LIVE);
  const [calibrating, setCalibrating] = useState(false);

  const beacon = audio?.beacon;
  const ticker = audio?.ticker;

  useEffect(() => {
    if (!visible) return undefined;
    const read = (): void => {
      setLive({
        fused: sensors?.getFusedHeadingDeg() ?? null,
        stats: perception?.getStats() ?? null,
        tracking: perception?.getTrackingState() ?? null,
        speech: speechStatsOf(speech),
        course: courseStateOf(haptics),
        beaconMuted: beacon?.isMuted ? beacon.isMuted() : null,
        tickerMuted: ticker?.isMuted ? ticker.isMuted() : null,
      });
    };
    read();
    const id = setInterval(read, DEBUG_POLL_MS);
    return () => clearInterval(id);
  }, [visible, sensors, perception, speech, haptics, beacon, ticker]);

  const toggleBeacon = (): void => {
    if (!beacon?.setMuted) return;
    const next = !(beacon.isMuted ? beacon.isMuted() : live.beaconMuted === true);
    beacon.setMuted(next);
    setLive((l) => ({ ...l, beaconMuted: next }));
  };
  const toggleTicker = (): void => {
    if (!ticker?.setMuted) return;
    const next = !(ticker.isMuted ? ticker.isMuted() : live.tickerMuted === true);
    ticker.setMuted(next);
    setLive((l) => ({ ...l, tickerMuted: next }));
  };

  const recalibrate = (): void => {
    if (!sensors || calibrating) return;
    setCalibrating(true);
    sensors
      .calibrateBodyOffset()
      .then((r) => {
        setBodyOffsetDeg(r.offsetDeg);
        if (r.ok) perception?.setBodyOffsetDeg(r.offsetDeg);
      })
      .catch(() => undefined)
      .finally(() => setCalibrating(false));
  };

  const nudgeRate = (delta: number): void => {
    const next = Math.min(SPEECH_RATE_MAX, Math.max(SPEECH_RATE_MIN, Math.round((speechRate + delta) * 10) / 10));
    setSpeechRate(next);
    speech?.setRate(next);
  };

  const m = metrics ?? {};
  const s = live.stats;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.sheet}>
        <View style={styles.header}>
          <Text accessibilityRole="header" style={styles.title}>
            {DEBUG_TITLE}
          </Text>
          <Button label={DEBUG_CLOSE_LABEL} onPress={onClose} size="compact" />
        </View>

        <ScrollView contentContainerStyle={styles.content}>
          <Section title="State">
            <Line>{`mode      ${mode}`}</Line>
            <Line>{`item      ${targetItem ?? DASH}   crossing ${activeCrossingId ?? DASH}`}</Line>
            <Line>{`illegal   ${illegal}   bus seq ${bus.seq()}   listeners ${bus.listenerCount()}`}</Line>
          </Section>

          <Section title="Heading">
            <Line>{`compass   ${fmtHeading(heading)}`}</Line>
            <Line>{`fused     ${fmtDeg(live.fused)}   body offset ${fmtDeg(bodyOffsetDeg)}`}</Line>
            <Line>{`tracking  ${live.tracking ?? DASH}`}</Line>
          </Section>

          <Section title="GPS">
            {fmtFix(lastFix).map((l) => (
              <Line key={l}>{l}</Line>
            ))}
          </Section>

          <Section title="Latency">
            <Line>{`tier 0    frame→event ${fmtMs(m.tier0FrameToEventMs ?? s?.frameToEventMs)}`}</Line>
            <Line>{`tier 1    last ${fmtMs(m.tier1LastMs)}   p95 ${fmtMs(m.tier1P95Ms)}`}</Line>
            <Line>{`tier 2    first token ${fmtMs(m.tier2FirstTokenMs)}   fallback ${m.tier2Fallback === undefined || m.tier2Fallback === null ? DASH : m.tier2Fallback ? 'yes' : 'no'}`}</Line>
          </Section>

          <Section title="Perception">
            <Line>{`detector  ${fmtFps(s?.detectorFps)}   depth ${fmtFps(s?.depthFps)}   ocr ${fmtFps(s?.ocrFps)}`}</Line>
            <Line>{`thermal   ${s?.thermalState ?? DASH}`}</Line>
            <Line>
              {facts.signal
                ? `signal    ${facts.signal.state}   fresh ${facts.signal.fresh ? 'yes' : 'no'}   conf ${facts.signal.confidence.toFixed(2)}   ${ageText(facts.signal.ts, now)}`
                : `signal    ${DASH}`}
            </Line>
          </Section>

          <Section title="Haptics">
            {fmtCourse(live.course).map((l) => (
              <Line key={l}>{l}</Line>
            ))}
          </Section>

          <Section title="Speech">
            <Line>{`per min   ${fmtNum(m.utterancesPerMinute ?? live.speech?.utterancesPerMinute, 1)}   backend ${m.lastSpeechBackend ?? live.speech?.lastBackend ?? DASH}   dropped ${fmtNum(m.policyDroppedCount ?? live.speech?.policyDropped)}`}</Line>
            <Line>{`rate      ${speechRate.toFixed(1)}   training ${training ? 'on' : 'off'}   battery ${fmtNum(m.batteryPercent, 0, '%')}`}</Line>
          </Section>

          <Section title="Last events">
            {lastEvents.length === 0 ? <Line>{DASH}</Line> : eventLines(lastEvents).map((l, i) => <Line key={`${i}-${l}`}>{l}</Line>)}
          </Section>

          <Section title="Overrides">
            <View style={styles.row}>
              <Button label={`Training ${training ? 'off' : 'on'}`} onPress={() => setTrainingMode(!training)} size="compact" style={styles.grow} />
              <Button label="Rate −" onPress={() => nudgeRate(-0.1)} size="compact" style={styles.grow} />
              <Button label="Rate +" onPress={() => nudgeRate(0.1)} size="compact" style={styles.grow} />
            </View>
            <View style={styles.row}>
              <Button
                label={live.beaconMuted ? 'Unmute beacon' : 'Mute beacon'}
                onPress={toggleBeacon}
                disabled={!beacon?.setMuted}
                size="compact"
                style={styles.grow}
              />
              <Button
                label={live.tickerMuted ? 'Unmute ticker' : 'Mute ticker'}
                onPress={toggleTicker}
                disabled={!ticker?.setMuted}
                size="compact"
                style={styles.grow}
              />
            </View>
            <View style={styles.row}>
              <Button label={calibrating ? 'Calibrating…' : 'Recalibrate body offset'} onPress={recalibrate} disabled={calibrating || !sensors} size="compact" style={styles.grow} />
              <Button label={DEBUG_ABORT_LABEL} onPress={abort} size="compact" style={styles.grow} />
            </View>
          </Section>

          {mockControls ? (
            <Section title="Mock controls">
              {mockControls}
            </Section>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: sizes.gutter,
    paddingTop: space.xl,
    paddingBottom: space.m,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
  },
  title: {
    fontFamily: monoFontFamily,
    fontSize: 20,
    fontWeight: '700',
    color: colors.text,
  },
  content: {
    paddingHorizontal: sizes.gutter,
    paddingVertical: space.l,
    gap: space.l,
  },
  section: {
    gap: space.xs,
  },
  sectionTitle: {
    fontFamily: monoFontFamily,
    fontSize: 13,
    color: colors.meta,
    marginBottom: space.xs,
  },
  mono: {
    fontFamily: monoFontFamily,
    fontSize: 13,
    lineHeight: 18,
    color: colors.text,
    fontVariant: ['tabular-nums'],
  },
  row: {
    flexDirection: 'row',
    gap: space.s,
    marginTop: space.s,
  },
  grow: {
    flex: 1,
  },
});
