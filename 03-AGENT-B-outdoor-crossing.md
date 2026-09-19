# 03 — Agent B: Outdoor Navigation, Crossings, and the Planner

**Outdoors is voice-led and haptic-confirmed; at the curb it is near-silent.** Walking
directions are a solved problem and you are integrating them, not inventing them. The parts
that are ours, where your effort goes: the turn flow (spoken, then felt), the crossing flow
(map-derived awareness, alignment, an honest signal read, a perception report at unsignalized
crossings), and the Nemotron jobs that turn route data into ≤ 12-word speech before the user
takes a step. Perception events (signal state, vehicles, drift) come from Agent C's native
module. You consume them; you never open a camera.

**Owns:** `src/outdoor/`, `src/crossing/`, `server/routes/route.ts`, `server/routes/plan.ts`
(plus the files beside them that only you touch: `server/routes/crossings.ts`,
`server/routes/data/`, `server/routes/cache/`, `server/routes/plan.eval.ts`,
`server/routes/plan.eval.md` — agree this with Agent D on day 0, since `server/` is theirs)
**Never touches:** `src/core/`, `src/ui/`, `src/perception/`, `src/indoor/`, `src/transition/`,
`modules/perception/`, the rest of `server/`, `mocks/`, `fixtures/`, `models/`, `training/`
**Contracts:** `01-SHARED-CONTRACTS.md` §1 (modes), §2–§4 (haptics, speech, sensors), §5
(events), §7 (PerceptionService), §8 (SemanticVision), §9 (Planner — you own these schemas),
§10 (CrossingController), §12 (mock mode). Change a contract by flagging it, never alone.
**Machine:** Mac 3. You build with `npx expo run:ios --device`; nothing you write is native.

---

## Scope boundary (read twice)

You build: route fetch and normalization through the proxy; the crossing data join; leg
advancement and re-planning; the turn flow; the `CrossingController` for signalized and
unsignalized crossings; the vehicle-alert reaction in outdoor modes; the Nemotron jobs, their
validators and templated fallbacks; pre-synthesis of variable phrases at route load; the
handoff to Agent D.

You do not build: anything that touches pixels (Agent C, `09-PERCEPTION-MODULE.md`); the
haptic patterns, the speech queue, the beacon or the ticker (Agent A, `02-AGENT-A-core-shell.md`);
store-entry detection (Agent D, `05-AGENT-D-harness-transition-demo.md`); the proxy core,
`/api/vision`, `/api/tts`, `/api/stt`, `/api/health` (Agent D). You request mode changes by
emitting events; only Agent A's store sets mode.

Two rules with no exceptions:
- Nothing time-critical waits on the network. Every phrase spoken outdoors is cached or
  pre-synthesized before the walk; every haptic fires synchronously inside an event handler.
- The app informs the crossing decision; it never makes it. Google data may say where a
  crossing is; it never triggers a walk cue. Forbidden in code, comments, UI, fixtures and the
  pitch: **safe, clear, go, cross now, no cars, you can cross.** Add a lint rule over your
  directories for the same list `01-SHARED-CONTRACTS.md` §3 rejects at runtime.

---

## Task 1 — `/api/route` (Routes API through the proxy)

`server/routes/route.ts`, `GET /api/route?originLat=&originLng=&destLat=&destLng=&storeId=`,
key `GOOGLE_MAPS_API_KEY` from the proxy's `.env`. The destination is the store JSON's
`entrance` (`fixtures/stores/<storeId>.json`, pinned by hand on the venue walk), never a
Places centroid: a big-box centroid can sit 50–100 m from the door. Places is only for finding
a store that is not in the fixtures, and not in the demo.

Request: `POST https://routes.googleapis.com/directions/v2:computeRoutes`, body
`{origin:{location:{latLng}}, destination:{location:{latLng}}, travelMode:'WALK'}`, headers
`X-Goog-Api-Key` and the mandatory field mask (omitting it is an error):

```
X-Goog-FieldMask: routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,
  routes.warnings,routes.legs.steps.distanceMeters,routes.legs.steps.staticDuration,
  routes.legs.steps.polyline.encodedPolyline,routes.legs.steps.startLocation,
  routes.legs.steps.endLocation,routes.legs.steps.navigationInstruction
```

Facts that shape the parser (verified in research):
- Steps carry `navigationInstruction {maneuver, instructions}`; `instructions` is plain text
  (HTML only if you opt in — do not). No bearing field exists anywhere: compute
  `startBearingDeg` from the first two points of the decoded step polyline and `endBearingDeg`
  from the last two.
- The Maneuver enum has 21 values and no crossing or arrival value: MANEUVER_UNSPECIFIED,
  DEPART, NAME_CHANGE, STRAIGHT, TURN_SLIGHT_LEFT/RIGHT, TURN_LEFT/RIGHT, TURN_SHARP_LEFT/RIGHT,
  UTURN_LEFT/RIGHT, RAMP_LEFT/RIGHT, FORK_LEFT/RIGHT, MERGE, ROUNDABOUT_LEFT/RIGHT, FERRY,
  FERRY_TRAIN. A step's maneuver is the action at the *start* of that step.
- Walking routes are beta ("might sometimes be missing clear sidewalks, pedestrian paths") and
  Google requires the warning displayed for every walking route. Expect it in
  `routes.warnings` **[verify on the first live call; hard-code the sentence if absent]**.
