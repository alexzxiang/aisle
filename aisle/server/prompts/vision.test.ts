import { describe, expect, it } from 'vitest';
import { describeDetections, describePath, renderFacts, systemPromptFor } from './vision';

describe('facts in words (round 6b)', () => {
  it('describeDetections: side from the box, distance from the depth grid when present, else box size', () => {
    expect(describeDetections([
      { cls: 'table', box: [0.4, 0.5, 0.3, 0.3], score: 0.8, trackId: 1, near: 0.8 },
      { cls: 'backpack', box: [0.05, 0.5, 0.1, 0.1], score: 0.7, trackId: 2 },
      { cls: 'cell_phone', box: [0.8, 0.5, 0.15, 0.1], score: 0.7, trackId: 3, near: 0.2 },
    ])).toBe('table ahead (close), backpack left (small, far), cell phone right (far)');
  });

  it('describePath: the bottom row of the depth grid in words', () => {
    expect(describePath({ centerBottomRel: 0.8, closingRate: 0, timestamp: 0, leftBottomRel: 0.2, rightBottomRel: 0.5 }))
      .toBe('ahead blocked, left open, right something a few steps away');
    expect(describePath({ centerBottomRel: 0.3, closingRate: 0.4, timestamp: 0 })).toBe('ahead open, closing in');
  });

  it('renderFacts carries the words, the scene labels and the path; situate may describe the scene', () => {
    const text = renderFacts({
      seq: 1, question: 'situate', mode: 'IDLE',
      facts: {
        detections: [{ cls: 'fridge', box: [0.6, 0.1, 0.35, 0.8], score: 0.8, trackId: 1, near: 0.7 }],
        ocr: [], sceneLabels: ['kitchen 0.71', 'refrigerator 0.44'],
        depth: { centerBottomRel: 0.2, closingRate: 0, timestamp: 0, leftBottomRel: 0.1, rightBottomRel: 0.9 },
      },
    });
    expect(text).toContain('onDeviceSees: fridge right (close)');
    expect(text).toContain('onDeviceScene: kitchen 0.71, refrigerator 0.44');
    expect(text).toContain('path: ahead open, left open, right blocked');
    expect(systemPromptFor({ question: 'situate', facts: { detections: [], ocr: [] } })).not.toContain('Do not describe the scene');
    expect(systemPromptFor({ question: 'storefront', facts: { detections: [], ocr: [] } })).toContain('Do not describe the scene');
  });
});
