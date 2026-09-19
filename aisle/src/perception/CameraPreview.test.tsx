/**
 * CameraPreview: the placeholder path (native view mocked away), the native
 * path (a fake component injected), the detection overlay and its pure helpers.
 */
import React from 'react';
import { Text, View } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { Detection, PerceptionService } from '../core/contracts';
import { services } from '../core/services';
import { createStubPerception } from '../core/stubs';
import { findForbidden } from '../ui/copy';
import {
  __setPerceptionNativeForTests,
  __setPerceptionPreviewViewForTests,
  type PerceptionNativeModule,
  type PerceptionPreviewNativeProps,
} from '../../modules/perception';
import {
  CameraPreview,
  DETECTION_COLORS,
  KEPT_CLASSES,
  OVERLAY_MIN_INTERVAL_MS,
  OVERLAY_STALE_MS,
  PLACEHOLDER_FRAME_INTERVAL_MS,
  PREVIEW_LABEL,
  boxToLayout,
  detectionLabel,
  isCameraPreviewAvailable,
  keptDetections,
} from './CameraPreview';

const mounted: ReactTestRenderer[] = [];

async function render(el: React.ReactElement): Promise<ReactTestRenderer> {
  let r!: ReactTestRenderer;
  await act(async () => {
    r = create(el);
  });
  mounted.push(r);
  return r;
}

/** A stub perception whose onDetections can be fired and whose snapshot is controllable. */
function fakePerception(opts: { base64?: string | null } = {}) {
  const listeners = new Set<(items: Detection[]) => void>();
  const base = createStubPerception();
  let snapshots = 0;
  const perception: PerceptionService & { fire(items: Detection[]): void; listenerCount(): number; snapshots(): number } = {
    ...base,
    onDetections(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    async snapshotJPEG(maxWidth) {
      snapshots += 1;
      if (opts.base64 === null) throw new Error('no frames');
      return { base64: opts.base64 ?? 'QUJD', width: maxWidth, height: (maxWidth * 3) / 4, seq: snapshots, timestamp: Date.now() };
    },
    fire(items) {
      for (const cb of Array.from(listeners)) cb(items);
    },
    listenerCount: () => listeners.size,
    snapshots: () => snapshots,
  };
  return perception;
}

function layout(r: ReactTestRenderer, testID: string, width = 300, height = 400): Promise<void> {
  const root = r.root.findAll((n: ReactTestInstance) => n.props.testID === testID && typeof n.type === 'string')[0];
  if (!root) throw new Error(`no host view with testID ${testID}`);
  return act(async () => {
    (root.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { x: 0, y: 0, width, height } } });
  });
}

function texts(r: ReactTestRenderer): string[] {
  return r.root
    .findAll((n: ReactTestInstance) => n.type === Text)
    .map((n: ReactTestInstance) => React.Children.toArray(n.props.children as React.ReactNode).join(''));
}

function boxes(r: ReactTestRenderer, testID: string): ReactTestInstance[] {
  const overlay = r.root.findAll((n: ReactTestInstance) => n.props.testID === `${testID}-overlay` && typeof n.type === 'string')[0];
  if (!overlay) return [];
  return overlay.children.filter((c): c is ReactTestInstance => typeof c !== 'string');
}

function det(cls: Detection['cls'], score: number, trackId: number, box: Detection['box'] = [0.1, 0.2, 0.3, 0.4]): Detection {
  return { cls, score, trackId, box };
}

beforeEach(() => {
  // Faking queueMicrotask makes React's act() see its own scheduling as an un-awaited act.
  jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
  services.reset();
  __setPerceptionNativeForTests(null);
  __setPerceptionPreviewViewForTests(null);
});