- Pricing is per-SKU free caps (Compute Routes Essentials: 10,000/month free); a WALK request
  with no routing preference bills Essentials. Volumes here are trivial.

Normalize to your own types in `src/outdoor/types.ts` (B-internal; not in `contracts.ts`):

```ts
export type LegManeuver =
  | 'STRAIGHT' | 'SLIGHT_LEFT' | 'SLIGHT_RIGHT' | 'TURN_LEFT' | 'TURN_RIGHT' | 'UTURN' | 'ARRIVE';

export interface RouteLeg {
  index: number;
  instruction: string;       // Google's plain text: planner input + DebugPanel only, never spoken raw
  maneuver: LegManeuver;     // the maneuver at the END of this leg (= next Google step's maneuver)
  distanceM: number;
  polyline: Array<{ lat: number; lng: number }>;
  startBearingDeg: number;   // initial great-circle bearing, first two polyline points
  endBearingDeg: number;
  endLat: number; endLng: number;
  roadSide: 'LEFT' | 'RIGHT' | 'NONE';  // side of the nearest named road along this leg; NONE if unknown
}

export interface RouteResponse {
  destName: string;
  legs: RouteLeg[];
  crossings: Array<Crossing & { afterLeg: number; sAlongM: number }>;  // Crossing from 01 §10
  warnings: string[];              // walking-beta text verbatim; always ≥ 1 entry
  script: RouteCompileOutput;      // Task 7, precomputed here
  planner: { routeCompile: { fallback: boolean; latencyMs: number };
             crossingAnnounce: { fallback: boolean; latencyMs: number } };
  fetchedAt: number;
}
```

Collapse rules: `TURN_*`, `TURN_SHARP_*`, `RAMP_*`, `FORK_*`, `ROUNDABOUT_*` → TURN_LEFT /
TURN_RIGHT; `TURN_SLIGHT_*` → SLIGHT_*; `UTURN_*` → UTURN; `STRAIGHT`, `MERGE`,
`MANEUVER_UNSPECIFIED` → STRAIGHT. `DEPART` and `NAME_CHANGE` steps merge into the following
step (geometry concatenated, no utterance of their own). The last leg's maneuver is `ARRIVE`,
synthesized. `roadSide` comes from the Overpass response (Task 2): the sign of the cross
product between the leg direction and the nearest named road centreline at the leg midpoint;
`NONE` when no road way lies within 25 m. It feeds `CourseError.roadSide`, so "drifting toward
the road" needs two agreeing signals rather than one.

Caching and terms: cache the full `RouteResponse` in proxy memory, keyed by origin and
destination rounded to 1e-4°, for 30 minutes; for the demo route also on disk
(`server/routes/cache/`) so a Google or Overpass hiccup at the venue costs nothing. Google's
terms cap lat/lng caching at 30 days and require "Google Maps" attribution text where route
content is shown without a map: supply `warnings` and the attribution string to Agent A's nav
screen. Google prohibits High Risk Activities: route data informs where a crossing is; no walk
cue derives from it. One clause is not resolved in `08-ROADMAP-AND-CONCERNS.md`: research read
the Maps ToS (§3.2.3(a)(iv)) as forbidding use of Google Maps Content with text-to-speech
services. Aisle speaks Nemotron-compiled phrases, not Google's strings, but street names
originate in the response. Raise it with the team before the pitch **[verify: current ToS text
and whether compiled phrases are inside it]**; Mapbox Directions (walking profile, bearings and
TTS-oriented voice instructions included) is the drop-in alternative if the answer is no.

---

## Task 2 — Crossing data join (OSM + WPRDC)

Google exposes no crossing. You find them by joining the route geometry to two sources, on
the proxy, once per route, from `route.ts` into `server/routes/crossings.ts`:

**OSM via Overpass.** One query per route bbox (route bounds padded 60 m), cached with the
route. Public Overpass is unreliable (504s observed in research; the main instance rejects
requests without a real `User-Agent`/`Accept`; fair use for an application is on the order of
100 queries/day): send `User-Agent: Aisle/0.1 (SteelHacks)`, try `overpass-api.de` then
`overpass.kumi.systems`, 25 s timeout, never per fix, never from the phone.

```
[out:json][timeout:25];
(
  node["highway"="crossing"]({{s}},{{w}},{{n}},{{e}});
  way["footway"="crossing"]({{s}},{{w}},{{n}},{{e}});
  way["highway"~"^(trunk|primary|secondary|tertiary|residential|unclassified|service)$"]({{s}},{{w}},{{n}},{{e}});
);
out body geom;
```

Tags that matter: `crossing=traffic_signals|marked|uncontrolled|unmarked`,
`crossing:signals=yes|no`, `button_operated=yes`, `traffic_signals:sound`, `tactile_paving`.
In the Oakland/Shadyside bbox 58 % of crossing nodes carry no `crossing=*` at all: treat
untagged as "crossing, signal unknown" (`signalized: null`).

**WPRDC signalized intersections.** Bundle the City of Pittsburgh dataset (783 rows with
lat/lng and `operation_type` ∈ {Fixed, Fully Actuated, Semi Actuated, Fixed/Ped Actuated,
Actuated, Actuated/PED, blank}; no pedestrian-signal, APS or countdown fields) as
`server/routes/data/wprdc-signalized.json`, licence noted beside it **[verify exact column
names when you download it]**.

