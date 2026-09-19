import React from 'react';
import { act, create } from 'react-test-renderer';
import { SCENE_ANSWER_HINT, SCENE_GUESS_PREFIX, SCENE_KNOWN_PREFIX, SCENE_LOOKING, ScenePanel, sceneLine } from './ScenePanel';
import { findForbiddenTerm } from '../core/phrases';

const kitchen = { setting: 'kitchen' as const, label: 'in a kitchen', confidence: 0.8, confirmed: false, source: 'camera' as const, at: 0 };

describe('ScenePanel', () => {
  it('sceneLine: looking / guess with the answer hint / known', () => {
    expect(sceneLine(null)).toEqual({ text: SCENE_LOOKING, hint: null });
    expect(sceneLine({ ...kitchen, label: '' })).toEqual({ text: SCENE_LOOKING, hint: null });
    expect(sceneLine(kitchen)).toEqual({ text: `${SCENE_GUESS_PREFIX}in a kitchen`, hint: SCENE_ANSWER_HINT });
    expect(sceneLine({ ...kitchen, confirmed: true, source: 'user', label: 'in the living room' })).toEqual({ text: `${SCENE_KNOWN_PREFIX}in the living room`, hint: null });
    for (const s of [SCENE_LOOKING, SCENE_GUESS_PREFIX, SCENE_KNOWN_PREFIX, SCENE_ANSWER_HINT]) expect(findForbiddenTerm(s)).toBeNull();
  });

  it('renders as one accessible summary line', () => {
    let tree: ReturnType<typeof create> | null = null;
    act(() => {
      tree = create(<ScenePanel scene={kitchen} reduceMotion />);
    });
    const root = tree!.root;
    const panel = root.findByProps({ testID: 'scene-panel' });
    expect(panel.props.accessibilityRole).toBe('summary');
    expect(panel.props.accessibilityLabel).toBe(`${SCENE_GUESS_PREFIX}in a kitchen. ${SCENE_ANSWER_HINT}`);
    act(() => {
      tree!.update(<ScenePanel scene={{ ...kitchen, confirmed: true }} reduceMotion />);
    });
    expect(root.findByProps({ testID: 'scene-panel' }).props.accessibilityLabel).toBe(`${SCENE_KNOWN_PREFIX}in a kitchen`);
    act(() => tree!.unmount());
  });
});
