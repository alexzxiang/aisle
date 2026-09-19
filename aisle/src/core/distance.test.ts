import { distanceFromBox, REACH_DISTANCE_M } from './distance';

it('does not round one walking step into arm reach', () => {
  expect(distanceFromBox([0.2, 0.05, 0.6, 0.9], 1.7, 56, 0.7)).toBeGreaterThan(1);
  expect(distanceFromBox([0.35, 0.45, 0.3, 0.1], 0.1, 56)).toBeGreaterThan(REACH_DISTANCE_M);
});

it('uses fridge width when the top or bottom is cropped, including a recorded reach frame', () => {
  // Captured frame 1789850161774-18-18: a hand is reaching the handle.
  const distance = distanceFromBox([0.012, 0.006, 0.977, 0.994], 1.7, 56, 0.7)!;
  expect(distance).toBeGreaterThan(0.6);
  expect(distance).toBeLessThan(REACH_DISTANCE_M);
  expect(distanceFromBox([0.25, 0, 0.5, 1], 1.7, 56, 0.7)).toBeGreaterThan(1.3);
});

it('uses lens geometry and rejects malformed boxes', () => {
  const wide = distanceFromBox([0.2, 0.2, 0.6, 0.6], 1.7, 56)!;
  const ultra = distanceFromBox([0.2, 0.2, 0.6, 0.6], 1.7, 100)!;
  expect(wide).toBeGreaterThan(ultra);
  for (const box of [[0, 0, 0, 1], [0, 0, 1, NaN], [-1, 0, 1, 1], [0.5, 0, 0.8, 1]]) {
    expect(distanceFromBox(box, 1.7, 56)).toBeNull();
  }
});
