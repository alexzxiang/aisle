import { describe, expect, it } from 'vitest';
import { boxOrNull } from '../../src/core/contracts';
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
    expect(props).toEqual(['speech', 'cameraRequest', 'userAction', 'aisle', 'storefront', 'scan', 'signal', 'hand', 'task', 'target', 'scene', 'confidence', 'seq']);
    expect(VISION_RESPONSE_SCHEMA_JSON.startsWith('{"type":"object","properties":{"speech":')).toBe(true);
  });

  it('has additionalProperties:false and all-required on every object', () => {
    let objects = 0;
    walk(VISION_RESPONSE_SCHEMA, (o) => {
      objects += 1;
      expect(o.additionalProperties).toBe(false);
      expect(o.required).toEqual(Object.keys(o.properties as Record<string, unknown>));
    });
    expect(objects).toBe(9);   // root + aisle, storefront, scan, signal, hand, task, target, scene
  });

  it('uses no numeric ranges or string lengths (unsupported by structured outputs)', () => {
    expect(VISION_RESPONSE_SCHEMA_JSON).not.toMatch(/minimum|maximum|minLength|maxLength|pattern/);
    expect(VISION_RESPONSE_SCHEMA_JSON).not.toMatch(/minItems|maxItems/);   // box length is checked in coercion
  });

  it('asks for boxes as a nullable array of numbers', () => {
    const t = (VISION_RESPONSE_SCHEMA.properties as Record<string, { properties?: Record<string, unknown> }>).target!;
    expect(t.properties?.box).toMatchObject({ type: ['array', 'null'], items: { type: 'number' } });
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
  it('keeps a normalized target box and defaults the field when absent', () => {
    const r = coerceVisionResponse({ target: { box: [0.25, 0.5, 0.2, 0.3], confidence: 0.7 } }, 1);
    expect(r?.target).toEqual({ box: [0.25, 0.5, 0.2, 0.3], confidence: 0.7 });
    expect(coerceVisionResponse({}, 1)?.target).toEqual({ box: null, confidence: 0 });
    expect(coerceVisionResponse({}, 1)?.hand.box).toBeNull();
  });
});

describe('boxOrNull', () => {
  it('nulls a box answered in pixels rather than clamping it onto the whole frame', () => {
    // [1,1,1,1] would aim a hand confidently at nothing; null makes the caller fall back.
    expect(boxOrNull([120, 300, 200, 150])).toBeNull();
  });
  it('clamps a target that runs past the edge, since half-out-of-frame is still a true direction', () => {
    const b = boxOrNull([-0.02, 0.9, 0.3, 0.4])!;
    expect(b[0]).toBe(0);                 // negative x pulled back to the edge
    expect(b[1]).toBe(0.9);
    expect(b[2]).toBe(0.3);
    expect(b[3]).toBeCloseTo(0.1, 10);    // height trimmed so the box ends at the frame
  });
  it('rejects wrong lengths, non-numbers and empty boxes', () => {
    for (const bad of [null, 'x', [0.1, 0.2, 0.3], [0.1, 0.2, 0.3, 0.4, 0.5], [0.1, 0.2, 'w', 0.4], [0.1, 0.2, 0, 0.4], [0.5, 0.5, NaN, 0.1]]) {
      expect(boxOrNull(bad)).toBeNull();
    }
  });
});
