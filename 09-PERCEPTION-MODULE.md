# 09 — PerceptionModule (native Swift, Agent C)

**You own the camera and everything that runs on its frames.** One Swift module, built with
the Expo Modules API on top of ARKit, is the only camera client in the app. It runs the
Tier 0 models on-device, applies every temporal filter, and emits rate-limited events to JS.
Nothing time-critical in Aisle waits on anything outside this module.

**Owns:** `modules/perception/` (Swift + JS bridge), `src/perception/`, `models/`
**Never touches:** `src/core/`, `src/outdoor/`, `src/crossing/`, `src/transition/`, `server/`
**Contract:** event and method names are fixed in `01-SHARED-CONTRACTS.md` §5 and §7.
Change them there first, or not at all.

---

## 1. Purpose and the single-camera-owner rule

iOS allows one `AVCaptureSession` owner. ARKit and `react-native-vision-camera` cannot run
together, and `expo-camera` cannot run beside either. Therefore:

- `react-native-vision-camera` is **not** installed. `expo-camera` is **not** mounted anywhere.
- Every frame consumer (COCO detector, signal model, depth, OCR, segmentation, JPEG
  snapshot for Claude) reads `ARFrame.capturedImage` inside this module.
- JS never sees pixels except through `snapshotJPEG(maxWidth)` (§7).
- The module runs headless: an `ARSession` with a delegate, no `ARSCNView`. The UI shows no
  preview; the blind user does not need one and it saves GPU.

What ARKit buys over a plain capture session: 6-DoF visual-inertial pose (centimetre-level
relative drift, works indoors, no LiDAR needed on any A12+ iPhone), a true-north-aligned
world frame steadier than the raw compass, plane detection, and camera pitch for the
horizon-strip gate. What it costs: ~300–600 lines of Swift, tracking loss in low light /
blank walls, no ultra-wide lens, 20–30 %/h battery.

---

## 2. ARKit configuration

```swift
let config = ARWorldTrackingConfiguration()
config.worldAlignment = .gravityAndHeading     // yaw 0 = true north; needs location services on
config.planeDetection = [.horizontal, .vertical]
config.environmentTexturing = .none
config.isAutoFocusEnabled = true
config.videoFormat = pickVideoFormat()         // see below
session.run(config, options: [.resetTracking, .removeExistingAnchors])
```

- **Video format:** iterate `ARWorldTrackingConfiguration.supportedVideoFormats` and choose
  the lowest-resolution format at 30 fps whose width ≥ 1280 (typically 1280×720@30 or
  1920×1080@30, device-dependent). Never 60 fps: it doubles thermal load and nothing here
  needs it. Log the chosen format to DebugPanel **[verify on the demo phone]**.
- **Orientation:** `capturedImage` is in sensor (landscape-right) orientation. Every Vision
  request receives `.right` for a portrait-held phone; every box emitted to JS is normalized
  to the upright frame. Do the rotation once per pipeline, not per model.
- **Frame pacing:** `session(_:didUpdate frame:)` arrives at 30 Hz. Schedule models by
  frame counter per profile (§3); never queue frames — if a model is busy, drop the frame.
- **Pose out:** `frame.camera.transform` → position (m) and yaw (deg, 0 = north). Body
  heading = yaw − `bodyOffsetDeg` (set from JS after the "walk straight for five seconds"
  calibration). Emit at 10 Hz on `onPose`.
- **Pitch:** `frame.camera.eulerAngles.x` gives tilt directly; use it (not the raw
  accelerometer) for the horizon strip. Horizon row ≈ principal point cy − f·tan(pitch),
  with f and cy from `frame.camera.intrinsics`.
- **Tracking state:** map `ARCamera.trackingState` to `NOT_AVAILABLE | LIMITED | NORMAL` and
  emit on change. On `LIMITED` for > 2 s: keep the detectors running (they do not need
  tracking), freeze the pose-derived lateral offset, and report `source: 'none'` so the
  SensorService falls back to `trueHeading` + dead reckoning. On `NOT_AVAILABLE` for > 5 s:
  `session.run(config, options: [.resetTracking])` once, then emit `NOT_AVAILABLE` and let
  JS say `compass_uncertain` if the compass is also bad.
