/**
 * Crossing data join: route polyline + OSM (Overpass) + WPRDC (03 Task 2). Pure.
 *
 * Google exposes no crossing, so a crossing is found by projecting OSM crossing
 * nodes onto the route geometry, clustering the ones that belong to the same
 * street, and resolving `signalized` / `pushButtonLikely` / `bearingDeg` /
 * `nearCurb` / `farCurb` from tags, geometry and the WPRDC signal list.
 *
 * In the Oakland/Shadyside bbox 58 % of crossing nodes carry no `crossing=*`
 * tag at all, so an untagged cluster is "crossing, signal unknown"
 * (`signalized: null`) — never a guess, and never a walk cue.
 */
import type { Crossing, Side } from '../core/contracts';
import {
  bearingAtAlong,
  haversineM,
  initialBearingDeg,
  pointAtAlong,
  polylineLengthM,
  projectOntoSegment,
  type LatLng,
} from '../outdoor/geo';
import { angularError } from '../outdoor/legs';
import type { RoadSide, RouteCrossing, RouteLeg } from '../outdoor/types';

// --- Overpass / WPRDC shapes ---------------------------------------------

export interface OverpassNode {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}

export interface OverpassWay {
  type: 'way';
  id: number;
  nodes?: number[];
  geometry?: Array<{ lat: number; lon: number }>;
  tags?: Record<string, string>;
}

export type OverpassElement = OverpassNode | OverpassWay | { type: string; id: number; tags?: Record<string, string> };

export interface OverpassResponse {
  elements?: OverpassElement[];
}

/** One row of the WPRDC "City of Pittsburgh Signalized Intersections" dataset. */
export interface WprdcSignal {
  id: string;
  description: string;
  operationType: string | null;
  lat: number;
  lng: number;
}

// --- Tunables (03 Task 2) -----------------------------------------------

export const NODE_TO_ROUTE_MAX_M = 10;
export const CLUSTER_ALONG_M = 15;
export const WPRDC_MATCH_M = 30;
export const STREET_SEARCH_M = 25;
export const CURB_FALLBACK_OFFSET_M = 6;
export const ROAD_SIDE_SEARCH_M = 25;

// --- Route line ----------------------------------------------------------

export interface RouteLine {
  points: LatLng[];
  /** Leg index owning the segment that starts at `points[i]`. */
  legOfSegment: number[];
  lengthM: number;
}

/** Concatenate the leg polylines into one line, remembering which leg owns what. */
export function buildRouteLine(legs: readonly RouteLeg[]): RouteLine {
  const points: LatLng[] = [];
  const legOfSegment: number[] = [];
  for (const leg of legs) {
    for (const p of leg.polyline) {
      const last = points[points.length - 1];
      if (last && Math.abs(last.lat - p.lat) < 1e-9 && Math.abs(last.lng - p.lng) < 1e-9) continue;
      if (points.length > 0) legOfSegment.push(leg.index);
      points.push(p);
    }
  }
  return { points, legOfSegment, lengthM: polylineLengthM(points) };
}

export interface RouteProjection {
  sAlongM: number;
  distM: number;
  crossTrackM: number;
  legIndex: number;
}

/** Nearest point on the whole route, with the owning leg. */
export function projectOntoRoute(p: LatLng, line: RouteLine): RouteProjection | null {
  if (line.points.length < 2) return null;
  let best: RouteProjection | null = null;
  let cumulative = 0;
  for (let i = 1; i < line.points.length; i += 1) {
    const a = line.points[i - 1]!;
    const b = line.points[i]!;
    const proj = projectOntoSegment(p, a, b);
    if (best === null || proj.distM < best.distM) {
      best = {
        sAlongM: cumulative + proj.alongM,
        distM: proj.distM,
        crossTrackM: proj.crossTrackM,
        legIndex: line.legOfSegment[i - 1] ?? 0,
      };
    }
    cumulative += haversineM(a, b);
  }
  return best;
}

// --- Element helpers -----------------------------------------------------

export function isNode(e: OverpassElement): e is OverpassNode {
  return e.type === 'node' && typeof (e as OverpassNode).lat === 'number';
}

export function isWay(e: OverpassElement): e is OverpassWay {
  return e.type === 'way';
}

export function crossingNodes(elements: readonly OverpassElement[]): OverpassNode[] {
  return elements.filter(isNode).filter((n) => (n.tags?.highway ?? '') === 'crossing');
}

export function crossingWays(elements: readonly OverpassElement[]): OverpassWay[] {
  return elements.filter(isWay).filter((w) => (w.tags?.footway ?? '') === 'crossing');
}

