import { describe, expect, it } from 'vitest';
import { describeDetections, describePath, proximityOf, renderFacts, systemPromptFor, VISION_PROMPTS } from './vision';

describe('facts in words (round 6b)', () => {
  it('preserves the mission stage and checkpoint after character two hundred', () => {
    const userText = `Goal: eggs in my fridge. ${'Observed room. '.repeat(15)}Stage: open. Look for interior shelves.`;
    const text = renderFacts({ seq: 1, question: 'task_step', mode: 'GUIDED_TASK', userText, facts: { detections: [], ocr: [] } });
    expect(text).toContain('Stage: open. Look for interior shelves.');
  });
  it('describes side and apparent size without inventing physical distance', () => {
    expect(describeDetections([
      { cls: 'table', box: [0.4, 0.5, 0.3, 0.3], score: 0.8, trackId: 1, near: 0.8 },
      { cls: 'backpack', box: [0.05, 0.5, 0.1, 0.1], score: 0.7, trackId: 2 },
      { cls: 'cell_phone', box: [0.8, 0.5, 0.15, 0.1], score: 0.7, trackId: 3, near: 0.2 },
    ])).toBe('table ahead, backpack left (small in frame), cell phone right (small in frame)');
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
    expect(text).toContain('onDeviceSees: fridge right (large in frame; distance unmeasured)');
    expect(text).toContain('onDeviceScene: kitchen 0.71, refrigerator 0.44');
    expect(text).toContain('path: ahead open, left open, right blocked');
    expect(systemPromptFor({ question: 'situate', facts: { detections: [], ocr: [] } })).not.toContain('Do not describe the scene');
    expect(systemPromptFor({ question: 'storefront', facts: { detections: [], ocr: [] } })).toContain('Do not describe the scene');
  });
});

describe('the two on-device lists are distinguished', () => {
  // An egg carton has no COCO class, so the eighty-class detector reports its
  // nearest — "orange" or "carrot" — and that guess used to reach Claude as a
  // strong hint with nothing to say it was coarse. Apple's classifier, already
  // running at 2 fps in the same profile, does know egg and carton.
  it('every question is told the detector cannot name most groceries', () => {
    for (const question of Object.keys(VISION_PROMPTS) as (keyof typeof VISION_PROMPTS)[]) {
      const p = VISION_PROMPTS[question];
      expect({ question, ok: /eighty-class/.test(p) }).toEqual({ question, ok: true });
      expect({ question, ok: /onDeviceScene/.test(p) }).toEqual({ question, ok: true });
    }
  });

  it('names the failure it exists to prevent, and ranks the sources', () => {
    const p = VISION_PROMPTS.task_step;
    expect(p).toMatch(/egg carton can arrive as "orange"/);
    expect(p).toMatch(/where a thing is, not for what a specific item is/);
    // Identity order: the image, then the big classifier, never the eighty labels.
    expect(p).toMatch(/the image decides, then onDeviceScene, and never the eighty-class labels/);
  });

  it('keeps the detector authoritative for position', () => {
    expect(VISION_PROMPTS.task_step).toMatch(/boxes and sides are reliable/);
  });
});

describe('relative depth never establishes physical proximity', () => {
  // Captured on the phone at the fridge door: the box filled 88 % of the frame
  // while the depth grid read near: 0, so Claude was told "fridge ahead (far)"
  // and answered "Walk forward and reach for the handle" while the user was
  // already touching it. Depth Anything normalises per frame; a flat surface
  // filling the view has nothing to normalise against and collapses to zero.
  const atTheDoor = { cls: 'fridge' as const, box: [0.01, 0.06, 0.96, 0.92] as [number, number, number, number], score: 1, trackId: 1, near: 0 };

  it('a frame-filling box does not become a claim about physical distance', () => {
    expect(describeDetections([atTheDoor])).toBe('fridge ahead (large in frame; distance unmeasured)');
    expect(proximityOf(0.88, 0)).toBe(2);
  });

  it('ignores depth when reporting apparent box size', () => {
    expect(proximityOf(0.05, 0.9)).toBe(1);
    expect(proximityOf(0.05, 0.5)).toBe(1);
  });

  it('agrees with the box when there is no depth at all', () => {
    expect(proximityOf(0.9, undefined)).toBe(2);
    expect(proximityOf(0.01, undefined)).toBe(0);
  });

  it('reports small image size without asserting that the object is far', () => {
    expect(describeDetections([{ cls: 'chair', box: [0.8, 0.5, 0.1, 0.1], score: 0.9, trackId: 2, near: 0.1 }]))
      .toBe('chair right (small in frame)');
  });
});
