# 01 — Shared Contracts (FROZEN)

Every interface in this file is a contract between agents. Agent A implements the
shared services (§1–§5, §11); B, C and D consume them and implement their own
(§7–§10). **Do not change a signature here without flagging it — a silent change
breaks three other agents.** Flag a change in the shared channel, get an ack from
every consumer, then edit this file and `contracts.ts` in the same commit.

Agent A writes all of these as TypeScript types in `src/core/contracts.ts`, verbatim,
on day 0 before anyone else starts. Types only: no implementation logic in that file.

Rationale for the choices below lives in `08-ROADMAP-AND-CONCERNS.md`; do not re-argue
them here. Agent C's native module is specified in `09-PERCEPTION-MODULE.md` and must
emit exactly the names in §5 and §7.

---

## 1. App state machine

```ts
export type AppMode =
  | 'IDLE'               // pre-task, awaiting item request
  | 'ONBOARDING'         // disclaimer + haptic/beacon tutorial
  | 'OUTDOOR_NAV'        // walking a route leg
  | 'APPROACH_CROSSING'  // mapped crossing within ~25 m on the route
  | 'AT_CURB'            // stopped at the curb; aligning; reading the signal / scanning
  | 'CROSSING'           // moving along the crossing bearing
  | 'TRANSITION'         // store-entry handoff in progress
  | 'INDOOR_NAV'         // navigating to the target aisle
  | 'AT_ITEM'            // arrived at the target aisle
  | 'ITEM_PICKUP'        // stretch: hand guidance to the package
  | 'CHECKOUT_NAV'       // navigating to checkout
  | 'DONE';
```

Legal transitions only. Every edge names the event that carries it; `setMode` rejects
everything else loudly, so an edge missing from this table is a dead end at runtime. The
event → edge mapping in `02-AGENT-A-core-shell.md` Task 2 must match this table row for row.

```
IDLE → ONBOARDING                       ITEM_REQUESTED while firstRun
IDLE → OUTDOOR_NAV                      ROUTE_READY while firstRun is false
ONBOARDING → OUTDOOR_NAV                onboarding finished AND ROUTE_READY
OUTDOOR_NAV → APPROACH_CROSSING         CROSSING_AHEAD            (cycle repeats per crossing)
APPROACH_CROSSING → AT_CURB             CURB_REACHED
AT_CURB → CROSSING                      CROSSING_STARTED
CROSSING → OUTDOOR_NAV                  FAR_CURB_REACHED
APPROACH_CROSSING → OUTDOOR_NAV         ROUTE_READY              (re-plan, crossing dropped)
AT_CURB → OUTDOOR_NAV                   CROSSING_ABORTED         (user does not cross / walked past)
CROSSING → OUTDOOR_NAV                  CROSSING_ABORTED         (abandoned mid-crossing)
OUTDOOR_NAV → TRANSITION                STORE_ENTERED
TRANSITION → INDOOR_NAV                 transition speech ends (3 s cap)
INDOOR_NAV → AT_ITEM                    TARGET_AISLE_REACHED
AT_ITEM → ITEM_PICKUP                   first ITEM_HAND_GUIDANCE (stretch beat)
AT_ITEM / ITEM_PICKUP → CHECKOUT_NAV    hint 'touching', step ≥ 8, or user "next"
CHECKOUT_NAV → DONE                     CHECKOUT_REACHED
* → IDLE                                abort (from any mode, including ONBOARDING and DONE)
```

`IDLE → OUTDOOR_NAV` is the ordinary path, not an exception: only the **first** run passes
through `ONBOARDING`, so every later run — every rehearsal, every fixture replay and the judged
demo — leaves `IDLE` on `ROUTE_READY` with `firstRun === false`. Quitting the practice path is
the abort edge `* → IDLE`; there is no separate practice-exit edge. A DebugPanel jump-to-mode
(`05-AGENT-D-harness-transition-demo.md`) emits the events above in order instead of calling
`setMode`, so it needs no edges of its own.

`CROSSING → AT_CURB` is deliberately **not** legal. The curb has one entry point, so a user who
steps back to the near curb goes out through `CROSSING_ABORTED → OUTDOOR_NAV` and B re-arms the
crossing (`CROSSING_AHEAD` → `CURB_REACHED`). One entry keeps the ticker, the near-silence
speech policy and the WALK onset rule starting from a single known state.

`CROSSED` is not a mode: `FAR_CURB_REACHED` (§5) returns the machine to `OUTDOOR_NAV`.
Any agent may **read** mode; only Agent A's store may **write** it, via `setMode()`.
Agents B/C/D request transitions by emitting events (§5); they never set mode directly.
Every service that changes behaviour by mode (speech policy §3, perception profile §7,
beacon, ticker) subscribes to the store; nobody passes mode around by hand.

---

## 2. HapticService (Agent A implements)

The entire vocabulary. Four patterns. Do not add a fifth. The old `ALIGNED` hot/cold
ramp is gone: **silence is the reward**.