**Join** (pure functions, unit-tested on a synthetic route):
1. Project every crossing node onto the route polyline; keep nodes with perpendicular distance
   ≤ 10 m; record along-track position `sAlongM` and the leg index `afterLeg`.
2. Cluster kept nodes within 15 m along-track (both curbs of one street; divided roads) into
   one `Crossing`; `crossingId` = the lowest OSM node id in the cluster.
3. `signalized`: `true` if any node has `crossing=traffic_signals` or `crossing:signals=yes`,
   or a WPRDC intersection lies within 30 m; `false` if tagged `marked|uncontrolled|unmarked`
   with `crossing:signals` absent or `no` and no WPRDC match; otherwise `null`.
4. `pushButtonLikely`: `button_operated=yes`, or the matched WPRDC `operation_type` contains
   "Actuated" or "PED".
5. `bearingDeg`: direction of travel along the `footway=crossing` way through the cluster when
   one exists, oriented to agree with the route; otherwise the route polyline bearing at
   `sAlongM`.
6. `nearCurb` / `farCurb`: the endpoints of that footway way when present; otherwise the
   polyline points 6 m before and after the cluster centre **[verify against the demo crossing
   on the venue walk; widen for four lanes]**.
7. `street`: the `name` of the nearest crossed road way, `""` if none. `roadSide`: the approach
   leg's value (`'RIGHT'` when that is NONE) — informational; see Task 6 for what the
   controller actually passes to COURSE.
8. Clusters with conflicting tags or a missing street are sent to the Nemotron
   `crossingAnnounce` job (Task 7); unambiguous clusters use the template and skip the model.

Crossings are returned sorted by `sAlongM`; `ROUTE_READY.crossingCount` is their number. A
`signalized: null` cluster is announced as "Crossing ahead: <street>." and the controller
resolves it at the curb (Task 6). The phone receives `crossings[]` fully formed; Agent D's
mock replays the recorded response.

---

## Task 3 — Leg advancement and re-planning

`src/outdoor/LegRunner.ts`. Subscribe to `SensorService.subscribeLocation` (Agent A runs
`Accuracy.BestForNavigation`, ~1 Hz on iOS while moving). Per fix:

- **Accuracy gate.** `accuracyM ≤ 20` → radius 15 m; `20 < accuracyM ≤ 35` → radius 25 m;
  `> 35` → the fix does not count toward advancement (still shown in DebugPanel). Apple's
  accuracy is a ~65 % bound, not a hard radius; urban GPS averages ~10 m error and is worst
  across the street, which is exactly the geometry that skips legs.
- **Advance** when two consecutive counting fixes are inside the radius of `endLat/endLng`, or
  when the along-track projection onto the leg polyline is past the leg end by > 10 m on two
  consecutive counting fixes (a corner cut on the inside). Never more than one leg per fix.
  Emit `OUTDOOR_LEG_ADVANCED {index, instruction}`.
- **Arrival** is the last leg's `ARRIVE`: no utterance of yours (Task 8).
- **Missed turn / off route.** Three consecutive counting fixes > 25 m cross-track from both
  the current and the next leg polyline with along-track progress stalled → call `/api/route`
  again from the current fix, speak the `answer` job's `replan` reply or the template
  "Re-routing." (INFO), replace legs and crossings, emit `ROUTE_READY` again. If the machine
  is in `APPROACH_CROSSING` and the new route drops that crossing, `abort()` the controller
  (`01-SHARED-CONTRACTS.md` §1 allows exactly that edge back to `OUTDOOR_NAV`).
- You never compute heading. `GeoFix.courseDeg` and `speedMps` are Agent A's fusion inputs;
  you read `sensors.getFusedHeadingDeg()` only for the scan gate in Task 6.

`angularError` stays and stays unit-tested across the 0°/360° boundary:

```ts
export function angularError(current: number, target: number): number {
  return ((target - current + 540) % 360) - 180;   // signed −180..180; + = target is to the right
}
```

