import type { Pose } from '../core/contracts';
import {
  alongTrackFromPose,
  createAisleCentering,
  createCenteringFeed,
  createSmoother,
  headingErrorDeg,
  lateralOffsetFromPose,
  offsetFromSignBox,
  selectOffset,
} from './centering';

const pose = (x: number, z: number, trackingState: Pose['trackingState'] = 'NORMAL'): Pose => ({ yawDeg: 0, x, y: 0, z, trackingState, timestamp: 0 });

describe('lateralOffsetFromPose (09 §5.6, 09 §10 drift checks)', () => {
  it('a straight track along the bearing reads 0 ± 0.02 m', () => {
    // Heading north (bearing 0): forward is −z.
    for (let i = 0; i <= 10; i += 1) {
      const p = { x: 0.01 * Math.sin(i), z: -i * 0.7 };
      expect(Math.abs(lateralOffsetFromPose({ x: 0, z: 0 }, p, 0))).toBeLessThanOrEqual(0.02);
    }
  });
  it('0.5 m parallel offset reads 0.5 m, signed + to the right', () => {
    // Bearing 0 (north): right is +x.
    expect(lateralOffsetFromPose({ x: 0, z: 0 }, { x: 0.5, z: -3 }, 0)).toBeCloseTo(0.5, 6);
    expect(lateralOffsetFromPose({ x: 0, z: 0 }, { x: -0.5, z: -3 }, 0)).toBeCloseTo(-0.5, 6);
    // Bearing 90 (east): forward +x, right +z (south).
    expect(lateralOffsetFromPose({ x: 0, z: 0 }, { x: 3, z: 0.5 }, 90)).toBeCloseTo(0.5, 6);
    // Bearing 180 (south): right is −x.
    expect(lateralOffsetFromPose({ x: 0, z: 0 }, { x: -0.5, z: 3 }, 180)).toBeCloseTo(0.5, 6);
    // Bearing 270 (west): right is −z (north).
    expect(lateralOffsetFromPose({ x: 0, z: 0 }, { x: -3, z: -0.5 }, 270)).toBeCloseTo(0.5, 6);
  });
  it('the anchor is respected', () => {
    expect(lateralOffsetFromPose({ x: 2, z: 2 }, { x: 2.5, z: -1 }, 0)).toBeCloseTo(0.5, 6);
  });
  it('alongTrack is the distance walked along the bearing', () => {
    expect(alongTrackFromPose({ x: 0, z: 0 }, { x: 0.5, z: -3 }, 0)).toBeCloseTo(3, 6);
    expect(alongTrackFromPose({ x: 0, z: 0 }, { x: 3, z: 0.5 }, 90)).toBeCloseTo(3, 6);
  });
});

describe('offsetFromSignBox', () => {
  it('a centred sign is 0; a sign left of centre means the user is right of the line', () => {
    expect(offsetFromSignBox([0.4, 0.1, 0.2, 0.05])).toBeCloseTo(0, 6);
    expect(offsetFromSignBox([0.2, 0.1, 0.2, 0.05], 4, 60)).toBeGreaterThan(0);
    expect(offsetFromSignBox([0.6, 0.1, 0.2, 0.05], 4, 60)).toBeLessThan(0);
  });
  it('scales with distance and field of view', () => {
    const a = offsetFromSignBox([0.2, 0.1, 0.2, 0.05], 4, 60);
    const b = offsetFromSignBox([0.2, 0.1, 0.2, 0.05], 8, 60);
    expect(b).toBeCloseTo(2 * a, 6);
    // 20 % of a 60° field at 4 m ≈ 4·tan(12°) ≈ 0.85 m
    expect(a).toBeCloseTo(4 * Math.tan((12 * Math.PI) / 180), 6);
  });
});

describe('headingErrorDeg', () => {
  it('is signed, wraps, and + means pointed right of the bearing', () => {
    expect(headingErrorDeg(10, 0)).toBe(10);
    expect(headingErrorDeg(350, 0)).toBe(-10);
    expect(headingErrorDeg(0, 350)).toBe(10);
    expect(headingErrorDeg(180, 0)).toBe(180);
    expect(headingErrorDeg(90, 270)).toBe(180);
    expect(headingErrorDeg(45, 45)).toBe(0);
  });
});

