import {
  alongTrackUnclampedM,
  bboxOf,
  bearingAtAlong,
  destinationPoint,
  haversineM,
  initialBearingDeg,
  pointAtAlong,
  polylineLengthM,
  projectOntoPolyline,
  projectOntoSegment,
} from './geo';

const A = { lat: 40.4419581, lng: -79.9564358 };
const wrap = (deg: number) => ((deg % 360) + 360) % 360 >= 359.5 ? ((deg % 360) + 360) % 360 - 360 : ((deg % 360) + 360) % 360;

describe('geo', () => {
  it('haversine and destinationPoint agree', () => {
    const b = destinationPoint(A, 90, 100);
    expect(haversineM(A, b)).toBeCloseTo(100, 3);
    expect(initialBearingDeg(A, b)).toBeCloseTo(90, 2);
  });

  it('initial bearing across the cardinal directions', () => {
    expect(wrap(initialBearingDeg(A, destinationPoint(A, 0, 50)))).toBeCloseTo(0, 2);
    expect(initialBearingDeg(A, destinationPoint(A, 180, 50))).toBeCloseTo(180, 2);
    expect(initialBearingDeg(A, destinationPoint(A, 270, 50))).toBeCloseTo(270, 2);
    expect(initialBearingDeg(A, destinationPoint(A, 359, 50))).toBeCloseTo(359, 1);
  });

  it('projects onto a segment with a signed cross-track (+ = right)', () => {
    const b = destinationPoint(A, 0, 100);            // northbound segment
    const right = destinationPoint(destinationPoint(A, 0, 40), 90, 3);
    const p = projectOntoSegment(right, A, b);
    expect(p.alongM).toBeCloseTo(40, 1);
    expect(p.crossTrackM).toBeCloseTo(3, 1);
    const left = destinationPoint(destinationPoint(A, 0, 40), 270, 3);
    expect(projectOntoSegment(left, A, b).crossTrackM).toBeCloseTo(-3, 1);
  });

  it('point-to-polyline projection picks the nearest segment and cumulates along-track', () => {
    const b = destinationPoint(A, 0, 100);
    const c = destinationPoint(b, 90, 100);
    const line = [A, b, c];
    const p = projectOntoPolyline(destinationPoint(destinationPoint(b, 90, 30), 0, 2), line);
    expect(p).not.toBeNull();
    expect(p!.segIndex).toBe(1);
    expect(p!.alongM).toBeCloseTo(130, 0);
    expect(p!.distM).toBeCloseTo(2, 1);
    expect(polylineLengthM(line)).toBeCloseTo(200, 1);
  });

  it('along-track is unclamped past the end (overshoot rule)', () => {
    const b = destinationPoint(A, 0, 100);
    const past = destinationPoint(b, 0, 12);
    expect(alongTrackUnclampedM(past, [A, b])).toBeCloseTo(112, 0);
  });

  it('pointAtAlong and bearingAtAlong walk the line', () => {
    const b = destinationPoint(A, 0, 100);
    const c = destinationPoint(b, 90, 100);
    const line = [A, b, c];
    expect(haversineM(pointAtAlong(line, 150), destinationPoint(b, 90, 50))).toBeLessThan(0.5);
    expect(wrap(bearingAtAlong(line, 50))).toBeCloseTo(0, 1);
    expect(bearingAtAlong(line, 150)).toBeCloseTo(90, 1);
  });

  it('bbox pads by metres', () => {
    const box = bboxOf([A], 60);
    expect(haversineM({ lat: box.s, lng: A.lng }, { lat: box.n, lng: A.lng })).toBeCloseTo(120, 0);
    expect(haversineM({ lat: A.lat, lng: box.w }, { lat: A.lat, lng: box.e })).toBeCloseTo(120, 0);
  });
});