Distances are computed in metres and spoken in feet, as words: `src/outdoor/numberWords.ts`
rounds to the nearest ten feet under one hundred and the nearest fifty above ("about two
hundred feet"). Flash v2.5 does no text normalization; digits never reach the speech layer.

---

## Task 4 — Spoken guidance: cached, pre-synthesized, never live mid-walk

Every outdoor utterance goes through `SpeechService.say` with a `dedupeKey`; without one a
jittery fix repeats "turn right" five times in ten seconds. Three sources of audio, in order:

1. **Cached** (`assets/audio/<cacheKey>.mp3`, bundled by Agent A; keys and canonical text in
   `01-SHARED-CONTRACTS.md` §3): `turn_left_soon`, `turn_right_soon`, `turn_left_now`,
   `turn_right_now`, `crossing_ahead_signalized`, `push_button_likely`, every curb, scan and
   vehicle phrase, `far_curb`, `offline_notice`.
2. **Pre-synthesized at route load:** every phrase with a street name or compiled variable —
   `script.legs[i].{soon, now, confirm}` whose text differs from a cached key's, every
   `crossingAnnouncements[].text`, the walking-beta sentence, and "Signal read is delayed"
   (fallback rung 2). Request them in one batch through `POST /api/tts` (`eleven_flash_v2_5`;
   free-plan concurrency is 4 simultaneous requests, so four at a time) *before* `ROUTE_READY`
   is emitted; store under `FileSystem.cacheDirectory/tts/<sha1(text)>.mp3`. Expand
   abbreviations first (`N`→North, `St`→Street, `Ave`→Avenue, `Blvd`, `Rd`, `Dr`,
   `US-19`→"U S nineteen") and test with real Pittsburgh strings ("S Bouquet St", "Forbes
   Ave"). Twenty phrases take well under ten seconds. **Contract flag for Agent A:**
   `SpeechService` has no `prefetch(texts)`; agree the shared path convention above (or add
   the method) so `say({text})` finds the file and nothing goes live during the walk.
3. **Live** Flash only for unbounded text: `how_far` replies (Task 7), non-urgent by
   construction. Offline, `expo-speech` speaks it.

Utterance table (`NAV` unless stated; cooldowns in ms):

| Moment | Text / key | dedupeKey | cooldown |
|---|---|---|---|
| Route ready | walking-beta sentence (pre-synth), then leg 0 `confirm` | `route-warning`, `leg-0-confirm` | once |
| 20 m before a turn | `script.legs[i].soon` or `turn_*_soon` | `leg-i-soon` | 15000 |
| At the maneuver point | `script.legs[i].now` or `turn_*_now`, then `TURN` | `leg-i-now` | 15000 |
| After the post-turn `CONFIRM` | `script.legs[i+1].confirm` | `leg-(i+1)-confirm` | once |
| ≤ 25 m before a crossing | `crossingAnnouncements[c].text` (pre-synth) or `crossing_ahead_signalized`; `push_button_likely` if flagged | `xing-c-ahead` | once |
| Vehicle event, any outdoor mode | `vehicle_left|right|ahead`, **CRITICAL**, `interrupt: true` | `vehicle-<dir>` | 4000 |
| Connectivity lost | `offline_notice` (INFO) | `offline` | once |

Trigger versus words: the `soon` cue fires at 20 m. `08-ROADMAP-AND-CONCERNS.md` gives the
example text "Turn right in twenty feet", which is 6 m — too late for 1 Hz GPS with 10 m error.
Keep the 20 m trigger; the words must match it ("Turn right in sixty feet") or omit the
distance ("Turn right soon"). Agent A owns the canonical text for `turn_*_soon`: flag it, and
instruct the planner the same way (Task 7).

Mode policy is enforced inside Agent A's SpeechService; you do not check mode before `say()`,
but you must expect a drop: at `AT_CURB` only signal transitions, vehicle alerts, scan reports
and `compass_uncertain` are spoken; while `CROSSING` only vehicle alerts, `countdown` and
`far_curb`. Sequence your speech so nothing important is ever queued behind a drop.

---

## Task 5 — Turn flow: spoken, then felt

COURSE (`HapticService.startCourse`) is a continuous service, not a turn-time ramp: silence when
on course; buzz rate and intensity grow with heading error beyond the dead zone (12° at compass
accuracy 3, 18° at 2, suppressed below with one `compass_uncertain`) or with cross-track drift
toward the roadway, 0.5 s hysteresis. Agent A implements the rule; you supply its reference
on every leg:

```ts
// on each leg start, and after every re-plan
haptics.stopCourse();
haptics.startCourse(sensors.courseErrorFor({
  bearingDeg: leg.startBearingDeg, line: leg.polyline, roadSide: leg.roadSide,
}));
perception.setCourseReference({ bearingDeg: leg.startBearingDeg });  // anchors ARKit drift at the current pose
```

At the maneuver point, synchronously and in this order: `say(now)` → `haptics.play('TURN')` →
re-target COURSE to the next leg (the snippet above). The buzz then runs against the new
bearing until the user is inside the dead zone; Agent A's service emits exactly one `CONFIRM`
on that first re-entry, and silence is the reward. Only then speak the next leg's `confirm`.
There is no hot/cold ramp anywhere; do not add one. `STRAIGHT` legs get no `TURN` and no
`now`; the reference simply updates. `UTURN` uses `TURN` and the compiled phrase.

Beacon: Agent A's direction beacon needs a target. Publish it from your zustand slice
`src/outdoor/store.ts` (`useOutdoorStore`: `{ beaconTarget: {lat,lng} | null, nextManeuverM,
nextCrossingM, legIndex, requestRescan() }`): the maneuver point inside the last 40 m of a leg,
`farCurb` while `CROSSING`, the store entrance inside the last 40 m of the final leg, `null`
otherwise. The beacon encodes direction only; distance is spoken, never beeped. **Contract
flag:** the beacon's input is not in `01-SHARED-CONTRACTS.md`; agree this slice with Agent A
on day 0. Body offset: Agent A calibrates it in onboarding ("walk straight for five seconds")
and sets `perception.setBodyOffsetDeg`; nothing for you to do.

---

## Task 6 — `CrossingController`

`src/crossing/CrossingController.ts` implements `01-SHARED-CONTRACTS.md` §10 exactly; one
instance. `src/crossing/VehicleAlert.ts` beside it reacts to `VEHICLE_APPROACHING` in every
outdoor mode. Internal states and what moves them:

```
ARMED ─curbReached()─▶ ALIGNING ─first CONFIRM or 8 s─▶ READING   (signalized !== false)
                                                     └─▶ SCANNING  (signalized === false; or READING
                                                                    saw only UNKNOWN for 10 s and spoke cant_see_signal)
READING | SCANNING ─crossingStarted()─▶ CROSSING ─farCurbReached()─▶ DONE
any ─abort()─▶ DONE
```

**ARMED** — `arm(c)` on the `CROSSING_AHEAD {crossingId, street, signalized, pushButtonLikely,
bearingDeg, distanceM}` that `LegRunner` emits when along-track distance to `nearCurb` ≤ 25 m
(the store moves to `APPROACH_CROSSING`). Speak the announcement once (Task 4),
`push_button_likely` once if flagged, and `perception.setCrossingBearing(c.bearingDeg)` — this
arms Agent C's geometric gate and onset tracking; the perception profile follows the mode by
itself. Keep the leg's COURSE reference. If the user walks straight past (`sAlongM` beyond
`farCurb` + 10 m with no stop) call `abort()` silently and log it.

**Curb detection → `curbReached()`.** The cane finds the curb; you detect the stop: within
12 m of `nearCurb` and (`speedMps < 0.3` or null for 2 s, or no pedometer step for 2 s), or
the DebugPanel "at curb" button. Emit `CURB_REACHED` → `AT_CURB`. Then `haptics.play('TURN')`
and `startCourse(courseErrorFor({bearingDeg: c.bearingDeg, roadSide: 'NONE'}))` — alignment to
the crossing bearing, no line; silence means aligned; the first re-entry gives the `CONFIRM`.
Say nothing about posture (onboarding did: chest height, ~10° up).

**READING (signalized).** `bus.on('SIGNAL_STATE')` → `signalUpdate(e)`. Agent C's module has
already applied the gate, the 5-of-8 filter and the onset rule and repeats the state every
2 s. Your job is the phrase, spoken only on transitions:

| Incoming | Speak | Notes |
|---|---|---|
| first non-UNKNOWN is WALK, `fresh: false` | `walk_already_on_wait` | never `walk_signal_on` on a stale WALK |
| DONT_WALK (from anything) | `dont_walk` | once per entry |
| WALK, `fresh: true` | `walk_signal_on` | the only path to this phrase |
| COUNTDOWN | `countdown` | also mid-crossing, once, no advice |
| UNKNOWN for 10 s since arming or since the last known state | `cant_see_signal` once | then the ladder |
| `setManualSignal(state)` | as above; source `manual` in DebugPanel | rung 4, always wired; `null` returns to live |

Agent A's ticker follows the same `SIGNAL_STATE` stream (slow = don't walk, fast = walk, mid =
countdown, none = unknown) and wins over the beacon at `AT_CURB`; you do not drive it. Nothing
else speaks at the curb.