afterEach(async () => {
  for (const r of mounted.splice(0)) {
    await act(async () => {
      r.unmount();
    });
  }
  services.reset();
  __setPerceptionNativeForTests(undefined);
  __setPerceptionPreviewViewForTests(undefined);
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------

describe('pure helpers', () => {
  it('labels as "<class> <score>" with two decimals, short signal names, clamped score', () => {
    expect(detectionLabel({ cls: 'car', score: 0.8149 })).toBe('car 0.81');
    expect(detectionLabel({ cls: 'ped_walk', score: 1.7 })).toBe('walk 1.00');
    expect(detectionLabel({ cls: 'ped_hand', score: -1 })).toBe('hand 0.00');
    expect(detectionLabel({ cls: 'ped_countdown', score: Number.NaN })).toBe('countdown 0.00');
  });

  it('keeps only the kept classes with a real box', () => {
    const items = [
      det('car', 0.9, 1),
      { cls: 'dog', score: 0.9, trackId: 2, box: [0, 0, 0.5, 0.5] } as unknown as Detection,
      det('person', 0.5, 3, [0.1, 0.1, 0, 0.2]),
      det('cart', 0.5, 4, [0.1, 0.1, Number.NaN, 0.2]),
      det('bus', 0.6, 5),
    ];
    expect(keptDetections(items).map((d) => d.trackId)).toEqual([1, 5]);
    expect(Array.from(KEPT_CLASSES).sort()).toEqual(Object.keys(DETECTION_COLORS).sort());
  });

  it('maps a normalized box to pixels, clamps to the frame, mirrors around the vertical axis', () => {
    expect(boxToLayout([0.1, 0.2, 0.3, 0.4], 200, 100)).toEqual({ left: 20, top: 20, width: 60, height: 40 });
    expect(boxToLayout([0.1, 0.2, 0.3, 0.4], 200, 100, true)).toEqual({ left: 120, top: 20, width: 60, height: 40 });
    expect(boxToLayout([0.9, 0.9, 0.5, 0.5], 200, 100)).toEqual({ left: 180, top: 90, width: 20, height: 10 });
    expect(boxToLayout([-1, -1, 3, 3], 200, 100)).toEqual({ left: 0, top: 0, width: 200, height: 100 });
  });

  it('every class has a distinct colour', () => {
    const values = Object.values(DETECTION_COLORS);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('placeholder path (native view unavailable)', () => {
  it('is reported unavailable and renders "Camera preview" with no native view, no forbidden words', async () => {
    expect(isCameraPreviewAvailable()).toBe(false);
    const perception = fakePerception({ base64: null });
    const r = await render(<CameraPreview perception={perception} testID="cam" />);
    expect(texts(r)).toContain(PREVIEW_LABEL);
    expect(texts(r)).toContain('Rebuild the app to see the camera');
    expect(r.root.findAll((n: ReactTestInstance) => n.props.testID === 'cam-native')).toHaveLength(0);
    for (const s of texts(r)) expect(findForbidden(s)).toEqual([]);
    const host = r.root.findAll((n: ReactTestInstance) => n.props.testID === 'cam' && typeof n.type === 'string')[0];
    expect(host.props.accessibilityLabel).toBe(PREVIEW_LABEL);
    expect(host.props.accessibilityRole).toBe('image');
  });

  it('shows the last replayed frame from snapshotJPEG, polling once a second, and stops after repeated failures', async () => {
    const perception = fakePerception({ base64: 'QUJD' });
    const r = await render(<CameraPreview perception={perception} testID="cam" mirror />);
    await act(async () => {
      await Promise.resolve();
    });
    const frame = r.root.findAll((n: ReactTestInstance) => n.props.testID === 'cam-frame')[0];
    expect(frame).toBeDefined();
    expect(frame.props.source).toEqual({ uri: 'data:image/jpeg;base64,QUJD' });
    expect(texts(r)).toContain('Replaying recorded frames');
    expect(perception.snapshots()).toBe(1);
    await act(async () => {
      jest.advanceTimersByTime(PLACEHOLDER_FRAME_INTERVAL_MS);
      await Promise.resolve();
    });
    expect(perception.snapshots()).toBe(2);

    const failing = fakePerception({ base64: null });
    await render(<CameraPreview perception={failing} />);
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        await Promise.resolve();
        jest.advanceTimersByTime(PLACEHOLDER_FRAME_INTERVAL_MS);
        await Promise.resolve();
      });
    }
    expect(failing.snapshots()).toBe(3);
  });

  it('calls onReady once on mount and falls back to the registry for the service', async () => {
    const perception = fakePerception();
    services.set('perception', perception);
    const onReady = jest.fn();
    const r = await render(<CameraPreview onReady={onReady} testID="cam" />);
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(perception.listenerCount()).toBe(1);
    await act(async () => {
      r.update(<CameraPreview onReady={onReady} testID="cam" mirror />);
    });
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('forces the placeholder when the composition root says mock, even with native linked', async () => {
    __setPerceptionNativeForTests({} as PerceptionNativeModule);
    __setPerceptionPreviewViewForTests(() => <View testID="cam-native" />);
    expect(isCameraPreviewAvailable()).toBe(true);
    const r = await render(<CameraPreview perception={fakePerception({ base64: null })} testID="cam" mock />);
    expect(texts(r)).toContain(PREVIEW_LABEL);
    expect(r.root.findAll((n: ReactTestInstance) => n.props.testID === 'cam-native')).toHaveLength(0);
  });
});

describe('detection overlay', () => {
  it('draws one colour-coded box per kept detection with a label, hidden from the screen reader', async () => {
    const perception = fakePerception({ base64: null });
    const r = await render(<CameraPreview perception={perception} testID="cam" />);
    await layout(r, 'cam', 200, 100);
    await act(async () => {
      perception.fire([det('car', 0.81, 7, [0.1, 0.2, 0.3, 0.4]), det('person', 0.55, 8, [0.5, 0.5, 0.2, 0.2]), { cls: 'dog', score: 0.9, trackId: 9, box: [0, 0, 1, 1] } as unknown as Detection]);
    });
    const b = boxes(r, 'cam');
    expect(b).toHaveLength(2);
    const flat = (n: ReactTestInstance) => Object.assign({}, ...([] as object[]).concat(n.props.style as object[]));
    expect(flat(b[0])).toMatchObject({ borderColor: DETECTION_COLORS.car, left: 20, top: 20, width: 60, height: 40 });
    expect(flat(b[1])).toMatchObject({ borderColor: DETECTION_COLORS.person, left: 100, top: 50, width: 40, height: 20 });
    expect(texts(r)).toEqual(expect.arrayContaining(['car 0.81', 'person 0.55']));
    const overlay = r.root.findAll((n: ReactTestInstance) => n.props.testID === 'cam-overlay' && typeof n.type === 'string')[0];
    expect(overlay.props.importantForAccessibility).toBe('no-hide-descendants');
    expect(overlay.props.accessibilityElementsHidden).toBe(true);
    for (const s of texts(r)) expect(findForbidden(s)).toEqual([]);
  });

  it('mirrors boxes with the image', async () => {
    const perception = fakePerception({ base64: null });
    const r = await render(<CameraPreview perception={perception} testID="cam" mirror />);
    await layout(r, 'cam', 200, 100);
    await act(async () => {
      perception.fire([det('bus', 0.7, 1, [0.1, 0.2, 0.3, 0.4])]);
    });
    const b = boxes(r, 'cam');
    const style = Object.assign({}, ...([] as object[]).concat(b[0].props.style as object[]));
    expect(style).toMatchObject({ left: 120, top: 20, width: 60, height: 40 });
  });

  it('redraws at most every 200 ms and drops stale boxes', async () => {
    const perception = fakePerception({ base64: null });
    const r = await render(<CameraPreview perception={perception} testID="cam" />);
    await layout(r, 'cam');
    await act(async () => {
      perception.fire([det('car', 0.9, 1)]);
    });
    expect(boxes(r, 'cam')).toHaveLength(1);
    await act(async () => {
      perception.fire([det('car', 0.9, 1), det('truck', 0.9, 2)]);
    });
    expect(boxes(r, 'cam')).toHaveLength(1);   // throttled: still the first frame
    await act(async () => {
      jest.advanceTimersByTime(OVERLAY_MIN_INTERVAL_MS);
    });
    expect(boxes(r, 'cam')).toHaveLength(2);   // the latest pending list, not the intermediate one
    await act(async () => {
      jest.advanceTimersByTime(OVERLAY_STALE_MS);
    });
    expect(boxes(r, 'cam')).toHaveLength(0);
  });

  it('draws nothing and does not subscribe when showDetections is false', async () => {
    const perception = fakePerception({ base64: null });
    const r = await render(<CameraPreview perception={perception} testID="cam" showDetections={false} />);
    await layout(r, 'cam');
    expect(perception.listenerCount()).toBe(0);
    expect(boxes(r, 'cam')).toHaveLength(0);
  });

  it('unsubscribes on unmount', async () => {
    const perception = fakePerception({ base64: null });
    const r = await render(<CameraPreview perception={perception} testID="cam" />);
    expect(perception.listenerCount()).toBe(1);
    await act(async () => {
      r.unmount();
    });
    mounted.splice(0);
    expect(perception.listenerCount()).toBe(0);
  });
});

describe('native path', () => {
  it('renders the native view with mirror, forwards onReady once, and overlays boxes on it', async () => {
    const seen: PerceptionPreviewNativeProps[] = [];
    let readyHandler: PerceptionPreviewNativeProps['onReady'];
    __setPerceptionNativeForTests({} as PerceptionNativeModule);
    __setPerceptionPreviewViewForTests((p: PerceptionPreviewNativeProps) => {
      seen.push(p);
      readyHandler = p.onReady;
      return <View testID={p.testID} />;
    });
    expect(isCameraPreviewAvailable()).toBe(true);
    const perception = fakePerception();
    const onReady = jest.fn();
    const r = await render(<CameraPreview perception={perception} testID="cam" mirror onReady={onReady} />);
    expect(r.root.findAll((n: ReactTestInstance) => n.props.testID === 'cam-native' && typeof n.type === 'string')).toHaveLength(1);
    expect(seen[seen.length - 1]?.mirror).toBe(true);
    expect(texts(r)).not.toContain(PREVIEW_LABEL);          // no placeholder text over the live image
    expect(perception.snapshots()).toBe(0);                  // no frame polling on the native path
    expect(onReady).not.toHaveBeenCalled();
    await act(async () => {
      readyHandler?.({ nativeEvent: { attached: true, running: false } });
      readyHandler?.({ nativeEvent: { attached: true, running: true } });
    });
    expect(onReady).toHaveBeenCalledTimes(1);

    await layout(r, 'cam', 100, 100);
    await act(async () => {
      perception.fire([det('ped_walk', 0.93, 3, [0.4, 0.1, 0.2, 0.2])]);
    });
    expect(boxes(r, 'cam')).toHaveLength(1);
    expect(texts(r)).toContain('walk 0.93');
  });
});
