/**
 * The camera panel (DESIGN.md, "The camera panel"): what Aisle sees, 4:3,
 * rounded glass, with the perception strip as a compact glass row over its
 * bottom edge.
 *
 * The preview itself is Agent C's `CameraPreview` (src/perception/
 * CameraPreview.tsx): the native ARKit view with detection boxes, or its own
 * "Camera preview" placeholder in mock mode. It is required at runtime so
 * this file, and the screen tests, stand without it; when the module is
 * absent the panel shows the same placeholder wording.
 *
 * For VoiceOver the panel is one image element ("Camera view") followed by
 * the three strip sentences; the boxes and labels the preview draws are
 * decoration for the sighted teammate and the judges.
 */
import React from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { GlassPanel } from './Glass';
import { PerceptionStrip } from './PerceptionStrip';
import type { StripSlot } from './derive';
import { colors, fontScaleCap, glass, sizes, space, type } from './theme';

export const CAMERA_LABEL = 'Camera view';
export const CAMERA_PLACEHOLDER = 'Camera preview';
export const CAMERA_PLACEHOLDER_DETAIL = 'Shows what Aisle sees while it guides you.';

interface CameraPreviewLikeProps {
  style?: StyleProp<ViewStyle>;
  showDetections?: boolean;
  mirror?: boolean;
  onReady?: () => void;
  testID?: string;
}

type CameraPreviewComponent = React.ComponentType<CameraPreviewLikeProps>;

let cameraPreview: CameraPreviewComponent | null = null;
let previewLinked: (() => boolean) | null = null;
try {
  // Agent C's module; optional so the UI compiles and tests before it lands.
  const mod = require('../perception/CameraPreview') as { CameraPreview?: CameraPreviewComponent; isCameraPreviewAvailable?: () => boolean };
  cameraPreview = typeof mod.CameraPreview === 'function' ? mod.CameraPreview : null;
  previewLinked = typeof mod.isCameraPreviewAvailable === 'function' ? mod.isCameraPreviewAvailable : null;
} catch {
  cameraPreview = null;
}

/** The native ARKit preview is in this binary (false on a build made before it, in Expo Go, in Jest). */
export function isCameraLive(): boolean {
  try {
    return cameraPreview !== null && (previewLinked?.() ?? false);
  } catch {
    return false;
  }
}

/** Whether Agent C's preview component is in this build. */
export function hasCameraPreview(): boolean {
  return cameraPreview !== null;
}

/** Tests: swap the preview implementation. */
export function setCameraPreviewForTests(impl: CameraPreviewComponent | null): void {
  cameraPreview = impl;
}

export interface CameraPanelProps {
  slots: StripSlot[];
  accent?: string;
  /** Caps the panel height on short screens; width still rules the 4:3 shape. */
  maxHeight?: number;
  style?: StyleProp<ViewStyle>;
  reduceMotion?: boolean;
}

export function CameraPanel({ slots, accent, maxHeight, style, reduceMotion }: CameraPanelProps): React.JSX.Element {
  const Preview = cameraPreview;
  return (
    <GlassPanel
      reduceMotion={reduceMotion}
      style={[styles.panel, maxHeight !== undefined && { maxHeight }, style]}
      contentStyle={styles.content}
      testID="camera-panel"
    >
      <View style={styles.viewfinder} accessible accessibilityRole="image" accessibilityLabel={CAMERA_LABEL}>
        {Preview ? (
          <Preview style={StyleSheet.absoluteFill} showDetections testID="camera-preview" />
        ) : (
          <View style={styles.placeholder} testID="camera-placeholder">
            <View style={styles.reticle} />
            <Text allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={styles.placeholderTitle}>
              {CAMERA_PLACEHOLDER}
            </Text>
            <Text allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={styles.placeholderDetail}>
              {CAMERA_PLACEHOLDER_DETAIL}
            </Text>
          </View>
        )}
      </View>
      <PerceptionStrip slots={slots} accent={accent} reduceMotion={reduceMotion} style={styles.strip} />
    </GlassPanel>
  );
}

const styles = StyleSheet.create({
  panel: {
    marginHorizontal: sizes.gutter,
    aspectRatio: sizes.cameraAspect,
    width: undefined,
  },
  content: {
    flex: 1,
    backgroundColor: colors.viewfinder,
  },
  viewfinder: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.viewfinder,
  },
  placeholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xl,
    paddingBottom: sizes.minTarget + space.l,
    gap: space.xs,
  },
  reticle: {
    width: 56,
    height: 56,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: glass.border,
    marginBottom: space.s,
    opacity: 0.6,
  },
  placeholderTitle: {
    ...type.body,
    fontWeight: '700',
    color: colors.viewfinderText,
    textAlign: 'center',
  },
  placeholderDetail: {
    ...type.meta,
    fontWeight: '500',
    color: colors.viewfinderText,
    opacity: 0.75,
    textAlign: 'center',
  },
  strip: {
    position: 'absolute',
    left: space.m,
    right: space.m,
    bottom: space.m,
  },
});