Fallback ladder after `cant_see_signal` (each rung demoable; the demo script names the rung):
1. Live detector (the table above).
2. `SemanticVision` `question: 'curb_crop'`: `perception.snapshotJPEG(1024)` at 1 fps, ≤ 3 in
   flight, sequence-numbered, 3 s freshness (the proxy routes this question to Sonnet 5 with
   thinking disabled); apply `signal.state` only when `confidence ≥ 0.5`, else UNKNOWN; the
   first spoken read is preceded by the pre-synthesized "Signal read is delayed". Stop the
   moment the live stream returns a non-UNKNOWN state.
3. No state claim: alignment, map facts, vehicle alerts only.
4. Manual state from a teammate's DebugPanel.

The `SemanticVision` client lives in `src/perception/` (Agent C; path per
`04-AGENT-C-perception-indoor.md`). Build requests per `01-SHARED-CONTRACTS.md` §8 with
`facts.detections` from `perception.onDetections`, `facts.headingDeg`, `facts.signalState`.

**SCANNING — `startUnsignalizedScan()`.** Enter when `signalized === false` once aligned, or
from READING as above when `signalized === null`. Sequence:
1. `say(no_signal_point_left)` — "No signal here. Point the camera left." Wait until
   `getFusedHeadingDeg()` is within ±30° of `bearingDeg − 90°`, or 4 s.
2. Left window, 2 s: Agent C's vehicle pipeline runs at full rate; collect every
   `VEHICLE_APPROACHING` and any `SCAN_RESULT {source: 'detector'}` seen in the window. At
   +1 s, `snapshotJPEG(512)` → `SemanticVision` `scan_left` with `facts.detections` and
   `headingDeg`, 3 s freshness. Emit `SCAN_RESULT {side: 'LEFT', vehiclesSeen, source:
   'claude'}` when it returns; `unclear` when Claude says so, when `confidence < 0.5`, or on
   timeout.
3. `say(now_right)` — "Now right." Wait for heading within ±30° of `bearingDeg + 90°` or 4 s;
   right window identical.
4. Listening pause, 2 s: nothing plays — no beacon, no ticker, no speech.
5. Report. Per side the verdict is the worst of {detector events in the window, Claude's
   `vehiclesSeen`}: `approaching` > `unclear` > `distant` = `none`. Speak as **CRITICAL,
   `interrupt: false`** so the clips play back to back without the 4 s gap (nothing else is
   queued at the curb):
   - both `none`/`distant`: `no_vehicles_left`, `no_vehicles_right`, `listen_then_cross` —
     "No vehicles seen to the left. No vehicles seen to the right. Listen, then cross."
   - any `approaching`: that side first, `vehicle_approaching_left|right`, then the other
     side's line; no `listen_then_cross`.
   - any `unclear`: `cant_see_well_left|right` for that side, then the other side's line; no
     `listen_then_cross`.
   The report states what was perceived. It never grants permission.