export function roadWays(elements: readonly OverpassElement[]): OverpassWay[] {
  const kinds = /^(trunk|primary|secondary|tertiary|residential|unclassified|service)$/;
  return elements.filter(isWay).filter((w) => kinds.test(w.tags?.highway ?? ''));
}

function wayPoints(w: OverpassWay): LatLng[] {
  return (w.geometry ?? []).map((g) => ({ lat: g.lat, lng: g.lon }));
}

interface NearestOnWay {
  way: OverpassWay;
  distM: number;
  point: LatLng;
  bearingDeg: number;
  crossTrackM: number;
}

function nearestPointOnWay(p: LatLng, w: OverpassWay): NearestOnWay | null {
  const pts = wayPoints(w);
  if (pts.length < 2) return null;
  let best: NearestOnWay | null = null;
  for (let i = 1; i < pts.length; i += 1) {
    const p0 = pts[i - 1]!;
    const p1 = pts[i]!;
    const proj = projectOntoSegment(p, p0, p1);
    if (best === null || proj.distM < best.distM) {
      best = {
        way: w,
        distM: proj.distM,
        point: {
          lat: p0.lat + (p1.lat - p0.lat) * proj.t,
          lng: p0.lng + (p1.lng - p0.lng) * proj.t,
        },
        bearingDeg: initialBearingDeg(p0, p1),
        crossTrackM: proj.crossTrackM,
      };
    }
  }
  return best;
}

// --- WPRDC ---------------------------------------------------------------

/** Parse the CKAN datastore records (or the bundled JSON) into typed rows. */
export function parseWprdcRecords(records: ReadonlyArray<Record<string, unknown>>): WprdcSignal[] {
  const out: WprdcSignal[] = [];
  for (const r of records) {
    const lat = Number(r.latitude ?? r.lat ?? NaN);
    const lng = Number(r.longitude ?? r.lng ?? NaN);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const opRaw = r.operation_type ?? r.operationType ?? null;
    out.push({
      id: String(r.id ?? r._id ?? `${lat},${lng}`),
      description: String(r.description ?? r.name ?? ''),
      operationType: typeof opRaw === 'string' && opRaw.trim() !== '' ? opRaw.trim() : null,
      lat,
      lng,
    });
  }
  return out;
}

/** "Actuated" or "PED" in the operation type means a push button is likely. */
export function operationTypeSuggestsButton(operationType: string | null | undefined): boolean {
  const t = (operationType ?? '').toUpperCase();
  return t.includes('ACTUATED') || t.includes('PED');
}

