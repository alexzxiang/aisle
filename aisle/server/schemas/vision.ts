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
import { coerceSearchObservation, searchBox, SEARCH_VIEWS } from '../../src/core/searchObservation';
import { FOOD_SECTIONS } from '../../src/core/foodCatalog';

const CAMERA_DIRECTIONS = ['up', 'down', 'left', 'right', 'closer', 'none'] as const;
const USER_ACTIONS = ['none', 'turn_left', 'turn_right', 'walk_forward', 'stop', 'reach'] as const;
const VEHICLES_SEEN = ['none', 'distant', 'approaching', 'unclear'] as const;
const SIGNAL_STATES = ['WALK', 'DONT_WALK', 'COUNTDOWN', 'UNKNOWN'] as const;
const HAND_HINTS = ['left', 'right', 'higher', 'lower', 'forward', 'touching', 'not_seen'] as const;
const SCENE_SETTINGS = ['street', 'crossing', 'entrance', 'store', 'home', 'kitchen', 'hallway', 'room', 'vehicle', 'unknown'] as const;

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
    scene: obj({
      setting: { type: 'string', enum: [...SCENE_SETTINGS], description: 'situate only: the coarse kind of place' },
      label: { type: 'string', description: 'situate only: at most five words, a place phrase such as "in a kitchen" or "on a sidewalk"; empty when unknown' },
      confidence: { type: 'number' },
    }),
    target: obj({
      // No minItems/maxItems: the Messages API rejects array counts other than 0 or 1 in
      // output_config schemas (400 on every vision call, round 7b). box4() enforces four numbers.
      box: { type: ['array', 'null'], items: { type: 'number' }, description: 'task_step / hand_guidance: the target item\'s box in the image as exactly four numbers [x, y, w, h], each 0..1 with origin top-left; null when not visible' },
      confidence: { type: 'number' },
    }),
    search: { ...obj({
      strategy: obj({
        relevance: { type: 'string', enum: ['promising', 'unlikely', 'unknown'] },
        action: { type: 'string', enum: ['inspect', 'relocate', 'recover'] },
        landmark: { type: 'string', description: 'Exact name from search.landmarks to approach or inspect; empty if no observed destination.' },
        reason: { type: 'string', description: 'Short factual explanation of relevance, not a movement command.' },
        confidence: { type: 'number' },
      }),
      inspection: obj({ target: { type: 'string', description: 'Exact requested item from Goal.' }, assessed: { type: 'boolean', description: 'True only if this visible shelf band was deliberately inspected for the requested item; not for an overview, navigation, blur or opaque packaging.' }, confidence: { type: 'number' } }),
      item: obj({ box: { type: ['array', 'null'], items: { type: 'number' }, description: 'The requested FOOD/ITEM from Goal, even while Look for names a navigation landmark. Null unless identified; never a shelf or appliance.' }, confidence: { type: 'number' } }),
      barrier: { type: 'string', enum: ['closed_fridge', 'closed_freezer', 'none', 'unknown'], description: 'A physical door blocking access to the requested item. Visible contents through glass are still behind a closed door.' },
      sign: { type: ['string', 'null'], description: 'Verbatim readable sign identifying the CURRENT area, not a distant destination. Null when unreadable.' },
      items: { type: 'array', items: { type: 'string' }, description: 'Up to twelve confidently identified foods or packages actually visible, never inferred hidden contents.' },
      view: { type: 'string', enum: [...SEARCH_VIEWS] },
      quality: { type: 'string', enum: ['usable', 'blurred', 'dark', 'occluded'] },
      landmarks: { type: 'array', items: obj({
        name: { type: 'string', description: 'Short stable name of a visible navigable landmark; do not invent a hidden destination.' },
        boundary: { type: 'string', enum: ['open_passage', 'cross_aisle', 'closed_door', 'unknown'] },
        kind: { type: 'string', enum: ['surface', 'appliance', 'doorway', 'aisle_end', 'section'] },
        section: { type: 'string', enum: [...FOOD_SECTIONS] },
        box: { type: 'array', items: { type: 'number' } },
        confidence: { type: 'number' },
      }) },
      confidence: { type: 'number' },
    }), type: ['object', 'null'] },
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
    scene: { setting: 'unknown', label: '', confidence: 0 },
    target: { box: null, confidence: 0 },
    confidence: 0,
    seq,
  };
}

const isIn = <T extends string>(set: readonly T[], v: unknown): v is T => typeof v === 'string' && (set as readonly string[]).includes(v);
const box4 = searchBox;
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
  const sn = (r.scene ?? {}) as Record<string, unknown>;
  const tg = (r.target ?? {}) as Record<string, unknown>;
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
    scene: { setting: isIn(SCENE_SETTINGS, sn.setting) ? sn.setting : 'unknown', label: typeof sn.label === 'string' ? sn.label.trim().slice(0, 60) : '', confidence: num(sn.confidence) },
    target: { box: box4(tg.box), confidence: num(tg.confidence) },
    ...(r.search ? { search: coerceSearchObservation(r.search) } : {}),
    confidence: num(r.confidence),
    seq,
  };
}
