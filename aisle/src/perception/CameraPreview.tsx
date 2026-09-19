/**
 * CameraPreview — what the camera sees (09 §8 "Preview view").
 *
 * Renders the native `PerceptionPreviewView` (an ARSCNView that borrows the
 * engine's one ARSession — no second camera session, 09 §1) and draws the
 * module's `onDetections` boxes over it: normalized `[x, y, w, h]` in the
 * upright frame → absolutely positioned views, one colour per kept class, a
 * `car 0.81` label, at most 5 Hz. The overlay is hidden from VoiceOver: the
 * perception strip is the accessible account of the same facts.
 *
 * When the native view is not linked (Expo Go, Jest) or the composition root
 * says `mock` (D's replayer never starts the engine, so the native view would
 * stay black), a placeholder panel says "Camera preview" and shows the last
 * replayed frame from `snapshotJPEG(512)`, polled once a second.
 *
 * Native behaviour to know about (documented in the Swift header too): the
 * preview is black until the engine's `start()`, and it freezes on the last
 * frame while the IDLE profile keeps the session paused. Neither is an error.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Image, StyleSheet, Text, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import type { Detection, PerceptionService } from '../core/contracts';
import { services } from '../core/services';
import { getPerceptionNative, getPerceptionPreviewView, type PerceptionPreviewReadyEvent } from '../../modules/perception';

export interface CameraPreviewProps {
  style?: StyleProp<ViewStyle>;
  /** Draw detection boxes. Default true. */
  showDetections?: boolean;
  /** Horizontal flip. Default false (rear camera). Boxes flip with the image. */
  mirror?: boolean;
  /** Once, when the surface is up: native view attached, or the placeholder mounted. */
  onReady?: () => void;
  testID?: string;
  /**
   * Composition-root flag (App.tsx reads `config.mock`, like `IntegrationControls`'
   * `mock` prop): force the placeholder even when the native view is linked.
   */
  mock?: boolean;
  /** Default: `services.tryGet('perception')`. */
  perception?: PerceptionService;
}

/** True when both the native module and its preview view are linked. */
export function isCameraPreviewAvailable(): boolean {
  return getPerceptionNative() !== null && getPerceptionPreviewView() !== null;
}

// ---------------------------------------------------------------------------
// Pure helpers (tested)
// ---------------------------------------------------------------------------

/** One colour per kept class (09 §3). Vehicles warm, people/carts cool, signals in OKO's convention. */
export const DETECTION_COLORS: Readonly<Record<Detection['cls'], string>> = Object.freeze({
  car: '#FF8A1F',
  bus: '#FFC21F',
  truck: '#FF5A5A',
  motorcycle: '#FF9E80',
  bicycle: '#5AC8FA',
  person: '#34E0A1',
  cart: '#C29BFF',
  ped_walk: '#3DDC84',
  ped_hand: '#FF4D4D',
  ped_countdown: '#FFA726',
});

/** Short names for the label; a class without an entry uses its own name. */
const DETECTION_NAMES: Readonly<Partial<Record<Detection['cls'], string>>> = Object.freeze({
  ped_walk: 'walk',
  ped_hand: 'hand',
  ped_countdown: 'countdown',
});

export const KEPT_CLASSES: ReadonlySet<string> = new Set(Object.keys(DETECTION_COLORS));

/** The module's rate is ≤ 5 Hz (09 §6); the overlay never redraws faster. */
export const OVERLAY_MIN_INTERVAL_MS = 200;
/** Boxes older than this (no event since) are dropped so a paused session shows none. */
export const OVERLAY_STALE_MS = 1500;
/** Placeholder frame poll (mock replayer). */
export const PLACEHOLDER_FRAME_INTERVAL_MS = 1000;

export const PREVIEW_LABEL = 'Camera preview';

