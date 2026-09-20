/** Session-only sparse spatial memory. Points are measured surfaces, never free-space claims.
 * Graph edges come exclusively from continuous, normally tracked walks. Semantic observations
 * attach to the capture pose (not the phone's position when a cloud response returns).
 */
import type { Pose } from './contracts';
import { foodSection, sectionFromFoods, type FoodSection } from './foodCatalog';
import type { SearchObservation, SearchView } from './searchObservation';

export type Point3 = { x: number; y: number; z: number };
export interface TripPlace extends Point3 {
  id: string;
  epoch: string;
  kind: 'area' | 'aisle_end' | 'doorway';
  name: string;
  sign: string | null;
  section: FoodSection;
  items: string[];
  at: number;
  relocalizedFrom?: string;
}
export interface TripPortal { from: string; name: string; kind: 'doorway' | 'aisle_end'; bearing: number; at: number; hits: number; reached: boolean }
export interface AisleSpan { entrance: string; exit: string; walkedMetres: number; section: FoodSection; lengthKnown: false }
export interface AisleVisit {
  id: string;
  epoch: string;
  label: string;
  section: FoodSection;
  firstPlace: string;
  lastPlace: string;
  visits: number;
  at: number;
  searches: Array<{ item: string; result: 'checked' | 'inconclusive'; at: number }>;
}
export interface TripEdge { from: string; to: string; metres: number }
interface Evidence extends Point3 {
  pitch?: number;
  place: string; item: string; view: SearchView; yaw: number; at: number;
  confidence: number;
  status: 'seen' | 'not_seen' | 'occluded' | 'unusable' | 'closed';
}
export interface TripRoute { destination: TripPlace; waypoint: TripPlace; metres: number }
const distance = (a: Point3, b: Point3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const norm = (s: string) => s.trim().toLowerCase();
const TTL = 30 * 60_000;

export function createTripMemory(now: () => number = Date.now) {
  const places: TripPlace[] = [];
  const edges: TripEdge[] = [];
  const portals: TripPortal[] = [];
  const aisles: AisleSpan[] = [];
  const aisleVisits: AisleVisit[] = [];
  let currentAisle: AisleVisit | null = null;
  let lastPortal: TripPlace | null = null;
  let walkedSincePortal = 0;
  const evidence: Evidence[] = [];
  const deferred = new Map<string, number>();
  const deferRoots = new Map<string, { id: string; item: string; until: number }>();
  const revisitStats = { created: 0, returned: 0, deferChecks: 0, deferHits: 0 };
  // Rebuild from original anchors, never from the expanded neighborhood: otherwise
  // each new waypoint would extend a three-metre cooldown indefinitely.
  const refreshDeferred = () => {
    deferred.clear();
    for (const [key, root] of deferRoots) {
      if (root.until <= now()) { deferRoots.delete(key); continue; }
      const costs = new Map<string, number>([[root.id, 0]]);
      const queue = [root.id];
      while (queue.length) {
        const from = queue.shift()!;
        for (const edge of edges) {
          const to = edge.from === from ? edge.to : edge.to === from ? edge.from : null;
          if (!to) continue;
          const cost = costs.get(from)! + edge.metres;
          if (cost <= 3 && cost < (costs.get(to) ?? Infinity)) { costs.set(to, cost); queue.push(to); }
        }
      }
      for (const id of costs.keys()) {
        const k = `${id}:${root.item}`;
        deferred.set(k, Math.max(deferred.get(k) ?? 0, root.until));
      }
    }
  };
  const voxels = new Map<string, Point3>();
  let history: Pose[] = [];
  const poseNodes = new Map<number, string>();
  let epoch = '';
  let nativeEpoch = '';
  let serial = 0;
  let last: Pose | null = null;
  let current: TripPlace | null = null;
  let ready = false;
  let stable = 0;
  let generation = 0;
  let signCandidate = '';
  let signHits = 0;
  let lastObservation = -Infinity;
  const nearest = (p: Point3, radius = 0.8) => places.filter(n => n.epoch === epoch && distance(n, p) <= radius)
    .sort((a, b) => distance(a, p) - distance(b, p))[0] ?? null;
  let lastNormal: Pose | null = null;
  const invalidate = () => { ready = false; stable = 0; current = null; currentAisle = null; lastPortal = null; walkedSincePortal = 0; history = []; poseNodes.clear(); generation++; };
  const at = (time: number): Pose | null => {
    if (!ready) return null;
    const p = history.reduce<Pose | null>((best, v) => !best || Math.abs(v.timestamp - time) < Math.abs(best.timestamp - time) ? v : best, null);
    return p && Math.abs(p.timestamp - time) <= 500 ? p : null;
  };
  const coverage = (id: string, item: string, yaw?: number) => {
    const rows = evidence.filter(e => e.place === id && e.item === norm(item) && now() - e.at <= TTL);
    const missing: SearchView[] = [];
    const views: SearchView[] = ['upper', 'middle', 'lower'];
    const positive = rows.some(e => e.status === 'seen');
    const heading = yaw ?? rows.at(-1)?.yaw ?? 0;
    const selected = new Map<SearchView, Evidence>();
    for (const view of views) {
      const aligned = rows.filter(e => e.view === view && Math.abs(((e.yaw - heading + 540) % 360) - 180) <= 25);
      // A later blocked/unusable frame invalidates earlier coverage of that band.
      const latest = aligned.at(-1);
      if (latest) selected.set(view, latest);
      const negatives = aligned.filter(e => e.status === 'not_seen' && e.confidence >= 0.85);
      const repeated = negatives.some(e => latest && latest.at - e.at >= 750);
      if (latest?.status !== 'not_seen' || !repeated) missing.push(view);
    }
    const upper = selected.get('upper');
    const lower = selected.get('lower');
    const differentViewpoint = upper && lower && ((Number.isFinite(upper.pitch) && Number.isFinite(lower.pitch)
      && Math.abs(upper.pitch! - lower.pitch!) >= 8) || distance(upper, lower) >= 0.25);
    // Changing only the model's view label on a stationary frame cannot complete a sweep.
    if (!differentViewpoint && !missing.includes('lower')) missing.push('lower');
    return { checked: !positive && missing.length === 0, missing, positive, samples: rows.length };
  };
  const inspected = (id: string, item: string) => {
    // A waypoint in an aisle has two faces. One swept face cannot eliminate the other.
    const headings = evidence.filter(e => e.place === id && e.item === norm(item) && e.view === 'middle' && e.status === 'not_seen').map(e => e.yaw);
    return headings.some(a => headings.some(b => Math.abs(((a - b + 540) % 360) - 180) >= 120
      && coverage(id, item, a).checked && coverage(id, item, b).checked));
  };
  return {
    ingest(p: Pose) {
      if (![p.x, p.y, p.z, p.yawDeg, p.timestamp].every(Number.isFinite) || p.timestamp > now() + 1000 || now() - p.timestamp > 2000) return;
      const nextEpoch = p.worldSessionId ?? 'legacy';
      const changed = nativeEpoch !== nextEpoch;
      if (changed) { nativeEpoch = nextEpoch; epoch = nextEpoch; invalidate(); last = null; lastNormal = null; voxels.clear(); }
      if (last && p.timestamp <= last.timestamp) return;
      if (p.trackingState !== 'NORMAL') { if (ready || stable) invalidate(); last = p; return; }
      const dt = last ? (p.timestamp - last.timestamp) / 1000 : 0;
      const lostContinuity = last?.trackingState !== 'NORMAL' && lastNormal
        && (p.timestamp - lastNormal.timestamp > 2000 || distance(lastNormal, p) > 1.5
          || Math.abs(((lastNormal.yawDeg - p.yawDeg + 540) % 360) - 180) > 30);
      if (last && (lostContinuity || dt > 2 || distance(last, p) > Math.max(1.5, dt * 3))) {
        // Even a NORMAL pose can jump after relocalization. Disconnect rather than draw a route through it.
        invalidate(); epoch = `${nextEpoch}:break:${++serial}`; voxels.clear();
        // Keep the native ID separate so the next frame stays in this new segment.
      }
      if (ready && last && last.trackingState === 'NORMAL') walkedSincePortal += distance(last, p);
      last = p;
      lastNormal = p;
      stable++;
      ready = stable >= 3;
      history.push(p);
      history = history.filter(v => p.timestamp - v.timestamp <= 15000).slice(-180);
      if (!ready) return;
      const previous = current;
      // Proximity alone cannot merge opposite sides of a thin shelf/wall.
      // Reuse only the current node or a directly connected waypoint on our walked path.
      let node = previous ? places.filter(n => n.epoch === epoch && distance(n, p) <= 0.8
        && (n.id === previous.id || edges.some(e => (e.from === previous.id && e.to === n.id) || (e.to === previous.id && e.from === n.id))))
        .sort((a, b) => distance(a, p) - distance(b, p))[0] ?? null : nearest(p, 0.25);
      if (!node && places.length < 2000) {
        node = { id: `place-${++serial}`, epoch, x: p.x, y: p.y, z: p.z, kind: 'area', name: 'visited area', sign: null, section: 'unknown', items: [], at: p.timestamp };
        places.push(node);
        revisitStats.created++;
      }
      if (!node) return;
      if (previous && previous.id !== node.id && node.at < p.timestamp) revisitStats.returned++;
      if (previous && previous.id !== node.id && previous.epoch === node.epoch && distance(previous, node) <= 2) {
        if (!edges.some(e => (e.from === previous.id && e.to === node!.id) || (e.to === previous.id && e.from === node!.id))) {
          edges.push({ from: previous.id, to: node.id, metres: distance(previous, node) });
          refreshDeferred();
        }
      }
      current = node;
      poseNodes.set(p.timestamp, node.id);
      while (poseNodes.size > 180) poseNodes.delete(poseNodes.keys().next().value!);
      for (const point of p.mappingPoints ?? []) {
        if (![point.x, point.y, point.z].every(Number.isFinite) || distance(p, point) > 8) continue;
        const key = [point.x, point.y, point.z].map(v => Math.floor(v / 0.25)).join(',');
        voxels.set(key, { ...point });
        if (voxels.size > 12000) voxels.delete(voxels.keys().next().value!);
      }
    },
    loseTracking() { if (ready || stable) invalidate(); },
    ready: () => ready && !!last && now() - last.timestamp <= 2000,
    generation: () => generation,
    coordinateEpoch: () => epoch,
    poseAt: at,
    observe(o: SearchObservation, item: string, capturedAt: number) {
      if (capturedAt <= lastObservation) return;
      const p = at(capturedAt);
      if (!p || o.confidence < 0.6) return;
      const node = places.find(n => n.id === poseNodes.get(p.timestamp));
      if (!node) return;
      lastObservation = capturedAt;
      node.at = capturedAt;
      node.items = [...new Set([...node.items, ...o.items.map(norm)])].slice(-30);
      const inferred = sectionFromFoods(o.items);
      if (inferred !== 'unknown') node.section = inferred;
      // Repeated signs are semantic clues at an observation point, not remote sign coordinates.
      const sign = norm(o.sign ?? '');
      const candidate = `${node.id}:${sign}`;
      signHits = candidate === signCandidate ? signHits + 1 : 1;
      signCandidate = candidate;
      if (sign && signHits >= 2 && o.quality === 'usable') {
        node.sign = o.sign; node.name = o.sign!;
        const section = foodSection(sign);
        if (section !== 'unknown') node.section = section;
        const matches = places.filter(n => n.epoch !== epoch && norm(n.sign ?? '') === sign && n.section === node.section);
        // Re-identify semantics after a reset; old route coordinates remain disconnected.
        if (matches.length === 1) node.relocalizedFrom = matches[0]!.id;
      }
      for (const l of o.landmarks) {
        if ((l.kind !== 'doorway' && l.kind !== 'aisle_end') || !['open_passage', 'cross_aisle'].includes(l.boundary ?? '') || l.confidence < 0.8 || o.quality !== 'usable') continue;
        const bearing = (p.yawDeg + (l.box[0] + l.box[2] / 2 - 0.5) * 56 + 360) % 360;
        const previous = portals.find(v => v.from === node.id && v.kind === l.kind && Math.abs(((v.bearing - bearing + 540) % 360) - 180) < 20);
        if (previous) { previous.at = capturedAt; previous.hits++; }
        else portals.push({ from: node.id, name: l.name, kind: l.kind, bearing, at: capturedAt, hits: 1, reached: false });
        if (portals.length > 500) portals.shift();
      }
      const seen = !!o.item?.box && o.item.confidence >= 0.8;
      if (seen) node.items = [...new Set([...node.items, norm(item)])];
      const status: Evidence['status'] = seen ? 'seen' : o.barrier?.startsWith('closed_') ? 'closed'
        : o.quality === 'occluded' ? 'occluded' : o.quality !== 'usable' ? 'unusable'
        : o.barrier !== 'none' || !o.inspection?.assessed || norm(o.inspection.target) !== norm(item)
          || o.inspection.confidence < 0.85 || o.confidence < 0.85 ? 'unusable' : 'not_seen';
      evidence.push({ x: p.x, y: p.y, z: p.z, pitch: p.pitchDeg, place: node.id, item: norm(item), view: o.view, yaw: p.yawDeg, at: capturedAt, confidence: Math.min(o.confidence, o.inspection?.confidence ?? 0), status });
      if (evidence.length > 3000) evidence.shift();
    },
    arrive(name: string, kind: TripPlace['kind']) {
      if (!ready || !current) return;
      current.name = name; current.kind = kind;
      if (kind !== 'area') {
        for (const portal of portals) {
          const source = places.find(n => n.id === portal.from);
          if (!source || source.epoch !== epoch || distance(source, current) > 8) continue;
          const bearing = Math.atan2(current.x - source.x, -(current.z - source.z)) * 180 / Math.PI;
          if (norm(portal.name) === norm(name) && now() - portal.at < 45000
            && Math.abs(((bearing - portal.bearing + 540) % 360) - 180) < 30) portal.reached = true;
        }
        if (kind === 'aisle_end' && lastPortal?.kind === 'aisle_end' && lastPortal.id !== current.id) {
          aisles.push({ entrance: lastPortal.id, exit: current.id, walkedMetres: walkedSincePortal, section: current.section, lengthKnown: false });
          if (aisles.length > 100) aisles.shift();
        }
        lastPortal = current; walkedSincePortal = 0;
      }
    },
    noteAisle(label: string, section: FoodSection) {
      if (!ready || !current) return;
      const key = norm(label) || (section !== 'unknown' ? section : 'unmarked aisle');
      if (currentAisle && currentAisle.epoch === epoch && norm(currentAisle.label) === 'unmarked aisle' && key !== 'unmarked aisle') {
        currentAisle.label = label;
        currentAisle.section = section;
        currentAisle.lastPlace = current.id;
        currentAisle.at = now();
        return;
      }
      if (currentAisle && currentAisle.epoch === epoch && (norm(currentAisle.label) === key
        || (key === 'unmarked aisle' && currentAisle.section === section))) {
        currentAisle.lastPlace = current.id;
        currentAisle.at = now();
        if (currentAisle.section === 'unknown' && section !== 'unknown') currentAisle.section = section;
        return;
      }
      // Unmarked aisles are distinct after a confirmed cross-aisle transition. A readable
      // sign may identify a previously visited aisle elsewhere in the trip.
      const known = key === 'unmarked aisle' ? undefined
        : aisleVisits.find(a => a.epoch === epoch && norm(a.label) === key && a.section === section);
      if (known) {
        known.visits += 1; known.lastPlace = current.id; known.at = now(); currentAisle = known;
      } else {
        currentAisle = { id: `aisle-${++serial}`, epoch, label: label || (section !== 'unknown' ? `${section} aisle` : 'unmarked aisle'), section,
          firstPlace: current.id, lastPlace: current.id, visits: 1, at: now(), searches: [] };
        aisleVisits.push(currentAisle);
        if (aisleVisits.length > 200) aisleVisits.shift();
      }
    },
    noteAisleSearch(item: string, result: 'checked' | 'inconclusive') {
      if (!currentAisle) return;
      const key = norm(item);
      const previous = currentAisle.searches.find(s => s.item === key);
      if (previous) {
        if (result === 'checked') previous.result = result;
        previous.at = now();
      } else currentAisle.searches.push({ item: key, result, at: now() });
    },
    leaveAisle() { currentAisle = null; },
    aisleVisited(label: string, item: string) {
      const key = norm(label);
      const genericSection = foodSection(label);
      const labelIsGeneric = genericSection !== 'unknown' && (key === genericSection || key === `${genericSection} aisle`
        || key === `${genericSection} section` || key === `${genericSection} sign`);
      // A local scan never rules out an entire department. Named aisles receive
      // only a short revisit cooldown; their visit history remains available.
      if (labelIsGeneric || key === 'unmarked aisle') return false;
      return aisleVisits.some(a => a.epoch === epoch && norm(a.label) === key
        && a.searches.some(s => s.item === norm(item) && now() - s.at < 120000));
    },
    visitedAisles(item: string) {
      return aisleVisits.filter(a => a.searches.some(s => s.item === norm(item)))
        .map(a => ({ id: a.id, label: a.label, section: a.section, result: a.searches.find(s => s.item === norm(item))!.result, visits: a.visits }));
    },
    checkedNear(item: string, p: Point3) { const n = ready && current && distance(current, p) <= 1.2 ? current : null; return !!n && coverage(n.id, item, 'yawDeg' in p ? Number(p.yawDeg) : undefined).checked; },
    /** A local retry cooldown, independent of evidence that the item is absent. */
    deferredHere(item: string) {
      revisitStats.deferChecks++;
      const hit = !!current && ready && !!last && now() - last.timestamp <= 2000 && (deferred.get(`${current.id}:${norm(item)}`) ?? 0) > now();
      if (hit) revisitStats.deferHits++;
      return hit;
    },
    coverage(item: string, p?: Point3 & { yawDeg?: number }) {
      const node = p ? (current && distance(current, p) <= 1.2 ? current : null) : current;
      return node ? coverage(node.id, item, p?.yawDeg) : { checked: false, missing: ['upper', 'middle', 'lower'] as SearchView[], positive: false, samples: 0 };
    },
    defer(item: string, id = current?.id, ms = 120000) {
      if (!id || !places.some(p => p.id === id && p.epoch === epoch)) return;
      deferRoots.set(`${id}:${norm(item)}`, { id, item: norm(item), until: now() + ms });
      if (deferRoots.size > 2000) deferRoots.delete(deferRoots.keys().next().value!);
      refreshDeferred();
    },
    revisitDiagnostics(item: string) {
      const until = current ? deferred.get(`${current.id}:${norm(item)}`) ?? 0 : 0;
      const trackingReady = ready && !!last && now() - last.timestamp <= 2000;
      return { ...revisitStats, currentPlace: current?.id ?? null, epoch, trackingReady,
        deferred: trackingReady && until > now(), remainingMs: Math.max(0, until - now()),
        activeAnchors: [...deferRoots.values()].filter(r => r.until > now() && r.item === norm(item)).length };
    },
    route(item: string, section: FoodSection, destinationId?: string): TripRoute | null {
      if (!ready || !current) return null;
      // Dijkstra over walked edges only: never route directly across shelving to a remembered point.
      const costs = new Map<string, number>([[current.id, 0]]);
      const parents = new Map<string, string>();
      const todo = new Set(places.filter(n => n.epoch === epoch).map(n => n.id));
      while (todo.size) {
        const id = [...todo].sort((a, b) => (costs.get(a) ?? Infinity) - (costs.get(b) ?? Infinity))[0]!;
        const cost = costs.get(id);
        if (cost === undefined) break;
        todo.delete(id);
        for (const e of edges) {
          const other = e.from === id ? e.to : e.to === id ? e.from : null;
          if (!other || !todo.has(other)) continue;
          const next = cost + e.metres;
          if (next < (costs.get(other) ?? Infinity)) { costs.set(other, next); parents.set(other, id); }
        }
      }
      const candidates = places.filter(n => n.epoch === epoch && now() - n.at <= TTL && n.id !== current!.id && costs.has(n.id) && !inspected(n.id, item)
        && (!destinationId || n.id === destinationId) && (deferred.get(`${n.id}:${norm(item)}`) ?? 0) <= now()
        && (n.items.includes(norm(item)) || (section !== 'unknown' && n.section === section)
          || portals.some(p => p.from === n.id && !p.reached && p.hits >= 2 && now() - p.at < TTL)));
      const destination = candidates.sort((a, b) => Number(b.items.includes(norm(item))) - Number(a.items.includes(norm(item))) || Number(b.section === section && section !== 'unknown') - Number(a.section === section && section !== 'unknown') || costs.get(a.id)! - costs.get(b.id)!)[0];
      if (!destination) return null;
      let step = destination.id;
      while (parents.get(step) && parents.get(step) !== current.id) step = parents.get(step)!;
      return { destination: { ...destination, items: [...destination.items] }, waypoint: { ...places.find(n => n.id === step)!, items: [] }, metres: costs.get(destination.id)! };
    },
    describe(item: string) {
      return places.filter(n => n.sign || n.section !== 'unknown' || n.kind !== 'area').slice(-12)
        .map(n => `${n.name}: ${n.section}; ${n.items.join(', ')}; ${n.epoch !== epoch ? 'old coordinates, rediscover before routing' : inspected(n.id, item) ? 'local shelf bands checked; hidden items unknown' : 'partial coverage'}`).join('; ');
    },
    snapshot() { return { ready, epoch, places: places.map(n => ({ ...n, items: [...n.items] })), edges: edges.map(e => ({ ...e })), portals: portals.map(p => ({ ...p })), aisles: aisles.map(a => ({ ...a })), aisleVisits: aisleVisits.map(a => ({ ...a, searches: a.searches.map(s => ({ ...s })) })), points: [...voxels.values()].map(p => ({ ...p })), evidence: evidence.map(e => ({ ...e })) }; },
  };
}
export type TripMemory = ReturnType<typeof createTripMemory>;