6. The report is dated; no automatic re-scan. A `parseIntent` result of `repeat` while
   `AT_CURB` (Agent A routes it to `useOutdoorStore.requestRescan()`) or the DebugPanel runs
   the scan again.

The two stills are the only cloud calls at an unsignalized crossing. If a vehicle looms during
the scan, Agent C's event and your `VehicleAlert` fire `STOP` regardless of scan state.

**CROSSING — `crossingStarted()`.** The user decides to step off; you only detect motion: ≥ 4
pedometer steps since the curb, or ARKit displacement > 1.5 m along `bearingDeg`
(`sensors.subscribePose`). Emit `CROSSING_STARTED` → `CROSSING`. Then
`perception.setCourseReference({bearingDeg})`, `startCourse(courseErrorFor({bearingDeg, line:
[nearCurb, farCurb], roadSide: 'NONE'}))`, `beaconTarget = farCurb`. Baseline veer without a
far-side cue is ~5 m over a 22 m crossing and ~60 % of blind travellers end outside the
crosswalk (26 % with a far-side beacon); the pose-derived drift (±0.1 m) plus the beacon are
the counter. Speech in this mode is only vehicle alerts, `countdown` and `far_curb`; a
DONT_WALK mid-crossing is dropped by policy — silence, no advice. **Contract flag for Agent
A:** with `roadSide: 'NONE'` the contract buzzes on heading alone; inside a crosswalk both
sides are roadway, so `startCourse` should buzz on `|crossTrackM| > 0.5` regardless of side
while `CROSSING`. Ask; do not implement it in `src/crossing/`.

**Far curb — `farCurbReached()`.** ARKit displacement along the bearing ≥ crossing length −
1 m, or two counting GPS fixes within 8 m of `farCurb` with `accuracyM ≤ 15`, or steps × 0.7 m
≥ length + 2 m as the last resort. `haptics.play('CONFIRM')`, `say(far_curb)`, `beaconTarget =
null`, `perception.setCrossingBearing(null)`, emit `FAR_CURB_REACHED` → `OUTDOOR_NAV`;
`LegRunner` re-targets COURSE to the current leg and the cycle repeats at the next crossing.

**`VehicleAlert`** (`OUTDOOR_NAV`, `APPROACH_CROSSING`, `AT_CURB`, `CROSSING`): on
`VEHICLE_APPROACHING {direction}` → `haptics.play('STOP')` then `say({cacheKey: vehicle_left |
vehicle_right | vehicle_ahead, priority: 'CRITICAL', interrupt: true, dedupeKey: 'vehicle-' +
direction, cooldownMs: 4000})`, both inside the handler, no `await` before `play`. Frame →
haptic must land under 150 ms end to end; show it in DebugPanel next to Agent C's
`getStats().frameToEventMs`. Forward field of view only; nothing about speed or distance is
ever said. `OBSTACLE_AHEAD {distanceClass: 'NEAR'}` outdoors → `STOP` only (the outdoor speech
policy has no obstacle phrase; flag to Agent A if one is wanted). **Ownership flag:** one
reactor per mode is the intent; confirm with Agent A that the core does not also react.

`abort()` from any state: COURSE reference back to the leg, `setCrossingBearing(null)`, beacon
off, no speech. Expose every state, verdict, timer and source through `getDebugState()` for
Agent A's DebugPanel: legs, next crossing, signal source (live / claude / manual), scan
verdicts, planner fallback flags, utterance count.

---

## Task 7 — Nemotron jobs (Tier 2, "Beyond the Chatbot")

