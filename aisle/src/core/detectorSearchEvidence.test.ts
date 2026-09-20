import { createDetectorSearchEvidence } from './detectorSearchEvidence';
import type { Detection, Pose } from './contracts';

const shelf: Detection = { cls: 'shelf', score: 0.95, trackId: 1, box: [0.1, 0.1, 0.8, 0.8] };
const pose = (timestamp: number, patch: Partial<Pose> = {}): Pose => ({ x: 0, y: 1.4, z: 0, yawDeg: 0, timestamp, trackingState: 'NORMAL', worldSessionId: 'one', ...patch });

it('accumulates distinct close shelf views, while duplicates do not count', () => {
  const e = createDetectorSearchEvidence('bananas');
  for (let i = 0; i < 7; i++) expect(e.update({ at: i * 500, detections: [shelf] }, pose(i * 500), i * 500)).toBe(false);
  expect(e.update({ at: 3500, detections: [shelf] }, pose(3500), 3500)).toBe(true);
  expect(e.update({ at: 3500, detections: [shelf] }, pose(3600), 3600)).toBe(false);
});

it.each(['milk', 'cheese', 'meat'])('never infers a miss for packaged/unsupported %s', item => {
  const e = createDetectorSearchEvidence(item);
  for (let i = 0; i < 20; i++) expect(e.update({ at: i * 500, detections: [shelf] }, pose(i * 500), i * 500)).toBe(false);
});

it('resets on even a weak target candidate, a view change, stale frames or lost tracking', () => {
  for (const interruption of ['target', 'turn', 'stale', 'tracking', 'different_surface']) {
    const e = createDetectorSearchEvidence('bananas');
    for (let i = 0; i < 7; i++) e.update({ at: i * 500, detections: [shelf] }, pose(i * 500), i * 500);
    const detections = interruption === 'target' ? [shelf, { ...shelf, cls: 'banana' as const, score: 0.4 }]
      : [{ ...shelf, trackId: interruption === 'different_surface' ? 2 : 1 }];
    expect(e.update({ at: interruption === 'stale' ? 2000 : 3500, detections },
      pose(3500, interruption === 'turn' ? { yawDeg: 40 } : interruption === 'tracking' ? { trackingState: 'LIMITED' } : {}), 3500)).toBe(false);
    expect(e.update({ at: 4000, detections: [shelf] }, pose(4000), 4000)).toBe(false);
  }
});

it('does not accumulate evidence from a distant shelf', () => {
  const e = createDetectorSearchEvidence('bananas');
  for (let i = 0; i < 20; i++) expect(e.update({ at: i * 500, detections: [{ ...shelf, box: [0.3, 0.3, 0.4, 0.25] }] }, pose(i * 500), i * 500)).toBe(false);
});