/** `car 0.81`. Score clamped to 0..1, two decimals. */
export function detectionLabel(d: Pick<Detection, 'cls' | 'score'>): string {
  const score = Math.min(1, Math.max(0, Number.isFinite(d.score) ? d.score : 0));
  return `${DETECTION_NAMES[d.cls] ?? d.cls} ${score.toFixed(2)}`;
}

/** Drop anything that is not a kept class (the replayer may carry extra labels) or has a degenerate box. */
export function keptDetections(items: readonly Detection[]): Detection[] {
  return items.filter((d) => {
    if (!KEPT_CLASSES.has(d.cls)) return false;
    const b = d.box;
    return Array.isArray(b) && b.length === 4 && b.every((v) => Number.isFinite(v)) && b[2] > 0 && b[3] > 0;
  });
}

export interface BoxLayout { left: number; top: number; width: number; height: number }

/** Normalized upright-frame box → pixels in a `width × height` view; mirrored around the vertical axis when asked. */
export function boxToLayout(box: Detection['box'], width: number, height: number, mirror = false): BoxLayout {
  const [x, y, w, h] = box;
  const cx = Math.max(0, Math.min(1, x));
  const cy = Math.max(0, Math.min(1, y));
  const cw = Math.max(0, Math.min(1 - cx, w));
  const ch = Math.max(0, Math.min(1 - cy, h));
  const left = mirror ? 1 - cx - cw : cx;
  return { left: px(left * width), top: px(cy * height), width: px(cw * width), height: px(ch * height) };
}