- **Interruptions** (phone call, backgrounding): `sessionWasInterrupted` → stop model
  scheduling; `sessionInterruptionEnded` → re-run with `.resetTracking`, reset all temporal
  filters (§5), re-arm the signal gate if one was set.
- **Geo tracking:** `ARGeoTrackingConfiguration.checkAvailability(at:)` for the demo
  coordinates during phase 0. If available it gives ~1 m absolute position outdoors
  **[verify: Pittsburgh coverage]**. Not required by anything in this spec; do not build on it.
- **Metric depth:** `sceneDepth` needs LiDAR; the demo phone is non-Pro. Depth Anything
  (§3) covers relative depth; nothing here claims metres from the camera.

---

## 3. Model set, inputs, schedule

All files under `models/` are committed with their licence file. CoreML `.mlpackage`,
compute units `.all` (Neural Engine preferred).

| Model | File | Input | Role |
|---|---|---|---|
| COCO YOLO-nano (YOLO11n or YOLOv8n) | `models/coco-yolo-nano.mlpackage` | 640×640 letterboxed (drop to 416 if fps gate missed) | car, bus, truck, motorcycle, bicycle, person |
| Pedestrian-signal detector v1 | `models/ped-signal-v1.mlpackage` | 640×640 crop of the native-resolution centre band | ped_walk, ped_hand, ped_countdown (trained per `10-CV-TRAINING-TRACK.md`) |
| Depth Anything V2 small | `models/depth-anything-v2-small.mlpackage` | model-native square input (518 px class) **[verify: CoreML build, input size, ms]** | relative depth → obstacles, aisle centring, end-of-aisle wall |
| Walkable-surface segmentation (optional, later) | `models/walkable-seg.mlpackage` | 512×256 class **[verify: export + fps]** | road / sidewalk / wall / building → curb line |
| Apple Vision OCR | (system) `VNRecognizeTextRequest`, `.fast` | upper 40 % band | aisle sign text |

Per-profile schedule (frame counter at 30 Hz; this **is** the thermal schedule):

| Profile | COCO | Signal | Depth | OCR | Segmentation |
|---|---|---|---|---|---|
| IDLE | off | off | off | off | off — session paused |
| OUTDOOR_NAV | 15 fps | off | 10 fps | off | 5–10 fps when enabled |
| APPROACH_CROSSING (also AT_CURB) | 15 fps | 15 fps | 10 fps | off | off |
| CROSSING | 15 fps | 15 fps | 10 fps | off | 5 fps when enabled |
| INDOOR_NAV (also AT_ITEM, CHECKOUT_NAV) | 15 fps (person, cart) | off | 10 fps | 3 fps | off |
| ITEM_PICKUP | 5 fps | off | 5 fps | off | off |

Budget per frame on an A15+ class phone: resize/rotate 2–5 ms, YOLO-nano 10–20 ms on the
ANE, tracker < 2 ms, decision < 1 ms. Depth 30–60 ms **[verify]**. OCR `.fast` on a sparse
band: tens to a few hundred ms, which is why it runs at 3 fps and only indoors. Measure
every one of these on the demo phone in phase 0 and put them in `getStats()`.

Cart is not a COCO class: use the "large moving rectangular object" heuristic (a tall
`person`-adjacent box or a wide low box moving with the person) or a small fine-tune if
`10-CV-TRAINING-TRACK.md` produces one. Label it `cart` in `Detection.cls` either way.

---

## 4. Tracker

IoU association across consecutive detector frames: match when IoU ≥ 0.3, greedy by score;
a track survives 5 missed frames; `trackId` is monotonic per session. Each track keeps a
ring buffer of (timestamp, box) for the last 1 s. The tracker is shared by the vehicle,
person/cart and signal pipelines; it costs < 2 ms.

---

## 5. Post-processing and temporal filters

