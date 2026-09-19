/**
 * ScenePanel — what the app believes about where the user is (the awareness
 * loop, src/core/situate.ts), as one glass line under the camera.
 *
 *   Looks like: in a kitchen · say yes or no          (a guess, question open)
 *   You are: in the living room                       (confirmed, or the user's words)
 *   Looking around…                                   (nothing known yet)
 *
 * Purely presentational: the store's `scene` in, a line out. Accessible as a
 * summary so VoiceOver reads it as one sentence.
 */
import React from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import type { SceneHypothesis } from '../core/contracts';
import { GlassPanel } from './Glass';
import { colors, fontScaleCap, space, type } from './theme';

export const SCENE_LOOKING = 'Looking around…';
export const SCENE_GUESS_PREFIX = 'Looks like: ';
export const SCENE_KNOWN_PREFIX = 'You are: ';
export const SCENE_ANSWER_HINT = 'say yes or no';

export interface ScenePanelProps {
  scene: SceneHypothesis | null;
  style?: StyleProp<ViewStyle>;
  reduceMotion?: boolean;
  testID?: string;
}

/** The line the panel shows for a scene (tested). */
export function sceneLine(scene: SceneHypothesis | null): { text: string; hint: string | null } {
  if (!scene || !scene.label) return { text: SCENE_LOOKING, hint: null };
  if (scene.confirmed) return { text: `${SCENE_KNOWN_PREFIX}${scene.label}`, hint: null };
  return { text: `${SCENE_GUESS_PREFIX}${scene.label}`, hint: SCENE_ANSWER_HINT };
}

export function ScenePanel({ scene, style, reduceMotion, testID = 'scene-panel' }: ScenePanelProps): React.JSX.Element {
  const line = sceneLine(scene);
  return (
    <GlassPanel
      reduceMotion={reduceMotion}
      style={style}
      contentStyle={styles.row}
      accessible
      accessibilityRole="summary"
      accessibilityLabel={line.hint ? `${line.text}. ${line.hint}` : line.text}
      testID={testID}
    >
      <View style={styles.dot} />
      <Text allowFontScaling maxFontSizeMultiplier={fontScaleCap.body} style={styles.text} numberOfLines={2}>
        {line.text}
        {line.hint ? <Text style={styles.hint}>{`  ·  ${line.hint}`}</Text> : null}
      </Text>
    </GlassPanel>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: space.m,
    paddingHorizontal: space.l,
    gap: space.m,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.secondary,
  },
  text: {
    ...type.body,
    color: colors.text,
    flexShrink: 1,
  },
  hint: {
    ...type.meta,
    color: colors.secondary,
  },
});
