/**
 * JS bridge for the native `Perception` module (09 §8).
 *
 * This file is the typed edge of the bridge and nothing more: it resolves the
 * native module lazily (so importing it in mock mode never touches
 * `requireNativeModule`), names every event exactly as `Events.swift` does, and
 * unwraps the two wire envelopes (`{items}` for the array events, `{state}` for
 * tracking state) so callers see the payloads from 01 §7.
 *
 * The `PerceptionService` interface itself is implemented in
 * `src/perception/PerceptionService.ts`; App.tsx picks that or D's replayer.
 */
import type { ComponentType } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { NativeModule, requireNativeViewManager, requireOptionalNativeModule, type EventSubscription } from 'expo-modules-core';

import type {
  DepthSummary,
  Detection,
  Direction,
  DistanceClass,
  HazardKind,
  ModeProfile,
  OcrRead,
  Pose,
  SignalState,
  SceneClassEvent,
  Snapshot,
  TrackingState,
} from '../../src/core/contracts';

// ---------------------------------------------------------------------------
// Event payloads (01 §7 callback shapes)
// ---------------------------------------------------------------------------

export interface SignalStateEvent { state: SignalState; fresh: boolean; confidence: number; nOfM: number }
export interface VehicleApproachingEvent { direction: Direction; trackId: number; growth: number }
export interface ObstacleAheadEvent { distanceClass: DistanceClass; direction: Direction }
export interface HazardEvent { kind: HazardKind; direction: Direction }
export type LateralOffsetSource = 'pose' | 'ocr_box' | 'shelf' | 'curb' | 'none';
export interface LateralOffsetEvent { offsetM: number; source: LateralOffsetSource }
export interface PlanesEvent { floors: number; verticals: number }
export interface PerceptionStats {
  detectorFps: number; depthFps: number; ocrFps: number; frameToEventMs: number; thermalState: string;
}

/** Payload per event, after envelope unwrapping. */
export interface PerceptionEventMap {
  onSignalState: SignalStateEvent;
  onVehicleApproaching: VehicleApproachingEvent;
  onObstacleAhead: ObstacleAheadEvent;
  onHazard: HazardEvent;
  onOcrText: OcrRead[];
  onDetections: Detection[];
  onPose: Pose;
  onLateralOffset: LateralOffsetEvent;
  onPlanes: PlanesEvent;
  onDepth: DepthSummary;
  onTrackingState: TrackingState;
  onSceneClass: SceneClassEvent;
}

export type PerceptionEventName = keyof PerceptionEventMap;

/** Mirrors `PerceptionEventName.allCases` in Events.swift. Order is irrelevant; the set is the contract. */
export const EVENT_NAMES: readonly PerceptionEventName[] = [
  'onSignalState', 'onVehicleApproaching', 'onObstacleAhead', 'onHazard', 'onOcrText',
  'onDetections', 'onPose', 'onLateralOffset', 'onPlanes', 'onDepth', 'onTrackingState', 'onSceneClass',
];

// ---------------------------------------------------------------------------
// Wire shapes: what actually crosses the bridge
// ---------------------------------------------------------------------------

type WireEvents = {
  onSignalState: (e: SignalStateEvent) => void;
  onVehicleApproaching: (e: VehicleApproachingEvent) => void;
  onObstacleAhead: (e: ObstacleAheadEvent) => void;
  onHazard: (e: HazardEvent) => void;
  onOcrText: (e: { items: OcrRead[] }) => void;
  onDetections: (e: { items: Detection[] }) => void;
  onPose: (e: Pose) => void;
  onLateralOffset: (e: LateralOffsetEvent) => void;
  onPlanes: (e: PlanesEvent) => void;
  onDepth: (e: DepthSummary) => void;
  onTrackingState: (e: { state: TrackingState }) => void;
  onSceneClass: (e: SceneClassEvent) => void;
};

/**
 * The Swift `PerceptionModule` surface, as declared in `ios/PerceptionModule.swift`.
 * `declare class … extends NativeModule<Events>` is the SDK 52+ idiom (see
 * expo-file-system); an `interface extends` does not pick up `addListener`.
 */
