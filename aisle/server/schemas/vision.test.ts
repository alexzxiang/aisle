import { describe, expect, it } from 'vitest';
import { VISION_RESPONSE_SCHEMA, VISION_RESPONSE_SCHEMA_JSON, VISION_RESPONSE_SCHEMA_SHA256, coerceVisionResponse, emptyVisionResponse } from './vision';

function walk(node: unknown, visit: (o: Record<string, unknown>) => void): void {
  if (typeof node !== 'object' || node === null) return;
  const o = node as Record<string, unknown>;
  if (o.type === 'object') visit(o);
  for (const v of Object.values(o)) walk(v, visit);
}

describe('VISION_RESPONSE_SCHEMA', () => {
  it('puts speech first and every contract field in order', () => {
    const props = Object.keys(VISION_RESPONSE_SCHEMA.properties as Record<string, unknown>);
    expect(props).toEqual(['speech', 'cameraRequest', 'userAction', 'aisle', 'storefront', 'scan', 'signal', 'hand', 'task', 'scene', 'confidence', 'seq']);
    expect(VISION_RESPONSE_SCHEMA_JSON.startsWith('{"type":"object","properties":{"speech":')).toBe(true);
  });

  it('has additionalProperties:false and all-required on every object', () => {
    let objects = 0;
    walk(VISION_RESPONSE_SCHEMA, (o) => {
      objects += 1;
      expect(o.additionalProperties).toBe(false);
      expect(o.required).toEqual(Object.keys(o.properties as Record<string, unknown>));
    });
    expect(objects).toBe(8);   // root + aisle, storefront, scan, signal, hand, task, scene
  });

  it('uses no numeric ranges or string lengths (unsupported by structured outputs)', () => {
    expect(VISION_RESPONSE_SCHEMA_JSON).not.toMatch(/minimum|maximum|minLength|maxLength|pattern/);
  });

  it('is byte-stable across calls (one grammar compile per model)', () => {
    expect(JSON.stringify(VISION_RESPONSE_SCHEMA)).toBe(VISION_RESPONSE_SCHEMA_JSON);
    expect(VISION_RESPONSE_SCHEMA_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('coerceVisionResponse', () => {
  it('fills a complete object and pins seq to the request', () => {
    const r = coerceVisionResponse({ ...emptyVisionResponse(1), speech: 'Hi.', scan: { vehiclesSeen: 'approaching', confidence: 0.8 }, seq: 99 }, 5);
    expect(r?.scan).toEqual({ vehiclesSeen: 'approaching', confidence: 0.8 });
    expect(r?.seq).toBe(5);
  });
  it('neutralizes missing or off-enum fields', () => {
    const r = coerceVisionResponse({ speech: 42, hand: { hint: 'grab' }, confidence: 'high' }, 2);
    expect(r?.speech).toBe('');
    expect(r?.hand.hint).toBe('not_seen');
    expect(r?.confidence).toBe(0);
    expect(r?.signal).toEqual({ state: 'UNKNOWN', confidence: 0 });
  });
  it('rejects non-objects', () => {
    expect(coerceVisionResponse(null, 1)).toBeNull();
    expect(coerceVisionResponse([], 1)).toBeNull();
    expect(coerceVisionResponse('x', 1)).toBeNull();
  });
});