```ts
export type HapticPattern =
  | 'TURN'      // rising triple pulse — "rotate now" (spoken turn is followed by this)
  | 'STOP'      // one long sharp buzz — vehicle approach or hard obstacle ONLY
  | 'CONFIRM';  // soft single tap — acknowledged / arrived / re-aligned after a turn

export type CompassAccuracy = 0 | 1 | 2 | 3;   // expo-location tiers; 3 = < 20° uncertainty

export interface CourseError {
  headingErrorDeg: number;     // signed, −180..180; + = user is pointed right of target bearing
  crossTrackM: number;         // signed metres off the leg / crossing line; + = right of line
  roadSide: 'LEFT' | 'RIGHT' | 'NONE';  // which side the roadway is on for this leg
  compassAccuracy: CompassAccuracy;
}

export interface HapticService {
  play(pattern: HapticPattern): void;

  /**
   * COURSE — the fourth pattern, run as a continuous service. Silence when on course.
   * Buzz rate and intensity rise with |headingErrorDeg| beyond the dead zone, or with
   * cross-track drift toward the roadway. Same rule on legs, at the curb, mid-crossing,
   * down an aisle. Polls getError at ≥ 10 Hz.
   */
  startCourse(getError: () => CourseError): void;
  stopCourse(): void;
}
```

Rules Agent A must enforce inside `startCourse`:

- Dead zone: 12° when `compassAccuracy === 3`, 18° when `=== 2`. Below 2: no course buzz,
  say `compass_uncertain` once (via §3), keep polling.
- Roadward drift: buzz when `crossTrackM > 0.5` toward `roadSide` **and** the sign of
  `headingErrorDeg` also points toward `roadSide` (two agreeing signals). Drift away from
  the road relies on heading alone.
- Hysteresis: an error must persist 0.5 s to start the buzz and 0.5 s inside the dead zone
  to stop it. Minimum buzz burst 150 ms. Buzz fatigue is a safety failure.
- Re-alignment after `TURN`: when the error first re-enters the dead zone after a
  `play('TURN')`, emit one `CONFIRM`, then silence. No other automatic CONFIRM.
- `STOP` pre-empts COURSE for 1 s; COURSE resumes without a CONFIRM.

**Latency:** `play()` fires in < 100 ms, fully on-device. A change in `getError()` output
is audible in the buzz in < 200 ms. Never gate a haptic on a network response.

---

## 3. SpeechService (Agent A implements)

```ts
export type SpeechPriority = 'CRITICAL' | 'NAV' | 'INFO';

export interface SpeechRequest {
  text: string;            // ≤ 12 words, numbers written as words ("twenty feet")
                           // except when cacheKey is on the long-phrase allow-list (below)
  priority: SpeechPriority;
  cacheKey?: string;       // plays assets/audio/<cacheKey>.mp3 locally — 0 ms network
  dedupeKey?: string;      // suppresses a repeat within cooldownMs
  cooldownMs?: number;     // default 8000
  interrupt?: boolean;     // CRITICAL only
}

export interface SpeechService {
  say(req: SpeechRequest): void;
  /** Play audio already streaming from the proxy (§8 streaming contract). Same queue. */
  playStream(streamId: string, priority: SpeechPriority): void;
  clearQueue(priority?: SpeechPriority): void;
  isSpeaking(): boolean;
  setRate(rate: number): void;   // expo-audio playbackRate with pitch correction, 0.8–1.6
}
```

**Backed by ElevenLabs `eleven_flash_v2_5`, two tiers, `expo-audio` playback:**

- **Cached (default):** ~40 fixed phrases pre-generated into `assets/audio/<cacheKey>.mp3`
  and preloaded at app start. Instant, offline.
- **Live:** only text containing runtime-variable words (street names, aisle labels), and
  those are pre-synthesized at route load / store load so nothing is live during the walk.
- Any `say()` without a `cacheKey` and without network falls back to `expo-speech`; it
  never fails silently.

Queue rules Agent A must enforce:

- `CRITICAL` interrupts and flushes everything below it, on every backend (cached player,
  live player, `expo-speech`) through one "current playback handle".
- `NAV` queues; max one pending (newest wins). `INFO` is dropped if anything is queued.
- A `dedupeKey` that fired within `cooldownMs` is dropped silently.
- **Never more than one utterance per 4 s** outside `CRITICAL`. Utterance ≤ 2 s.
- `text` with more than 12 words is rejected in dev (throw) and truncated at 12 in prod.
- **Long-phrase allow-list — one member, `disclaimer`.** When `cacheKey` is on the allow-list,
  the 12-word check, the digits-written-as-words check and the ≤ 2 s utterance length do not
  apply; the limit is instead **≤ 12 s of generated audio**, measured on the file. The
  first-launch disclaimer is ~45 words and plays through this same queue, so without the
  exemption the first launch of every build throws. Nothing else joins the allow-list without
  the flag-and-ack in this file's header, and the forbidden-word check is never exempt.
