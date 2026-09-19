/**
 * Store map (01 §6) — the format Agent C owns; D produces the fixtures.
 *
 * `AisleStoreMap` is `StoreMap` (01 §6, verbatim in contracts.ts) with the
 * aisle / landmark / item element types named so `src/indoor/` can pass them
 * around; everything spoken comes from `spokenLabel`, written as words. The
 * validator below is 04 Task 0 step 1 plus the 01 §6 rule that a digit in a
 * `spokenLabel` is a fixture bug.
 */
import type { Side, StoreMap } from '../core/contracts';

export interface StoreAisle {
  id: string;
  label: string;          // display / log only; may carry digits
  spokenLabel: string;    // spoken; digits written as words
  signText: string[];
  order: number;
  categories: string[];
}

export interface StoreLandmark {
  id: string;
  label: string;
  spokenLabel: string;
  signText: string[];
  afterAisleOrder: number;
}

export interface StoreItem {
  aisleId: string;
  sideWhenAscending: Side;
  shelf?: string;
  packageHint?: string;
}

export interface AisleStoreMap extends StoreMap {
  aisles: StoreAisle[];
  landmarks: StoreLandmark[];
  itemIndex: Record<string, StoreItem>;
}

export const CHECKOUT_LANDMARK_ID = 'checkout';

