/**
 * The one byte-stable superset `VisionResponse` schema (01 §8, 07 §3).
 *
 * Every question uses this exact object as `output_config.format.schema`, so
 * Anthropic's grammar compile (cached 24 h per schema) happens once per model.
 * Never vary it per question. `speech` is first so the proxy can start TTS the
 * instant the string closes. `additionalProperties: false` on every object, every
 * property required, no numeric ranges or string lengths (unsupported).
 *
 * Agent C owns the shape; this file renders it. A change here is a contract change.
 */
import { createHash } from 'node:crypto';
import type { VisionResponse } from '../../src/core/contracts';

const CAMERA_DIRECTIONS = ['up', 'down', 'left', 'right', 'closer', 'none'] as const;
const USER_ACTIONS = ['none', 'turn_left', 'turn_right', 'walk_forward', 'stop', 'reach'] as const;
const VEHICLES_SEEN = ['none', 'distant', 'approaching', 'unclear'] as const;
const SIGNAL_STATES = ['WALK', 'DONT_WALK', 'COUNTDOWN', 'UNKNOWN'] as const;
const HAND_HINTS = ['left', 'right', 'higher', 'lower', 'touching', 'not_seen'] as const;

const obj = (properties: Record<string, unknown>): Record<string, unknown> => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

export const VISION_RESPONSE_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze(
  obj({
    speech: { type: 'string', description: 'At most twelve words, or an empty string. Numbers as words.' },
    cameraRequest: { type: 'string', enum: [...CAMERA_DIRECTIONS] },
    userAction: { type: 'string', enum: [...USER_ACTIONS] },
    aisle: obj({
      matchedAisleId: { type: ['string', 'null'] },
      matchedLandmarkId: { type: ['string', 'null'] },
      confidence: { type: 'number' },
    }),
    storefront: obj({ visible: { type: 'boolean' }, confidence: { type: 'number' } }),
    scan: obj({ vehiclesSeen: { type: 'string', enum: [...VEHICLES_SEEN] }, confidence: { type: 'number' } }),
    signal: obj({ state: { type: 'string', enum: [...SIGNAL_STATES] }, confidence: { type: 'number' } }),
    hand: obj({ hint: { type: 'string', enum: [...HAND_HINTS] } }),
    task: obj({ done: { type: 'boolean', description: 'task_step only: the current step is complete' }, confidence: { type: 'number' } }),
    confidence: { type: 'number' },
    seq: { type: 'integer' },
  }),
);

/** Canonical bytes (stable key order = insertion order above). */
export const VISION_RESPONSE_SCHEMA_JSON: string = JSON.stringify(VISION_RESPONSE_SCHEMA);
export const VISION_RESPONSE_SCHEMA_SHA256: string = createHash('sha256').update(VISION_RESPONSE_SCHEMA_JSON).digest('hex');

/** The only thing the client gets on timeout / non-end_turn / invalid JSON. */
export function emptyVisionResponse(seq: number): VisionResponse {
  return {
    speech: '',
    cameraRequest: 'none',
    userAction: 'none',
    aisle: { matchedAisleId: null, matchedLandmarkId: null, confidence: 0 },
    storefront: { visible: false, confidence: 0 },
    scan: { vehiclesSeen: 'unclear', confidence: 0 },
    signal: { state: 'UNKNOWN', confidence: 0 },
    hand: { hint: 'not_seen' },
    task: { done: false, confidence: 0 },
    confidence: 0,
    seq,
  };
}

const isIn = <T extends string>(set: readonly T[], v: unknown): v is T => typeof v === 'string' && (set as readonly string[]).includes(v);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/**
 * Coerce a parsed model object onto the contract shape. Anything missing or off-enum
 * falls to the neutral value; `seq` is always the request's. Returns null when the
 * input is not an object at all (the caller then answers `{ confidence: 0 }`).
 */
export function coerceVisionResponse(raw: unknown, seq: number): VisionResponse | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const a = (r.aisle ?? {}) as Record<string, unknown>;
  const sf = (r.storefront ?? {}) as Record<string, unknown>;
  const sc = (r.scan ?? {}) as Record<string, unknown>;
  const sg = (r.signal ?? {}) as Record<string, unknown>;
  const h = (r.hand ?? {}) as Record<string, unknown>;
  return {
    speech: typeof r.speech === 'string' ? r.speech : '',
    cameraRequest: isIn(CAMERA_DIRECTIONS, r.cameraRequest) ? r.cameraRequest : 'none',
    userAction: isIn(USER_ACTIONS, r.userAction) ? r.userAction : 'none',
    aisle: { matchedAisleId: strOrNull(a.matchedAisleId), matchedLandmarkId: strOrNull(a.matchedLandmarkId), confidence: num(a.confidence) },
    storefront: { visible: sf.visible === true, confidence: num(sf.confidence) },
    scan: { vehiclesSeen: isIn(VEHICLES_SEEN, sc.vehiclesSeen) ? sc.vehiclesSeen : 'unclear', confidence: num(sc.confidence) },
    signal: { state: isIn(SIGNAL_STATES, sg.state) ? sg.state : 'UNKNOWN', confidence: num(sg.confidence) },
    hand: { hint: isIn(HAND_HINTS, h.hint) ? h.hint : 'not_seen' },
    task: { done: (r.task as { done?: unknown } | undefined)?.done === true, confidence: num((r.task as { confidence?: unknown } | undefined)?.confidence) },
    confidence: num(r.confidence),
    seq,
  };
}
