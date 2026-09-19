#!/usr/bin/env node
/**
 * Synthetic fixture generator (Agent D).
 *
 * Writes:
 *   fixtures/track.json                 home → signalized crossing → store door → indoors
 *   fixtures/perception/<pack>.jsonl    hand-authored native-event packs (01 §12 line format)
 *   fixtures/perception/index.json      { pack: rawJsonlText } so Metro/Jest can import the packs (parsed at runtime)
 *
 * These are SYNTHETIC. They exist so B and C can build against mock mode before the demo
 * phone exists. Phase 2 replaces every pack with the module's own debug export and the
 * track with a live-run recording; the replayer never changes (06 "chicken-and-egg").
 *
 * Run from the app root:  node fixtures/tools/generate.mjs
 *                         node fixtures/tools/generate.mjs --index-only   (re-index recorded packs only)
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, '..');
const perceptionDir = join(fixturesDir, 'perception');
mkdirSync(perceptionDir, { recursive: true });

// `--index-only`: rebuild perception/index.json from whatever .jsonl files are on disk
// (recordings from the demo phone dropped over the synthetic packs) without touching
// the packs or the track. Everything below is skipped.
if (process.argv.includes('--index-only')) {
  const onDisk = {};
  for (const f of readdirSync(perceptionDir).filter((n) => n.endsWith('.jsonl')).sort()) {
    onDisk[basename(f, '.jsonl')] = readFileSync(join(perceptionDir, f), 'utf8').replace(/\n+$/, '');
  }
  writeFileSync(join(perceptionDir, 'index.json'), JSON.stringify(onDisk) + '\n');
  console.log(`index.json rebuilt from ${Object.keys(onDisk).length} packs: ${Object.keys(onDisk).join(', ')}`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Deterministic pseudo-random (so regenerating gives byte-identical output)
// ---------------------------------------------------------------------------
let seed = 20260919;
function rnd() {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}
const jitter = (amp) => (rnd() * 2 - 1) * amp;
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
const r6 = (v) => Math.round(v * 1e6) / 1e6;

// ---------------------------------------------------------------------------
// Geometry — local metres (x east, y north) around the pinned entrance
// ---------------------------------------------------------------------------
const ENTRANCE = { lat: 40.4443, lng: -79.9436 };
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LNG = 111320 * Math.cos((ENTRANCE.lat * Math.PI) / 180);

function toLatLng(x, y) {
  return { lat: r6(ENTRANCE.lat + y / M_PER_DEG_LAT), lng: r6(ENTRANCE.lng + x / M_PER_DEG_LNG) };
}
function bearingOf(a, b) {
  const deg = (Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI;
  return (deg + 360) % 360;
}
function dist(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

const P0 = { x: -120, y: 120 }; // home
const P1 = { x: -40, y: 78 };   // right turn
const P2 = { x: -40, y: 30 };   // near curb
const P3 = { x: -40, y: 8 };    // far curb (22 m crossing)
const P4 = { x: -8, y: 8 };     // along the storefront
const E = { x: 0, y: 0 };       // pinned door

const SPEED = 1.3;              // m/s walking
const CURB_DWELL_S = 14;        // UNKNOWN 6 s → DONT_WALK → WALK at 12 s in the curb pack, +2 s to step off
const INDOOR_S = 30;

// Segment list: [from, to, kind]
const segments = [
  [P0, P1, 'leg1'],
  [P1, P2, 'leg2'],
  [P2, P2, 'curb'],
  [P2, P3, 'crossing'],
  [P3, P4, 'leg3'],
  [P4, E, 'leg4'],
];

const samples = [];
const marks = {};
let t = 0;
let steps = 0;
let stepAcc = 0;
let prevBearing = bearingOf(P0, P1);

function push(pos, { speed, bearing, compassAcc = 3, gpsAcc, courseNull = false, heading, walking }) {
  const ll = toLatLng(pos.x, pos.y);
  const isWalking = walking ?? (speed !== null && speed > 0.3);
  const stepRate = isWalking ? 1.85 : 0;
  stepAcc += stepRate;
  const whole = Math.floor(stepAcc);
  steps += whole;
  stepAcc -= whole;
  samples.push({
    t,
    lat: ll.lat,
    lng: ll.lng,
    accuracyM: r2(gpsAcc),
    courseDeg: courseNull || speed < 0.5 ? null : r2((bearing + jitter(3) + 360) % 360),
    speedMps: speed === null ? null : r2(speed),
    heading: { trueHeadingDeg: r2((heading + 360) % 360), accuracy: compassAcc },
    steps,
  });
  t += 1;
}

for (const [from, to, kind] of segments) {
  if (kind === 'curb') {
    marks.curbArriveT = t;
    // arrive pointed 15° left of the crossing bearing (180), align during the first 5 s,
    // then hold aligned and still for the remaining dwell (≥ 4 s aligned pause).
    const align = [165, 168, 172, 176, 179];
    for (let i = 0; i < CURB_DWELL_S; i += 1) {
      const heading = i < align.length ? align[i] : 180 + jitter(1);
      push(from, { speed: 0.1, bearing: 180, gpsAcc: 6 + rnd() * 2, courseNull: true, heading });
    }
    continue;
  }
  const bearing = bearingOf(from, to);
  const len = dist(from, to);
  const n = Math.max(1, Math.round(len / SPEED));
  if (kind === 'crossing') marks.crossingStartT = t;
  if (kind === 'leg3') marks.farCurbT = t;
  for (let i = 0; i < n; i += 1) {
    const f = i / n;
    let pos = { x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f };
    let heading = bearing + jitter(3);
    let compassAcc = 3;
    let gpsAcc = 5 + rnd() * 4;

    // A short turn: heading swings over the first two samples of a new segment.
    if (i === 0 && Math.abs(((bearing - prevBearing + 540) % 360) - 180) > 20) heading = prevBearing + (bearing - prevBearing) * 0.5;

    // Compass accuracy tier 2 for 20 s in the middle of leg 2 (dead zone 18°).
    if (kind === 'leg2' && i >= 5 && i < 25) compassAcc = 2;

    // Mid-crossing drift: 1.2 m to the right and back (exercises COURSE on the crossing line).
    if (kind === 'crossing') {
      const drift = Math.sin(f * Math.PI) * -1.2; // facing south, right is west (−x)
      pos = { x: pos.x + drift, y: pos.y };
      heading = bearing + Math.sin(f * Math.PI) * -10 + jitter(2);
    }

    // Steel storefront: compass tier 1 for the last 8 m before the door.
    if (kind === 'leg4' && dist(pos, E) < 8) compassAcc = 1;

    // One urban-canyon jump on leg 1: accuracy 38 m, 40 m off the line, one fix only.
    const isCanyon = kind === 'leg1' && i === 30;
    if (isCanyon) {
      const rad = (bearing * Math.PI) / 180;
      const rightNormal = { x: Math.cos(rad), y: -Math.sin(rad) };
      pos = { x: pos.x + rightNormal.x * 40, y: pos.y + rightNormal.y * 40 };
      gpsAcc = 38;
      marks.canyonJumpT = t;
    }
    if (kind === 'leg2' && dist(pos, P2) <= 25 && marks.approachT === undefined) marks.approachT = t;

    push(pos, { speed: SPEED, bearing, compassAcc, gpsAcc, heading });
  }
  prevBearing = bearing;
}

// The door sample: standing on the pin.
marks.doorT = t;
push(E, { speed: 0.9, bearing: 135, compassAcc: 1, gpsAcc: 7, heading: 135 });

// Indoors: iOS holds 5–10 m and a frozen position for several seconds, then snaps to ~65 m.
// Steps keep accumulating; the compass is useless next to the steel frame.
for (let i = 1; i <= INDOOR_S; i += 1) {
  if (i < 8) {
    const pos = { x: jitter(1.2), y: jitter(1.2) };
    push(pos, { speed: 0.8, bearing: 90, compassAcc: 1, gpsAcc: 6.5 + i * 0.4, courseNull: true, heading: 135 - i * 5 });
  } else if (i === 8) {
    marks.accuracySnapT = t;
    push({ x: 36, y: 42 }, { speed: null, bearing: 90, compassAcc: 1, gpsAcc: 65, courseNull: true, heading: 95, walking: true });
  } else {
    push({ x: 36 + jitter(6), y: 42 + jitter(6) }, { speed: null, bearing: 90, compassAcc: 1, gpsAcc: 60 + rnd() * 12, courseNull: true, heading: 90 + jitter(8), walking: true });
  }
}

const crossing = {
  crossingId: 'crossing-forbes-01',
  street: 'Forbes',
  signalized: true,
  pushButtonLikely: false,
  bearingDeg: 180,
  nearCurb: toLatLng(P2.x, P2.y),
  farCurb: toLatLng(P3.x, P3.y),
  roadSide: 'LEFT',
};

// Legs are Google-shaped: a step runs through the crossing (leg 1 ends at the far curb, P3),
// and the crossing sits on the route line at its sAlongM. A leg that stopped at the near curb
// left a 22 m gap that B's leg progress read as "advanced, then 35 m off the next leg" and
// re-planned at the curb.
const legs = [
  { index: 0, from: toLatLng(P0.x, P0.y), to: toLatLng(P1.x, P1.y), bearingDeg: r2(bearingOf(P0, P1)), distanceM: r2(dist(P0, P1)), roadSide: 'RIGHT' },
  { index: 1, from: toLatLng(P1.x, P1.y), to: toLatLng(P3.x, P3.y), bearingDeg: 180, distanceM: r2(dist(P1, P3)), roadSide: 'LEFT' },
  { index: 2, from: toLatLng(P3.x, P3.y), to: toLatLng(P4.x, P4.y), bearingDeg: 90, distanceM: r2(dist(P3, P4)), roadSide: 'RIGHT' },
  { index: 3, from: toLatLng(P4.x, P4.y), to: toLatLng(E.x, E.y), bearingDeg: 135, distanceM: r2(dist(P4, E)), roadSide: 'RIGHT' },
];

// Phase table: where jump-to-mode seeks the track and which perception pack it arms.
const phases = {
  OUTDOOR_NAV: { t: 0, pack: 'outdoor-leg', packOffsetMs: 0 },
  APPROACH_CROSSING: { t: marks.approachT, pack: 'vehicle-approach', packOffsetMs: 0 },
  AT_CURB: { t: marks.curbArriveT, pack: 'curb-walk-onset', packOffsetMs: 0 },
  CROSSING: { t: marks.crossingStartT, pack: 'curb-walk-onset', packOffsetMs: 14000 },
  TRANSITION: { t: marks.doorT, pack: 'outdoor-leg', packOffsetMs: 0 },
  INDOOR_NAV: { t: marks.doorT + 10, pack: 'indoor-aisle-walk', packOffsetMs: 0 },
  AT_ITEM: { t: marks.doorT + 14, pack: 'indoor-aisle-walk', packOffsetMs: 26000 },
  ITEM_PICKUP: { t: marks.doorT + 16, pack: 'indoor-aisle-walk', packOffsetMs: 30000 },
  CHECKOUT_NAV: { t: marks.doorT + 20, pack: 'indoor-aisle-walk', packOffsetMs: 34000 },
};

const track = {
  hz: 1,
  meta: {
    synthetic: true,
    generator: 'fixtures/tools/generate.mjs',
    recordedOn: 'none — synthetic until the phase-2 live run replaces it',
    speedMps: SPEED,
    entrance: { ...ENTRANCE, radiusM: 35 },
    door: { t: marks.doorT },
    accuracySnap: { t: marks.accuracySnapT, accuracyM: 65 },
    canyonJump: { t: marks.canyonJumpT, accuracyM: 38, offLineM: 40 },
    compassAccuracy2: { fromT: 70 + 5, toT: 70 + 25 },
    curb: { arriveT: marks.curbArriveT, dwellS: CURB_DWELL_S, alignedFromT: marks.curbArriveT + 5 },
    crossing,
    legs,
    expectedTransitionWindowS: [5, 15],
  },
  phases,
  samples,
};

writeFileSync(join(fixturesDir, 'track.json'), JSON.stringify(track, null, 1) + '\n');

// ---------------------------------------------------------------------------
// Perception packs
// ---------------------------------------------------------------------------
const packs = {};
function pack(name) {
  const lines = [];
  const add = (t, event, payload) => lines.push({ t: Math.round(t), event, payload });
  packs[name] = lines;
  return add;
}
const box = (x, y, w, h) => [r3(x), r3(y), r3(w), r3(h)];
const heartbeat = (add, from, to, state, extra) => {
  for (let ms = from; ms < to; ms += 2000) add(ms, 'onSignalState', { state, fresh: false, ...extra });
};

// 1. outdoor-leg — 30 s, pose 10 Hz, lateral drift to +0.7 m and back, one MID obstacle.
{
  const add = pack('outdoor-leg');
  add(0, 'onTrackingState', 'NORMAL');
  const yaw = 118;
  const rad = (yaw * Math.PI) / 180;
  for (let ms = 0; ms <= 30000; ms += 100) {
    const s = ms / 1000;
    const drift = s < 5 ? 0 : s < 12 ? ((s - 5) / 7) * 0.7 : s < 20 ? 0.7 - ((s - 12) / 8) * 0.7 : 0;
    const along = s * SPEED;
    const x = along * Math.sin(rad) + drift * Math.cos(rad);
    const z = -(along * Math.cos(rad) - drift * Math.sin(rad));
    add(ms, 'onPose', { yawDeg: r2(yaw + jitter(2)), x: r3(x), y: r3(jitter(0.02)), z: r3(z), trackingState: 'NORMAL', timestamp: ms });
    if (ms % 200 === 0) add(ms, 'onLateralOffset', { offsetM: r3(drift + jitter(0.02)), source: 'pose' });
    if (ms % 500 === 0) add(ms, 'onDepth', { centerBottomRel: r3(0.2 + jitter(0.03) + (s > 21 && s < 23 ? 0.35 : 0)), closingRate: r3(s > 21 && s < 23 ? 0.4 : jitter(0.02)), timestamp: ms });
    if (ms % 1000 === 0) add(ms, 'onPlanes', { floors: 1, verticals: s > 10 ? 2 : 1 });
    if (ms % 1000 === 500) add(ms, 'onDetections', s > 8 && s < 16 ? [{ cls: 'person', box: box(0.55, 0.35, 0.08, 0.3), score: 0.81, trackId: 3 }] : []);
  }
  add(22000, 'onObstacleAhead', { distanceClass: 'MID', direction: 'CENTER' });
}

// 2. curb-walk-onset — UNKNOWN 6 s → DONT_WALK → WALK fresh → COUNTDOWN → DONT_WALK, 0.5 Hz heartbeats.
//    Pose at 10 Hz, facing the crossing bearing (180): still at the curb until 13 s (one second
//    after the WALK onset), then walking the crossing at SPEED, so B's displacement rules see the
//    start (> 1.5 m) and the far curb (≥ length − 1 m) exactly as ARKit would on the phone.
{
  const add = pack('curb-walk-onset');
  add(0, 'onTrackingState', 'NORMAL');
  const CURB_WALK_START_S = 13;
  // Own PRNG stream: the poses were added after the other packs were cut, and the shared
  // sequence must not shift under C's indoor packs (byte-identical regeneration).
  let poseSeed = 20260920;
  const poseJitter = (amp) => {
    poseSeed = (poseSeed * 1664525 + 1013904223) % 4294967296;
    return (poseSeed / 4294967296 - 0.5) * 2 * amp;
  };
  for (let ms = 0; ms <= 30000; ms += 100) {
    const s = ms / 1000;
    const along = s < CURB_WALK_START_S ? 0 : (s - CURB_WALK_START_S) * SPEED;
    // bearing 180: east = 0, north = −along → ARKit z = +along (north = −z).
    add(ms, 'onPose', { yawDeg: r2(180 + poseJitter(2)), x: r3(poseJitter(0.03)), y: r3(poseJitter(0.02)), z: r3(along + poseJitter(0.03)), trackingState: 'NORMAL', timestamp: ms });
  }
  heartbeat(add, 0, 6000, 'UNKNOWN', { confidence: 0.2, nOfM: 2 });
  add(6000, 'onSignalState', { state: 'DONT_WALK', fresh: false, confidence: 0.9, nOfM: 6 });
  heartbeat(add, 8000, 12000, 'DONT_WALK', { confidence: 0.91, nOfM: 7 });
  add(12000, 'onSignalState', { state: 'WALK', fresh: true, confidence: 0.93, nOfM: 6 });
  heartbeat(add, 14000, 20000, 'WALK', { confidence: 0.94, nOfM: 8 });
  add(20000, 'onSignalState', { state: 'COUNTDOWN', fresh: false, confidence: 0.88, nOfM: 5 });
  heartbeat(add, 22000, 26000, 'COUNTDOWN', { confidence: 0.9, nOfM: 6 });
  add(26000, 'onSignalState', { state: 'DONT_WALK', fresh: false, confidence: 0.92, nOfM: 7 });
  heartbeat(add, 28000, 30001, 'DONT_WALK', { confidence: 0.92, nOfM: 8 });
  for (let ms = 0; ms <= 30000; ms += 500) {
    const s = ms / 1000;
    const cls = s < 6 ? null : s < 12 ? 'ped_hand' : s < 20 ? 'ped_walk' : s < 26 ? 'ped_countdown' : 'ped_hand';
    const dets = cls ? [{ cls, box: box(0.49 + jitter(0.01), 0.42, 0.025, 0.04), score: r2(0.7 + rnd() * 0.25), trackId: 21 }] : [];
    // 06 demo beat: a car from the right ~4 s into the crossing (its box grows over 2 s; PRNG-free).
    if (s >= 16 && s <= 18) dets.push({ cls: 'car', box: box(0.78 - (s - 16) * 0.06, 0.44, 0.1 + (s - 16) * 0.08, 0.09 + (s - 16) * 0.06), score: 0.86, trackId: 31 });
    add(ms, 'onDetections', dets);
  }
  add(17000, 'onVehicleApproaching', { direction: 'RIGHT', trackId: 31, growth: 1.6 });
}

// 3. curb-walk-already-on — the first non-UNKNOWN state is WALK with fresh:false.
{
  const add = pack('curb-walk-already-on');
  add(0, 'onTrackingState', 'NORMAL');
  heartbeat(add, 0, 4000, 'UNKNOWN', { confidence: 0.2, nOfM: 3 });
  add(4000, 'onSignalState', { state: 'WALK', fresh: false, confidence: 0.9, nOfM: 6 });
  heartbeat(add, 6000, 14000, 'WALK', { confidence: 0.92, nOfM: 8 });
  add(14000, 'onSignalState', { state: 'COUNTDOWN', fresh: false, confidence: 0.87, nOfM: 5 });
  heartbeat(add, 16000, 18000, 'COUNTDOWN', { confidence: 0.88, nOfM: 6 });
  add(18000, 'onSignalState', { state: 'DONT_WALK', fresh: false, confidence: 0.91, nOfM: 7 });
  heartbeat(add, 20000, 22001, 'DONT_WALK', { confidence: 0.91, nOfM: 8 });
}

// 4. curb-flicker — 4-of-8 flicker that stays UNKNOWN, a LIMITED gap, 10 s of UNKNOWN.
{
  const add = pack('curb-flicker');
  add(0, 'onTrackingState', 'NORMAL');
  heartbeat(add, 0, 30001, 'UNKNOWN', { confidence: 0.45, nOfM: 4 });
  add(8000, 'onTrackingState', 'LIMITED');
  add(11000, 'onTrackingState', 'NORMAL');
  for (let ms = 0; ms <= 30000; ms += 250) {
    const lit = Math.floor(ms / 250) % 2 === 0; // exactly half the frames see the lens
    add(ms, 'onDetections', lit ? [{ cls: 'ped_walk', box: box(0.5, 0.41, 0.024, 0.038), score: 0.62, trackId: 30 }] : []);
  }
}

// 5. vehicle-approach — a parked car (constant area) never fires; one approach from the right.
{
  const add = pack('vehicle-approach');
  add(0, 'onTrackingState', 'NORMAL');
  for (let ms = 0; ms <= 20000; ms += 200) {
    const s = ms / 1000;
    const dets = [{ cls: 'car', box: box(0.12, 0.55, 0.14, 0.09), score: 0.88, trackId: 7 }]; // parked, constant
    if (s >= 7.5 && s <= 11) {
      const g = (s - 7.5) / 3.5; // grows ~1.6× in area over the window
      const w = 0.06 * (1 + g * 0.6);
      const h = 0.045 * (1 + g * 0.6);
      dets.push({ cls: 'car', box: box(0.78 - g * 0.1, 0.52, w, h), score: r2(0.8 + g * 0.1), trackId: 12 });
    }
    add(ms, 'onDetections', dets);
    if (ms % 500 === 0) add(ms, 'onDepth', { centerBottomRel: r3(0.15 + jitter(0.02)), closingRate: r3(jitter(0.02)), timestamp: ms });
  }
  add(10000, 'onVehicleApproaching', { direction: 'RIGHT', trackId: 12, growth: 1.6 });
  // Silence for the same track for ≥ 4 s afterwards (rate limit) — nothing else fires.
}

// 6. scan-unsignalized — left window 0–8 s, right window 10–18 s, detections only.
{
  const add = pack('scan-unsignalized');
  add(0, 'onTrackingState', 'NORMAL');
  for (let ms = 0; ms <= 20000; ms += 250) {
    const s = ms / 1000;
    const dets = [];
    if (s < 8) dets.push({ cls: 'car', box: box(0.3, 0.5, 0.05, 0.035), score: 0.7, trackId: 40 }); // distant, static
    if (s >= 10 && s < 18) dets.push({ cls: 'truck', box: box(0.62, 0.48, 0.07, 0.06), score: 0.74, trackId: 41 }); // parked
    add(ms, 'onDetections', dets);
  }
}
// 6b. scan-unsignalized-approach — same windows; an approach fires during the right scan.
{
  const add = pack('scan-unsignalized-approach');
  add(0, 'onTrackingState', 'NORMAL');
  for (let ms = 0; ms <= 20000; ms += 250) {
    const s = ms / 1000;
    const dets = [];
    if (s < 8) dets.push({ cls: 'car', box: box(0.3, 0.5, 0.05, 0.035), score: 0.7, trackId: 40 });
    if (s >= 12 && s <= 15) {
      const g = (s - 12) / 3;
      dets.push({ cls: 'car', box: box(0.7 - g * 0.15, 0.5, 0.05 * (1 + g), 0.04 * (1 + g)), score: 0.86, trackId: 42 });
    }
    add(ms, 'onDetections', dets);
  }
  add(14500, 'onVehicleApproaching', { direction: 'RIGHT', trackId: 42, growth: 1.7 });
}

// 7. indoor-aisle-walk — OCR aisles 1→3 with 2-of-3 agreement, ocr_box drift, one person, end-of-aisle wall.
{
  const add = pack('indoor-aisle-walk');
  add(0, 'onTrackingState', 'NORMAL');
  const ocr = (ms, text, conf, x = 0.45) => add(ms, 'onOcrText', [{ text, box: box(x, 0.08, 0.14, 0.05), confidence: conf, timestamp: ms }]);
  ocr(2000, '1 PRODUCE', 0.86);
  ocr(2400, '1 PRODUCE', 0.9);
  ocr(2800, 'I PRODUCE', 0.61);          // the near-miss third read; 2-of-3 still agrees on aisle 1
  ocr(12000, '2 BAKERY', 0.84);
  ocr(12400, '2 BAKERY', 0.88);
  ocr(12800, '2 BAKERY', 0.9);
  ocr(24000, '3 DAIRY', 0.87);
  ocr(24400, '3 DA1RY', 0.66);           // OCR near-miss: digit-for-letter, must still match aisle 3
  ocr(24800, '3 DAIRY', 0.91);
  for (let ms = 0; ms <= 40000; ms += 100) {
    const s = ms / 1000;
    add(ms, 'onPose', { yawDeg: r2(92 + jitter(2)), x: r3(s * 0.9), y: r3(jitter(0.02)), z: r3(jitter(0.05)), trackingState: 'NORMAL', timestamp: ms });
    if (ms % 200 === 0) add(ms, 'onLateralOffset', { offsetM: r3(Math.sin(s / 4) * 0.35 + jitter(0.03)), source: 'ocr_box' });
    if (ms % 400 === 0) {
      const wall = s > 34 ? Math.min(1, 0.3 + (s - 34) / 6) : 0.25;
      add(ms, 'onDepth', { centerBottomRel: r3(wall + jitter(0.02)), closingRate: r3(s > 34 ? 0.15 : jitter(0.02)), timestamp: ms });
    }
    if (ms % 1000 === 0) add(ms, 'onPlanes', { floors: 1, verticals: 2 });
    if (ms % 1000 === 500) add(ms, 'onDetections', s > 14 && s < 19 ? [{ cls: 'person', box: box(0.48, 0.3, 0.12, 0.45), score: 0.85, trackId: 50 }] : []);
  }
  add(16000, 'onHazard', { kind: 'PERSON_AHEAD', direction: 'CENTER' });
  add(37000, 'onObstacleAhead', { distanceClass: 'MID', direction: 'CENTER' });
  add(39000, 'onObstacleAhead', { distanceClass: 'NEAR', direction: 'CENTER' });
}

// 8. indoor-hard-cases — nothing matches, two signs in one frame, order skip, direction flip, silence, malformed line.
{
  const add = pack('indoor-hard-cases');
  add(0, 'onTrackingState', 'NORMAL');
  const read = (text, ms, x = 0.45) => ({ text, box: box(x, 0.08, 0.14, 0.05), confidence: 0.8, timestamp: ms });
  add(2000, 'onOcrText', [read('A1SLE 7Z', 2000)]);                       // matches nothing
  add(6000, 'onOcrText', [read('2 BAKERY', 6000, 0.2), read('3 DAIRY', 6000, 0.7)]); // two signs, one frame
  add(6400, 'onOcrText', [read('2 BAKERY', 6400, 0.2), read('3 DAIRY', 6400, 0.7)]);
  add(6800, 'onOcrText', [read('2 BAKERY', 6800, 0.2)]);
  add(10000, 'onOcrText', [read('6 FROZEN', 10000)]);                    // skips 3 orders from aisle 2 → ignore
  add(10400, 'onOcrText', [read('6 FROZEN', 10400)]);
  add(20000, 'onOcrText', [read('3 DAIRY', 20000)]);
  add(20400, 'onOcrText', [read('3 DAIRY', 20400)]);
  add(22000, 'onOcrText', [read('2 BAKERY', 22000)]);                    // decreasing order → direction flip
  add(22400, 'onOcrText', [read('2 BAKERY', 22400)]);
  add(22800, 'onOcrText', [read('2 BAKERY', 22800)]);
  // 20 s with no read: 23–43 s. Only pose keeps flowing.
  for (let ms = 0; ms <= 50000; ms += 100) add(ms, 'onPose', { yawDeg: r2(270 + jitter(2)), x: r3(-ms / 1000 * 0.8), y: 0, z: r3(jitter(0.05)), trackingState: 'NORMAL', timestamp: ms });
  add(45000, '__MALFORMED__', null);                                       // replaced by a broken line below
  add(46000, 'onUnknownFutureEvent', { anything: true });                  // unknown event name: skipped, counted
  add(48000, 'onOcrText', [read('1 PRODUCE', 48000)]);
  add(48400, 'onOcrText', [read('1 PRODUCE', 48400)]);
}

// Sort each pack by t (stable) and write .jsonl + the importable index.
const index = {};
for (const [name, lines] of Object.entries(packs)) {
  lines.sort((a, b) => a.t - b.t);
  const text = lines
    .map((l) => (l.event === '__MALFORMED__' ? '{"t": 45000, "event": "onOcrText", "payload": [ {"text": "BROKEN LINE' : JSON.stringify(l)))
    .join('\n');
  writeFileSync(join(perceptionDir, `${name}.jsonl`), text + '\n');
  index[name] = text;
}
writeFileSync(join(perceptionDir, 'index.json'), JSON.stringify(index) + '\n');

// Sanity print
const door = track.meta.door.t;
console.log(`track: ${samples.length} samples, door t=${door}, snap t=${track.meta.accuracySnap.t}, curb t=${marks.curbArriveT}, crossing t=${marks.crossingStartT}, far curb t=${marks.farCurbT}, approach t=${marks.approachT}, canyon t=${marks.canyonJumpT}`);
for (const [name, lines] of Object.entries(packs)) console.log(`pack ${name}: ${lines.length} lines`);