export declare class PerceptionNativeModule extends NativeModule<WireEvents> {
  start(profile: ModeProfile): Promise<void>;
  setProfile(profile: ModeProfile): void;
  stop(): void;
  setCrossingBearing(bearingDeg: number | null): void;
  setCourseReference(bearingDeg: number | null): void;
  setBodyOffsetDeg(offsetDeg: number): void;
  setKnownSigns(words: string[]): void;
  snapshotJPEG(maxWidth: SnapshotWidth): Promise<Snapshot>;
  getTrackingState(): TrackingState;
  getStats(): PerceptionStats;
  /** 09 §10 fixture recorder: writes `{"t","event","payload"}` jsonl lines to `path`. */
  startDebugExport(path: string): Promise<void>;
  stopDebugExport(): Promise<string | null>;
  /** Video format + model load log for the DebugPanel (09 §6: never widens getStats). */
  nativeLog(): string[];
}

export const NATIVE_MODULE_NAME = 'Perception';

let cached: PerceptionNativeModule | null | undefined;

/**
 * Resolve the native module once. Returns `null` when it is not linked (Expo Go,
 * a JS-only build, Jest) instead of throwing, so the composition root can
 * decide what to do; `requirePerceptionNative()` is the throwing variant.
 */
export function getPerceptionNative(): PerceptionNativeModule | null {
  if (cached === undefined) {
    cached = requireOptionalNativeModule<PerceptionNativeModule>(NATIVE_MODULE_NAME);
  }
  return cached;
}

export function requirePerceptionNative(): PerceptionNativeModule {
  const mod = getPerceptionNative();
  if (!mod) {
    throw new Error(
      `[perception] native module '${NATIVE_MODULE_NAME}' is not linked. ` +
        'Run `npx expo prebuild && npx expo run:ios --device` (09 §8), or set EXPO_PUBLIC_MOCK=1.',
    );
  }
  return mod;
}

/** Tests / the composition root can inject a fake without touching globals. */
export function __setPerceptionNativeForTests(mod: PerceptionNativeModule | null | undefined): void {
  cached = mod;
}

// ---------------------------------------------------------------------------
// Preview view (ios/PerceptionPreviewView.swift, 09 §8 "Preview view")
// ---------------------------------------------------------------------------

/** `View(PerceptionPreviewView.self)` in PerceptionModule.swift; `ViewName(...)` there. */
export const NATIVE_PREVIEW_VIEW_NAME = 'PerceptionPreviewView';

export interface PerceptionPreviewReadyEvent {
  /** Always true: the ARSCNView now renders the engine's session. */
  attached: boolean;
  /** Whether that session had a frame at attach time; false ⇒ black until `start()`. */
  running: boolean;
}

/** Props of the raw native view. `src/perception/CameraPreview.tsx` wraps it. */
export interface PerceptionPreviewNativeProps {
  style?: StyleProp<ViewStyle>;
  /** Horizontal flip. Default false (the rear camera is not mirrored). */
  mirror?: boolean;
  onReady?: (e: { nativeEvent: PerceptionPreviewReadyEvent }) => void;
  testID?: string;
}

let cachedView: ComponentType<PerceptionPreviewNativeProps> | null | undefined;

/**
 * Resolve the native preview component once, or `null` when the view manager
 * is not linked (Expo Go, a JS-only build, Jest). The view borrows the
 * engine's ARSession: black before `start()`, frozen on the last frame while
 * the IDLE profile keeps the session paused (see the Swift header).
 */
/**
 * Is the view manager in this binary? `requireNativeViewManager` never throws: it
 * hands back an adapter that red-boxes "Unimplemented component" at render time
 * when the build predates the view. Expo's registry answers up front.
 */
interface ExpoGlobal {
  getViewConfig?: (moduleName: string, viewName?: string) => unknown;
  modules?: Record<string, { ViewPrototypes?: Record<string, unknown> } | undefined>;
}

let linkedLogged = false;