Every filter's UNKNOWN state produces silence, never a guess. All filters reset on profile
change, session interruption, and `setCrossingBearing(null)`.

### 5.1 Pedestrian signal (APPROACH_CROSSING, AT_CURB, CROSSING)

1. Run only when `setCrossingBearing(deg)` has armed the gate.
2. **Geometric gate**, all three required for a detection to count:
   - body heading within ±20° of the crossing bearing (compass best tier guarantees ±20°);
   - box centre inside the horizon strip (horizon row ± 12 % of frame height, from §2 pitch);
   - among gated boxes take the one nearest the frame centre column; ignore the rest.
   This is the defence against reading the parallel crosswalk's head, the most likely
   dangerous misread.
3. **N-of-M:** per-frame class → ring buffer of 8; emit a state only when ≥ 5 of the last 8
   agree; otherwise UNKNOWN. This also absorbs LED PWM flicker on the rolling shutter.
4. **Onset rule:** track the first non-UNKNOWN state since arming. If it is WALK, emit
   `fresh: false` (JS says "Walk already on — wait for next"). If DONT_WALK → WALK is
   observed, emit WALK with `fresh: true` immediately. COUNTDOWN is always `fresh: false`.
5. Emit `onSignalState {state, fresh, confidence, nOfM}` on change plus a 0.5 Hz heartbeat.
   `confidence` = mean score of the agreeing frames.
6. Ten seconds of UNKNOWN after arming is JS's cue for "Can't see the signal" and the
   fallback ladder; the module just keeps reporting.

### 5.2 Vehicle approach (OUTDOOR_NAV, APPROACH_CROSSING, AT_CURB, CROSSING)

Classes car, bus, truck, motorcycle, bicycle. Fire `onVehicleApproaching` when, on one track:

- box-area growth > 40 % over the last 0.5 s (ratio of area now to area 0.5 s ago > 1.4),
  with bottom-edge descent in the same window as the supporting signal;
- track age ≥ 0.3 s;
- box centre in the lower two-thirds of the upright frame;
- the same track has not fired in the last 4 s;
- the phone's yaw rate over the window < 30°/s (the user is not sweeping the camera —
  turning toward cross traffic makes every parked car "grow").

`direction` from box centre x: < 0.33 LEFT, > 0.67 RIGHT, else CENTER. Payload
`{direction, trackId, growth}`. Frame → event < 100 ms so that JS's STOP lands < 150 ms.
Parked cars (no growth) and flowing cross traffic (little growth, high lateral velocity)
must not fire; if they do on recorded footage, raise the growth threshold before touching
the track age. False-alarm budget: < 1 per 5 minutes of curb footage.

During an unsignalized scan the same pipeline runs at full rate on every frame; JS emits
`SCAN_RESULT {side, vehiclesSeen: 'approaching'}` from this event, `'none'` otherwise.

### 5.3 Obstacles from depth (all moving profiles)

Relative depth from Depth Anything; the centre-bottom cell = centre third × bottom third of
the upright frame. Per depth frame: median relative depth of the cell and its closing rate
over 0.5 s. Emit `onObstacleAhead {distanceClass, direction}` when the cell is NEAR, or MID
and closing faster than the walking-pace rate; ≤ 1 per 2 s. Thresholds for NEAR / MID / FAR
are calibrated per phone in phase 0 by walking at a wall from 4 m (relative depth is
unitless; do not pretend otherwise). Direction from which third of the bottom row is
nearest. JS turns NEAR + closing into STOP and everything else into INFO.

Indoors the same depth map gives aisle centring (floor / shelf boundary asymmetry, left vs
right thirds) → `onLateralOffset {source: 'shelf'}` and the end-of-aisle wall.

### 5.4 Person / cart indoors (INDOOR_NAV and after)

COCO `person` (and `cart` heuristic) with box centre in the lower two-thirds and area above
a size threshold → `onHazard {kind: PERSON_AHEAD | CART_AHEAD, direction}`, ≤ 1 per 3 s. INFO
semantics in JS: the cane already covers it. Never STOP from this pipeline.