export type StoreMapValidation =
  | { ok: true; map: AisleStoreMap; warnings: string[] }
  | { ok: false; errors: string[] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isSide = (v: unknown): v is Side => v === 'LEFT' || v === 'RIGHT';
const hasDigit = (s: string): boolean => /\d/.test(s);

/**
 * 04 Task 0 step 1: `entrance.pinnedBy` present, every `order` unique, every
 * `signText` non-empty, every `itemIndex` entry pointing at a real aisle. Plus
 * 01 §6: a `spokenLabel` with a digit is a fixture bug — fail the load.
 */
export function validateStoreMap(raw: unknown): StoreMapValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ['store map is not an object'] };

  if (typeof raw.storeId !== 'string' || raw.storeId.length === 0) errors.push('storeId missing');
  if (typeof raw.displayName !== 'string') errors.push('displayName missing');

  const entrance = raw.entrance;
  if (!isRecord(entrance)) {
    errors.push('entrance missing');
  } else {
    if (typeof entrance.lat !== 'number' || typeof entrance.lng !== 'number') errors.push('entrance.lat/lng must be numbers');
    if (typeof entrance.radiusM !== 'number' || entrance.radiusM <= 0) errors.push('entrance.radiusM must be > 0');
    if (typeof entrance.pinnedBy !== 'string' || entrance.pinnedBy.length === 0) errors.push('entrance.pinnedBy missing (pin the door on the venue walk; never a Places centroid)');
    if (typeof entrance.pinnedAt !== 'string') errors.push('entrance.pinnedAt missing');
  }

  const aisles = raw.aisles;
  const orders = new Set<number>();
  const aisleIds = new Set<string>();
  if (!Array.isArray(aisles) || aisles.length === 0) {
    errors.push('aisles must be a non-empty array');
  } else {
    aisles.forEach((a: unknown, i: number) => {
      const where = `aisles[${i}]`;
      if (!isRecord(a)) {
        errors.push(`${where} is not an object`);
        return;
      }
      if (typeof a.id !== 'string' || !a.id) errors.push(`${where}.id missing`);
      else if (aisleIds.has(a.id)) errors.push(`${where}.id '${a.id}' duplicated`);
      else aisleIds.add(a.id);
      if (typeof a.label !== 'string') errors.push(`${where}.label missing`);
      if (typeof a.spokenLabel !== 'string' || !a.spokenLabel) errors.push(`${where}.spokenLabel missing (01 §6)`);
      else if (hasDigit(a.spokenLabel)) errors.push(`${where}.spokenLabel '${a.spokenLabel}' contains a digit; write it as words`);
      if (!isStringArray(a.signText) || a.signText.length === 0 || a.signText.some((s) => s.trim().length === 0)) {
        errors.push(`${where}.signText must be a non-empty array of non-empty strings`);
      }
      if (typeof a.order !== 'number' || !Number.isFinite(a.order)) errors.push(`${where}.order must be a number`);
      else if (orders.has(a.order)) errors.push(`${where}.order ${a.order} duplicated`);
      else orders.add(a.order);
      if (!isStringArray(a.categories)) errors.push(`${where}.categories must be a string array`);
    });
  }

  const landmarks = raw.landmarks;
  if (!Array.isArray(landmarks)) {
    errors.push('landmarks must be an array');
  } else {
    landmarks.forEach((l: unknown, i: number) => {
      const where = `landmarks[${i}]`;
      if (!isRecord(l)) {
        errors.push(`${where} is not an object`);
        return;
      }
      if (typeof l.id !== 'string' || !l.id) errors.push(`${where}.id missing`);
      if (typeof l.spokenLabel !== 'string' || !l.spokenLabel) errors.push(`${where}.spokenLabel missing (01 §6)`);
      else if (hasDigit(l.spokenLabel)) errors.push(`${where}.spokenLabel '${l.spokenLabel}' contains a digit`);
      if (!isStringArray(l.signText) || l.signText.length === 0) errors.push(`${where}.signText must be a non-empty array`);
      if (typeof l.afterAisleOrder !== 'number') errors.push(`${where}.afterAisleOrder must be a number`);
    });
    if (!landmarks.some((l: unknown) => isRecord(l) && l.id === CHECKOUT_LANDMARK_ID)) {
      warnings.push(`no '${CHECKOUT_LANDMARK_ID}' landmark: CHECKOUT_NAV cannot finish from a sign`);
    }
  }

  const itemIndex = raw.itemIndex;
  if (!isRecord(itemIndex)) {
    errors.push('itemIndex must be an object');
  } else {
    for (const [item, entry] of Object.entries(itemIndex)) {
      const where = `itemIndex['${item}']`;
      if (!isRecord(entry)) {
        errors.push(`${where} is not an object`);
        continue;
      }
      if (typeof entry.aisleId !== 'string' || !aisleIds.has(entry.aisleId)) errors.push(`${where}.aisleId '${String(entry.aisleId)}' is not an aisle`);
      if (!isSide(entry.sideWhenAscending)) errors.push(`${where}.sideWhenAscending must be LEFT or RIGHT`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, map: raw as unknown as AisleStoreMap, warnings };
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function aisleById(map: AisleStoreMap, id: string): StoreAisle | null {
  return map.aisles.find((a) => a.id === id) ?? null;
}

export function landmarkById(map: AisleStoreMap, id: string): StoreLandmark | null {
  return map.landmarks.find((l) => l.id === id) ?? null;
}

/** `order` for an aisle id or `afterAisleOrder` for a landmark id; null when unknown. */
export function orderOf(map: AisleStoreMap, id: string): number | null {
  const a = aisleById(map, id);
  if (a) return a.order;
  const l = landmarkById(map, id);
  return l ? l.afterAisleOrder : null;
}

/** Every signText token, uppercased and deduplicated: the OCR `customWords` list (04 Task 0 step 6). */
export function signVocabulary(map: AisleStoreMap): string[] {
  const out = new Set<string>();
  const push = (s: string): void => {
    for (const tok of s.toUpperCase().split(/\s+/)) if (tok) out.add(tok);
  };
  for (const a of map.aisles) a.signText.forEach(push);
  for (const l of map.landmarks) l.signText.forEach(push);
  return Array.from(out);
}

/** Aisles sorted by order, ascending. */
export function aislesByOrder(map: AisleStoreMap): StoreAisle[] {
  return [...map.aisles].sort((a, b) => a.order - b.order);
}