describe('selectOffset precedence (04 Task 6)', () => {
  it('pose while NORMAL, else shelf, else ocr_box only with a sign in view, else 0/none', () => {
    const s = { pose: 0.3, shelf: 0.2, ocr_box: 0.1 };
    expect(selectOffset(s, 'NORMAL', true)).toEqual({ offsetM: 0.3, source: 'pose' });
    expect(selectOffset(s, 'LIMITED', true)).toEqual({ offsetM: 0.2, source: 'shelf' });
    expect(selectOffset({ pose: 0.3, ocr_box: 0.1 }, 'LIMITED', true)).toEqual({ offsetM: 0.1, source: 'ocr_box' });
    expect(selectOffset({ pose: 0.3, ocr_box: 0.1 }, 'LIMITED', false)).toEqual({ offsetM: 0, source: 'none' });
    expect(selectOffset({}, 'NORMAL', false)).toEqual({ offsetM: 0, source: 'none' });
  });
});

describe('createSmoother', () => {
  it('first sample passes through; then a 1 s time constant', () => {
    const s = createSmoother(1000);
    expect(s.push(1, 0)).toBe(1);
    const v = s.push(0, 1000);
    expect(v).toBeCloseTo(Math.exp(-1), 3);
    s.reset();
    expect(s.value()).toBeNull();
  });
});

describe('createCenteringFeed → CourseError', () => {
  it('no reference or heading → compassAccuracy 0 (no buzz), zero error', () => {
    const f = createCenteringFeed({ now: () => 0 });
    expect(f.getError()).toEqual({ headingErrorDeg: 0, crossTrackM: 0, roadSide: 'NONE', compassAccuracy: 0 });
  });
  it('anchors at the current pose and reports a 0.5 m drift with the right sign', () => {
    let t = 0;
    const f = createCenteringFeed({ now: () => t });
    f.updatePose(pose(0, 0));
    f.setReference(0);
    f.updateHeading(5);
    f.updatePose(pose(0.5, -2));
    const e = f.getError();
    expect(e.compassAccuracy).toBe(3);
    expect(e.headingErrorDeg).toBe(5);
    expect(e.crossTrackM).toBeCloseTo(0.5, 6);
    expect(e.roadSide).toBe('NONE');
    // LIMITED tracking freezes the pose source; falls to shelf if present, else 0.
    f.updateTracking('LIMITED');
    expect(f.getError().crossTrackM).toBe(0);
    t = 1000;
    f.updateLateral({ offsetM: -0.3, source: 'shelf' }, t);
    expect(f.getError().crossTrackM).toBeCloseTo(-0.3, 6);
  });
  it('a reference set before any pose anchors on the first pose', () => {
    const f = createCenteringFeed({ now: () => 0 });
    f.setReference(90);
    f.updatePose(pose(1, 1));
    f.updatePose(pose(4, 1.5));
    expect(f.getError().crossTrackM).toBeCloseTo(0.5, 6);
  });
});

describe('createAisleCentering (side effects)', () => {
  function harness(heading: number | null) {
    const calls: string[] = [];
    const perception = { setCourseReference: (r: { bearingDeg: number } | null) => { calls.push(`ref:${r ? r.bearingDeg : 'null'}`); } };
    const haptics = {
      startCourse: () => { calls.push('startCourse'); },
      stopCourse: () => { calls.push('stopCourse'); },
    };
    const sensors = {
      courseErrorFor: (t: { bearingDeg: number | (() => number); roadSide: string }) => {
        const bearing = typeof t.bearingDeg === 'function' ? t.bearingDeg() : t.bearingDeg;
        calls.push(`courseErrorFor:${bearing}:${t.roadSide}`);
        return () => ({ headingErrorDeg: 0, crossTrackM: 0, roadSide: 'NONE' as const, compassAccuracy: 3 as const });
      },
      getFusedHeadingDeg: () => heading,
    };
    return { calls, c: createAisleCentering({ perception, haptics, sensors }) };
  }
  it('anchor sets the module reference at the fused heading and starts the shared ramp with roadSide NONE', () => {
    const { calls, c } = harness(92.4);
    expect(c.anchor()).toBe(92.4);
    expect(calls).toEqual(['ref:92.4', 'courseErrorFor:92.4:NONE', 'startCourse']);
    expect(c.isRunning()).toBe(true);
  });
  it('re-anchors on a cross-aisle turn; stop clears the reference and the ramp', () => {
    const { calls, c } = harness(180);
    c.anchor(90);
    c.reanchor();
    c.stop();
    c.stop();
    expect(calls).toEqual([
      'ref:90', 'courseErrorFor:90:NONE', 'startCourse',
      'ref:180', 'courseErrorFor:180:NONE', 'startCourse',
      'stopCourse', 'ref:null',
    ]);
    expect(c.isRunning()).toBe(false);
  });
  it('does nothing without a heading', () => {
    const { calls, c } = harness(null);
    expect(c.anchor()).toBeNull();
    expect(calls).toEqual([]);
  });
});
