import { describe, expect, it } from 'vitest';
import { MODELS } from '../config';
import { VISION_RESPONSE_SCHEMA } from '../schemas/vision';
import { fakeClaude, sampleRequest, visionBody } from '../test/fakes';
import { buildVisionParams, modelFor, runVision } from './anthropic';

describe('buildVisionParams', () => {
  it('routes curb_crop to Sonnet 5 with thinking disabled and a cache_control breakpoint on the system prompt', () => {
    const p = buildVisionParams(sampleRequest({ question: 'curb_crop', mode: 'AT_CURB' }));
    expect(p.model).toBe(MODELS.sonnet);
    expect(p.thinking).toEqual({ type: 'disabled' });
    expect(p.temperature).toBeUndefined();
    const sys = p.system as Array<{ cache_control?: unknown }>;
    expect(sys[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('routes everything else to Haiku 4.5 with no thinking field', () => {
    for (const q of ['storefront', 'aisle_disambiguate', 'scan_left', 'scan_right', 'hand_guidance', 'free'] as const) {
      const p = buildVisionParams(sampleRequest({ question: q }));
      expect(p.model, q).toBe(MODELS.haiku);
      expect(p.thinking, q).toBeUndefined();
      expect(modelFor(q)).toBe(MODELS.haiku);
    }
  });

  it('sends the byte-stable superset schema as output_config.format, max_tokens 300, image before text', () => {
    const p = buildVisionParams(sampleRequest());
    expect(p.max_tokens).toBe(300);
    expect(p.output_config?.format).toEqual({ type: 'json_schema', schema: VISION_RESPONSE_SCHEMA });
    const content = p.messages[0]!.content as Array<{ type: string }>;
    expect(content.map((c) => c.type)).toEqual(['image', 'text']);
  });

  it('is text-only when the image is absent', () => {
    const p = buildVisionParams(sampleRequest({ image: undefined }));
    const content = p.messages[0]!.content as Array<{ type: string }>;
    expect(content.map((c) => c.type)).toEqual(['text']);
  });

  it('includes knownSigns only for aisle_disambiguate', () => {
    const withSigns = buildVisionParams(sampleRequest({ question: 'aisle_disambiguate', facts: { detections: [], ocr: ['3 DAIRY'], knownSigns: ['3', 'DAIRY'] } }));
    const sys = (withSigns.system as Array<{ text: string }>)[0]!.text;
    expect(sys).toContain('DAIRY');
    const other = buildVisionParams(sampleRequest({ question: 'storefront', facts: { detections: [], ocr: [], knownSigns: ['3', 'DAIRY'] } }));
    expect((other.system as Array<{ text: string }>)[0]!.text).not.toContain('DAIRY');
  });
});

describe('runVision', () => {
  it('extracts speech while streaming, fires onSpeechReady after the language check, and returns the coerced response', async () => {
    const stream = fakeClaude({ speech: 'Aisle three. Eggs on your right.' });
    const ready: string[] = [];
    const r = await runVision(sampleRequest({ seq: 7 }), { onSpeechReady: (s) => ready.push(s) }, { stream });
    expect(ready).toEqual(['Aisle three. Eggs on your right.']);
    expect(r.response?.speech).toBe('Aisle three. Eggs on your right.');
    expect(r.response?.seq).toBe(7);
    expect(r.response?.confidence).toBe(0.9);
    expect(r.verdict).toBe('pass');
    expect(r.speechClosedMs).not.toBeNull();
    expect(r.firstTokenMs).not.toBeNull();
    expect(r.stopReason).toBe('end_turn');
  });

  it('blanks forbidden speech before TTS and in the JSON', async () => {
    const stream = fakeClaude({ speech: 'The road is clear.' });
    const ready: string[] = [];
    const r = await runVision(sampleRequest(), { onSpeechReady: (s) => ready.push(s) }, { stream });
    expect(ready).toEqual(['']);
    expect(r.verdict).toBe('blanked');
    expect(r.response?.speech).toBe('');
    expect(r.response?.confidence).toBe(0.9);
  });

  it('returns null (client gets confidence 0) when stop_reason is not end_turn', async () => {
    const r = await runVision(sampleRequest(), {}, { stream: fakeClaude({ speech: 'Doors ahead.', stopReason: 'max_tokens' }) });
    expect(r.response).toBeNull();
    expect(r.error).toBe('stop_reason:max_tokens');
  });

  it('returns null on a timeout and still fires onSpeechReady("") so the socket closes cleanly', async () => {
    const ready: string[] = [];
    const r = await runVision(sampleRequest(), { onSpeechReady: (s) => ready.push(s) }, { stream: fakeClaude({ speech: 'Doors ahead.', deltas: 10, delayMs: 30 }), timeoutMs: 40 });
    expect(r.response).toBeNull();
    expect(r.error).toBe('timeout');
    expect(ready.length).toBe(1);
  });

  it('returns null on invalid JSON', async () => {
    const r = await runVision(sampleRequest(), {}, { stream: fakeClaude({ body: '{"speech":"Hi."' }) });
    expect(r.response).toBeNull();
    expect(r.error).toBe('invalid_json');
  });

  it('coerces off-enum values to neutral and keeps seq from the request', async () => {
    const body = visionBody('Hi.', { cameraRequest: 'sideways' as never, seq: 999 });
    const r = await runVision(sampleRequest({ seq: 3 }), {}, { stream: fakeClaude({ body }) });
    expect(r.response?.cameraRequest).toBe('none');
    expect(r.response?.seq).toBe(3);
  });

  it('throws a config error when no key and no stream are given', async () => {
    await expect(runVision(sampleRequest(), {}, { apiKey: null })).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});
