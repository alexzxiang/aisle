# 04 — Agent C: Perception Module & Indoor Guidance

**You own the camera and everything that runs on its frames, and you own the indoor
leg.** The native module you write is the only thing in Aisle that sees pixels; the
indoor navigator you write is the beat that is never cut. Budget your time accordingly:
the module first (every other agent's live path depends on it), the navigator second,
Claude calls third, item pick-up last.

**Owns:** `modules/perception/` (Swift + JS bridge), `src/perception/`, `src/indoor/`, `models/`
**Never touches:** `src/core/`, `src/ui/`, `src/outdoor/`, `src/crossing/`, `src/transition/`, `server/`, `mocks/`, `fixtures/`
**Human machine:** Mac 1 (Xcode; the Swift owner). Native changes ship to the Windows
user's phone through EAS internal distribution, so batch them.
**Contracts:** modes, events, `PerceptionService`, `StoreMap` and `VisionRequest` /
`VisionResponse` are frozen in `01-SHARED-CONTRACTS.md` (§1, §5, §6, §7, §8). The native
module is specified in `09-PERCEPTION-MODULE.md`. Flag a change; never make it alone.

---

## Core insight: we are still not doing SLAM

No floor plan, no GPS indoors, no LiDAR. The store is pre-mapped as an **ordered list of
aisles**; the camera's only job is to answer "which aisle sign am I looking at right
now?", and navigation is comparing the current aisle's `order` to the target's. What
changed since the first draft: the answer now comes from **on-device OCR in under a
second**, not from a cloud model every 2 s; ARKit pose and a depth model keep the user
centred and warn of what is directly ahead; Claude is asked only when the on-device
answer is ambiguous. Relative, not absolute. Defend this if a judge asks how you localize.

---

## Task 1 — The native `PerceptionModule` (spec: `09-PERCEPTION-MODULE.md`)

One Swift module (Expo Modules API) on ARKit world tracking, `gravityAndHeading`, headless
(no preview view). Read 09 in full before writing Swift; this section is the summary of
what you are responsible for, not the spec.

Responsibilities:

- **Single camera owner.** `react-native-vision-camera` and `expo-camera` are absent from
  `package.json`. Every consumer reads `ARFrame.capturedImage` inside the module.
- **Models on the Neural Engine:** COCO YOLO-nano (vehicles, people, cart heuristic), the
  fine-tuned pedestrian-signal detector (`ped_walk` / `ped_hand` / `ped_countdown`, trained
  per `10-CV-TRAINING-TRACK.md`), Depth Anything V2 small (relative depth), Apple Vision
  OCR (`.fast`, upper band, language correction off, `customWords` from the store map),
  and optionally a walkable-surface segmentation model later.
- **Temporal filters live in Swift:** signal geometric gate + 5-of-8 + onset rule; vehicle
  looming (area growth > 40 % in 0.5 s, track ≥ 0.3 s, lower two-thirds, 4 s per-track
  cooldown, yaw-rate suppression); obstacle NEAR / MID / FAR with closing rate; person /
  cart hazard; OCR blur gate; pose-derived lateral offset. UNKNOWN is silence, never a guess.
- **Rate-limited events to JS** with exactly the names and payloads in 01 §7; pixels leave
  the module only through `snapshotJPEG(maxWidth)`.
- **Per-profile schedule** (01 §7 table): detector 15 fps, depth 10, OCR 3 (indoor only),
  segmentation 5–10 when enabled; session paused in IDLE; `.serious` thermal state halves
  every rate and shows in `getStats()`.

JS side, `src/perception/PerceptionService.ts`:

- Implements the `PerceptionService` interface over `requireNativeModule('Perception')`;
  swaps in D's replayer from `mocks/` when `EXPO_PUBLIC_MOCK=1`.
- Subscribes to the mode store and maps `AppMode → ModeProfile`: `AT_CURB` → the
  `APPROACH_CROSSING` profile, `TRANSITION` → `OUTDOOR_NAV`, `AT_ITEM` / `CHECKOUT_NAV` →
  `INDOOR_NAV`, everything else by name. Nobody passes mode in by hand.
- Re-broadcasts native events on the bus as `SIGNAL_STATE`, `VEHICLE_APPROACHING`,
  `SCAN_RESULT {source: 'detector'}`, `OBSTACLE_AHEAD`, `HAZARD`, and re-emits pose to the
  `SensorService`.
- **Owns the two time-critical reflexes**, because frame → haptic < 150 ms cannot survive
  another hop: on `onVehicleApproaching` it calls `haptics.play('STOP')` and
  `speech.say({cacheKey: 'vehicle_left' | 'vehicle_right' | 'vehicle_ahead', priority: 'CRITICAL', interrupt: true})`
  *before* emitting the bus event; on `onObstacleAhead` with `NEAR` and positive closing
  rate it plays `STOP` + `obstacle_ahead` the same way. Everything else about a crossing
  (signal phrase choice, ticker, scan flow) belongs to B's `CrossingController`.

---

## Task 2 — Model files and loading (`models/`)

| File | Source | Licence file |
|---|---|---|
| `models/coco-yolo-nano.mlpackage` | stock YOLO11n / YOLOv8n export, 640 (416 if the fps gate is missed) | `models/LICENSES/coco-yolo-nano.txt` |
| `models/ped-signal-v1.mlpackage` | D's training track (`10-CV-TRAINING-TRACK.md`); you integrate every new version | dataset licences from the same track |
| `models/depth-anything-v2-small.mlpackage` | CoreML build **[verify: exists, input size, ms on the demo phone]** | Apache-2.0 per the upstream repo **[verify]** |
| `models/walkable-seg.mlpackage` | optional, later **[verify export + fps]** | as exported |

Rules:

- Load lazily per profile; unload what the profile does not use (`INDOOR_NAV` never holds
  the signal model; `APPROACH_CROSSING` never holds OCR state).
- Compute units `.all`; log which unit each model actually landed on at first load and
  show it in DebugPanel via `getStats()`. A model that falls to CPU is a phase-0 bug.
- Model swap without a native rebuild is not a goal; a new `.mlpackage` means a new EAS
  build for the Windows user's phone. Batch model updates with other native changes.
- Phase-0 measurement on the demo phone, per model, per profile: fps, per-frame ms,
  surface warmth after 10 minutes. Numbers land in `getStats()` and the DebugPanel, and
  into the fixtures you record for D.

---

## Task 3 — Aisle identification (`src/indoor/aisleMatcher.ts`)

Input: `onOcrText` reads (≤ 3 Hz, upper 40 % band, blur-gated in Swift). Output: at most
one `AISLE_IDENTIFIED {aisleId, label, confidence, source: 'ocr'}` per distinct sign.

1. **Normalize again in JS** (idempotent; do not trust that a fixture or the mock did it):
   uppercase, strip punctuation, collapse whitespace, tokenize; digit-confusion map
   (O→0, I/l→1, S→5, B→8, Z→2) applied only to tokens that are otherwise numeric.
2. **Reject price-tag text before matching:** any token containing `$`, a decimal point, or
   the words `FOR`, `EA`, `LB`, `OZ`, `SAVE`; any read whose box height is below the
   phase-0 threshold for a hanging sign at 5 m (measure it on the venue stills).
3. **Fuzzy match against `signText` of every aisle and landmark in the store map:**
   - numeric map entries require an **exact** digit match on a numeric token (a "3" is
     never "8");
   - alphabetic entries match on Levenshtein distance ≤ 2 to a token of ≥ 3 characters,
     tightened to ≤ 1 when the map entry has ≤ 4 letters (`DELI`, `ICE`);
   - a read that matches one aisle's number and a different aisle's word is a two-match,
     not a match.
4. **Two signs in one frame:** the module emits both; take the read with the larger box.
5. **2-of-3 vote:** emit `AISLE_IDENTIFIED` only when the same `aisleId` wins in 2 of the
   last 3 processed reads (a read window of ≤ 3 s). `confidence` = mean OCR confidence of
   the agreeing reads.
6. **Plausibility window** (from the navigator): a candidate more than 2 orders away from
   `currentOrder` is held, not emitted; it is accepted only if the next two reads agree
   (three in a row). This is what stops a cross-aisle directory or an end-cap from
   teleporting the navigator.
7. **Hand-off to Claude** only on **no match** (text of ≥ 3 characters in the band that
   matches nothing) or **two-match**, at most one call per 4 s (Task 8).

Do not tune this against the fixture video alone: the 20 venue stills are the accuracy
set; the video is the false-positive set.

---

## Task 4 — Navigator (`src/indoor/navigator.ts`)

State: `currentOrder: number | null`, `targetOrder`, `direction: 'ASC' | 'DESC' | null`,
`lastReadAt`, `stepsAtLastRead`.

```
currentOrder === null            → keep_going (INFO, once per 15 s) — first confident read sets it
currentOrder <  targetOrder      → direction ASC;  keep_going (NAV, cadence from Task 5)
currentOrder >  targetOrder      → direction DESC; passed_it_turn_around (NAV) once, then keep_going
currentOrder === targetOrder     → TARGET_AISLE_REACHED {aisleId, side}
```

`side` = `itemIndex[item].sideWhenAscending`, inverted when `direction === 'DESC'`. The
arrival utterance is pre-synthesized at store load (aisle labels are variable text):
`"<label> aisle. <item> on your <side>."` — six words; resist the sentence. Play `CONFIRM`.

Edge cases, each with a unit test against a synthetic read sequence:

- **Non-numeric labels** (`DAIRY`): order comes from the map, never parsed from text.
- **Cross-aisles and end-caps:** reads skipping > 2 orders are ignored unless repeated
  (Task 3 step 6).
- **Entering mid-store:** the entrance may open onto the middle of the front cross-aisle;
  `currentOrder` is unknown until the first confident read, and `direction` is set from
  the first *two* reads, not assumed.
- **Walking the wrong way:** two consecutive reads with decreasing order (while
  `direction === 'ASC'`, or vice versa) flip `direction` and therefore the LEFT/RIGHT side.
  Say `passed_it_turn_around` only if the target is now behind; otherwise stay silent and
  let the next `keep_going` carry the corrected direction.
- **Two signs in one frame:** larger box (Task 3 step 4).
- **No read for 20 s:** `keep_going` once as INFO ("Keep going, looking for a sign"); after
  a further 20 s, a `CAMERA_REQUEST {direction: 'up'}` → `tilt_camera_up`, once.
- **Same sign re-read while standing still:** dedupe on `aisleId` + 10 s; do not advance
  the step prior.
- **Target order reached but item side unknown** (item not in `itemIndex`): B's
  `disambiguate` job has already picked the aisle; say the aisle label only.

The win condition is aisle-level. `TARGET_AISLE_REACHED` → mode `AT_ITEM` is the payoff
that always ships; Task 9 is the stretch on top of it.

---

## Task 5 — Pedometer prior (`src/indoor/pedometerPrior.ts`)

`SensorService.getStepsSince(lastReadAt) × 0.7 m` = distance since the last confirmed
sign. With aisle pitch measured on the venue walk (typically 3–4 m **[verify at the
venue]**), that is an estimated `currentOrder` between reads, good to ±1.5–2 aisles over
50 m. Use it for three things and nothing else:

- **Cadence:** `keep_going` fires when the prior says the next sign should be in view and
  none has been read (not on a fixed timer).
- **Plausibility:** it sets the window in Task 3 step 6.
- **Early overshoot:** if the prior passes `targetOrder + 1` with no read, say
  `passed_it_turn_around` once and request a read (`tilt_camera_up`) rather than waiting
  for the next sign.

Never use CMPedometer distance (research shows ~40 % bias); steps only. Never speak a
step count derived from the prior as fact.

---

## Task 6 — Aisle centring → COURSE (`src/indoor/aisleCentring.ts`)

The old VLM `alignmentOffset` is gone; a single-frame VLM cannot estimate lateral position.
Centring comes from the module:

- On `AISLE_IDENTIFIED` (or when the navigator decides the user has turned into an aisle),
  call `perception.setCourseReference({bearingDeg: fusedHeading})` so the module anchors
  pose-derived drift at the current position along the current heading.
- `onLateralOffset` supplies `offsetM` from `pose` (ARKit, ±0.05–0.1 m), `ocr_box` (sign box
  offset from frame centre, smoothed 1 s) and `shelf` (left/right depth asymmetry).
  Precedence: `pose` when tracking is NORMAL; else `shelf`; `ocr_box` only while a sign is
  in view. `source: 'none'` → feed 0 and let heading alone drive.
- Start the shared ramp: `haptics.startCourse(sensors.courseErrorFor({bearingDeg, roadSide: 'NONE'}))`.
  A's `SensorService` already fuses your lateral offset into `crossTrackM`; you supply the
  offset, you do not run a second ramp. Silence when centred; buzz grows with error; same
  vocabulary as outdoors. Stop the ramp on `TARGET_AISLE_REACHED` and while `ITEM_PICKUP`.
- Re-anchor `setCourseReference` on every cross-aisle turn the navigator issues; a stale
  anchor down a new aisle buzzes constantly, which is a safety failure, not a nuisance.

Verify on a taped straight line in phase 0: 0.5 m of real offset reads 0.5 ± 0.1 m.

---

## Task 7 — Obstacles and hazards (`src/indoor/obstacles.ts`)

From `onObstacleAhead {distanceClass, direction}` (depth, ≤ 1 per 2 s) and
`onHazard {kind, direction}` (COCO person / cart, ≤ 1 per 3 s):

- `NEAR` + closing → `STOP` + `obstacle_ahead` (CRITICAL) — done in `PerceptionService`
  (Task 1) so it never waits on this file.
- `MID` closing, or `NEAR` static → `OBSTACLE_AHEAD` on the bus + `obstacle_ahead` as INFO,
  cooldown 8 s. End-of-aisle wall shows up here first; the navigator uses it to expect a
  cross-aisle turn.
- `HAZARD` → INFO only, two words, never STOP. The cane already covers the person and the
  cart; the alert is a courtesy, and a CRITICAL interrupt for something the cane found
  first is exactly the chatty failure the speech policy exists to prevent.

**Hazard honesty (say this in the pitch and the disclaimer flow):** depth is relative and
uncalibrated in metres; NEAR / MID / FAR are per-phone thresholds calibrated by walking at a
wall. Cart is a heuristic, not a class. Nothing here is collision avoidance; the cane or
dog is. The phrase is always "Obstacle ahead" or "Person ahead" — never a distance, never a
reassurance. The forbidden words apply indoors too.

---

## Task 8 — Claude Tier 1 (`src/perception/semanticVision.ts`)

Schema and request are 01 §8; do not fork them. You own the schema text; D owns the
proxy route. Rules for every call:

- **Only on ambiguity, storefront, active perception or user speech.** Never on a timer in
  a time-critical mode. Triggers: `aisle_disambiguate` (Task 3 step 7, ≤ 1 per 4 s);
  `storefront` (called by D's `TransitionDetector` through this client, ≤ 1 per 5 s);
  `scan_left` / `scan_right` (called by B's `CrossingController`, one still per side);
  `curb_crop` (B, fallback rung only, `claude-sonnet-5` with thinking disabled, 1024 crop);
  `hand_guidance` (Task 9); `free` (A's voice path when the intent needs eyes).
- **Scene-change gate:** skip the call if neither the detector state nor the OCR token set
  changed since the last call and the last result is inside its freshness window (6 s
  indoors, 3 s at crossings).
- **Thumbnails:** `snapshotJPEG(512)` (512×384, 266 image tokens) by default; `640`
  (640×480, 414 tokens) when text must be read (`aisle_disambiguate`, `hand_guidance`);
  omit the image entirely when the facts answer the question (`free` follow-ups).
- **On-device facts as text** in every request: last `Detection[]`, normalized OCR tokens,
  `DepthSummary`, `signalState`, `headingDeg`; `knownSigns` for `aisle_disambiguate`;
  `targetItem` + `packageHint` for `hand_guidance`. Grounded prompts are faster and more
  accurate than a bare image.
- **Sequence and freshness:** `seq` monotonic; ≤ 3 in flight; a result with `seq` below the
  last applied, or older than its window, is dropped and never spoken.
- **Confidence:** `< 0.5` → ignore the whole response. `aisle.matchedAisleId` with
  `confidence ≥ 0.7` and inside the plausibility window → `AISLE_IDENTIFIED {source: 'claude'}`.
- **Active perception:** `cameraRequest ≠ 'none'` → `CAMERA_REQUEST`; `userAction ≠ 'none'`
  → `USER_ACTION`. Speech turns them into the cached ≤ 6-word prompts (`tilt_camera_up`,
  `turn_left_a_little`, `turn_right_a_little`), ≤ 1 per 3 s, and never while the COURSE
  buzz is active (ask `haptics` state before saying it). This is the reason the indoor loop
  tolerates a 1–2 s model: it can ask for a better view instead of guessing.
- **Streaming:** the proxy relays ElevenLabs audio as `streamId = seq` as soon as `speech`
  closes; you call `speech.playStream(seq, 'NAV')` (or `'INFO'` for `free`). The full JSON
  arrives after; apply the fields then.
- **Forbidden words** in `speech`: the schema description says so; the client also filters
  and drops the utterance if one slips through.

Nemotron is not in the image path. Do not send frames to `/api/plan`.

---

## Task 9 — Item pick-up (stretch; `src/indoor/itemPickup.ts`)

Only after `TARGET_AISLE_REACHED` and only if the user asks or the demo script enables it;
mode `AT_ITEM → ITEM_PICKUP`, profile `ITEM_PICKUP` (detector 5 fps, depth 5, OCR off).

1. Pre-synthesized at store load: `"Face the shelf on your <side>."` then cached `reach_out`.
2. Loop, ≤ 8 steps: `snapshotJPEG(640)` → `hand_guidance` with `targetItem`, `packageHint`
   → `hand.hint` → `ITEM_HAND_GUIDANCE {hint, step}` → one cached word (`left`, `right`,
   `higher`, `lower`). ~2 s per step; 4 s speech gap still applies, so pace the loop to it.
3. `touching` → `CONFIRM`, cached `touching`, → `CHECKOUT_NAV`.
4. `not_seen` twice in a row → `CAMERA_REQUEST {direction: 'down'}` once, then continue.
5. Step 8 without `touching` → `ask_staff` ("Ask staff for help finding it") → `CHECKOUT_NAV`.

Demo on a distinctive package (`packageHint` in the store map). Shelf-level detection in
clutter is where academic systems still fail; "Eggs on your right" is the guaranteed
payoff and this loop is the bonus.

---

## Task 10 — Checkout landmark

`CHECKOUT_NAV` reuses Tasks 3–7 with the target set to the `checkout` landmark:
`targetOrder = landmarks.checkout.afterAisleOrder`, `signText` `CHECKOUT` / `REGISTERS` /
`LANES` matched with the same fuzzy rules (alphabetic, distance ≤ 2). On a 2-of-3 match:
`CHECKOUT_REACHED` + `CONFIRM` + cached `checkout_ahead` → `DONE`. Set `afterAisleOrder` on
the venue walk to where the registers actually sit relative to aisle order (0 if before
aisle 1, 99 if past the last); the fixture value is an example, not a fact. Do not build
open-lane or queue detection.

---

## Task 11 — Venue mapping (physical, phase 0, with a named human)

Walk the store with a teammate and a tape measure. Ask the manager about filming first
(backup venue: the campus market). Record into `fixtures/stores/<storeId>.json` (01 §6):

- every aisle sign's **exact strings** (all faces; hanging signs are two-sided and read
  from the cross-aisle), its `order`, and category words for `categories`;
- **sign height** (`signHeightM`) and **digit height**; from those and the ~70° FOV decide
  the reading distance the navigator copy assumes ("read from the cross-aisle at 3–6 m");
- aisle pitch in metres (Task 5) and where the front and back cross-aisles are;
- checkout signage strings and `afterAisleOrder`;
- **entrance pin:** stand in the doorway, take the coordinates from the phone (average
  30 s of fixes), set `radiusM: 35`, `pinnedBy: 'venue-walk'`, `pinnedAt`. Places gives a
  centroid 50–100 m from the door; never use it for the entrance.
- lighting: fluorescent flicker, dark end-caps, glare on glossy signs; note where OCR
  struggles so the demo route avoids it;
- the demo item: aisle, `sideWhenAscending`, `shelf`, `packageHint`.

Then record for D: one **full-route video** (phone at chest, ~15° up, lanyard, cane in the
other hand), **20 aisle-sign stills** at 3–6 m, and an ARKit session log (pose + tracking
state) exported with the module's debug method to `fixtures/perception/*.jsonl`. That
recording is the insurance policy: if live perception misbehaves at demo time, the replay
still tells the whole story.

---

## Task 12 — Vision request contract with D's proxy

D implements `server/` (`POST /api/vision`, the WebSocket variant, `GET /api/health`); you
implement the client and define what "correct" means. Agree these before either side codes:

- **Transport:** HTTP `POST /api/vision` with the `VisionRequest` body for one-off
  questions; a persistent WebSocket (opened on `TRANSITION`, kept alive through `DONE`)
  carrying the same body for the indoor loop, so the ElevenLabs audio can stream back on
  `streamId = seq` without a second connection.
- **Model routing is server-side** from `question`: `curb_crop` → `claude-sonnet-5`,
  `thinking: {type: 'disabled'}`; everything else → `claude-haiku-4-5`. The client never
  names a model.
- **One byte-stable superset schema** (01 §8 `VisionResponse`, `additionalProperties: false`,
  `speech` first). The proxy warms it at start; you send one warm-up per mode change
  (convention to agree with D: a `free` request with no image and `userText: "warm"` that
  the proxy answers from a canned response without touching ElevenLabs).
- **Timeouts:** proxy 4 s, `max_tokens ≤ 300`, `maxRetries: 0`; on timeout, `stop_reason
  !== 'end_turn'`, refusal or invalid JSON the client receives `{ confidence: 0, seq }` and
  says nothing. No retries from the phone either — the next scene change is the retry.
- **Image block before text**, JPEG quality 0.8, orientation baked in (the module does
  this); the proxy passes bytes through unchanged. Check the actual bytes once in phase 0.
- **Health:** `GET /api/health` must report the Anthropic upstream individually; the
  DebugPanel shows it. If it is red, the indoor loop runs OCR-only and says nothing about
  it beyond the `offline_notice` once.
- **Privacy line you must keep true:** only these sparse frames leave the phone; Tier 0
  video never does; the proxy stores no frames; Anthropic does not retain images past the
  request. Confirm the retention page before the pitch **[verify wording on the day]**.
- **Mock:** `fixtures/vision/*.json` keyed by `question` + `seq`; unknown keys return
  `{ confidence: 0 }`. You must be able to run the whole indoor leg with `EXPO_PUBLIC_MOCK=1`
  and no proxy.

---

## Definition of done

Module (details in `09-PERCEPTION-MODULE.md` §11; these are the gates you are judged on):

- [ ] Module is the only camera client; `react-native-vision-camera` and `expo-camera` absent
- [ ] Runs on the demo phone from `npx expo run:ios --device`; `getStats()` live in DebugPanel; ARKit video format logged
- [ ] COCO detector ≥ 15 fps; depth ≥ 10 fps **[verify build]**; OCR 3 fps indoors; per-profile schedule enforced; thermal `.serious` halves rates
- [ ] STOP fires on recorded curb footage with frame → haptic < 150 ms; < 1 false alert per 5 min of curb footage
- [ ] Signal model v1 on-device with gate, 5-of-8 and onset rule; at +14 h from integration start on held-out local frames: false-WALK precision > 95 %, WALK/HAND recall > 80 % at 10–20 m, parallel confusion < 2 %
- [ ] Every event name, payload and rate limit matches 01 §7; D's replayer consumes the module's own fixture format
- [ ] `snapshotJPEG` returns upright 512 / 640 / 1024 frames without blocking the loop

Indoor:

- [ ] `AISLE_IDENTIFIED` for ≥ 18 of the 20 venue stills, zero wrong-aisle emissions on the full-route video, digits never fuzzy-matched
- [ ] A sign entering view at ≤ 5 m is identified within 3 s at walking pace (2-of-3 at 3 fps) on the replay and live
- [ ] Navigator passes synthetic sequences for: forward, backward, overshoot, mid-store entry, wrong-way flip with side inversion, cross-aisle skip held then accepted, two signs in one frame, 20 s silence → one INFO
- [ ] Pedometer prior drives `keep_going` cadence and the plausibility window; no step count is ever spoken as fact
- [ ] Aisle centring: 0.5 m taped offset reads 0.5 ± 0.1 m; COURSE silent when centred; re-anchored on every cross-aisle turn
- [ ] Obstacle: NEAR + closing → STOP once per 2 s; person / cart → INFO only; wall-approach sequence FAR → MID → NEAR in order on the demo phone
- [ ] Claude called only on no-match / two-match / storefront / scan / hand guidance / user speech; ≤ 1 per 4 s indoors; stale or `< 0.5` results never spoken; camera / user prompts ≤ 1 per 3 s and never during the COURSE buzz
- [ ] Streaming path measured: first spoken word ~1.5 s after the snapshot on the venue Wi-Fi or hotspot; p95 end-to-end < 3 s
- [ ] Item pick-up loop gives up after 8 with `ask_staff`; `touching` → CONFIRM; demoed on the distinctive package or cut without touching the aisle-level path
- [ ] Checkout landmark reached and announced from its sign strings; `afterAisleOrder` matches the real store
- [ ] Store map complete with pinned entrance, sign strings, `sideWhenAscending`, `packageHint`; full-route video, 20 stills and ARKit log delivered to D
- [ ] Whole indoor leg runs with `EXPO_PUBLIC_MOCK=1`, no proxy, no camera
- [ ] No forbidden word (safe, clear, go, cross now, no cars, you can cross) in any string under `src/indoor/`, `src/perception/` or the schema description
