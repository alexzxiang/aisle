import { FOOD_SECTIONS, type FoodSection } from './foodCatalog';

export const SEARCH_VIEWS = ['overview', 'left', 'right', 'upper', 'middle', 'lower', 'label', 'unknown'] as const;
export type SearchView = typeof SEARCH_VIEWS[number];
export type SearchBox = [number, number, number, number];
export interface SearchLandmark {
  name: string;
  kind: 'surface' | 'appliance' | 'doorway' | 'aisle_end' | 'section';
  section: FoodSection;
  box: SearchBox;
  confidence: number;
}
export interface SearchObservation {
  /** Requested item, separate from a navigation landmark named in Look for. */
  item?: { box: SearchBox | null; confidence: number };
  /** Physical barrier between the user and requested food, including transparent doors. */
  barrier?: 'closed_fridge' | 'closed_freezer' | 'none' | 'unknown';
  /** Readable aisle/section sign, verbatim. Null if no sign, never a guessed aisle number. */
  sign: string | null;
  items: string[];
  view: SearchView;
  quality: 'usable' | 'blurred' | 'dark' | 'occluded';
  landmarks: SearchLandmark[];
  confidence: number;
}

export function searchBox(raw: unknown): SearchBox | null {
  if (!Array.isArray(raw) || raw.length !== 4 || !raw.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)) return null;
  const [x, y, w, h] = raw as SearchBox;
  return w > 0 && h > 0 && x + w <= 1.01 && y + h <= 1.01 ? [x, y, w, h] : null;
}
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const confidence = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
const name = (v: unknown): string => typeof v === 'string' ? v.trim().slice(0, 60) : '';

/** Shared by proxy and phone. Old servers may omit search entirely. */
export function coerceSearchObservation(raw: unknown): SearchObservation | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = record(raw);
  const landmarks: SearchLandmark[] = [];
  for (const rawLandmark of Array.isArray(r.landmarks) ? r.landmarks.slice(0, 6) : []) {
    const l = record(rawLandmark);
    const box = searchBox(l.box);
    if (!box || !name(l.name) || !['surface', 'appliance', 'doorway', 'aisle_end', 'section'].includes(String(l.kind))) continue;
    landmarks.push({ name: name(l.name), kind: l.kind as SearchLandmark['kind'], box, confidence: confidence(l.confidence), section: FOOD_SECTIONS.includes(l.section as FoodSection) ? l.section as FoodSection : 'unknown' });
  }
  return {
    item: { box: searchBox(record(r.item).box), confidence: confidence(record(r.item).confidence) },
    barrier: ['closed_fridge', 'closed_freezer', 'none', 'unknown'].includes(String(r.barrier)) ? r.barrier as SearchObservation['barrier'] : 'unknown',
    sign: name(r.sign) || null,
    items: Array.isArray(r.items) ? [...new Set(r.items.map(name).filter(Boolean))].slice(0, 12) : [],
    view: SEARCH_VIEWS.includes(r.view as SearchView) ? r.view as SearchView : 'unknown',
    quality: ['usable', 'blurred', 'dark', 'occluded'].includes(String(r.quality)) ? r.quality as SearchObservation['quality'] : 'occluded',
    landmarks,
    confidence: confidence(r.confidence),
  };
}