- Forbidden words, rejected at the call site by a lint rule and at runtime: **safe, clear,
  go, cross now, no cars, you can cross.**

Mode policy (SpeechService reads mode from the store; callers do not check it):

| Mode | May speak |
|---|---|
| OUTDOOR_NAV / APPROACH_CROSSING | leg instructions, crossing facts, `compass_uncertain` |
| AT_CURB | signal transitions, vehicle alerts, scan reports, `compass_uncertain` — nothing else |
| CROSSING | vehicle alerts, `countdown`, `far_curb` |
| INDOOR_NAV / AT_ITEM / CHECKOUT_NAV | aisle facts, obstacle, camera/user prompts |
| any | disclaimer, offline notice, abort |

Audio siblings (owned by A, not in this interface): the **direction beacon** (stereo-panned
pulse toward a target; silent over speech, sparse at AT_CURB, off indoors) and the
**signal-state ticker** (tempo: slow = don't walk, fast = walk, mid = countdown, none =
unknown). The ticker wins at AT_CURB, the beacon wins while CROSSING; never both.

Cache keys every agent may use (Agent A generates the files; text is canonical):

```
disclaimer, compass_uncertain, crossing_ahead_signalized, push_button_likely,
walk_signal_on, walk_already_on_wait, dont_walk, countdown, cant_see_signal,
vehicle_left, vehicle_right, vehicle_ahead, far_curb, no_signal_point_left, now_right,
no_vehicles_left, no_vehicles_right, listen_then_cross, vehicle_approaching_left,
vehicle_approaching_right, cant_see_well_left, cant_see_well_right,
turn_left_soon, turn_right_soon, turn_left_now, turn_right_now, entering_store,
keep_going, passed_it_turn_around, checkout_ahead, obstacle_ahead, tilt_camera_up,
turn_left_a_little, turn_right_a_little, reach_out, higher, lower, left, right,
touching, ask_staff, offline_notice
```

---

## 4. SensorService (Agent A implements; pose comes from Agent C's module)

```ts
export interface GeoFix {
  lat: number;
  lng: number;
  accuracyM: number;        // Apple: ~63–68 % bound, not a hard radius
  courseDeg: number | null; // GPS course over ground, null when speed < 0.5 m/s
  speedMps: number | null;
  timestamp: number;
}

export interface HeadingSample {
  trueHeadingDeg: number;   // 0–359 true north (expo-location watchHeadingAsync)
  accuracy: CompassAccuracy;
  timestamp: number;
}

export type TrackingState = 'NOT_AVAILABLE' | 'LIMITED' | 'NORMAL';

export interface Pose {
  yawDeg: number;           // ARKit world yaw, gravityAndHeading aligned (0 = true north)
  x: number; y: number; z: number;   // metres in the ARKit world frame
  trackingState: TrackingState;
  timestamp: number;
}

export interface SensorService {
  subscribeHeading(cb: (h: HeadingSample) => void): () => void;
  subscribeLocation(cb: (fix: GeoFix) => void): () => void;
  subscribeSteps(cb: (stepsSinceStart: number) => void): () => void;
  subscribePose(cb: (p: Pose) => void): () => void;          // re-emitted from PerceptionService
  getHeading(): HeadingSample | null;
  getFusedHeadingDeg(): number | null;   // ARKit yaw corrected by trueHeading; null when both bad
  getLastFix(): GeoFix | null;
  getStepsSince(timestamp: number): number;
  /** "Walk straight for five seconds": trueHeading vs GPS course while speed > 0.5 m/s. */
  calibrateBodyOffset(): Promise<{ offsetDeg: number; ok: boolean }>;
  /** The producer for HapticService.startCourse. Fuses heading, dead reckoning, GPS
   *  cross-track and (when present) the perception module's lateral offset. */
  courseErrorFor(target: {
    bearingDeg: number;
    line?: Array<{ lat: number; lng: number }>;
    roadSide: 'LEFT' | 'RIGHT' | 'NONE';
  }): () => CourseError;
}
```

Heading comes from `watchHeadingAsync` (`trueHeading`, `accuracy`), never from the raw
magnetometer. Location uses `Accuracy.BestForNavigation`. Steps from `expo-sensors`
Pedometer (iOS). GPS re-anchors dead reckoning only when `accuracyM ≤ 10`.

---

## 5. Event bus (Agent A implements, everyone emits/subscribes)

