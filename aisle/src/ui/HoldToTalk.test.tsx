import React from 'react';
import { Text } from 'react-native';
import { act, create } from 'react-test-renderer';
import { HOLD_HINT, HOLD_MS, HoldToTalk, LISTENING_TEXT, RELEASE_TEXT } from './HoldToTalk';
import { findForbiddenTerm } from '../core/phrases';

describe('HoldToTalk', () => {
  it('a long press on the background starts listening with a CONFIRM, shows the overlay, and release stops', () => {
    const voice = { start: jest.fn(), stop: jest.fn() };
    const onStart = jest.fn();
    let tree: ReturnType<typeof create> | null = null;
    act(() => {
      tree = create(<HoldToTalk voice={voice} onStart={onStart} reduceMotion><Text>screen</Text></HoldToTalk>);
    });
    const root = tree!.root;
    const layer = root.findByProps({ testID: 'hold-to-talk' });
    expect(layer.props.delayLongPress).toBe(HOLD_MS);
    expect(root.findAllByProps({ testID: 'hold-to-talk-overlay' })).toHaveLength(0);
    act(() => { layer.props.onLongPress(); });
    expect(voice.start).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledTimes(1);
    const overlay = root.findByProps({ testID: 'hold-to-talk-overlay' });
    expect(overlay.props.accessibilityLabel).toBe(`${LISTENING_TEXT}. ${RELEASE_TEXT}.`);
    act(() => { layer.props.onPressOut(); });
    expect(voice.stop).toHaveBeenCalledTimes(1);
    expect(root.findAllByProps({ testID: 'hold-to-talk-overlay' })).toHaveLength(0);
    // A release with nothing held is a no-op; a second long press starts again.
    act(() => { layer.props.onPressOut(); });
    expect(voice.stop).toHaveBeenCalledTimes(1);
    act(() => { layer.props.onLongPress(); });
    expect(voice.start).toHaveBeenCalledTimes(2);
    act(() => tree!.unmount());
    expect(voice.stop).toHaveBeenCalledTimes(2);   // unmount while held never leaves the mic open
  });

  it('does nothing without a voice port, and its copy is clean', () => {
    let tree: ReturnType<typeof create> | null = null;
    act(() => {
      tree = create(<HoldToTalk voice={null} reduceMotion><Text>screen</Text></HoldToTalk>);
    });
    const layer = tree!.root.findByProps({ testID: 'hold-to-talk' });
    act(() => { layer.props.onLongPress(); });
    expect(tree!.root.findAllByProps({ testID: 'hold-to-talk-overlay' })).toHaveLength(0);
    for (const s of [HOLD_HINT, LISTENING_TEXT, RELEASE_TEXT]) expect(findForbiddenTerm(s)).toBeNull();
    act(() => tree!.unmount());
  });
});
