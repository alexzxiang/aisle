/**
 * Google Routes API `computeRoutes` → `RouteLeg[]` (03 Task 1). Pure.
 *
 * Facts this parser is built on (03 Task 1):
 * - Steps carry `navigationInstruction {maneuver, instructions}`; `instructions`
 *   is plain text. A step's maneuver is the action at the *start* of that step.
 * - There is no bearing field anywhere: `startBearingDeg` comes from the first
 *   two points of the decoded step polyline, `endBearingDeg` from the last two.
 * - The Maneuver enum has 21 values and no crossing or arrival value, so the
 *   final leg's `ARRIVE` is synthesized here.
 *
 * Leg model: a leg is the geometry you walk, and its `maneuver` is the action at
 * its **end** — that is, the maneuver of the next Google step. A step whose own
 * maneuver is `DEPART` or `NAME_CHANGE` carries no action, so it never ends a
 * leg: its geometry is concatenated into the leg under construction (or starts
 * the first one) and it gets no utterance of its own.
 */
import { initialBearingDeg, polylineLengthM, type LatLng } from './geo';
import { decodePolyline } from './polyline';
import { GOOGLE_ATTRIBUTION, WALKING_BETA_WARNING, type LegManeuver, type RouteLeg } from './types';

// --- Raw response shape (only the fields our field mask asks for) ----------

export interface RawLatLng { latitude: number; longitude: number }
export interface RawLocation { latLng?: RawLatLng }

export interface RawStep {
  distanceMeters?: number;
  staticDuration?: string;
  polyline?: { encodedPolyline?: string };
  startLocation?: RawLocation;
  endLocation?: RawLocation;
  navigationInstruction?: { maneuver?: string; instructions?: string };
}

export interface RawRoute {
  distanceMeters?: number;
  duration?: string;
  polyline?: { encodedPolyline?: string };
  warnings?: string[];
  legs?: Array<{ steps?: RawStep[] }>;
}

export interface RawComputeRoutesResponse {
  routes?: RawRoute[];
}

/** The mandatory field mask; omitting it is an error on `computeRoutes`. */
export const ROUTES_FIELD_MASK = [
  'routes.distanceMeters',
  'routes.duration',
  'routes.polyline.encodedPolyline',
  'routes.warnings',
  'routes.legs.steps.distanceMeters',
  'routes.legs.steps.staticDuration',
  'routes.legs.steps.polyline.encodedPolyline',
  'routes.legs.steps.startLocation',
  'routes.legs.steps.endLocation',
  'routes.legs.steps.navigationInstruction',
].join(',');

export const COMPUTE_ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

/** The 21 documented Maneuver values. */
export const RAW_MANEUVERS = [
  'MANEUVER_UNSPECIFIED', 'DEPART', 'NAME_CHANGE', 'STRAIGHT',
  'TURN_SLIGHT_LEFT', 'TURN_SLIGHT_RIGHT', 'TURN_LEFT', 'TURN_RIGHT',
  'TURN_SHARP_LEFT', 'TURN_SHARP_RIGHT', 'UTURN_LEFT', 'UTURN_RIGHT',
  'RAMP_LEFT', 'RAMP_RIGHT', 'FORK_LEFT', 'FORK_RIGHT', 'MERGE',
  'ROUNDABOUT_LEFT', 'ROUNDABOUT_RIGHT', 'FERRY', 'FERRY_TRAIN',
] as const;

export type RawManeuver = (typeof RAW_MANEUVERS)[number];

/** Maneuvers that carry no action and therefore never end a leg. */
const PASSTHROUGH: ReadonlySet<string> = new Set(['DEPART', 'NAME_CHANGE']);

/** Collapse Google's 21 values onto our seven (03 Task 1). */
export function collapseManeuver(raw: string | undefined): LegManeuver {
  const m = (raw ?? '').toUpperCase();
  if (m === 'TURN_SLIGHT_LEFT') return 'SLIGHT_LEFT';
  if (m === 'TURN_SLIGHT_RIGHT') return 'SLIGHT_RIGHT';
  if (m === 'UTURN_LEFT' || m === 'UTURN_RIGHT') return 'UTURN';
  if (/LEFT$/.test(m) && m !== 'STRAIGHT') return 'TURN_LEFT';
  if (/RIGHT$/.test(m)) return 'TURN_RIGHT';
  // STRAIGHT, MERGE, MANEUVER_UNSPECIFIED, FERRY*, DEPART, NAME_CHANGE, ''
  return 'STRAIGHT';
}

/** The street this leg walks along, from Google's plain-text instruction. */
export function extractStreet(instruction: string | undefined): string {
  const first = (instruction ?? '').split(/\n|\r/)[0]?.trim() ?? '';
  if (first === '') return '';
  const onto = /\b(?:onto|on)\s+(.+)$/i.exec(first);
  if (!onto) return '';
  let street = (onto[1] ?? '').trim();
  street = street.split(/\s+(?:toward|towards|and continue|then)\b/i)[0] ?? '';
  street = street.replace(/[.,;:]+$/, '').replace(/\s*\([^)]*\)\s*$/, '');
  street = street.replace(/\s+Destination.*$/i, '');
  return street.trim();
}

function toLatLng(loc: RawLocation | undefined): LatLng | null {
  const ll = loc?.latLng;
  if (!ll || typeof ll.latitude !== 'number' || typeof ll.longitude !== 'number') return null;
  return { lat: ll.latitude, lng: ll.longitude };
}