```ts
export type Direction = 'LEFT' | 'CENTER' | 'RIGHT';
export type Side = 'LEFT' | 'RIGHT';
export type SignalState = 'WALK' | 'DONT_WALK' | 'COUNTDOWN' | 'UNKNOWN';
export type DistanceClass = 'NEAR' | 'MID' | 'FAR';          // < 1 m, 1–2.5 m, > 2.5 m (relative depth)
export type HazardKind = 'PERSON_AHEAD' | 'CART_AHEAD';       // indoor, INFO priority
export type TransitionReason = 'FUSED' | 'MANUAL';
export type CameraDirection = 'up' | 'down' | 'left' | 'right' | 'closer' | 'none';
export type UserAction = 'none' | 'turn_left' | 'turn_right' | 'walk_forward' | 'stop' | 'reach';
export type HandHint = 'left' | 'right' | 'higher' | 'lower' | 'touching' | 'not_seen';
export type VehiclesSeen = 'none' | 'distant' | 'approaching' | 'unclear';

export type AppEvent =
  // task and routing
  | { type: 'ITEM_REQUESTED'; item: string; source: 'voice' | 'keyboard' | 'mock' }
  | { type: 'ROUTE_READY'; legCount: number; destName: string; crossingCount: number }
  | { type: 'OUTDOOR_LEG_ADVANCED'; index: number; instruction: string }
  // crossings
  | { type: 'CROSSING_AHEAD'; crossingId: string; street: string; signalized: boolean | null;
      pushButtonLikely: boolean; bearingDeg: number; distanceM: number }
  | { type: 'CURB_REACHED'; crossingId: string }
  | { type: 'SIGNAL_STATE'; state: SignalState; fresh: boolean; confidence: number }
  | { type: 'VEHICLE_APPROACHING'; direction: Direction; trackId: number }
  | { type: 'SCAN_RESULT'; side: Side; vehiclesSeen: VehiclesSeen; source: 'detector' | 'claude' }
  | { type: 'CROSSING_STARTED'; crossingId: string }
  | { type: 'FAR_CURB_REACHED'; crossingId: string }
  | { type: 'CROSSING_ABORTED'; crossingId: string; reason: 'user' | 'walked_past' | 'replan' }
  // course keeping (all modes)
  | { type: 'COURSE_DEVIATION'; meters: number; side: Side }
  | { type: 'OBSTACLE_AHEAD'; distanceClass: DistanceClass; direction: Direction }
  | { type: 'HAZARD'; kind: HazardKind; direction: Direction }
  // transition and indoor
  | { type: 'STORE_ENTERED'; reason: TransitionReason; confidence: number }
  | { type: 'AISLE_IDENTIFIED'; aisleId: string; label: string; confidence: number;
      source: 'ocr' | 'claude' }
  | { type: 'TARGET_AISLE_REACHED'; aisleId: string; side: Side }
  | { type: 'CHECKOUT_REACHED' }
  // active perception (Tier 1)
  | { type: 'CAMERA_REQUEST'; direction: CameraDirection }
  | { type: 'USER_ACTION'; action: UserAction }
  | { type: 'ITEM_HAND_GUIDANCE'; hint: HandHint; step: number }
  // system
  | { type: 'ERROR'; scope: string; message: string };

export interface EventBus {
  emit(e: AppEvent): void;
  on<T extends AppEvent['type']>(
    type: T,
    cb: (e: Extract<AppEvent, { type: T }>) => void
  ): () => void;
}
```

Who emits what: B — ROUTE_READY, OUTDOOR_LEG_ADVANCED, CROSSING_AHEAD, CURB_REACHED,
CROSSING_STARTED, FAR_CURB_REACHED, CROSSING_ABORTED, SCAN_RESULT (both `source` values);
C — SIGNAL_STATE, VEHICLE_APPROACHING, OBSTACLE_AHEAD, HAZARD, AISLE_IDENTIFIED,
TARGET_AISLE_REACHED, CHECKOUT_REACHED, CAMERA_REQUEST, USER_ACTION, ITEM_HAND_GUIDANCE;
D — STORE_ENTERED; A — ITEM_REQUESTED, COURSE_DEVIATION, ERROR. Mock mode (§12) may emit
any of them.

**`SCAN_RESULT` has exactly one emitter: Agent B's `CrossingController`, for both `source`
values.** The native module is never told which side is being scanned — `setCrossingBearing`
(§7) arms the signal gate and nothing else, and there is deliberately no `setScanSide` — so
the side is known only to the code that owns the scan window. Inside each window B derives the
detector verdict from the `VEHICLE_APPROACHING` events C emitted during it (`approaching` if
any fired, `none` if none did) and emits `SCAN_RESULT {side, vehiclesSeen, source: 'detector'}`;
it emits the `source: 'claude'` result when the still it sent returns, or `unclear` on low
confidence or timeout. The spoken report takes the worse of the two per side.

This closes the open contract flag in `03-AGENT-B-outdoor-crossing.md`: "JS emits
`SCAN_RESULT` from this event" in `09-PERCEPTION-MODULE.md` §5.2 means B's controller, not C's
bridge, so C emits `VEHICLE_APPROACHING` only and `04-AGENT-C-perception-indoor.md` drops
`SCAN_RESULT` from C's emitter list. 05's DebugPanel scan-result override is unchanged: it
injects the event B would have emitted.

`SIGNAL_STATE` is emitted on every state change and at least every 2 s while a state
holds; `UNKNOWN` produces silence downstream, never a guess. `fresh: false` means WALK
was already showing when tracking began ("Walk already on — wait for next").

