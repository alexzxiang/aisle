/**
 * Mock-mode route source (01 §12): a `RouteResponse` derived from the track
 * fixture's own `meta.legs` / `meta.crossing`, so B's LegRunner walks the same
 * line D's sensor replayer plays and the crossing arms where the track says it
 * is. Used only by the composition root when `EXPO_PUBLIC_MOCK=1`; the live
 * build fetches `GET /api/route` through B's client.
 *
 * Wording comes from B's own templates (`templateRouteCompile`), so the replayed
 * walk speaks exactly what the proxy's templated fallback would. D owns a
 * recorded route fixture in the long run (B's request: `fixtures/route/demo.json`
 * served from a mock RouteClient); this is the composition root's fallback until
 * that lands, and it never fakes a Google response.
 */
import type { Crossing } from './contracts';
import { buildRouteLine, projectOntoRoute } from '../crossing/crossingData';
import { templateRouteCompile } from '../outdoor/plannerJobs';
import { RouteClientError, type RouteClient } from '../outdoor/routeClient';
import { WALKING_BETA_WARNING, type LegManeuver, type RoadSide, type RouteCrossing, type RouteLeg, type RouteResponse } from '../outdoor/types';

export const FIXTURE_ATTRIBUTION = 'Route data: fixture track (mock mode)';

/** The subset of D's `fixtures/track.json` meta this needs (structural; no import from mocks/). */
export interface FixtureTrackLeg {
  index: number;
  from: { lat: number; lng: number };
  to: { lat: number; lng: number };
  bearingDeg: number;
  distanceM: number;
  roadSide: RoadSide;
}

export interface FixtureTrackMeta {
  entrance?: { lat: number; lng: number; radiusM: number };
  crossing?: Crossing;
  legs?: FixtureTrackLeg[];
}

export interface FixtureTrack {
  meta?: FixtureTrackMeta;
}

function wrap180(deg: number): number {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

/** The maneuver at the end of a leg, from the bearing change into the next leg. */
export function maneuverBetween(fromBearingDeg: number, toBearingDeg: number): LegManeuver {
  const d = wrap180(toBearingDeg - fromBearingDeg);
  const a = Math.abs(d);
  if (a < 20) return 'STRAIGHT';
  if (a > 150) return 'UTURN';
  if (a < 60) return d < 0 ? 'SLIGHT_LEFT' : 'SLIGHT_RIGHT';
  return d < 0 ? 'TURN_LEFT' : 'TURN_RIGHT';
}

const MANEUVER_TEXT: Readonly<Record<LegManeuver, string>> = {
  STRAIGHT: 'Continue straight',
  SLIGHT_LEFT: 'Bear left',
  SLIGHT_RIGHT: 'Bear right',
  TURN_LEFT: 'Turn left',
  TURN_RIGHT: 'Turn right',
  UTURN: 'Turn around',
  ARRIVE: 'Arrive at the store entrance',
};

export interface RouteFromTrackOptions {
  destName?: string;
  now?: number;
}

/** Null when the track carries no legs. */
export function routeFromTrack(track: FixtureTrack, opts: RouteFromTrackOptions = {}): RouteResponse | null {
  const metaLegs = track.meta?.legs ?? [];
  if (metaLegs.length === 0) return null;
  const sorted = [...metaLegs].sort((a, b) => a.index - b.index);

  const legs: RouteLeg[] = sorted.map((l, i) => {
    const next = sorted[i + 1];
    const maneuver: LegManeuver = next ? maneuverBetween(l.bearingDeg, next.bearingDeg) : 'ARRIVE';
    return {
      index: i,
      instruction: MANEUVER_TEXT[maneuver],
      maneuver,
      distanceM: l.distanceM,
      polyline: [{ lat: l.from.lat, lng: l.from.lng }, { lat: l.to.lat, lng: l.to.lng }],
      startBearingDeg: l.bearingDeg,
      endBearingDeg: l.bearingDeg,
      endLat: l.to.lat,
      endLng: l.to.lng,
      roadSide: l.roadSide,
    };
  });

  const crossings: RouteCrossing[] = [];
  const c = track.meta?.crossing;
  if (c) {
    const line = buildRouteLine(legs);
    const centre = { lat: (c.nearCurb.lat + c.farCurb.lat) / 2, lng: (c.nearCurb.lng + c.farCurb.lng) / 2 };
    const proj = projectOntoRoute(centre, line);
    crossings.push({ ...c, afterLeg: proj?.legIndex ?? 0, sAlongM: proj?.sAlongM ?? 0 });
  }

  const script = templateRouteCompile({
    steps: legs.map((l) => ({ index: l.index, instruction: l.instruction, maneuver: l.maneuver, distanceM: l.distanceM, startBearingDeg: l.startBearingDeg })),
    crossings: crossings.map((x) => ({
      crossingId: x.crossingId, afterStep: x.afterLeg, street: x.street, signalized: x.signalized, pushButtonLikely: x.pushButtonLikely, bearingDeg: x.bearingDeg,
    })),
  });

  return {
    destName: opts.destName ?? 'the store',
    legs,
    crossings,
    warnings: [WALKING_BETA_WARNING],
    attribution: FIXTURE_ATTRIBUTION,
    script,
    planner: {
      routeCompile: { fallback: true, latencyMs: 0 },
      crossingAnnounce: { fallback: true, latencyMs: 0 },
    },
    fetchedAt: opts.now ?? Date.now(),
  };
}

/** A RouteClient that answers with the fixture route; throws B's `shape` error when the track has none. */
export function createFixtureRouteClient(track: FixtureTrack, opts: { destName?: string; now?: () => number } = {}): RouteClient {
  return {
    async fetchRoute() {
      const route = routeFromTrack(track, { destName: opts.destName, now: opts.now?.() });
      if (!route) throw new RouteClientError('route: fixture track has no legs', 'shape');
      return route;
    },
  };
}
