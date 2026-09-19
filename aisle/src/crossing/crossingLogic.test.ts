import type { VehiclesSeen } from '../core/contracts';
import { FORBIDDEN_TERMS, PHRASES, findForbiddenTerm } from '../core/phrases';
import { destinationPoint } from '../outdoor/geo';
import {
  crossingStarted,
  decideSignalPhrase,
  farCurbReached,
  initialSignalTrack,
  isStoppedAtCurb,
  poseDisplacementAlongM,
  scanBearingFor,
  scanReportKeys,
  unknownTimedOut,
  walkedPast,
  worstVerdict,
} from './crossingLogic';

describe('signal phrase table (fresh vs stale onset)', () => {
  it('a stale WALK as the first state says walk_already_on_wait, never walk_signal_on', () => {
    const t0 = 1000;
    const d = decideSignalPhrase(initialSignalTrack(t0), { state: 'WALK', fresh: false }, t0 + 500);
    expect(d.key).toBe('walk_already_on_wait');
    // Heartbeat repeats of the same stale WALK stay silent.
    const d2 = decideSignalPhrase(d.track, { state: 'WALK', fresh: false }, t0 + 2500);
    expect(d2.key).toBeNull();
  });

  it('DONT_WALK → WALK fresh speaks dont_walk then walk_signal_on', () => {
    let track = initialSignalTrack(0);
    const a = decideSignalPhrase(track, { state: 'DONT_WALK', fresh: false }, 100);
    expect(a.key).toBe('dont_walk');
    track = a.track;
    const b = decideSignalPhrase(track, { state: 'WALK', fresh: true }, 5000);
    expect(b.key).toBe('walk_signal_on');
    const c = decideSignalPhrase(b.track, { state: 'COUNTDOWN', fresh: true }, 9000);
    expect(c.key).toBe('countdown');
  });

  it('UNKNOWN is silence until 10 s, then cant_see_signal exactly once and the ladder', () => {
    let track = initialSignalTrack(0);
    const a = decideSignalPhrase(track, { state: 'UNKNOWN', fresh: false }, 2000);
    expect(a.key).toBeNull();
    expect(a.enterLadder).toBe(false);
    track = a.track;
    const b = decideSignalPhrase(track, { state: 'UNKNOWN', fresh: false }, 10_100);
    expect(b.key).toBe('cant_see_signal');
    expect(b.enterLadder).toBe(true);
    const c = decideSignalPhrase(b.track, { state: 'UNKNOWN', fresh: false }, 25_000);
    expect(c.key).toBeNull();
    expect(unknownTimedOut(c.track, 30_000)).toBe(false);
  });

  it('a known state resets the UNKNOWN clock', () => {
    let track = initialSignalTrack(0);
    track = decideSignalPhrase(track, { state: 'DONT_WALK', fresh: false }, 9000).track;
    const d = decideSignalPhrase(track, { state: 'UNKNOWN', fresh: false }, 12_000);
    expect(d.key).toBeNull();
    expect(unknownTimedOut(d.track, 21_000)).toBe(false);
    expect(unknownTimedOut(d.track, 22_100)).toBe(true);
  });
});

describe('scan verdicts', () => {
  const verdicts: VehiclesSeen[] = ['none', 'distant', 'approaching', 'unclear'];

  it('worst-of ranking: approaching > unclear > distant = none', () => {
    expect(worstVerdict('none', 'approaching')).toBe('approaching');
    expect(worstVerdict('unclear', 'distant')).toBe('unclear');
    expect(worstVerdict('none', 'distant')).toBe('none');
    expect(worstVerdict('approaching', 'unclear')).toBe('approaching');
    expect(worstVerdict(null, 'none')).toBe('none');
    expect(worstVerdict(null, null)).toBe('unclear');
  });

  it('the 3×3 matrix produces the exact phrase sequences', () => {
    expect(scanReportKeys('none', 'none')).toEqual(['no_vehicles_left', 'no_vehicles_right', 'listen_then_cross']);
    expect(scanReportKeys('distant', 'none')).toEqual(['no_vehicles_left', 'no_vehicles_right', 'listen_then_cross']);
    expect(scanReportKeys('approaching', 'none')).toEqual(['vehicle_approaching_left', 'no_vehicles_right']);
    expect(scanReportKeys('none', 'approaching')).toEqual(['vehicle_approaching_right', 'no_vehicles_left']);
    expect(scanReportKeys('approaching', 'approaching')).toEqual(['vehicle_approaching_left', 'vehicle_approaching_right']);
    expect(scanReportKeys('unclear', 'none')).toEqual(['cant_see_well_left', 'no_vehicles_right']);
    expect(scanReportKeys('none', 'unclear')).toEqual(['cant_see_well_right', 'no_vehicles_left']);
    expect(scanReportKeys('unclear', 'unclear')).toEqual(['cant_see_well_left', 'cant_see_well_right']);
    expect(scanReportKeys('approaching', 'unclear')).toEqual(['vehicle_approaching_left', 'cant_see_well_right']);
    expect(scanReportKeys('unclear', 'approaching')).toEqual(['vehicle_approaching_right', 'cant_see_well_left']);
  });

  it('never includes listen_then_cross when anything is approaching or unclear', () => {
    for (const l of verdicts) {
      for (const r of verdicts) {
        const keys = scanReportKeys(l, r);
        const clean = ['none', 'distant'].includes(l) && ['none', 'distant'].includes(r);
        expect(keys.includes('listen_then_cross')).toBe(clean);
        expect(keys.length).toBe(clean ? 3 : 2);
      }
    }
  });

  it('every report phrase is free of the forbidden words', () => {
    for (const l of verdicts) {
      for (const r of verdicts) {
        for (const k of scanReportKeys(l, r)) expect(findForbiddenTerm(PHRASES[k])).toBeNull();
      }
    }
    expect(FORBIDDEN_TERMS).toContain('you can cross');
  });

  it('scan bearings are ±90° with wraparound', () => {
    expect(scanBearingFor(10, 'LEFT')).toBe(280);
    expect(scanBearingFor(350, 'RIGHT')).toBe(80);
  });
});

