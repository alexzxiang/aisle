import { describe, expect, it } from 'vitest';
import type { VisionRequest } from '../../src/core/contracts';
import { emptyVisionResponse } from '../schemas/vision';
import type { VisionCallResult } from './anthropic';
import { withFrameCapture, type CapturedFrame } from './frameCapture';

const req = (over: Partial<VisionRequest> = {}): VisionRequest => ({
  seq: 7, question: 'task_step', mode: 'GUIDED_TASK', facts: { detections: [], ocr: ['MILK'] },
  image: { base64: Buffer.from('jpegbytes').toString('base64'), width: 768, height: 1024 },
  userText: 'goal: eggs in my fridge', ...over,
});
const result: VisionCallResult = {
  response: emptyVisionResponse(7), speech: '', verdict: 'pass', model: 'claude-haiku-4-5',
  stopReason: 'end_turn', firstTokenMs: 300, speechClosedMs: null, totalMs: 900,
} as VisionCallResult;

function recorder() {
  const files = new Map<string, string | Buffer>();
  return { files, write: async (p: string, d: string | Buffer) => { files.set(p.split(/[\\/]/).pop()!, d); } };
}

describe('withFrameCapture', () => {
  it('returns the vision result untouched and saves the still, its facts and the answer', async () => {
    const rec = recorder();
    const cap = withFrameCapture(async () => result, { dir: 'frames', mkdirp: async () => undefined, now: () => 1000, write: rec.write });
    expect(await cap.vision(req(), {})).toBe(result);
    await cap.flush();
    expect(rec.files.get('1000-7-1.jpg')).toEqual(Buffer.from('jpegbytes'));
    const frame = JSON.parse(String(rec.files.get('1000-7-1.json'))) as CapturedFrame;
    expect(frame).toMatchObject({ id: '1000-7-1', question: 'task_step', userText: 'goal: eggs in my fridge', model: 'claude-haiku-4-5', totalMs: 900 });
    expect(frame.facts.ocr).toEqual(['MILK']);
    expect(frame.image).toEqual({ file: '1000-7-1.jpg', width: 768, height: 1024 });
  });

  it('records a facts-only call without inventing an image', async () => {
    const rec = recorder();
    const cap = withFrameCapture(async () => result, { dir: 'frames', mkdirp: async () => undefined, now: () => 1, write: rec.write });
    await cap.vision(req({ image: undefined }), {});
    await cap.flush();
    expect([...rec.files.keys()]).toEqual(['1-7-1.json']);
    expect((JSON.parse(String(rec.files.get('1-7-1.json'))) as CapturedFrame).image).toBeNull();
  });

  it('never lets a failed write reach the caller', async () => {
    const cap = withFrameCapture(async () => result, { dir: 'frames', mkdirp: async () => undefined, write: async () => { throw new Error('disk full'); } });
    await expect(cap.vision(req(), {})).resolves.toBe(result);
    await expect(cap.flush()).resolves.toBeUndefined();
  });

  it('gives two calls in the same millisecond different ids', async () => {
    const rec = recorder();
    const cap = withFrameCapture(async () => result, { dir: 'frames', mkdirp: async () => undefined, now: () => 5, write: rec.write });
    await cap.vision(req(), {});
    await cap.vision(req(), {});
    await cap.flush();
    expect([...rec.files.keys()].filter((k) => k.endsWith('.json')).sort()).toEqual(['5-7-1.json', '5-7-2.json']);
  });
});
