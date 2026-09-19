import { bearingDeg, haversineM, projectOntoLine, toLocalXY } from './geo';

// Pitt campus: Forbes Ave near Bigelow, roughly east–west.
const A = { lat: 40.4443, lng: -79.9560 };
const B = { lat: 40.4443, lng: -79.9500 }; // ~510 m east of A
const N = { lat: 40.4480, lng: -79.9560 }; // ~411 m north of A

describe('haversineM', () => {
  it('measures a known east–west separation', () => {
    const d = haversineM(A, B);
    expect(d).toBeGreaterThan(500);
    expect(d).toBeLessThan(520);
  });

  it('is symmetric and zero for the same point', () => {
    expect(haversineM(A, N)).toBeCloseTo(haversineM(N, A), 6);
    expect(haversineM(A, A)).toBe(0);
  });
});

describe('bearingDeg', () => {
  it('points east, north, west, south', () => {
    expect(bearingDeg(A, B)).toBeCloseTo(90, 0);
    expect(bearingDeg(B, A)).toBeCloseTo(270, 0);
    expect(bearingDeg(A, N)).toBeCloseTo(0, 0);
    expect(bearingDeg(N, A)).toBeCloseTo(180, 0);
  });
});

describe('toLocalXY', () => {
  it('returns east/north metres relative to the origin', () => {
    const p = toLocalXY(B, A);
    expect(p.x).toBeGreaterThan(500);
    expect(Math.abs(p.y)).toBeLessThan(1);
    const q = toLocalXY(N, A);
    expect(q.y).toBeGreaterThan(400);
    expect(Math.abs(q.x)).toBeLessThan(1);
  });
});

describe('projectOntoLine', () => {
  const line = [A, B]; // heading east

  it('returns null without a line', () => {
    expect(projectOntoLine(A, [])).toBeNull();
    expect(projectOntoLine(A, [A])).toBeNull();
  });

  it('is zero on the line and signed + to the right of travel', () => {
    const mid = { lat: A.lat, lng: (A.lng + B.lng) / 2 };
    const on = projectOntoLine(mid, line);
    expect(on).not.toBeNull();
    expect(Math.abs(on!.crossTrackM)).toBeLessThan(0.05);
    expect(on!.segBearingDeg).toBeCloseTo(90, 0);

    // Walking east, south is to the right → positive cross-track.
    const south = { lat: mid.lat - 0.00002, lng: mid.lng }; // ~2.2 m south
    const right = projectOntoLine(south, line)!;
    expect(right.crossTrackM).toBeGreaterThan(2);
    expect(right.crossTrackM).toBeLessThan(2.5);
    expect(right.distM).toBeCloseTo(right.crossTrackM, 6);

    const north = { lat: mid.lat + 0.00002, lng: mid.lng };
    expect(projectOntoLine(north, line)!.crossTrackM).toBeLessThan(-2);
  });

  it('picks the nearest segment on a polyline', () => {
    const poly = [A, B, { lat: B.lat + 0.004, lng: B.lng }]; // east then north
    const nearSecond = { lat: B.lat + 0.002, lng: B.lng + 0.00003 };
    const p = projectOntoLine(nearSecond, poly)!;
    expect(p.segIndex).toBe(1);
    expect(p.segBearingDeg).toBeCloseTo(0, 0);
    // Heading north, east is to the right → positive.
    expect(p.crossTrackM).toBeGreaterThan(0);
  });

  it('clamps to the segment ends beyond the line', () => {
    const past = { lat: B.lat, lng: B.lng + 0.001 };
    const p = projectOntoLine(past, line)!;
    expect(p.distM).toBeGreaterThan(80);
    expect(Math.abs(p.crossTrackM)).toBeLessThan(0.05); // still on the extended line
  });
});