---

## 6. Store map schema (Agent C owns the format, Agent D produces fixtures)

`fixtures/stores/<storeId>.json`. The `entrance` is **pinned by hand during the venue
walk** — Places returns a centroid, which can be 50–100 m from the door.

```json
{
  "storeId": "demo-store-01",
  "displayName": "Demo Grocery",
  "entrance": { "lat": 40.4443, "lng": -79.9436, "radiusM": 35,
                "pinnedBy": "venue-walk", "pinnedAt": "2026-09-18" },
  "signHeightM": 2.4,
  "aisles": [
    { "id": "a1", "label": "Aisle 1", "spokenLabel": "Aisle one",
      "signText": ["1", "PRODUCE"], "order": 1,
      "categories": ["produce", "fruit", "vegetables"] },
    { "id": "a3", "label": "Aisle 3", "spokenLabel": "Aisle three",
      "signText": ["3", "DAIRY"], "order": 3,
      "categories": ["dairy", "eggs", "milk", "cheese", "butter"] }
  ],
  "landmarks": [
    { "id": "checkout", "label": "Checkout", "spokenLabel": "Checkout",
      "signText": ["CHECKOUT", "REGISTERS", "LANES"], "afterAisleOrder": 99 }
  ],
  "itemIndex": {
    "eggs":  { "aisleId": "a3", "sideWhenAscending": "RIGHT", "shelf": "middle",
               "packageHint": "yellow carton" },
    "milk":  { "aisleId": "a3", "sideWhenAscending": "RIGHT" },
    "bread": { "aisleId": "a2", "sideWhenAscending": "LEFT" }
  }
}
```

```ts
export interface StoreMap {
  storeId: string;
  displayName: string;
  entrance: { lat: number; lng: number; radiusM: number; pinnedBy: string; pinnedAt: string };
  signHeightM?: number;
  aisles: Array<{ id: string; label: string; spokenLabel: string; signText: string[];
                 order: number; categories: string[] }>;
  landmarks: Array<{ id: string; label: string; spokenLabel: string; signText: string[];
                     afterAisleOrder: number }>;
  itemIndex: Record<string, { aisleId: string; sideWhenAscending: Side; shelf?: string; packageHint?: string }>;
}
```

`order` is what makes navigation work without SLAM: the navigator compares the current
aisle's `order` to the target's. `sideWhenAscending` is the side when walking toward
increasing `order`; the navigator inverts it when travelling in descending order. Order
comes from the map, never from the sign text, so non-numeric labels (`DAIRY`) work.

`label` is display and log text only — it carries digits (`Aisle 3`), and so does the `label`
field on `AISLE_IDENTIFIED` (§5). **Everything spoken comes from `spokenLabel`**, written as
words (`Aisle three`) because Flash does no text normalization and A rejects a digit in `text`
in dev (§3). One arrival template, used by `04-AGENT-C-perception-indoor.md` and by the demo
lines in `06-INTEGRATION-AND-DEMO.md` and `00-PROJECT-BRIEF.md`:

```
"<spokenLabel>. <item> on your <side>."   →   "Aisle three. Eggs on your right."
```

Both parts are variable text: D writes `spokenLabel` by hand when the store map is built and A
pre-synthesizes the utterance at store load (§3), so nothing is live during the walk. A store
map whose `spokenLabel` contains a digit is a fixture bug — fail the load in dev.

---

## 7. PerceptionService (Agent C implements — JS side of the native `PerceptionModule`)

One native Swift module owns the camera (ARKit world tracking). Nothing else in the app may
open a camera session. Tier 0 events are emitted natively, rate-limited, and re-broadcast on
the event bus by this service. Full spec: `09-PERCEPTION-MODULE.md`.

