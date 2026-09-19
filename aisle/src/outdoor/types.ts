/**
 * B-internal outdoor types (03 Task 1). Not part of `contracts.ts`.
 * `Crossing` and `RouteCompileOutput` come from 01 (§10, §9).
 */
import type { Crossing, RouteCompileOutput } from '../core/contracts';
import type { LatLng } from './geo';

export type LegManeuver =
  | 'STRAIGHT' | 'SLIGHT_LEFT' | 'SLIGHT_RIGHT' | 'TURN_LEFT' | 'TURN_RIGHT' | 'UTURN' | 'ARRIVE';

export const LEG_MANEUVERS: readonly LegManeuver[] = [
  'STRAIGHT', 'SLIGHT_LEFT', 'SLIGHT_RIGHT', 'TURN_LEFT', 'TURN_RIGHT', 'UTURN', 'ARRIVE',
];

export type RoadSide = 'LEFT' | 'RIGHT' | 'NONE';

export interface RouteLeg {
  index: number;
  instruction: string;       // Google's plain text: planner input + DebugPanel only, never spoken raw
  maneuver: LegManeuver;     // the maneuver at the END of this leg (= next Google step's maneuver)
  distanceM: number;
  polyline: LatLng[];
  startBearingDeg: number;   // initial great-circle bearing, first two polyline points
  endBearingDeg: number;
  endLat: number;
  endLng: number;
  roadSide: RoadSide;        // side of the nearest named road along this leg; NONE if unknown
  /** Street the leg continues on (parsed from the instruction when present). */
  street?: string;
}

export type RouteCrossing = Crossing & { afterLeg: number; sAlongM: number };

export interface RouteResponse {
  destName: string;
  legs: RouteLeg[];
  crossings: RouteCrossing[];
  warnings: string[];              // walking-beta text verbatim; always ≥ 1 entry
  attribution: string;             // "Google Maps" attribution for the nav screen
  script: RouteCompileOutput;      // precomputed on the proxy
  planner: {
    routeCompile: { fallback: boolean; latencyMs: number };
    crossingAnnounce: { fallback: boolean; latencyMs: number };
  };
  fetchedAt: number;
}

/**
 * Google's mandatory walking-route warning. Displayed on the route screen and
 * pre-synthesized once at route load; the proxy allow-lists this exact byte
 * string (05 "Server-side language rule"). Any other wording is not exempt.
 */
export const WALKING_BETA_WARNING =
  'Walking directions are in beta. Use caution – This route may be missing sidewalks or pedestrian paths.';

export const GOOGLE_ATTRIBUTION = 'Route data: Google Maps';