describe('curb, start and far-curb detectors', () => {
  const near = { lat: 40.4419, lng: -79.9564 };
  const far = destinationPoint(near, 45, 20);

  it('stopped at the curb needs ≤ 12 m and 2 s of stillness', () => {
    expect(isStoppedAtCurb({ distToNearCurbM: 5, stillForMs: 2000 })).toBe(true);
    expect(isStoppedAtCurb({ distToNearCurbM: 5, stillForMs: 1500 })).toBe(false);
    expect(isStoppedAtCurb({ distToNearCurbM: 13, stillForMs: 5000 })).toBe(false);
  });

  it('walked past is > 10 m beyond the far curb along the crossing line', () => {
    expect(walkedPast(destinationPoint(near, 45, 25), near, far)).toBe(false);
    expect(walkedPast(destinationPoint(near, 45, 31), near, far)).toBe(true);
    expect(walkedPast(near, near, far)).toBe(false);
  });

  it('crossing started: 1.5 m of pose displacement along the bearing; 4 steps only as the no-pose fallback', () => {
    expect(crossingStarted({ stepsSinceCurb: 3, displacementM: 1.0 })).toBe(false);
    expect(crossingStarted({ stepsSinceCurb: 4, displacementM: null })).toBe(true);
    expect(crossingStarted({ stepsSinceCurb: 0, displacementM: 1.6 })).toBe(true);
    // Pose tracking NORMAL: shuffles and a turn in place (steps, no displacement) never start it.
    expect(crossingStarted({ stepsSinceCurb: 6, displacementM: 0.2 })).toBe(false);
    // Stepping back from the curb is negative displacement: not a start.
    expect(crossingStarted({ stepsSinceCurb: 6, displacementM: -2 })).toBe(false);
  });

  it('the no-pose step rule is suppressed during a scan window and while facing > 45° off the bearing', () => {
    expect(crossingStarted({ stepsSinceCurb: 6, displacementM: null, scanInProgress: true })).toBe(false);
    expect(crossingStarted({ stepsSinceCurb: 6, displacementM: null, headingOffDeg: 60 })).toBe(false);
    expect(crossingStarted({ stepsSinceCurb: 6, displacementM: null, headingOffDeg: -90 })).toBe(false);
    expect(crossingStarted({ stepsSinceCurb: 6, displacementM: null, headingOffDeg: 30 })).toBe(true);
    expect(crossingStarted({ stepsSinceCurb: 6, displacementM: null, headingOffDeg: null })).toBe(true);
    // With a pose the displacement decides regardless of the scan / heading flags.
    expect(crossingStarted({ stepsSinceCurb: 0, displacementM: 1.6, scanInProgress: true, headingOffDeg: 90 })).toBe(true);
  });

  it('far curb: displacement, two good fixes, or steps as the last resort', () => {
    expect(farCurbReached({ lengthM: 20, displacementM: 19.2, goodFixesNearFar: 0, stepsSinceCurb: 0 })).toBe(true);
    expect(farCurbReached({ lengthM: 20, displacementM: 15, goodFixesNearFar: 2, stepsSinceCurb: 0 })).toBe(true);
    expect(farCurbReached({ lengthM: 20, displacementM: null, goodFixesNearFar: 1, stepsSinceCurb: 31 })).toBe(false);
    expect(farCurbReached({ lengthM: 20, displacementM: null, goodFixesNearFar: 1, stepsSinceCurb: 32 })).toBe(true);
  });

  it('pose displacement follows the ARKit gravityAndHeading frame (x east, −z north)', () => {
    const origin = { x: 0, z: 0 };
    expect(poseDisplacementAlongM(origin, { x: 0, z: -10 }, 0)).toBeCloseTo(10, 5);
    expect(poseDisplacementAlongM(origin, { x: 10, z: 0 }, 90)).toBeCloseTo(10, 5);
    expect(poseDisplacementAlongM(origin, { x: 10, z: 0 }, 0)).toBeCloseTo(0, 5);
    expect(poseDisplacementAlongM(origin, { x: 0, z: 10 }, 0)).toBeCloseTo(-10, 5);
  });
});