### 5.5 OCR (INDOOR_NAV and after)

- `VNRecognizeTextRequest`, `recognitionLevel = .fast`, `usesLanguageCorrection = false`
  ("c001" must not become "cool"), `regionOfInterest` = upper 40 % of the upright frame,
  `minimumTextHeight ≈ 0.02`, `customWords` = the store map's sign vocabulary from
  `setKnownSigns`.
- **Blur gate:** skip the OCR frame when gyro rate over the exposure window exceeds a
  threshold set in phase 0 (motion energy, GLIMPSE-style), or when tracking is LIMITED
  with reason `excessiveMotion`.
- **Normalization** in Swift before emitting: uppercase, strip punctuation, collapse
  whitespace; apply the digit-confusion map (O→0, I/l→1, S→5, B→8, Z→2) only to tokens
  that are otherwise numeric. Emit raw and normalized text with the box.
- Two signs in one frame: emit both; JS takes the larger box. Emit ≤ 3 Hz via `onOcrText`.
- The fuzzy match (edit distance ≤ 2, digits exact) and the 2-of-3 vote live in
  `src/indoor/`, not here — the module reports text; the navigator decides.
- Sign box horizontal offset from centre, smoothed 1 s → `onLateralOffset {source: 'ocr_box'}`.

### 5.6 Drift (OUTDOOR_NAV, CROSSING, INDOOR_NAV)

- `setCourseReference({bearingDeg})` records the current ARKit position as the anchor and
  the bearing as the line. Lateral offset = signed perpendicular distance of the current
  position from that line (+ = right). Emit at 5 Hz, smoothed 1 s, `source: 'pose'`.
  Expected accuracy ±0.05–0.1 m while tracking is NORMAL; frozen (`source: 'none'`) when
  LIMITED.
- When segmentation is enabled, the road/sidewalk boundary's column position gives an
  independent curb-line offset → `source: 'curb'`, ±0.2–0.5 m. The SensorService needs
  two agreeing signals for "toward the road"; this is the second one.
- Phone-to-body offset: heading assumes the phone faces the walking direction. The module
  applies `bodyOffsetDeg` to yaw before any heading comparison (signal gate, drift line).
  A chest mount keeps it stable; a hand-held phone does not, and the JS re-check on
  course/heading disagreement will call `setBodyOffsetDeg` again.

---

## 6. JS events and rate limits (must match 01 §7 exactly)

| Event | Payload | Rate |
|---|---|---|
| `onSignalState` | `{state: WALK\|DONT_WALK\|COUNTDOWN\|UNKNOWN, fresh, confidence, nOfM}` | on change + 0.5 Hz |
| `onVehicleApproaching` | `{direction: LEFT\|CENTER\|RIGHT, trackId, growth}` | ≤ 1 / track / 4 s |
| `onObstacleAhead` | `{distanceClass: NEAR\|MID\|FAR, direction}` | ≤ 1 / 2 s |
| `onHazard` | `{kind: PERSON_AHEAD\|CART_AHEAD, direction}` | ≤ 1 / 3 s |
| `onOcrText` | `OcrRead[]` `{text, box, confidence, timestamp}` | ≤ 3 Hz |
| `onDetections` | `Detection[]` `{cls, box, score, trackId}` | ≤ 5 Hz |
| `onPose` | `{yawDeg, x, y, z, trackingState, timestamp}` | 10 Hz |
| `onLateralOffset` | `{offsetM, source: pose\|ocr_box\|shelf\|curb\|none}` | 5 Hz |
| `onDepth` | `{centerBottomRel, closingRate, timestamp}` | ≤ 5 Hz |
| `onPlanes` | `{floors, verticals}` | 1 Hz |
| `onTrackingState` | `NOT_AVAILABLE\|LIMITED\|NORMAL` | on change |

