/**
 * Round 4: "take me to CVS" — resolve a spoken place name to a trip destination.
 *
 * Order: (1) the loaded store map when its display name matches (keeps the aisle flow for
 * the demo store), (2) the proxy's `/api/places` (OpenStreetMap via Overpass, nearest name
 * match), synthesized into a map with no aisles — the trip then runs "destination-only":
 * outdoor guidance to the entrance, the store-entry handoff, and DONE at the door.
 * Nothing here decides how to walk there; that stays with the route and the perception tiers.
 */
import type { GeoFix } from './contracts';
import type { AisleStoreMap } from '../indoor/storeMap';

export interface Place {
  id: string;
  name: string;
  lat: number;
  lng: number;
  distanceM: number;
  kind: string | null;
}

export interface ResolveDestinationDeps {
  proxyUrl: string;
  fetchImpl?: typeof fetch;
  /** The loaded store map (if any): a name match keeps the real map. */
  loadedMap?: AisleStoreMap | null;
  timeoutMs?: number;
  now?: () => number;
}

export type DestinationOutcome =
  | { kind: 'store_map'; map: AisleStoreMap }
  | { kind: 'place'; map: AisleStoreMap; place: Place }
  | { kind: 'none'; reason: 'no_match' | 'offline' | 'no_fix' };

export const PLACE_ENTRANCE_RADIUS_M = 35;
export const DESTINATION_TIMEOUT_MS = 25_000;

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Does the spoken name match the loaded map's display name (either direction)? */
export function matchesStoreMap(name: string, map: AisleStoreMap | null | undefined): boolean {
  if (!map) return false;
  const a = norm(name);
  const b = norm(map.displayName);
  return a.length > 0 && b.length > 0 && (a === b || a.includes(b) || b.includes(a));
}

/** A store map with no aisles: entrance = the place; the item index is empty. */
export function mapForPlace(place: Place, now: number = Date.now()): AisleStoreMap {
  return {
    storeId: `poi-${place.id.replace(/[^a-z0-9]+/gi, '-')}`,
    displayName: place.name,
    entrance: { lat: place.lat, lng: place.lng, radiusM: PLACE_ENTRANCE_RADIUS_M, pinnedBy: 'openstreetmap', pinnedAt: new Date(now).toISOString().slice(0, 10) },
    aisles: [],
    landmarks: [],
    itemIndex: {},
  };
}

export async function resolveDestination(name: string, fix: GeoFix | null, deps: ResolveDestinationDeps): Promise<DestinationOutcome> {
  if (matchesStoreMap(name, deps.loadedMap)) return { kind: 'store_map', map: deps.loadedMap as AisleStoreMap };
  if (!fix) return { kind: 'none', reason: 'no_fix' };
  const fetchImpl = deps.fetchImpl ?? fetch;
  const q = new URLSearchParams({ q: name, lat: String(fix.lat), lng: String(fix.lng), radiusM: '2500', limit: '3' });
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => controller?.abort(), deps.timeoutMs ?? DESTINATION_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${deps.proxyUrl.replace(/\/+$/, '')}/api/places?${q.toString()}`, { headers: { Accept: 'application/json' }, signal: controller?.signal });
    if (!res.ok) return { kind: 'none', reason: res.status >= 500 ? 'offline' : 'no_match' };
    const body = (await res.json()) as { places?: Place[] };
    const place = Array.isArray(body.places) ? body.places[0] : undefined;
    if (!place || typeof place.lat !== 'number' || typeof place.lng !== 'number') return { kind: 'none', reason: 'no_match' };
    return { kind: 'place', map: mapForPlace(place, deps.now?.() ?? Date.now()), place };
  } catch {
    return { kind: 'none', reason: 'offline' };
  } finally {
    clearTimeout(timer);
  }
}
