/**
 * B's zustand slice (03 Task 5): what the beacon, the nav screen and the
 * DebugPanel read from the outdoor track. Nobody outside `src/outdoor/` and
 * `src/crossing/` writes it.
 *
 * `beaconTarget` is a point; Agent A's beacon resolves it against the last
 * fix each pulse (`src/core/audio.ts` BeaconTarget accepts `{lat,lng}`). The
 * beacon encodes direction only — distance is spoken, never beeped.
 *
 * Contract flag (03 Task 5): this slice is not in 01; agreed with A on day 0.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { LatLng } from './geo';
import type { RouteCrossing, RouteLeg, RouteResponse } from './types';

export type SignalSource = 'live' | 'claude' | 'manual' | 'none';

export interface OutdoorState {
  /** Where the beacon should point, or null for off. */
  beaconTarget: LatLng | null;
  /** Metres to the current leg's maneuver point (null before a route exists). */
  nextManeuverM: number | null;
  /** Metres along-track to the next crossing's near curb (null when none ahead). */
  nextCrossingM: number | null;
  legIndex: number;
  legs: RouteLeg[];
  crossings: RouteCrossing[];
  destName: string | null;
  warnings: string[];
  attribution: string | null;
  plannerFallback: { routeCompile: boolean; crossingAnnounce: boolean } | null;
  /** Monotonic counter; the CrossingController re-runs the scan when it changes. */
  rescanRequests: number;
  /** Last GPS fix accepted or rejected by the accuracy gate (DebugPanel). */
  lastFixCounted: boolean | null;
  /** Utterances B asked for since route load (DebugPanel counter). */
  utteranceCount: number;
  /** Crossing debug: controller state and sources. */
  crossingState: string | null;
  signalSource: SignalSource;
  scanVerdicts: { left: string | null; right: string | null } | null;
  /** Re-plans triggered by the off-route rule. */
  replans: number;
  offline: boolean;
}

export interface OutdoorActions {
  setRoute(route: Pick<RouteResponse, 'legs' | 'crossings' | 'destName' | 'warnings' | 'attribution' | 'planner'>): void;
  clearRoute(): void;
  setBeaconTarget(target: LatLng | null): void;
  setProgress(p: { legIndex?: number; nextManeuverM?: number | null; nextCrossingM?: number | null; lastFixCounted?: boolean | null }): void;
  requestRescan(): void;
  countUtterance(): void;
  setCrossingDebug(d: Partial<Pick<OutdoorState, 'crossingState' | 'signalSource' | 'scanVerdicts'>>): void;
  bumpReplans(): void;
  setOffline(v: boolean): void;
  reset(): void;
}

export type OutdoorStoreState = OutdoorState & OutdoorActions;
export type OutdoorStore = StoreApi<OutdoorStoreState>;

export const INITIAL_OUTDOOR_STATE: OutdoorState = {
  beaconTarget: null,
  nextManeuverM: null,
  nextCrossingM: null,
  legIndex: 0,
  legs: [],
  crossings: [],
  destName: null,
  warnings: [],
  attribution: null,
  plannerFallback: null,
  rescanRequests: 0,
  lastFixCounted: null,
  utteranceCount: 0,
  crossingState: null,
  signalSource: 'none',
  scanVerdicts: null,
  replans: 0,
  offline: false,
};

export function createOutdoorStore(initial: Partial<OutdoorState> = {}): OutdoorStore {
  return createStore<OutdoorStoreState>()((set) => ({
    ...INITIAL_OUTDOOR_STATE,
    ...initial,
    setRoute(route) {
      set({
        legs: route.legs,
        crossings: route.crossings,
        destName: route.destName,
        warnings: route.warnings,
        attribution: route.attribution,
        plannerFallback: { routeCompile: route.planner.routeCompile.fallback, crossingAnnounce: route.planner.crossingAnnounce.fallback },
        legIndex: 0,
        nextManeuverM: route.legs[0]?.distanceM ?? null,
        nextCrossingM: route.crossings[0]?.sAlongM ?? null,
        beaconTarget: null,
      });
    },
    clearRoute() {
      set({ ...INITIAL_OUTDOOR_STATE });
    },
    setBeaconTarget(target) {
      set({ beaconTarget: target });
    },
    setProgress(p) {
      set((s) => ({
        legIndex: p.legIndex ?? s.legIndex,
        nextManeuverM: p.nextManeuverM === undefined ? s.nextManeuverM : p.nextManeuverM,
        nextCrossingM: p.nextCrossingM === undefined ? s.nextCrossingM : p.nextCrossingM,
        lastFixCounted: p.lastFixCounted === undefined ? s.lastFixCounted : p.lastFixCounted,
      }));
    },
    requestRescan() {
      set((s) => ({ rescanRequests: s.rescanRequests + 1 }));
    },
    countUtterance() {
      set((s) => ({ utteranceCount: s.utteranceCount + 1 }));
    },
    setCrossingDebug(d) {
      set((s) => ({
        crossingState: d.crossingState === undefined ? s.crossingState : d.crossingState,
        signalSource: d.signalSource ?? s.signalSource,
        scanVerdicts: d.scanVerdicts === undefined ? s.scanVerdicts : d.scanVerdicts,
      }));
    },
    bumpReplans() {
      set((s) => ({ replans: s.replans + 1 }));
    },
    setOffline(v) {
      set({ offline: v });
    },
    reset() {
      set({ ...INITIAL_OUTDOOR_STATE });
    },
  }));
}

/** The app-wide slice. Tests create their own with `createOutdoorStore()`. */
export const outdoorStore: OutdoorStore = createOutdoorStore();

export function useOutdoorStore<T>(selector: (s: OutdoorStoreState) => T): T {
  return useStore(outdoorStore, selector);
}

// ---------------------------------------------------------------------------
// Beacon target rule (03 Task 5), pure
// ---------------------------------------------------------------------------

export const BEACON_WINDOW_M = 40;

/**
 * The maneuver point inside the last 40 m of a leg, the store entrance inside
 * the last 40 m of the final leg, `null` otherwise. (While CROSSING the
 * controller sets `farCurb` itself.)
 */
export function beaconTargetFor(
  leg: RouteLeg | undefined,
  remainingM: number,
  entrance: LatLng | null,
): LatLng | null {
  if (!leg) return null;
  if (remainingM > BEACON_WINDOW_M) return null;
  if (leg.maneuver === 'ARRIVE') return entrance ?? { lat: leg.endLat, lng: leg.endLng };
  return { lat: leg.endLat, lng: leg.endLng };
}