```ts
export type ModeProfile =
  | 'IDLE' | 'OUTDOOR_NAV' | 'APPROACH_CROSSING' | 'CROSSING' | 'INDOOR_NAV' | 'ITEM_PICKUP';
  // AT_CURB uses the APPROACH_CROSSING profile; TRANSITION uses OUTDOOR_NAV.

export interface Detection {
  cls: 'car' | 'bus' | 'truck' | 'motorcycle' | 'bicycle' | 'person' | 'cart'
     | 'ped_walk' | 'ped_hand' | 'ped_countdown';
  box: [x: number, y: number, w: number, h: number];  // normalized 0..1, upright frame
  score: number;
  trackId: number;
}

export interface OcrRead {
  text: string;           // raw, upper band only
  box: [number, number, number, number];
  confidence: number;
  timestamp: number;
}

export interface DepthSummary {
  centerBottomRel: number;   // relative depth 0..1 (1 = nearest) in the centre-bottom cell
  closingRate: number;       // d(rel)/dt, positive = approaching
  timestamp: number;
}

export interface Snapshot {
  base64: string; width: number; height: number; seq: number; timestamp: number;
}

export interface PerceptionService {
  start(profile: ModeProfile): Promise<void>;
  setProfile(profile: ModeProfile): void;
  stop(): void;

  // context the native filters need (set by B / A / C-indoor; null clears)
  setCrossingBearing(bearingDeg: number | null): void;   // arms the signal gate + onset tracking; NOT a scan-side setter (§5)
  setCourseReference(ref: { bearingDeg: number } | null): void;  // anchors pose-derived drift at the current pose
  setBodyOffsetDeg(offsetDeg: number): void;             // from SensorService.calibrateBodyOffset
  setKnownSigns(words: string[]): void;                  // OCR customWords from the store map

  onSignalState(cb: (e: { state: SignalState; fresh: boolean; confidence: number; nOfM: number }) => void): () => void;
  onVehicleApproaching(cb: (e: { direction: Direction; trackId: number; growth: number }) => void): () => void;
  onObstacleAhead(cb: (e: { distanceClass: DistanceClass; direction: Direction }) => void): () => void;
  onHazard(cb: (e: { kind: HazardKind; direction: Direction }) => void): () => void;   // indoor person / cart
  onOcrText(cb: (reads: OcrRead[]) => void): () => void;
  onDetections(cb: (d: Detection[]) => void): () => void;        // ≤ 5 Hz, for DebugPanel + facts
  onPose(cb: (p: Pose) => void): () => void;                    // 10 Hz
  onLateralOffset(cb: (e: { offsetM: number; source: 'pose' | 'ocr_box' | 'shelf' | 'curb' | 'none' }) => void): () => void;
  onPlanes(cb: (e: { floors: number; verticals: number }) => void): () => void;  // 1 Hz
  onDepth(cb: (d: DepthSummary) => void): () => void;           // ≤ 5 Hz
  onTrackingState(cb: (s: TrackingState) => void): () => void;

  snapshotJPEG(maxWidth: 512 | 640 | 1024): Promise<Snapshot>;  // upright, EXIF baked in
  getTrackingState(): TrackingState;
  getStats(): { detectorFps: number; depthFps: number; ocrFps: number; frameToEventMs: number; thermalState: string };
}
```

Per-mode model profiles (targets on the demo phone; thermal schedule):

| Profile | Detector (COCO) | Signal model | Depth | OCR | Segmentation |
|---|---|---|---|---|---|
| IDLE | off | off | off | off | off |
| OUTDOOR_NAV | 15 fps | off | 10 fps | off | 5–10 fps when enabled |
| APPROACH_CROSSING / AT_CURB | 15 fps | 15 fps, centre band | 10 fps | off | off |
| CROSSING | 15 fps | 15 fps | 10 fps | off | 5 fps when enabled |
| INDOOR_NAV / AT_ITEM / CHECKOUT_NAV | 15 fps (person, cart) | off | 10 fps | 3 fps, upper band | off |
| ITEM_PICKUP | 5 fps | off | 5 fps | off | off |

Event rate limits: `onSignalState` on change + 0.5 Hz heartbeat; `onVehicleApproaching`
≤ 1 per track per 4 s; `onObstacleAhead` ≤ 1 per 2 s; `onHazard` ≤ 1 per 3 s;
`onOcrText` ≤ 3 Hz; `onLateralOffset` 5 Hz smoothed over 1 s.

---

## 8. SemanticVision (Agent C owns the schema; proxy route by Agent D) — Tier 1 Claude

Only slack-tolerant questions. Called on scene change or user speech, never on a timer in a
time-critical mode. Model `claude-haiku-4-5`; `claude-sonnet-5` with
`thinking: {type: 'disabled'}` only for `curb_crop`. Structured outputs
(`output_config.format`, `json_schema`, `additionalProperties: false`). **One byte-stable
superset schema for every question** (grammar compile is cached per schema); the proxy warms
it at start and on every mode change.

Request, `POST /api/vision` (HTTP) or the same body over the persistent WebSocket:

```ts
export type VisionQuestion =
  | 'storefront' | 'aisle_disambiguate' | 'scan_left' | 'scan_right'
  | 'curb_crop' | 'hand_guidance' | 'free';

export interface VisionRequest {
  seq: number;
  question: VisionQuestion;
  mode: AppMode;
  image?: { base64: string; width: number; height: number };  // 512×384 default; 640×480 when text must be read; omit when facts suffice
  facts: {                                  // on-device truth, sent as text
    detections: Detection[];
    ocr: string[];
    depth?: DepthSummary;
    signalState?: SignalState;
    headingDeg?: number;
    knownSigns?: string[];                  // aisle_disambiguate only
    targetItem?: string;                    // hand_guidance only
  };
  userText?: string;                        // 'free' only
}
```

Response schema (field order is the contract — `speech` first so TTS can start when it closes):

