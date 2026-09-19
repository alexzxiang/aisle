import {
  angleAbsDiffDeg,
  angleDiffDeg,
  circularMeanDeg,
  circularMeanOffsetDeg,
  circularStats,
  clamp,
  constantPowerPan,
  headingErrorDeg,
  isWithinDeg,
  normalizeDeg,
  smoothAngleDeg,
  wrapDeg180,
} from './angles';

describe('normalizeDeg / wrapDeg180', () => {
  it.each([
    [0, 0], [359, 359], [360, 0], [361, 1], [-1, 359], [-360, 0], [720.5, 0.5], [-90, 270],
  ])('normalizeDeg(%p) = %p', (input, expected) => {
    expect(normalizeDeg(input)).toBeCloseTo(expected, 9);
  });

  it.each([
    [0, 0], [179, 179], [180, -180], [181, -179], [-180, -180], [-181, 179], [360, 0], [540, -180], [-90, -90],
  ])('wrapDeg180(%p) = %p', (input, expected) => {
    expect(wrapDeg180(input)).toBeCloseTo(expected, 9);
  });

  it('treats non-finite samples as 0 rather than NaN', () => {
    expect(normalizeDeg(NaN)).toBe(0);
    expect(normalizeDeg(Infinity)).toBe(0);
    expect(wrapDeg180(NaN)).toBe(0);
    expect(wrapDeg180(-Infinity)).toBe(0);
  });
});

describe('angleDiffDeg / headingErrorDeg', () => {
  it('is positive when the target is clockwise of the reference', () => {
    expect(angleDiffDeg(10, 30)).toBe(20);
    expect(angleDiffDeg(30, 10)).toBe(-20);
  });

  it('takes the short way round the wrap', () => {
    expect(angleDiffDeg(350, 10)).toBe(20);
    expect(angleDiffDeg(10, 350)).toBe(-20);
    expect(angleAbsDiffDeg(0, 180)).toBe(180);
    expect(angleAbsDiffDeg(359, 1)).toBe(2);
  });

  it('heading error is + when the user points right of the target', () => {
    expect(headingErrorDeg(30, 10)).toBe(20);   // facing 30, target 10 → 20° right → "turn left"
    expect(headingErrorDeg(350, 10)).toBe(-20); // facing 350, target 10 → 20° left
    expect(headingErrorDeg(10, 10)).toBe(0);
  });
});

describe('circularStats', () => {
  it('averages across the 359/1 discontinuity', () => {
    const s = circularStats([359, 1, 0, 2, 358]);
    expect(s.meanDeg).toBeCloseTo(0, 6);
    expect(s.spreadDeg).toBeLessThan(3);
    expect(s.r).toBeGreaterThan(0.99);
    expect(s.count).toBe(5);
  });

  it('reports a wide spread for disagreeing samples', () => {
    const s = circularStats([0, 90, 180, 270]);
    expect(s.meanDeg).toBeNull();
    expect(s.spreadDeg).toBe(180);
    expect(s.r).toBe(0);
  });

  it('ignores non-finite samples and handles the empty case', () => {
    expect(circularStats([]).count).toBe(0);
    expect(circularStats([NaN, 45]).meanDeg).toBeCloseTo(45, 6);
    expect(circularMeanDeg([])).toBeNull();
  });

  it('circularMeanOffsetDeg returns a signed offset', () => {
    expect(circularMeanOffsetDeg([350, 352, 348])).toBeCloseTo(-10, 6);
    expect(circularMeanOffsetDeg([10, 12, 8])).toBeCloseTo(10, 6);
  });

  it('spread grows with disagreement', () => {
    const tight = circularStats([0, 5, -5, 3, -3]).spreadDeg;
    const loose = circularStats([0, 40, -40, 30, -30]).spreadDeg;
    expect(tight).toBeLessThan(15);
    expect(loose).toBeGreaterThan(15);
  });
});

describe('smoothAngleDeg', () => {
  it('starts at the first sample and moves toward new ones the short way', () => {
    expect(smoothAngleDeg(null, 350, 0.5)).toBe(350);
    expect(smoothAngleDeg(350, 10, 0.5)).toBeCloseTo(0, 9);
    expect(smoothAngleDeg(10, 350, 0.5)).toBeCloseTo(0, 9);
  });

  it('clamps alpha to 0..1', () => {
    expect(smoothAngleDeg(0, 90, 2)).toBeCloseTo(90, 9);
    expect(smoothAngleDeg(0, 90, -1)).toBeCloseTo(0, 9);
  });
});

describe('isWithinDeg / clamp', () => {
  it('window test respects the wrap', () => {
    expect(isWithinDeg(355, 5, 15)).toBe(true);
    expect(isWithinDeg(330, 5, 15)).toBe(false);
    expect(isWithinDeg(20, 5, 15)).toBe(true);
    expect(isWithinDeg(20.1, 5, 15)).toBe(false);
  });

  it('clamp handles non-finite input by returning the minimum', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(50, 0, 10)).toBe(10);
    expect(clamp(NaN, 0, 10)).toBe(0);
  });
});

describe('constantPowerPan', () => {
  it('keeps left² + right² = 1 across the sweep', () => {
    for (let rel = -180; rel <= 180; rel += 7) {
      const { left, right } = constantPowerPan(rel);
      expect(left * left + right * right).toBeCloseTo(1, 9);
      expect(left).toBeGreaterThanOrEqual(0);
      expect(right).toBeGreaterThanOrEqual(0);
    }
  });

  it('is centred dead ahead and hard at ±90°', () => {
    const c = constantPowerPan(0);
    expect(c.left).toBeCloseTo(Math.SQRT1_2, 9);
    expect(c.right).toBeCloseTo(Math.SQRT1_2, 9);
    expect(constantPowerPan(-90)).toEqual({ left: 1, right: expect.closeTo(0, 9) });
    expect(constantPowerPan(90)).toEqual({ left: expect.closeTo(0, 9), right: 1 });
  });

  it('saturates behind the user on the correct side', () => {
    expect(constantPowerPan(135).right).toBe(1);
    expect(constantPowerPan(-135).left).toBe(1);
    expect(constantPowerPan(270).left).toBe(1); // 270 = −90
  });

  it('is monotonic: more to the right → louder right channel', () => {
    let prev = -1;
    for (let rel = -90; rel <= 90; rel += 5) {
      const { right } = constantPowerPan(rel);
      expect(right).toBeGreaterThanOrEqual(prev);
      prev = right;
    }
  });
});
