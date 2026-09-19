import { describe, expect, it } from 'vitest';
import type { CapturedFrame } from '../lib/frameCapture';
import { emptyVisionResponse } from '../schemas/vision';
import { boxHit, labelSkeleton, scoreFrame, summarize, type VisionBox } from './vision.eval';

const withTarget = (box: VisionBox | null, done = false) => ({ ...emptyVisionResponse(1), target: { box, confidence: 0.8 }, task: { done, confidence: 0.8 } });

describe('boxHit', () => {
  it('counts a box whose centre lands within a tenth of the label on both axes', () => {
    expect(boxHit([0.40, 0.40, 0.20, 0.20], [0.45, 0.35, 0.20, 0.20])).toBe(true);   // centres 0.05 apart
    expect(boxHit([0.40, 0.40, 0.20, 0.20], [0.55, 0.40, 0.20, 0.20])).toBe(false);  // 0.15 off in x
  });
  it('judges on the centre, so a right place with the wrong size still steers correctly', () => {
    expect(boxHit([0.45, 0.45, 0.10, 0.10], [0.30, 0.30, 0.40, 0.40])).toBe(true);
  });
  it('rewards agreeing the target is out of view, and punishes both a hallucinated and a missed box', () => {
    expect(boxHit(null, null)).toBe(true);
    expect(boxHit([0.4, 0.4, 0.2, 0.2], null)).toBe(false);
    expect(boxHit(null, [0.4, 0.4, 0.2, 0.2])).toBe(false);
  });
});

describe('scoreFrame', () => {
  it('scores only the metrics the label sets', () => {
    expect(scoreFrame(withTarget([0.4, 0.4, 0.2, 0.2], true), { target: [0.4, 0.4, 0.2, 0.2], done: true })).toEqual({ target: true, done: true });
    expect(scoreFrame(withTarget(null), { setting: 'kitchen' })).toEqual({ setting: false });
  });
  it('fails a call that returned nothing, even where the label says "not in view"', () => {
    // A timeout must not be credited as correctly seeing no target.
    expect(scoreFrame(null, { target: null, done: false })).toEqual({ target: false, done: false });
  });
});

describe('summarize', () => {
  it('reports hit rates and the median latency per question and source', () => {
    const [s] = summarize([
      { question: 'task_step', source: 'haiku', latencyMs: 900, score: { target: true, done: true } },
      { question: 'task_step', source: 'haiku', latencyMs: 1500, score: { target: false, done: true } },
      { question: 'task_step', source: 'haiku', latencyMs: 1100, score: { target: true } },
    ]);
    expect(s).toMatchObject({ question: 'task_step', source: 'haiku', n: 3, p50Ms: 1100 });
    expect(s!.rates).toEqual({ target: { hits: 2, n: 3 }, done: { hits: 2, n: 2 } });
  });
});

describe('labelSkeleton', () => {
  const frame = (id: string, question: CapturedFrame['question']): CapturedFrame => ({
    id, at: '', question, mode: 'GUIDED_TASK', userText: 'goal: eggs', facts: { detections: [], ocr: [] },
    image: { file: `${id}.jpg`, width: 768, height: 1024 }, model: 'h', totalMs: 1, response: withTarget([0.1, 0.1, 0.1, 0.1]),
  });

  it('lists what to fill for each frame without showing the model\'s answer', () => {
    const s = labelSkeleton([frame('a', 'task_step')], {});
    expect(s.a).toEqual({ question: 'task_step', image: 'a.jpg', asked: 'goal: eggs', fill: ['target', 'done'] });
    expect(JSON.stringify(s)).not.toContain('0.1');   // no anchoring on the model's box
  });
  it('never overwrites a label someone already filled in', () => {
    const filled = { a: { target: [0.5, 0.5, 0.2, 0.2], done: true } };
    expect(labelSkeleton([frame('a', 'task_step'), frame('b', 'situate')], filled)).toEqual({
      a: filled.a,
      b: { question: 'situate', image: 'b.jpg', asked: 'goal: eggs', fill: ['setting'] },
    });
  });
  it('skips questions the eval does not judge', () => {
    expect(labelSkeleton([frame('c', 'curb_crop')], {})).toEqual({});
  });
});