export function nearestWprdc(p: LatLng, signals: readonly WprdcSignal[], maxM = WPRDC_MATCH_M): WprdcSignal | null {
  let best: WprdcSignal | null = null;
  let bestD = Infinity;
  for (const s of signals) {
    const d = haversineM(p, { lat: s.lat, lng: s.lng });
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best !== null && bestD <= maxM ? best : null;
}

// --- Tag reading ---------------------------------------------------------

const UNSIGNALIZED_CROSSING_TAGS: ReadonlySet<string> = new Set(['marked', 'uncontrolled', 'unmarked', 'zebra']);

export function tagSaysSignalized(tags: Record<string, string> | undefined): boolean {
  if (!tags) return false;
  return tags.crossing === 'traffic_signals' || tags['crossing:signals'] === 'yes';
}

export function tagSaysUnsignalized(tags: Record<string, string> | undefined): boolean {
  if (!tags) return false;
  const signals = tags['crossing:signals'];
  if (signals === 'yes') return false;
  const crossing = tags.crossing ?? '';
  return UNSIGNALIZED_CROSSING_TAGS.has(crossing) && (signals === undefined || signals === 'no');
}

// --- Clustering ----------------------------------------------------------

export interface ClusteredNode {
  node: OverpassNode;
  sAlongM: number;
  distM: number;
  legIndex: number;
}

export interface NodeCluster {
  nodes: ClusteredNode[];
  sAlongM: number;      // cluster centre along the route
  legIndex: number;     // leg the cluster sits on
}

/** Project nodes onto the route, drop the far ones, cluster along-track. */
export function clusterCrossingNodes(
  nodes: readonly OverpassNode[],
  line: RouteLine,
  maxDistM = NODE_TO_ROUTE_MAX_M,
  clusterM = CLUSTER_ALONG_M,
): NodeCluster[] {
  const kept: ClusteredNode[] = [];
  for (const node of nodes) {
    const proj = projectOntoRoute({ lat: node.lat, lng: node.lon }, line);
    if (!proj || proj.distM > maxDistM) continue;
    kept.push({ node, sAlongM: proj.sAlongM, distM: proj.distM, legIndex: proj.legIndex });
  }
  kept.sort((a, b) => a.sAlongM - b.sAlongM);

  const clusters: NodeCluster[] = [];
  for (const k of kept) {
    const last = clusters[clusters.length - 1];
    const lastNode = last?.nodes[last.nodes.length - 1];
    if (last && lastNode && k.sAlongM - lastNode.sAlongM <= clusterM) {
      last.nodes.push(k);
    } else {
      clusters.push({ nodes: [k], sAlongM: k.sAlongM, legIndex: k.legIndex });
    }
  }
  for (const c of clusters) {
    const sum = c.nodes.reduce((a, n) => a + n.sAlongM, 0);
    c.sAlongM = sum / c.nodes.length;
    c.legIndex = c.nodes[0]?.legIndex ?? 0;
  }
  return clusters;
}

// --- The join ------------------------------------------------------------

export interface JoinOptions {
  legs: readonly RouteLeg[];
  elements: readonly OverpassElement[];
  wprdc?: readonly WprdcSignal[];
}

export interface JoinResult {
  crossings: RouteCrossing[];
  /** Clusters whose tags conflict or whose street is unknown (03 Task 2 rule 8). */
  ambiguous: AmbiguousCluster[];
}

export interface AmbiguousCluster {
  crossingId: string;
  street: string;
  candidates: Array<{
    nodeId: string;
    distToPolylineM: number;
    tags: Record<string, string>;
    wprdcOperationType?: string;
  }>;
}

interface ResolvedCluster {
  crossing: RouteCrossing;
  conflicting: boolean;
  ambiguous: AmbiguousCluster;
}

function clusterCentre(cluster: NodeCluster, line: RouteLine): LatLng {
  return pointAtAlong(line.points, cluster.sAlongM);
}

/** Degrees off parallel (0 = parallel either way, 90 = perpendicular). */
function offParallelDeg(a: number, b: number): number {
  const diff = Math.abs(angularError(a, b));
  return Math.min(diff, 180 - diff);
}

/** A footway is "along the path" when it is within this many degrees of the travel direction. */
export const FOOTWAY_PARALLEL_MAX_DEG = 45;

/**
 * The footway=crossing way the pedestrian actually walks along.
 *
 * At an intersection the cluster holds crossing nodes for every crosswalk, and
 * the ones on the route's own centreline are often the crosswalks *over the
 * street being walked along* — not the pedestrian's crossing. The crosswalk
 * they use runs parallel to their direction of travel on the far side of the
 * cluster (at a right turn, the leg they turn onto), so pick the touching or
 * nearby footway most parallel to that bearing, tie-broken by distance.
 * Returns `{ way: null, perpendicularOnly: true }` when footways exist but all
 * of them run across the path: that cluster is somebody else's crossing.
 */
function footwayFor(
  cluster: NodeCluster,
  ways: readonly OverpassWay[],
  centre: LatLng,
  travelBearingDeg: number,
): { way: OverpassWay | null; perpendicularOnly: boolean } {
  const ids = new Set(cluster.nodes.map((n) => n.node.id));
  const candidates: Array<{ way: OverpassWay; offDeg: number; distM: number }> = [];
  for (const w of ways) {
    const pts = wayPoints(w);
    if (pts.length < 2) continue;
    const touching = (w.nodes ?? []).some((id) => ids.has(id));
    const near = nearestPointOnWay(centre, w);
    const distM = near ? near.distM : Infinity;
    if (!touching && distM > NODE_TO_ROUTE_MAX_M * 2) continue;
    const dir = initialBearingDeg(pts[0]!, pts[pts.length - 1]!);
    candidates.push({ way: w, offDeg: offParallelDeg(dir, travelBearingDeg), distM: touching ? 0 : distM });
  }
  if (candidates.length === 0) return { way: null, perpendicularOnly: false };
  const parallel = candidates.filter((c) => c.offDeg <= FOOTWAY_PARALLEL_MAX_DEG);
  if (parallel.length === 0) return { way: null, perpendicularOnly: true };
  parallel.sort((a, b) => (a.distM - b.distM) || (a.offDeg - b.offDeg));
  return { way: parallel[0]!.way, perpendicularOnly: false };
}

/** Route bearing just past the cluster: the direction the pedestrian crosses in. */
export const TRAVEL_BEARING_LOOKAHEAD_M = 8;

/**
 * The road being crossed: a named road way near the cluster whose local bearing
 * is closest to perpendicular to the crossing bearing. Distance alone picks the
 * sidewalk's own street, which is not the one you are crossing.
 */
export function crossedRoadFor(
  centre: LatLng,
  crossingBearingDeg: number,
  roads: readonly OverpassWay[],
  searchM = STREET_SEARCH_M,
): { name: string; way: OverpassWay } | null {
  let best: { name: string; way: OverpassWay } | null = null;
  let bestScore = Infinity;
  for (const w of roads) {
    const name = (w.tags?.name ?? '').trim();
    if (name === '') continue;
    const near = nearestPointOnWay(centre, w);
    if (!near || near.distM > searchM) continue;
    const diff = Math.abs(angularError(crossingBearingDeg, near.bearingDeg));
    const perpendicularity = Math.abs(90 - Math.min(diff, 180 - diff));
    const score = near.distM + perpendicularity * 0.25;
    if (score < bestScore) {
      bestScore = score;
      best = { name, way: w };
    }
  }
  return best;
}

/** Which side of this leg's direction of travel the nearest named road lies on. */
export function roadSideForLeg(leg: RouteLeg, roads: readonly OverpassWay[], searchM = ROAD_SIDE_SEARCH_M): RoadSide {
  if (leg.polyline.length < 2) return 'NONE';
  const midpoint = pointAtAlong(leg.polyline, polylineLengthM(leg.polyline) / 2);
  const bearing = bearingAtAlong(leg.polyline, polylineLengthM(leg.polyline) / 2);
  let best: NearestOnWay | null = null;
  for (const w of roads) {
    if ((w.tags?.name ?? '').trim() === '') continue;
    const near = nearestPointOnWay(midpoint, w);
    if (near && (best === null || near.distM < best.distM)) best = near;
  }
  if (!best || best.distM > searchM) return 'NONE';
  // Signed cross-track of the road's nearest point relative to the direction of travel.
  const ahead = pointAtAlong([midpoint, destination(midpoint, bearing, 25)], 25);
  const proj = projectOntoSegment(best.point, midpoint, ahead);
  if (Math.abs(proj.crossTrackM) < 0.5) return 'NONE';
  return proj.crossTrackM > 0 ? 'RIGHT' : 'LEFT';
}

function destination(from: LatLng, bearingDeg: number, distM: number): LatLng {
  const DEG = Math.PI / 180;
  const R = 6371008.8;
  const dLat = (distM * Math.cos(bearingDeg * DEG)) / R / DEG;
  const dLng = (distM * Math.sin(bearingDeg * DEG)) / (R * Math.cos(from.lat * DEG)) / DEG;
  return { lat: from.lat + dLat, lng: from.lng + dLng };
}

function resolveCluster(
  cluster: NodeCluster,
  line: RouteLine,
  legs: readonly RouteLeg[],
  footways: readonly OverpassWay[],
  roads: readonly OverpassWay[],
  wprdc: readonly WprdcSignal[],
): ResolvedCluster | null {
  const centre = clusterCentre(cluster, line);
  const routeBearing = bearingAtAlong(line.points, Math.min(line.lengthM, cluster.sAlongM + TRAVEL_BEARING_LOOKAHEAD_M));
  const picked = footwayFor(cluster, footways, centre, routeBearing);
  if (picked.perpendicularOnly) return null;
  const footway = picked.way;

  // 5. bearing: the footway=crossing direction, oriented to agree with the route.
  let bearingDeg = routeBearing;
  let nearCurb: LatLng | null = null;
  let farCurb: LatLng | null = null;
  if (footway) {
    const pts = wayPoints(footway);
    if (pts.length >= 2) {
      const a = pts[0]!;
      const b = pts[pts.length - 1]!;
      const forward = initialBearingDeg(a, b);
      const agrees = Math.abs(angularError(routeBearing, forward)) <= 90;
      nearCurb = agrees ? a : b;
      farCurb = agrees ? b : a;
      bearingDeg = initialBearingDeg(nearCurb, farCurb);
    }
  }
  // 6. curbs: the footway endpoints, else 6 m before and after the cluster centre.
  if (!nearCurb || !farCurb) {
    nearCurb = pointAtAlong(line.points, Math.max(0, cluster.sAlongM - CURB_FALLBACK_OFFSET_M));
    farCurb = pointAtAlong(line.points, Math.min(line.lengthM, cluster.sAlongM + CURB_FALLBACK_OFFSET_M));
  }

  // 3. signalized
  const tagsList = cluster.nodes.map((n) => n.node.tags ?? {});
  const anySignalTag = tagsList.some(tagSaysSignalized);
  const allUnsignalizedTag = tagsList.length > 0 && tagsList.every(tagSaysUnsignalized);
  const wprdcMatch = nearestWprdc(centre, wprdc);
  let signalized: boolean | null;
  if (anySignalTag || wprdcMatch !== null) signalized = true;
  else if (allUnsignalizedTag) signalized = false;
  else signalized = null;
  const conflicting = (anySignalTag && allUnsignalizedTag)
    || (wprdcMatch !== null && allUnsignalizedTag && !anySignalTag);

  // 4. pushButtonLikely
  const buttonTag = tagsList.some((t) => t.button_operated === 'yes');
  const pushButtonLikely = buttonTag || (wprdcMatch !== null && operationTypeSuggestsButton(wprdcMatch.operationType));

  // 7. street and roadSide
  const road = crossedRoadFor(centre, bearingDeg, roads);
  const street = road?.name ?? '';
  const approachLeg = legs[cluster.legIndex];
  const legRoadSide: RoadSide = approachLeg?.roadSide ?? 'NONE';
  const roadSide: Side = legRoadSide === 'LEFT' ? 'LEFT' : 'RIGHT';

  const lowestId = cluster.nodes.reduce((min, n) => (n.node.id < min ? n.node.id : min), cluster.nodes[0]?.node.id ?? 0);
  const crossingId = String(lowestId);

  const crossing: RouteCrossing = {
    crossingId,
    street,
    signalized,
    pushButtonLikely,
    bearingDeg,
    nearCurb: { lat: nearCurb.lat, lng: nearCurb.lng },
    farCurb: { lat: farCurb.lat, lng: farCurb.lng },
    roadSide,
    afterLeg: cluster.legIndex,
    sAlongM: cluster.sAlongM,
  };

  const ambiguous: AmbiguousCluster = {
    crossingId,
    street,
    candidates: cluster.nodes.map((n) => {
      const candidate: AmbiguousCluster['candidates'][number] = {
        nodeId: String(n.node.id),
        distToPolylineM: Math.round(n.distM * 10) / 10,
        tags: n.node.tags ?? {},
      };
      if (wprdcMatch?.operationType) candidate.wprdcOperationType = wprdcMatch.operationType;
      return candidate;
    }),
  };

  return { crossing, conflicting, ambiguous };
}

/**
 * Join the route to the crossing sources. Crossings come back sorted by
 * `sAlongM`; `ROUTE_READY.crossingCount` is their number.
 */
export function joinCrossings(opts: JoinOptions): JoinResult {
  const { legs, elements } = opts;
  const wprdc = opts.wprdc ?? [];
  const line = buildRouteLine(legs);
  if (line.points.length < 2) return { crossings: [], ambiguous: [] };

  const footways = crossingWays(elements);
  const roads = roadWays(elements);
  const clusters = clusterCrossingNodes(crossingNodes(elements), line);

  const crossings: RouteCrossing[] = [];
  const ambiguous: AmbiguousCluster[] = [];
  for (const cluster of clusters) {
    const resolved = resolveCluster(cluster, line, legs, footways, roads, wprdc);
    if (resolved === null) continue;
    crossings.push(resolved.crossing);
    if (resolved.conflicting || resolved.crossing.street === '') ambiguous.push(resolved.ambiguous);
  }
  crossings.sort((a, b) => a.sAlongM - b.sAlongM);
  return { crossings, ambiguous };
}

/** Apply `roadSide` to every leg from the Overpass road ways (03 Task 1). */
export function withRoadSides(legs: readonly RouteLeg[], elements: readonly OverpassElement[]): RouteLeg[] {
  const roads = roadWays(elements);
  return legs.map((leg) => ({ ...leg, roadSide: roadSideForLeg(leg, roads) }));
}

/** Overpass QL for one route bbox (padded by the caller). */
export function overpassQuery(bbox: { s: number; w: number; n: number; e: number }): string {
  const b = `${bbox.s.toFixed(6)},${bbox.w.toFixed(6)},${bbox.n.toFixed(6)},${bbox.e.toFixed(6)}`;
  return [
    '[out:json][timeout:25];',
    '(',
    `  node["highway"="crossing"](${b});`,
    `  way["footway"="crossing"](${b});`,
    `  way["highway"~"^(trunk|primary|secondary|tertiary|residential|unclassified|service)$"](${b});`,
    ');',
    'out body geom;',
  ].join('\n');
}

/** Crossing → the fields the controller needs, without the route bookkeeping. */
export function toCrossing(rc: RouteCrossing): Crossing {
  const { afterLeg: _afterLeg, sAlongM: _sAlongM, ...rest } = rc;
  return rest;
}

/** Straight-line length of a crossing in metres. */
export function crossingLengthM(c: Pick<Crossing, 'nearCurb' | 'farCurb'>): number {
  return haversineM(c.nearCurb, c.farCurb);
}