```ts
export interface VisionResponse {
  speech: string;                           // ≤ 12 words or "" ; never the forbidden words
  cameraRequest: CameraDirection;
  userAction: UserAction;
  aisle: { matchedAisleId: string | null; matchedLandmarkId: string | null; confidence: number };
  storefront: { visible: boolean; confidence: number };
  scan: { vehiclesSeen: VehiclesSeen; confidence: number };
  signal: { state: SignalState; confidence: number };      // curb_crop only; UNKNOWN unless confident
  hand: { hint: HandHint };                                 // hand_guidance only
  confidence: number;                                        // 0..1 overall; < 0.5 → callers ignore
  seq: number;
}
```

Streaming contract:

1. Proxy streams Claude; when the `speech` string closes it opens the ElevenLabs WebSocket
   (`eleven_flash_v2_5`, `flush: true`) and relays audio to the phone as `streamId = seq`.
   The phone calls `SpeechService.playStream(streamId, priority)`; the SpeechService
   applies the same mode policy and 4 s gap.
2. The full JSON arrives afterwards; the client applies it only if `seq` ≥ last applied.
3. ≤ 3 requests in flight; freshness window 3 s at crossings, 6 s indoors; stale results
   dropped, never spoken.
4. `cameraRequest` / `userAction` become ≤ 6-word prompts, ≤ 1 per 3 s, never while the
   COURSE buzz is active.
5. `max_tokens` ≤ 300 output; `maxRetries: 0`; proxy timeout 4 s; on timeout or
   `stop_reason !== 'end_turn'` the client gets `{ confidence: 0 }` and stays silent.

Question-specific rules: `scan_*` returns `unclear` when the frame is dark or blurred (the
report then says "Can't see well to the left"); `curb_crop` is the fallback rung only, and
its announcement adds "Signal read is delayed"; `hand_guidance` gives one hint per call,
the caller gives up after 8.

---

## 9. Planner (Agent B owns schemas; proxy route by Agent D) — Tier 2 Nemotron

`POST /api/plan { job, input }` → `nvidia/nemotron-3.5-lightning-30b-a3b` on NIM with
`chat_template_kwargs: { enable_thinking: false }`, `nvext: { guided_json: <schema> }`,
`stream: true`. **First-token deadline 1.5 s**; on miss the proxy returns the deterministic
templated fallback with `fallback: true`. Same-model failover via OpenRouter behind the
proxy on 429/503. Nothing time-critical ever waits on this route.

```ts
export type PlannerJob = 'routeCompile' | 'parseIntent' | 'disambiguate' | 'crossingAnnounce' | 'answer';

export interface PlannerResult<T> { job: PlannerJob; output: T; fallback: boolean; latencyMs: number }

// routeCompile — once at route fetch; B pre-synthesizes the variable phrases immediately
export interface RouteCompileInput {
  steps: Array<{ index: number; instruction: string; maneuver: string; distanceM: number; startBearingDeg: number }>;
  crossings: Array<{ crossingId: string; afterStep: number; street: string; signalized: boolean | null; pushButtonLikely: boolean; bearingDeg: number }>;
}
export interface RouteCompileOutput {
  legs: Array<{ index: number; soon: string; now: string; confirm: string }>;  // each ≤ 12 words, numbers as words
  crossingAnnouncements: Array<{ crossingId: string; text: string }>;         // "Crossing ahead: Forbes. Signalized."
}

// parseIntent — after push-to-talk STT
export interface ParseIntentInput { transcript: string; mode: AppMode; knownItems: string[] }
export interface ParseIntentOutput {
  intent: 'find_item' | 'repeat' | 'how_far' | 'where_am_i' | 'abort' | 'help' | 'unknown';
  item: string | null;
  reply: string;   // ≤ 12 words
}

// disambiguate — "dairy" vs "eggs" → aisle
export interface DisambiguateInput { item: string; storeMap: StoreMap }
export interface DisambiguateOutput { aisleId: string | null; confidence: number; askBack: string | null }

// crossingAnnounce — which OSM node is on the path, signalized?, push button likely?
export interface CrossingAnnounceInput {
  candidates: Array<{ nodeId: string; distToPolylineM: number; tags: Record<string, string>; wprdcOperationType?: string }>;
  street: string;
}
export interface CrossingAnnounceOutput { nodeId: string | null; signalized: boolean | null; pushButtonLikely: boolean; text: string }

// answer — "repeat / how far / where am I", re-plan after a missed turn
export interface AnswerInput { question: 'repeat' | 'how_far' | 'where_am_i' | 'replan'; context: Record<string, unknown> }
export interface AnswerOutput { reply: string }   // ≤ 12 words
```

| Job | When | Deadline | Fallback |
|---|---|---|---|
| routeCompile | route fetch | 8 s total (pre-walk) | template per maneuver enum |
| parseIntent | after STT | 1.5 s first token | keyword match on `knownItems`, else "Say the item again" |
| disambiguate | item not in `itemIndex` | 1.5 s | category substring match |
| crossingAnnounce | route fetch | 8 s total | nearest node; `crossing:signals`/WPRDC direct |
| answer | user asks | 1.5 s | cached "repeat" = last leg phrase; distance from GPS |

Evidence artifact for judges (B, phase 3): one page in the repo with intent accuracy on
~60 utterances and the instruction-wording A/B against raw Google text.

