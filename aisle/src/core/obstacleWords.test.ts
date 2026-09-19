import type { Detection } from './contracts';
import { describeObstacle, obstacleDetection, openSide } from './obstacleWords';
import { checkPhrase } from './phrases';

const chair: Detection = { cls: 'chair', box: [0.35, 0.45, 0.3, 0.5], score: 0.9, trackId: 1, near: 0.8 };
const farTable: Detection = { cls: 'table', box: [0.4, 0.3, 0.2, 0.12], score: 0.9, trackId: 2, near: 0.1 };
const person: Detection = { cls: 'person', box: [0.05, 0.2, 0.25, 0.75], score: 0.9, trackId: 3, near: 0.7 };
const hand: Detection = { cls: 'hand', box: [0.5, 0.5, 0.5, 0.5], score: 0.99, trackId: 4, near: 1 };

describe('obstacle words (round 13): what, where, how far, which way round', () => {
  it('names the big low thing ahead, its distance, and the open side', () => {
    expect(describeObstacle({ detections: [chair, farTable, hand], depth: { center: 0.9, left: 0.2, right: 0.6 }, hfovDeg: 56, direction: 'CENTER' }))
      .toBe('Chair ahead, close. Open on your left.');
    expect(describeObstacle({ detections: [{ ...chair, box: [0.35, 0.55, 0.2, 0.25], near: 0.4 }], depth: { center: 0.7, left: 0.5, right: 0.2 }, hfovDeg: 56, direction: 'CENTER' }))
      .toMatch(/^Chair ahead, (?:two|three|four) steps\. Open on your right\.$/);
  });
  it('a person to one side, and nothing named at all', () => {
    expect(describeObstacle({ detections: [person], depth: { center: 0.8, left: 0.8, right: 0.3 }, hfovDeg: 56, direction: 'LEFT' }))
      .toBe('Person on your left, close. Open on your right.');
    expect(describeObstacle({ detections: [], depth: { center: 0.9, left: 0.8, right: 0.9 }, hfovDeg: 56, direction: 'CENTER' })).toBe('Something close ahead. Stop.');
    expect(describeObstacle({ detections: [hand], depth: null, hfovDeg: 56, direction: 'CENTER' })).toBe('Something close ahead. Stop.');
  });
  it('helpers: the hand is never the obstacle; the more open side wins; every line is clean', () => {
    expect(obstacleDetection([hand, farTable], 'CENTER')).toBeNull();
    expect(openSide({ center: 0.9, left: 0.3, right: 0.1 })).toBe('right');
    expect(openSide({ center: 0.9 })).toBeNull();
    for (const line of [
      describeObstacle({ detections: [chair], depth: { center: 0.9, left: 0.2 }, hfovDeg: 100, direction: 'CENTER' }),
      describeObstacle({ detections: [{ cls: 'washing_machine', box: [0.3, 0.4, 0.4, 0.6], score: 0.8, trackId: 9, near: 0.9 }], depth: { center: 0.9, right: 0.1 }, hfovDeg: 56, direction: 'RIGHT' }),
    ]) expect(checkPhrase(line)).toEqual([]);
  });
});