export function isPerceptionPreviewViewLinked(): boolean {
  const expo = (globalThis as { expo?: ExpoGlobal }).expo;
  if (!expo || typeof expo.getViewConfig !== 'function') return getPerceptionNative() !== null; // no registry (tests): follow the module
  // Three independent answers from the registry; any yes is a yes. The module has one
  // view, so its default view is the preview view (`getViewConfig(module)` alone).
  let named = false;
  let dflt = false;
  let prototypes = false;
  try {
    named = expo.getViewConfig(NATIVE_MODULE_NAME, NATIVE_PREVIEW_VIEW_NAME) != null;
  } catch { /* fall through */ }
  try {
    dflt = expo.getViewConfig(NATIVE_MODULE_NAME) != null;
  } catch { /* fall through */ }
  try {
    const protos = expo.modules?.[NATIVE_MODULE_NAME]?.ViewPrototypes;
    prototypes = !!protos && Object.keys(protos).length > 0;
  } catch { /* fall through */ }
  const linked = named || dflt || prototypes;
  if (!linkedLogged) {
    linkedLogged = true;
    // One line in Metro so a build mismatch is diagnosable from the laptop.
    console.log(`[perception] preview view ${linked ? 'linked' : 'NOT in this build'} (named=${named} default=${dflt} prototypes=${prototypes}, module=${getPerceptionNative() !== null})`);
  }
  return linked;
}

export function getPerceptionPreviewView(): ComponentType<PerceptionPreviewNativeProps> | null {
  if (cachedView === undefined) {
    try {
      cachedView = isPerceptionPreviewViewLinked()
        ? requireNativeViewManager<PerceptionPreviewNativeProps>(NATIVE_MODULE_NAME, NATIVE_PREVIEW_VIEW_NAME)
        : null;
    } catch {
      cachedView = null;
    }
  }
  return cachedView;
}

/** Tests inject a fake component (or `null` for the unavailable path). */
export function __setPerceptionPreviewViewForTests(view: ComponentType<PerceptionPreviewNativeProps> | null | undefined): void {
  cachedView = view;
}

// ---------------------------------------------------------------------------
// Typed subscriptions with envelope unwrapping
// ---------------------------------------------------------------------------

type Unsubscribe = () => void;

function toUnsubscribe(sub: EventSubscription): Unsubscribe {
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    sub.remove();
  };
}

/**
 * Subscribe to one native event and receive the 01 §7 payload. The array events
 * (`onOcrText`, `onDetections`) and `onTrackingState` are unwrapped here; the
 * others cross the bridge as-is.
 */
export function subscribePerceptionEvent<K extends PerceptionEventName>(
  native: PerceptionNativeModule,
  name: K,
  cb: (payload: PerceptionEventMap[K]) => void,
): Unsubscribe {
  switch (name) {
    case 'onOcrText':
      return toUnsubscribe(native.addListener('onOcrText', (e) => {
        (cb as (p: OcrRead[]) => void)(Array.isArray(e?.items) ? e.items : []);
      }));
    case 'onDetections':
      return toUnsubscribe(native.addListener('onDetections', (e) => {
        (cb as (p: Detection[]) => void)(Array.isArray(e?.items) ? e.items : []);
      }));
    case 'onTrackingState':
      return toUnsubscribe(native.addListener('onTrackingState', (e) => {
        (cb as (p: TrackingState) => void)(e.state);
      }));
    default: {
      // Every remaining event's wire shape equals its payload shape.
      const listener = cb as unknown as WireEvents[Exclude<K, 'onOcrText' | 'onDetections' | 'onTrackingState'>];
      return toUnsubscribe(
        native.addListener(
          name as Exclude<K, 'onOcrText' | 'onDetections' | 'onTrackingState'>,
          listener,
        ),
      );
    }
  }
}

export const SNAPSHOT_WIDTHS = [512, 640, 768, 1024] as const;
export type SnapshotWidth = (typeof SNAPSHOT_WIDTHS)[number];

export function isSnapshotWidth(w: number): w is SnapshotWidth {
  return (SNAPSHOT_WIDTHS as readonly number[]).includes(w);
}