Methods: `start(profile)`, `setProfile(profile)`, `stop()`, `setCrossingBearing(deg|null)`,
`setCourseReference({bearingDeg}|null)`, `setBodyOffsetDeg(deg)`, `setKnownSigns(words)`,
`snapshotJPEG(maxWidth)`, `getTrackingState()`, `getStats()`. Boxes are normalized 0..1 in
the upright frame. Timestamps are `Date.now()`-comparable milliseconds, converted from
`frame.timestamp` once at session start. Events cross the bridge as plain JSON; keep
`onDetections` ≤ 5 Hz and never send pixels through an event.

---

## 7. `snapshotJPEG(maxWidth)`

- Takes the most recent `capturedImage`, rotates upright, scales the long edge to
  `maxWidth` (512 → 512×384 thumbnail for the default Claude call, 640 → 640×480 when text
  must be read, 1024 only for the curb crop), JPEG quality 0.8 (Anthropic warns heavy
  compression hurts OCR), bakes orientation into pixels (no EXIF reliance), returns
  `{base64, width, height, seq, timestamp}`.
- Never blocks the frame loop: encode on a utility queue; ≤ 2 snapshots in flight; a third
  call returns the latest completed snapshot.
- `curb_crop` variant: JS passes `maxWidth: 1024`; the module crops the horizon strip
  around the frame centre before scaling so a distant signal head keeps its pixels.
- The privacy line for the pitch depends on this method being the only way pixels leave
  the module: keep it that way.

---

## 8. Scaffolding (Expo Modules API) and iOS permissions

1. `npx create-expo-module@latest --local modules/perception` (local module, autolinked; no
   npm publish). Module name `Perception`; JS wrapper `src/perception/PerceptionService.ts`
   implements the `PerceptionService` interface from 01 §7 over `requireNativeModule`.
2. `modules/perception/ios/PerceptionModule.swift`: `Name("Perception")`, `Events(...)` for
   every event in §6, `AsyncFunction("start")`, `Function("setProfile")` etc.,
   `AsyncFunction("snapshotJPEG")`. Keep the ARKit delegate, the scheduler, the tracker and
   each filter in separate files; the module file only wires them.
3. `modules/perception/ios/Perception.podspec`: frameworks ARKit, Vision, CoreML, CoreImage,
   Accelerate; iOS deployment target as the Expo SDK 57 template sets it.
4. Models: copy `models/*.mlpackage` into the pod resources (or reference via a script
   phase); load lazily per profile and unload what the profile does not use.
5. `app.json` → `ios.infoPlist` before the first build (strings are read aloud by iOS; keep
   them honest and short):
   - `NSCameraUsageDescription` — "Aisle reads signs and signals through the camera."
   - `NSLocationWhenInUseUsageDescription` — "Aisle needs your location to guide you."
   - `NSMotionUsageDescription` — "Aisle counts steps to estimate progress."
   - `NSMicrophoneUsageDescription` — "Aisle listens only while you hold the talk button."
   - `NSSpeechRecognitionUsageDescription` — "Aisle turns your request into text on this phone."
   - `NSLocalNetworkUsageDescription` (dev client) — "Development server discovery."
   - `UIRequiredDeviceCapabilities`: `arkit`.
6. Build: `npx expo prebuild` once, then `npx expo run:ios --device`. Native changes ship to
   the Windows user's phone via `eas build --profile development --platform ios`; batch them.
7. `EXPO_PUBLIC_MOCK=1`: `src/perception/PerceptionService.ts` swaps in D's replayer from
   `mocks/`; the native module is never called.

---

## 9. Battery and thermal

Expect noticeable warmth within 10 minutes and 15–25 %/h drain with detector + depth + GPS
+ network **[verify on the demo phone]**; ARKit adds to that (20–30 %/h class). Rules:
detectors every other frame (15 fps) and depth every third (10 fps) are the ceiling, not a
starting point; unload models the profile does not need; pause the session in IDLE; read
`ProcessInfo.thermalState` each second and, at `.serious`, halve every rate and report it in
`getStats().thermalState`; at `.critical`, keep only the profile's safety model (signal or
vehicles) and tell JS. Screen dim, Low Power Mode off (it disables haptics), start every
run above 80 %.