---

## 10. CrossingController (Agent B) and TransitionDetector (Agent D)

```ts
export interface Crossing {
  crossingId: string; street: string; signalized: boolean | null; pushButtonLikely: boolean;
  bearingDeg: number; nearCurb: { lat: number; lng: number }; farCurb: { lat: number; lng: number };
  roadSide: Side;
}

export interface CrossingController {
  arm(c: Crossing): void;               // on CROSSING_AHEAD; runs approach announcement once at ~25 m
  curbReached(): void;                  // → AT_CURB: TURN + COURSE to bearingDeg; ticker on; speech policy narrows
  signalUpdate(e: { state: SignalState; fresh: boolean }): void;   // from PerceptionService; owns the phrase choice
  startUnsignalizedScan(): Promise<void>;   // left scan → right scan → 2 s pause → perception report
  crossingStarted(): void;              // → CROSSING: beacon to farCurb, COURSE holds bearing
  farCurbReached(): void;               // CONFIRM, beacon off, → OUTDOOR_NAV
  setManualSignal(state: SignalState | null): void;   // DebugPanel rung 4 — always wired
  abort(reason?: 'user' | 'walked_past' | 'replan'): void;   // emits CROSSING_ABORTED → OUTDOOR_NAV (§1)
}
```

Rules the controller enforces: the WALK phrase is spoken only on `fresh: true`; `fresh:
false` speaks `walk_already_on_wait`; `UNKNOWN` for > 10 s at a signalized crossing speaks
`cant_see_signal` once and enters the fallback ladder; Google data never triggers a walk
cue; scan reports state what was perceived, never permission.

```ts
export interface TransitionSignals {
  distanceMinThenRise: number;   // 0 | 0.3
  accuracyStepUp: number;        // 0 | 0.3
  stepsSinceMin: number;         // 0 | 0.2  (≥ 15 steps)
  storefrontFrame: number;       // 0 | 0.2  (one Tier-1 positive, ≤ 1 call / 5 s)
  ambientLight: number;          // bonus, Android only
}

export interface TransitionSignal {
  reason: TransitionReason;
  confidence: number;            // sum of TransitionSignals, fire at ≥ 0.6
  signals: TransitionSignals;
  detectedAt: number;
}

export interface TransitionDetector {
  start(dest: { lat: number; lng: number; radiusM: number }): void;
  stop(): void;
  onEnter(cb: (s: TransitionSignal) => void): () => void;   // fires once; 10 s debounce
  forceEnter(): void;                                        // manual override — always wire this up
}
```

---

## 11. Latency budget (hard numbers)

| Path | Budget | Owner |
|---|---|---|
| Tier 0 frame → haptic (STOP, signal ticker change) | < 150 ms | C |
| Heading / course change → COURSE buzz change | < 200 ms | A |
| Haptic `play()` fire | < 100 ms, on-device | A |
| Tier 1 Claude end-to-end (p95) | < 3 s | C / D |
| Tier 1 first spoken word (streamed) | ~1.5 s | C / D / A |
| Tier 2 Nemotron first token | < 1.5 s, else templated fallback | B / D |
| Cached phrase → audio out | < 50 ms (local file) | A |
| Live ElevenLabs Flash → first audio | < 400 ms (measured on-device) | A |
| Spoken utterance length | < 2 s (≤ 12 words) | all |
| Minimum gap between utterances | 4 s (non-CRITICAL) | A |
| Signal model on-device | ≥ 15 fps | C |
| Transition announcement after the door (live) | 5–15 s, acceptable | D |

Stale beats slow: any Tier 1 result older than its freshness window, or any Tier 2 answer
past its deadline, is dropped, never queued. All of these land in DebugPanel.

---

## 12. Mock mode (Agent D provides, everyone develops against it)

`EXPO_PUBLIC_MOCK=1` makes the entire app runnable with **no store, no walking, no camera
and no API keys**. Mocks live in `mocks/`, owned by D; fixtures in `fixtures/`.

- `SensorService` replays `fixtures/track.json` (GPS with accuracy profile, heading with
  accuracy tier, steps, GPS course) including the real entry-lag profile.
- `PerceptionService` replays `fixtures/perception/*.jsonl` (timestamped signal states,
  detections/tracks, OCR reads, pose, depth summaries) recorded from the native module on
  the demo phone; `snapshotJPEG` returns `fixtures/frames/<seq>.jpg`.
- `SemanticVision` and `Planner` replay `fixtures/vision/*.json` / `fixtures/plan/*.json`
  keyed by `question`/`job` + `seq`; unknown keys return `{ confidence: 0 }` / `fallback: true`.
- Speech and haptics still fire normally. DebugPanel exposes jump-to-mode, manual signal
  state, `forceEnter`, and the utterances-per-minute counter.

Agents B and C **must** be able to develop and test entirely in mock mode. The same installed
build with the flag set is the demo backup: no separate "airplane-mode build".