function stepPoints(step: RawStep): LatLng[] {
  const encoded = step.polyline?.encodedPolyline;
  const decoded = encoded ? decodePolyline(encoded) : [];
  if (decoded.length >= 2) return decoded;
  const a = toLatLng(step.startLocation);
  const b = toLatLng(step.endLocation);
  if (a && b) return [a, b];
  if (a) return [a];
  return [];
}

/** Bearing over the first `spanM` metres (or the first two points). */
export function startBearingOf(points: readonly LatLng[]): number {
  if (points.length < 2) return 0;
  return initialBearingDeg(points[0]!, points[1]!);
}

export function endBearingOf(points: readonly LatLng[]): number {
  if (points.length < 2) return 0;
  return initialBearingDeg(points[points.length - 2]!, points[points.length - 1]!);
}

interface LegDraft {
  points: LatLng[];
  distanceM: number;
  instruction: string;
  street: string;
}

export interface ParsedRoute {
  legs: RouteLeg[];
  warnings: string[];
  attribution: string;
  distanceM: number;
  durationS: number | null;
  routePolyline: LatLng[];
}

function appendPoints(target: LatLng[], points: readonly LatLng[]): void {
  for (const p of points) {
    const last = target[target.length - 1];
    if (last && Math.abs(last.lat - p.lat) < 1e-9 && Math.abs(last.lng - p.lng) < 1e-9) continue;
    target.push(p);
  }
}

function parseDurationS(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = /^(\d+(?:\.\d+)?)s$/.exec(raw.trim());
  return m ? Number(m[1]) : null;
}

/**
 * Normalize the first route of a `computeRoutes` response.
 * `warnings` always has at least one entry: Google requires the walking-beta
 * sentence to be displayed for every walking route, so it is supplied verbatim
 * when the response omits it (03 Task 1 [verify on the first live call]).
 */
export function parseComputeRoutes(raw: RawComputeRoutesResponse): ParsedRoute {
  const route = raw.routes?.[0];
  const steps: RawStep[] = [];
  for (const leg of route?.legs ?? []) {
    for (const s of leg.steps ?? []) steps.push(s);
  }

  const drafts: LegDraft[] = [];
  let maneuvers: LegManeuver[] = [];
  let cur: LegDraft | null = null;

  for (const step of steps) {
    const rawManeuver = (step.navigationInstruction?.maneuver ?? '').toUpperCase();
    const instruction = (step.navigationInstruction?.instructions ?? '').trim();
    const points = stepPoints(step);
    const distanceM = typeof step.distanceMeters === 'number' ? step.distanceMeters : polylineLengthM(points);

    if (cur === null) {
      cur = { points: [], distanceM: 0, instruction, street: extractStreet(instruction) };
      appendPoints(cur.points, points);
      cur.distanceM += distanceM;
      continue;
    }
    if (PASSTHROUGH.has(rawManeuver)) {
      // No action here: concatenate the geometry, keep the leg's own wording.
      appendPoints(cur.points, points);
      cur.distanceM += distanceM;
      if (cur.street === '') cur.street = extractStreet(instruction);
      continue;
    }
    // This step's maneuver is the action at the end of the leg under construction.
    drafts.push(cur);
    maneuvers.push(collapseManeuver(rawManeuver));
    cur = { points: [], distanceM: 0, instruction, street: extractStreet(instruction) };
    appendPoints(cur.points, points);
    cur.distanceM += distanceM;
  }
  if (cur !== null) {
    drafts.push(cur);
    maneuvers.push('ARRIVE');
  }
  // Defensive: keep the arrays the same length even on a malformed response.
  maneuvers = maneuvers.slice(0, drafts.length);

  const legs: RouteLeg[] = drafts.map((d, index) => {
    const points = d.points.length >= 2 ? d.points : d.points.slice();
    const end = points[points.length - 1] ?? { lat: 0, lng: 0 };
    return {
      index,
      instruction: d.instruction,
      maneuver: maneuvers[index] ?? 'ARRIVE',
      distanceM: d.distanceM > 0 ? d.distanceM : polylineLengthM(points),
      polyline: points,
      startBearingDeg: startBearingOf(points),
      endBearingDeg: endBearingOf(points),
      endLat: end.lat,
      endLng: end.lng,
      roadSide: 'NONE',
      street: d.street,
    };
  });

  const responseWarnings = (route?.warnings ?? []).filter((w) => typeof w === 'string' && w.trim() !== '');
  const warnings = responseWarnings.length > 0 ? responseWarnings : [WALKING_BETA_WARNING];

  const routePolyline = route?.polyline?.encodedPolyline
    ? decodePolyline(route.polyline.encodedPolyline)
    : legs.flatMap((l) => l.polyline);

  return {
    legs,
    warnings,
    attribution: GOOGLE_ATTRIBUTION,
    distanceM: typeof route?.distanceMeters === 'number' ? route.distanceMeters : legs.reduce((a, l) => a + l.distanceM, 0),
    durationS: parseDurationS(route?.duration),
    routePolyline,
  };
}

/** Body for `POST computeRoutes`, WALK (03 Task 1). */
export function computeRoutesBody(origin: LatLng, destination: LatLng): Record<string, unknown> {
  return {
    origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
    destination: { location: { latLng: { latitude: destination.lat, longitude: destination.lng } } },
    travelMode: 'WALK',
  };
}