/** Layout values to 1/100 px: stable keys for React and no float noise (`120.00000000000001`). */
function px(v: number): number {
  return Math.round(v * 100) / 100;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CameraPreview(props: CameraPreviewProps): React.JSX.Element {
  const { style, showDetections = true, mirror = false, onReady, testID, mock = false } = props;
  const perception = props.perception ?? services.tryGet('perception');
  const Native = mock ? null : getPerceptionNative() !== null ? getPerceptionPreviewView() : null;

  const [size, setSize] = useState({ width: 0, height: 0 });
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
  }, []);

  const detections = useDetections(perception, showDetections);

  const readyRef = useRef(onReady);
  readyRef.current = onReady;
  const readySent = useRef(false);
  const fireReady = useCallback(() => {
    if (readySent.current) return;
    readySent.current = true;
    readyRef.current?.();
  }, []);
  const onNativeReady = useCallback((_e: { nativeEvent: PerceptionPreviewReadyEvent }) => fireReady(), [fireReady]);

  const frameUri = usePlaceholderFrame(Native ? null : perception);
  useEffect(() => {
    if (!Native) fireReady();
  }, [Native, fireReady]);

  const overlay = showDetections && size.width > 0 && detections.length > 0 ? (
    <View
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID={testID ? `${testID}-overlay` : undefined}
    >
      {detections.map((d) => {
        const color = DETECTION_COLORS[d.cls];
        const l = boxToLayout(d.box, size.width, size.height, mirror);
        return (
          <View key={`${d.trackId}-${d.cls}`} style={[styles.box, { borderColor: color, left: l.left, top: l.top, width: l.width, height: l.height }]}>
            <View style={[styles.tag, { backgroundColor: color }]}>
              <Text style={styles.tagText} numberOfLines={1} allowFontScaling={false}>{detectionLabel(d)}</Text>
            </View>
          </View>
        );
      })}
    </View>
  ) : null;

  if (Native) {
    return (
      <View style={[styles.root, style]} onLayout={onLayout} testID={testID} accessible accessibilityRole="image" accessibilityLabel={PREVIEW_LABEL}>
        <Native style={StyleSheet.absoluteFill} mirror={mirror} onReady={onNativeReady} testID={testID ? `${testID}-native` : undefined} />
        {overlay}
      </View>
    );
  }

  return (
    <View style={[styles.root, style]} onLayout={onLayout} testID={testID} accessible accessibilityRole="image" accessibilityLabel={PREVIEW_LABEL}>
      {frameUri ? (
        <Image
          source={{ uri: frameUri }}
          style={[StyleSheet.absoluteFill, mirror ? styles.mirrored : null]}
          resizeMode="cover"
          testID={testID ? `${testID}-frame` : undefined}
        />
      ) : null}
      <View style={styles.placeholder} pointerEvents="none">
        <Text style={styles.placeholderTitle} allowFontScaling maxFontSizeMultiplier={1.4}>{PREVIEW_LABEL}</Text>
        <Text style={styles.placeholderMeta} allowFontScaling maxFontSizeMultiplier={1.4}>
          {frameUri ? 'Replaying recorded frames' : 'Not available on this build'}
        </Text>
      </View>
      {overlay}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** Latest kept detections, redrawn at most every OVERLAY_MIN_INTERVAL_MS and dropped after OVERLAY_STALE_MS. */
function useDetections(perception: PerceptionService | undefined, enabled: boolean): Detection[] {
  const [items, setItems] = useState<Detection[]>([]);
  useEffect(() => {
    if (!perception || !enabled) {
      setItems([]);
      return undefined;
    }
    let lastFlush = 0;
    let pending: Detection[] | null = null;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let staleTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const armStale = () => {
      if (staleTimer) clearTimeout(staleTimer);
      staleTimer = setTimeout(() => {
        staleTimer = null;
        if (!disposed) setItems([]);
      }, OVERLAY_STALE_MS);
    };
    const flush = () => {
      flushTimer = null;
      if (disposed || !pending) return;
      lastFlush = Date.now();
      setItems(pending);
      pending = null;
      armStale();
    };
    const unsubscribe = perception.onDetections((list) => {
      pending = keptDetections(list);
      const wait = OVERLAY_MIN_INTERVAL_MS - (Date.now() - lastFlush);
      if (wait <= 0) flush();
      else if (!flushTimer) flushTimer = setTimeout(flush, wait);
    });
    return () => {
      disposed = true;
      unsubscribe();
      if (flushTimer) clearTimeout(flushTimer);
      if (staleTimer) clearTimeout(staleTimer);
    };
  }, [perception, enabled]);
  return items;
}

/** Placeholder path only: the replayer's latest frame as a data URI, or null. Stops after three failures. */
function usePlaceholderFrame(perception: PerceptionService | null | undefined): string | null {
  const [uri, setUri] = useState<string | null>(null);
  useEffect(() => {
    if (!perception) {
      setUri(null);
      return undefined;
    }
    let disposed = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const snap = await perception.snapshotJPEG(512);
        if (disposed) return;
        if (snap && typeof snap.base64 === 'string' && snap.base64.length > 0) {
          setUri(`data:image/jpeg;base64,${snap.base64}`);
        }
        failures = 0;
      } catch {
        failures += 1;
      }
      if (!disposed && failures < 3) timer = setTimeout(() => { void tick(); }, PLACEHOLDER_FRAME_INTERVAL_MS);
    };
    void tick();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [perception]);
  return uri;
}

// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  root: {
    overflow: 'hidden',
    backgroundColor: '#000000',
    minHeight: 120,
  },
  mirrored: {
    transform: [{ scaleX: -1 }],
  },
  placeholder: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  placeholderTitle: {
    color: '#F2F4F7',
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: 0.2,
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowRadius: 6,
    textShadowOffset: { width: 0, height: 1 },
  },
  placeholderMeta: {
    marginTop: 4,
    color: '#A8B0BD',
    fontSize: 13,
    fontWeight: '500',
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowRadius: 6,
    textShadowOffset: { width: 0, height: 1 },
  },
  box: {
    position: 'absolute',
    borderWidth: 2,
    borderRadius: 4,
  },
  tag: {
    position: 'absolute',
    left: -2,
    top: -20,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderTopLeftRadius: 4,
    borderTopRightRadius: 4,
    maxWidth: 160,
  },
  tagText: {
    color: '#0A0C10',
    fontSize: 12,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
});