---

## 10. Test plan

Fixtures for Agent D (recorded on the demo phone, phase 0):

- Per demo crossing: 3–5 min of video in both signal states, two times of day, phone at
  chest, tilted up ~10°. Hand-label approaching-vehicle events and signal-state spans.
- Store: one full-route video, phone at chest tilted ~15° up, plus 20 aisle-sign stills.
- ARKit session logs: pose + tracking state + timestamps for one outdoor leg and one aisle
  walk, exported as `fixtures/perception/*.jsonl` by a debug method on this module.

Unit checks per filter (Swift tests, runnable in Xcode without a device where the input is
synthetic):

- Signal gate: synthetic boxes off-strip, off-heading, off-centre are rejected; 4-of-8 is
  UNKNOWN, 5-of-8 emits; onset: WALK-first → `fresh: false`; DONT_WALK→WALK → `fresh: true`.
- Vehicle looming: parked-car track (constant area) never fires; 1.4× area in 0.5 s at age
  0.3 s fires once, then not again for 4 s; yaw-sweep suppression holds.
- Depth: wall-approach sequence crosses FAR → MID → NEAR in order; NEAR + closing once per 2 s.
- OCR normalization: "AISLE 3" / "Aisle3" / "A1SLE 3" → tokens `AISLE`, `3`; `c001` unchanged.
- Drift: straight synthetic pose track yields 0 ± 0.02 m; 0.5 m parallel offset yields 0.5 m.

On-device measurement (DebugPanel, phase 0 and again at integration start): fps per model
per profile, per-stage ms, frame → event latency for STOP and for a signal change (target
< 150 ms end-to-end), surface temperature after 10 minutes, battery per hour. Signal-model
gate at +14 h from integration start: false-WALK precision > 95 %, WALK/HAND recall > 80 %
at 10–20 m, parallel-signal confusion < 2 % after the gate, on-device ≥ 15 fps, all on
held-out local frames.

Live: every filter behaves identically on recorded footage replayed through the mock
`PerceptionService` and on the phone at the venue. If they diverge, the fixture is wrong or
the phone is throttling — find out which before the next run.

---

## 11. Definition of done

- [ ] Module is the only camera client; `react-native-vision-camera` and `expo-camera` absent from `package.json`
- [ ] `npx expo run:ios --device` installs a build on the demo phone with the module running and `getStats()` live in DebugPanel
- [ ] Chosen ARKit video format logged; pose at 10 Hz with yaw within ±20° of `trueHeading` outdoors when both are good
- [ ] Tracking-state handling: LIMITED freezes drift, NOT_AVAILABLE resets once, interruptions reset filters and re-arm
- [ ] COCO detector ≥ 15 fps; STOP fires on recorded curb footage with frame → haptic < 150 ms; < 1 false alert per 5 min
- [ ] Signal model v1 on-device with gate, 5-of-8 and onset rule; measured against the +14 h gate on held-out local frames
- [ ] Depth model runs at 10 fps **[verify build]**; NEAR / MID / FAR calibrated on the demo phone; obstacle event once per 2 s
- [ ] OCR at 3 fps indoors, upper band, language correction off, `customWords` from the store map, blur-gated
- [ ] Pose-derived lateral offset within ±0.1 m on a taped straight line; `bodyOffsetDeg` applied everywhere heading is compared
- [ ] `snapshotJPEG` returns upright 512 / 640 / 1024 frames without blocking the loop; the curb crop keeps the horizon strip
- [ ] Every event name, payload and rate limit matches 01 §7; the mock replayer consumes the module's own fixture format
- [ ] Per-profile schedule enforced; `.serious` thermal state halves rates and is visible in DebugPanel
- [ ] All `app.json` permission strings present before the first build; models and dataset licences committed under `models/`
- [ ] [verify] items closed or downgraded in phase 0: Depth Anything CoreML build and timing, segmentation export (or dropped to heading + dead reckoning only), ARKit geo tracking availability in Pittsburgh (informational)