`server/routes/plan.ts` serves `POST /api/plan { job, input }` for all five jobs in
`01-SHARED-CONTRACTS.md` §9. You own the schemas, prompts, validators and templated fallbacks
for all five; you call three (`routeCompile`, `crossingAnnounce`, `answer`), Agent A calls
`parseIntent`, Agent C calls `disambiguate`. Export the JS client as `src/outdoor/planner.ts`
(`Planner.run<T>(job, input): Promise<PlannerResult<T>>`) for the others to import **[open:
confirm the client's home with A and C]**.

Request to NIM (`https://integrate.api.nvidia.com/v1/chat/completions`, `NVIDIA_API_KEY`):

```json
{ "model": "nvidia/nemotron-3.5-lightning-30b-a3b",
  "messages": [{"role": "system", "content": "<job prompt>"}, {"role": "user", "content": "<JSON input>"}],
  "chat_template_kwargs": {"enable_thinking": false},
  "nvext": {"guided_json": "<job schema>"},
  "stream": true, "temperature": 0, "max_completion_tokens": 400 }
```

That body is `07-SPONSOR-STACK.md` §1 ("Model and request shape") verbatim: 07 owns the
provider request shape and wins over this doc if the two ever differ, so change it there first
and copy it back. Two fields are not stylistic. `max_completion_tokens` is the name the NIM
catalog sample uses — the OpenAI SDK maps `max_tokens`, a raw `fetch` body may not, so a
`max_tokens` cap can cap nothing; confirm on day 0 that the cap is actually applied. Temperature
0 is what makes the wording repeatable, which the cached script, the pre-synthesized audio and
the wording A/B all assume.

Rules: confirm the model id and `nvext` acceptance against the authenticated `/v1/models` in
phase 0 (fallback id `nvidia/nemotron-nano-3-30b-a3b`; spelling varies by surface). Always
stream. First-token deadline 1.5 s (8 s total for the two route-time jobs); on miss, 429 or
503 → one OpenRouter same-model attempt, then the deterministic template with `fallback:
true`. Validate every output after the grammar — ≤ 12 words per phrase, no digits (`/\d/`),
none of the forbidden words, enums exact — and fall back per field. Log `latencyMs`, fallback,
and whether any reasoning tokens appeared (they must not). Warm each job's schema with one
dummy call at proxy start. Hosted latency is unpublished: budget 0.7–1.5 s TTFT with a fat
tail, which is why nothing during the walk waits on this route.

**`routeCompile`** — one call at route fetch, in-process from `route.ts` (no second round
trip), input `RouteCompileInput` built from `legs[]` (collapsed `maneuver`) and `crossings[]`
(`afterStep = afterLeg`). Prompt essentials: write for a blind pedestrian at walking pace;
`soon` is spoken about sixty feet before the maneuver and says "sixty feet" or no distance;
`now` is the imperative at the point; `confirm` names the street to continue on and its length
in feet as words; ≤ 12 words each, no digits, no abbreviations, street names spelled out
("Forbes Avenue"); never the forbidden words; never anything about crossing timing. Template
per `LegManeuver`: TURN_* → "Turn left in sixty feet." / "Turn left now." / "Continue on
<street>, about <n> feet."; SLIGHT_* → "Bear left…"; UTURN → "Turn around now."; STRAIGHT →
`soon` and `now` empty; ARRIVE → `now` empty (Agent D announces the store), `confirm`
"Entrance ahead, about <n> feet." The eval below is the A/B between raw Google text, these
templates and the model.

**`crossingAnnounce`** — at route fetch, only for clusters with conflicting tags or no street
name; input `CrossingAnnounceInput` (candidates with `distToPolylineM`, `tags`,
`wprdcOperationType`), output `{nodeId, signalized, pushButtonLikely, text}`. Prompt: pick the
node on the pedestrian's path; `signalized` may be `null`; `text` is exactly "Crossing ahead:
<street>. Signalized." or "Crossing ahead: <street>." with an optional "Push button likely."
Fallback: nearest node, `crossing:signals`/WPRDC read directly, template text. The judge never
sees a frame and never writes a walk cue.

**`answer`** — during the walk on `parseIntent` results `repeat`, `how_far`, `where_am_i`, and
on `replan`; `context` = current leg phrases, metres to the maneuver and to the next crossing,
street names, mode. 1.5 s first token or the template: `repeat` = last `now`/`confirm` from
cache; `how_far` = "About <n> feet to the turn." (live Flash, non-urgent); `where_am_i` = "On
<street>, <n> feet from <next street>."; `replan` = "Re-routing.".

**Precompute and cache.** Everything the walk needs from Nemotron exists before `ROUTE_READY`:
the script, the announcements, and their audio (Task 4). During the walk the only Nemotron
traffic is `answer` and `parseIntent`, single turns with a template behind each. If the cut
line drops live Nemotron, the cached script still plays; that is the design, not a fallback.

**Eval artifact** (phase 3; `server/routes/plan.eval.ts` → `server/routes/plan.eval.md`, one
page, linked from the README): intent accuracy on ~60 utterances (20 clean, 20 noisy-ASR
variants such as "eggs please" / "were am i", 20 off-task) with a confusion matrix; wording
A/B — raw Google text vs template vs Nemotron — rated blind by three teammates on "understood at
walking pace", with word counts; p50/p95 first-token and total latency per job; `nvext`
acceptance and fallback rates; proof that thinking was off. This is the evidence for "Nemotron
routes, classifies, judges and decides; it never chats."

---

## Task 8 — Handoff to Agent D

When the final leg becomes current (`maneuver === 'ARRIVE'`):
`transitionDetector.start({lat: store.entrance.lat, lng: store.entrance.lng, radiusM:
store.entrance.radiusM})` — from the store JSON, never from Places or from Google's
destination point — and set `beaconTarget` to the entrance for the last 40 m. Keep COURSE and
leg guidance running: the five-signal fusion needs the user to actually reach the door, and
live it fires 5–15 s after it. Speak nothing at arrival; Agent D's `STORE_ENTERED` and
`entering_store` are the handoff.

On `STORE_ENTERED` (fused or `forceEnter`): `haptics.stopCourse()`,
`perception.setCourseReference(null)`, `beaconTarget = null`, unsubscribe location and pose,
dispose the controller. Two modules reacting to location after the door is a guaranteed
double-speech; yours must be gone. You never detect store entry and never call `forceEnter`.

---

## Task 9 — Mock support

`EXPO_PUBLIC_MOCK=1` (`01-SHARED-CONTRACTS.md` §12) must run everything above with no walking,
no camera and no keys: `SensorService` replays `fixtures/track.json`; `PerceptionService`
replays `fixtures/perception/*.jsonl` (signal states with `fresh`, vehicle events, pose);
`/api/route`, `SemanticVision` and `Planner` replay `fixtures/route/*.json`,
`fixtures/vision/*.json`, `fixtures/plan/*.json`. Develop this way; walk outside to verify.

You owe Agent D the data: after the venue walk, capture the real `/api/route` response for
the demo route (legs, crossings, script, warnings) and hand it over as
`fixtures/route/demo.json`; D's mock serves it and its track replays the same polyline. Agent
D owns `fixtures/` and `mocks/`; you produce, they commit.

Your own tests (`src/outdoor/__tests__`, `src/crossing/__tests__`,
`server/routes/__tests__`; plain unit tests, no device): `angularError` across 0°/360°;
polyline decode and initial bearing against known points; point-to-polyline projection; the
join on a synthetic route with tagged, untagged and WPRDC-only nodes; leg advancement under an
accuracy-jittered fixture (no skipped leg, no double advance); controller sequences — WALK
first → `walk_already_on_wait`; DONT_WALK→WALK → `walk_signal_on`; 10 s UNKNOWN →
`cant_see_signal` then a rung-2 request; the 3×3 scan verdict matrix → exact phrase sequence;
vehicle during scan → STOP inside the handler; planner validators reject digits, > 12 words
and forbidden words and produce the template; forbidden-word lint over `src/outdoor/`,
`src/crossing/`, `server/routes/`.

---

## Phase plan and cuts (yours)

Phase 0 (before integration): NIM key, model id and `nvext` acceptance; Google project with
Routes enabled; WPRDC file bundled; Overpass query proven on the Oakland bbox; demo route
walked, entrance pinned, a fixed-time crossing (WPRDC `operation_type = Fixed`) within ~150 m
of the store chosen. Phase 1 order: `/api/route` + join + `routeCompile` schema → legs, turn
flow, controller states, curb speech policy → precompute, pre-synthesis, `answer` → live venue
runs → the eval page. When the cut line drops live Nemotron you lose nothing spoken (the
cached script plays); dropping vehicle warnings turns `VehicleAlert` off (STOP for obstacles
stays); dropping the live signal read is rung 3; dropping the outdoor leg replays the walk-up
from fixtures and runs live only at the crossing and the store. The crossing beat demos at
every rung; the demo script (`06-INTEGRATION-AND-DEMO.md`) must name the rung in use.

---

## Definition of done

- [ ] `/api/route` returns normalized legs with bearings from polylines and `warnings` populated; maneuver collapse unit-tested; walking-beta sentence displayed and spoken once; "Google Maps" attribution supplied to the nav screen
- [ ] Crossing join yields `crossings[]` for the demo route that matches the venue walk (street, signalized, push button, bearing, near/far curb within a few metres); untagged nodes give `signalized: null`; Overpass called once per route, cached, with a User-Agent, never from the phone
- [ ] Leg advancement: two consecutive counting fixes, accuracy gate, along-track overshoot rule; no skipped or double-advanced leg on the jittered fixture; re-plan on a missed turn
- [ ] No utterance repeats inside its cooldown (DebugPanel counter); every variable phrase pre-synthesized before `ROUTE_READY`; zero live TTS during a mock walk (asserted on the proxy log)
- [ ] Turn flow: `now` → `TURN` → COURSE against the next bearing → one `CONFIRM` → `confirm` phrase; no ramp code anywhere in `src/outdoor/`
- [ ] `CrossingController` passes the scripted sequences: a stale WALK never speaks `walk_signal_on`; `cant_see_signal` after 10 s UNKNOWN; rung-2 requests sequence-numbered and dropped when stale; manual override always works
- [ ] Unsignalized scan: left and right windows, one Claude still per side, 2 s pause, exact wording for all nine verdict combinations, `SCAN_RESULT(claude)` per side
- [ ] `VehicleAlert`: STOP + two words, CRITICAL, forward FOV only, frame → haptic < 150 ms measured on recorded curb footage
- [ ] Nemotron: request body identical to `07-SPONSOR-STACK.md` §1 (temperature 0, `max_completion_tokens`, stream, `chat_template_kwargs`, `nvext`) with the token cap proven to be honoured; `enable_thinking: false` and `guided_json` verified against the live endpoint; every job has a validator and a template; deadline and OpenRouter failover exercised by a fault-injection test; schemas warmed at proxy start
- [ ] Handoff: `TransitionDetector.start` with the store-JSON entrance; all B listeners gone after `STORE_ENTERED`; nothing spoken at arrival
- [ ] Forbidden-word lint clean over `src/outdoor/`, `src/crossing/`, `server/routes/`, the fixtures you produced and the eval page
- [ ] `server/routes/plan.eval.md` in the repo: intent accuracy, wording A/B, latency, fallback rates
- [ ] Everything runs end to end under `EXPO_PUBLIC_MOCK=1`; `fixtures/route/demo.json` delivered to Agent D
- [ ] Contract flags raised in the shared channel, not implemented unilaterally: `SpeechService.prefetch` / shared TTS cache path; beacon target slice; `CROSSING` cross-track buzz with `roadSide: 'NONE'`; who emits `SCAN_RESULT(detector)` with a side; who reacts to `VEHICLE_APPROACHING`; `turn_*_soon` wording vs the 20 m trigger; `Planner` client location; B's files under `server/routes/`; the Maps ToS text-to-speech clause
