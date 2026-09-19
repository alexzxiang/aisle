# 11 — Phase 0 Checklist (everything that must be true before integration starts)

Phase 0 is the work with lead time: toolchain, accounts, venue, data, the demo phone, and the
decisions nobody should be making at 3 a.m. It is done before the build clock in
`08-ROADMAP-AND-CONCERNS.md` starts, because every gate in that roadmap (+6 h, +14 h, +18 h) is
measured from that start. Nothing here is app code.

**Integration start** = hour 0 of the build clock: `src/core/contracts.ts` lands and the four
tracks begin. Under the event rules that is 11:00 ET on 2026-09-19 at the earliest.

**How to read this doc.** Items are ordered by the cost of discovering them late: the first
section can cost a day, the last section costs an argument. Every item has an owner, a way to
verify that leaves evidence (a screenshot, a number, a file), and what changes in the plan if it
fails. "Owner" names a machine and a track (Mac 1 / C, Mac 2 / A, Mac 3 / B, Windows / D) or
"Human lead"; if a track is a coding agent, a named human still owns every checkbox that touches
a phone, a street, a store or an account. Fill in the names table in §8 first.

Machine roles (locked in `08-ROADMAP-AND-CONCERNS.md`): Mac 1 = Agent C, Swift owner of the
`PerceptionModule`; Mac 2 = Agent A, builds the demo phone; Mac 3 = Agent B; Windows = Agent D.

---

## 0. The rule that decides what "done" means

- [ ] **R0. Event rules on pre-written work, in writing.** Owner: Human lead.
  The published rules say work may begin only after 11:00 ET on 9/19 and pre-event code is
  disallowed except open-source libraries [verified from the event page]. Ask the organizers
  (Discord or the check-in desk, and keep the answer) which of these are allowed before 11:00:
  environment setup and a throwaway toolchain spike; accounts and keys; venue notes and
  recorded video; labeled datasets; **trained model weights**; a hosted empty server.
  Verify: the answer is pasted into the team channel with a timestamp.
  If it fails (no definite answer): assume the strict reading. Every phase-0 code artifact is a
  scratch spike in a directory outside the repo, never committed; what carries over is
  knowledge, timings, environment, accounts, data, fixtures and venue notes. Model weights are
  treated as data unless told otherwise; if told otherwise, keep the dataset and the notebook
  and retrain in build hours 1–6 (< 1 h on a T4), which the roadmap already permits.

Everything below is written to survive the strict reading.

---

## 1. Toolchain on the demo phone (a day if it goes wrong)

- [ ] **T1. Xcode on all three Macs.** Owner: each Mac user.
  Verify: `xcodebuild -version` prints a current Xcode; command-line tools selected; CocoaPods
  installed; Node LTS; each Mac has signed in to the paid Apple Developer team in Xcode and can
  run a blank iOS app on a physical iPhone over USB (not the simulator; ARKit and CoreML on the
  Neural Engine do not exist there).
  If it fails on one Mac: that Mac does JS only; the other two build for its phone via USB or
  EAS. If it fails on Mac 1: the Swift owner moves to whichever Mac works. Do not start
  integration with fewer than two Macs that can build to a device.

- [ ] **T2. Throwaway spike: dev build with the `PerceptionModule` scaffold, an ARKit session
  and one CoreML model running on the demo phone.** Owner: Mac 1 / C, on the demo phone.
  This is a rehearsal of `09-PERCEPTION-MODULE.md` §8 steps 1–6 in a scratch directory:
  `create-expo-app` pinned to SDK 57, `expo-dev-client`, `npx create-expo-module@latest --local
  modules/perception`, an `ARWorldTrackingConfiguration` with `worldAlignment =
  .gravityAndHeading`, a stock COCO YOLO-nano `.mlpackage` (`models/coco-yolo-nano.mlpackage`
  shape) run on `capturedImage` at 15 fps, a `getStats()`-style fps and per-stage-ms log, and
  `npx expo prebuild` → `npx expo run:ios --device`.
  Verify: the build installs and launches on the demo phone; the log shows the chosen ARKit
  video format, `trackingState` reaching `NORMAL`, detector fps ≥ 15 with boxes on a parked car,
  and yaw within ±20° of `trueHeading` outdoors. Record: first-build minutes (expect 20–40),
  incremental-build minutes (expect ~2), per-stage ms. Write every command and its timing into
  the team notes so hour 0 of the build is typing, not discovering.
  If it fails: this is R1 in the risk register and the highest-cost failure in the project.
  Time-box two attempts on two Macs; if neither works, integration starts with Track C spending
  its first hours on the toolchain, the +6 h gate slides by the same amount, and the demo plan
  of record becomes fixture replay for perception (`EXPO_PUBLIC_MOCK=1`) until it lands.

- [ ] **T3. EAS internal distribution to the Windows user's iPhone.** Owner: Windows / D, with
  Mac 2 / A for the build.
  Verify: the Windows user's iPhone UDID is registered (`eas device:create`), one `eas build
  --profile development --platform ios` of the spike has completed, the install link opens on
  that phone, and the phone connects to `npx expo start --dev-client` running on the Windows
  machine over the hotspot (§7). Record the EAS queue time: the free plan is one low-priority
  build at a time, 15 iOS builds per month, 90+ minute waits at peak [verified from Expo
  pricing]. Budget the month's builds: native changes are batched, not per commit.
  If it fails: the Windows user develops entirely in mock mode on a Mac-built phone borrowed
  for testing, and one Mac user owns "install the latest native build on every phone" as a
  standing job. If the queue is the problem and the budget allows, the $19 Starter plan buys the
  high-priority queue.

- [ ] **T4. Permission strings and capabilities before the first build.** Owner: Mac 1 / C.
  Verify: `app.json` → `ios.infoPlist` in the spike carries `NSCameraUsageDescription`,
  `NSLocationWhenInUseUsageDescription`, `NSMotionUsageDescription`,
  `NSMicrophoneUsageDescription`, `NSSpeechRecognitionUsageDescription`,
  `NSLocalNetworkUsageDescription`, and `UIRequiredDeviceCapabilities: ["arkit"]`, with the
  exact texts from `09-PERCEPTION-MODULE.md` §8; each prompt appears once on the demo phone and
  is granted; location is "Precise: On". Also verify on the demo phone: `expo-haptics`
  `impactAsync` fires while the ARKit session is running and while the audio mode has
  `allowsRecording: false` (iOS suppresses haptics in a recording category and in Low Power
  Mode).
  If it fails (a missing string crashes at first use of that API): fix and rebuild; it costs
  one build cycle now and a demo later.

- [ ] **T5. SDK 57 pin and the audio layer.** Owner: Mac 2 / A.
  Verify in the spike: `expo@~57` (57.0.23 is current [verified]; SDK 58 has been in beta since
  2026-09-15 and `create-expo-app` must not drift to it), `expo-av` absent from `package.json`,
  `expo-audio` plays a bundled mp3 with `setPlaybackRate` and pitch correction, and the
  direction-beacon panning path works through the chosen headphones. `expo-audio` exposes no
  pan property; prove one of: two looped players (hard-left and hard-right renders of the same
  tick) with a constant-power volume law, or a small native pan in the module. Record which.
  If it fails: the beacon degrades to the pre-rendered set (five to seven pan positions as
  separate files, switched by heading bucket); nothing else changes.

- [ ] **T6. Windows machine ready.** Owner: Windows / D.
  Verify: Node LTS, `eas-cli`, `npx expo login` to the team account, a Metro server the Windows
  user's phone can reach; a Colab notebook opens with a GPU runtime (§5); Overpass and WPRDC
  downloads work from that machine.
  If it fails: the Windows user pairs on a Mac for the proxy and fixtures; the schedule does
  not depend on this machine building anything native.

---

## 2. The five [verify] items (each changes a section of the plan)

- [ ] **V1. Depth Anything V2 small as CoreML on the demo phone.** Owner: Mac 1 / C.
  Verify: obtain Apple's published CoreML build or convert the small model to
  `models/depth-anything-v2-small.mlpackage` **[verify: build source, input size]**; run it in
  the spike on the Neural Engine; record ms per frame at the model-native input and whether
  10 fps holds alongside the 15 fps detector. Walk at a wall from 4 m and note the relative-depth
  values that will become NEAR / MID / FAR.
  If it fails (no build, or > 100 ms): depth is dropped for the event. `OBSTACLE_AHEAD` and
  `onDepth` never fire; indoor aisle centring comes from `onLateralOffset {source: 'ocr_box'}`
  and ARKit pose only; the pitch says the cane covers obstacles. Downgrade the corresponding
  rows in `09-PERCEPTION-MODULE.md` §11 and `04-AGENT-C-perception-indoor.md`.

- [ ] **V2. Walkable-surface segmentation export.** Owner: Mac 1 / C (lowest priority in
  this section; it is marked optional everywhere).
  Verify: a Cityscapes-class road / sidewalk / wall model exports to
  `models/walkable-seg.mlpackage` at the 512×256 class and runs at ≥ 5 fps **[verify: model,
  export, fps]**.
  If it fails: `onLateralOffset {source: 'curb'}` is never emitted. "Toward the road" still
  needs two agreeing signals; they are heading error and GPS cross-track (`CourseError` in
  `01-SHARED-CONTRACTS.md` §2). Nothing else changes. Do not spend more than two hours here.

- [ ] **V3. US-convention pedestrian-signal datasets.** Owner: Windows / D (CV track), per
  `10-CV-TRAINING-TRACK.md`.
  Verify: candidate Roboflow Universe pedestrian-signal / crosswalk-signal projects downloaded;
  licence of each recorded in the repo's dataset licence file; classes mapped to `ped_walk`,
  `ped_hand`, `ped_countdown`; image counts per class written down; ImVisible / LYTNet excluded
  (red/green non-US heads) **[verify: specific projects and licences]**.
  If it fails (nothing usable or licence-blocked): the model trains on local frames only
  (§5 D1), the expected recall drops, and the fallback ladder's rung 2 (Sonnet 5 curb crop)
  or rung 3 (alignment + map awareness, no state claim) becomes the plan of record for the demo
  script now, not at +14 h.

- [ ] **V4. Exact dev-build package versions for SDK 57.** Owner: Mac 2 / A.
  Verify: `npx expo install --check` is clean in the spike with this set: `expo@~57.0.23`,
  `expo-audio ~57.0.5`, `expo-haptics ~57.0.3`, `expo-location ~57.0.18`, `expo-sensors
  ~57.0.3`, `expo-speech ~57.0.3`, `expo-file-system ~57.0.7`, `expo-keep-awake ~57.0.2`,
  `react-native 0.86.3` [verified from the SDK 57 bundled-modules list]; plus `expo-dev-client`,
  `expo-modules-core`, `zustand`, and the on-device STT package (`expo-speech-recognition`
  57.1.0 is the maintained option; `@react-native-voice/voice` is archived) **[verify: the
  dev-client, modules-core and STT versions resolve on SDK 57]**. `react-native-vision-camera`
  and `expo-camera` are not installed. Record the final `package.json` in the team notes.
  If one package fails: replace or drop that feature, never bump the SDK. STT failing moves
  voice input to ElevenLabs Scribe via `POST /api/stt`, then to keyboard dictation.

- [ ] **V5. ARKit geo tracking in Pittsburgh.** Owner: Mac 1 / C. Informational.
  Verify: in the spike, `ARGeoTrackingConfiguration.checkAvailability(at:)` for the store
  entrance and the crossing coordinates; record the boolean **[verify: coverage]**.
  If it fails: nothing changes; `09-PERCEPTION-MODULE.md` §2 does not build on it. If it
  succeeds, note it as a phase-3 option only.

---

## 3. Accounts and quotas (days if a verification step bites)

Store every key in the team password manager and as environment variables on the proxy host
(§7): `ANTHROPIC_API_KEY`, `NVIDIA_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`,
`GOOGLE_MAPS_API_KEY`, plus the OpenRouter key. Never in the app bundle.

- [ ] **A1. NVIDIA NIM — first, because it can take days.** Owner: Mac 3 / B.
  New build.nvidia.com keys have been hitting "Please contact support to verify your account",
  resolved only by email, sometimes over days [verified from NVIDIA forum reports June–Sept
  2026]. Verify: a key exists; authenticated `GET /v1/models` lists
  `nvidia/nemotron-3.5-lightning-30b-a3b` (copy the exact id; spelling varies by surface) and
  a fallback `nemotron-nano-3` id; one `curl` to chat completions with `chat_template_kwargs:
  {enable_thinking: false}`, `nvext: {guided_json: <a PlannerJob schema>}`, `stream: true`
  returns schema-valid JSON with no thinking tokens; record TTFT over five calls. Also: an
  OpenRouter key and confirmation the same model is listed there **[verify]**. Put the
  Nemotron AMA (Saturday afternoon) on Agent B's calendar for the rate-limit question.
  If it fails: Tier 2 runs on OpenRouter only, or on the deterministic templates in
  `01-SHARED-CONTRACTS.md` §9 with `fallback: true`. The sponsor-track evidence page then
  documents the failure, which the track brief explicitly accepts.

- [ ] **A2. Anthropic.** Owner: Windows / D.
  Verify: org and key; a `curl` to `claude-haiku-4-5` and to `claude-sonnet-5` (with
  `thinking: {type: 'disabled'}`) using `output_config.format` / `json_schema` and one
  512×384 image returns valid JSON; Console shows the tier (new orgs may sit in the Evaluation
  tier with limits below Start; Start is 1,000 RPM per model [verified]) and a spend cap that
  will not trip during rehearsals. Run real traffic in phase 0 so the tier settles.
  If it fails: Tier 1 is off; storefront and aisle disambiguation degrade to OCR + map only;
  unsignalized scans report from the detector alone ("Can't see well" when it is dark).

- [ ] **A3. ElevenLabs.** Owner: Mac 2 / A.
  Verify: the SteelHacks Creator-month perk redeemed on the account that holds the API key
  (131k credits, Flash concurrency 10 instead of 4, commercial licence) [verified from the
  track page]; voice chosen and `ELEVENLABS_VOICE_ID` recorded; one `eleven_flash_v2_5`
  request and one `scribe_v2` transcription succeed; an attribution line drafted for the
  README regardless of plan. Do not generate the phrase cache yet if R0 says audio assets are
  app work; do audition the voice with three phrases including one with a number written as
  words.
  If it fails: `expo-speech` speaks everything; the cache keys in `01-SHARED-CONTRACTS.md` §3
  are unchanged; the track entry weakens but the demo does not.

- [ ] **A4. Google Maps Platform.** Owner: Mac 3 / B.
  Verify: a fresh GCP project with billing; **Routes API** enabled (the legacy Directions API
  cannot be enabled in new projects [verified]); Places API (New) enabled; one `computeRoutes`
  WALK call with a field mask from the demo start point to the store returns steps with
  `maneuver` and plain-text instructions; the key is restricted to those APIs. Check whether
  Places returns `entrances` for the chosen store (added August 2026, Pro SKU, coverage
  unknown) — informational; the entrance is pinned by hand regardless (S3). Note that
  Google's instruction strings are never sent verbatim to TTS; leg phrases come from
  `routeCompile` or its template.
  If it fails: the demo route is fetched once on a working key and stored as a fixture; the
  outdoor leg is replayed (already the last-but-one rung of the cut order).

- [ ] **A5. Apple Developer and devices.** Owner: Mac 2 / A.
  Verify: all iPhones that will ever run the app are registered on the team (three Mac users',
  the Windows user's, the demo phone, one backup); bundle identifier chosen; a development
  build signs on each Mac without prompts. With the paid team the 7-day expiry in the risk
  register (R24) does not apply, but re-run the build the morning of anyway.
  If it fails: fewer phones; the demo phone and the backup are the only two that matter.

- [ ] **A6. Expo / EAS.** Owner: Windows / D.
  Verify: one team Expo account or organization; every developer `npx expo login` to it; the
  T3 build exists in the EAS dashboard.

- [ ] **A7. Colab.** Owner: Windows / D.
  Verify: a notebook starts a T4 (or better) runtime; `ultralytics` trains one epoch on a toy
  set and exports a CoreML `.mlpackage`; the export loads in Xcode on Mac 1.
  If it fails: train on a Mac (MPS, slower) or use any other free GPU; if no GPU at all, the
  signal model moves to the fallback ladder as plan of record (see V3).

- [ ] **A8. Open data.** Owner: Mac 3 / B.
  Verify: the WPRDC City of Pittsburgh Signalized Intersections CSV downloaded (783 rows;
  `operation_type` present; Fixed = 357) [verified]; an Overpass query for `highway=crossing`
  nodes in the route bbox returns results and is saved (a check near 40.4443,-79.9436 returned
  15 nodes within 200 m, 3 `button_operated=yes` [verified 2026-09-16]).

---

## 4. Venue (needs daylight and two visits; cannot be done at the event)

- [ ] **S1. Store chosen, manager asked.** Owner: Human lead.
  Criteria: overhead or end-cap aisle signs with readable text; an entrance within ~150 m of a
  fixed-time signalized crossing (S4); open during rehearsal hours and Sunday morning;
  walking distance from Posvar Hall. Forbes Street Market is across the street from the
  opening ceremony and is the obvious first candidate [verified from event logistics]; a campus
  market is the backup (R21). Verify: the manager has been asked about filming and a short
  Sunday demo, and the answer is written down; closing hours noted.
  If it fails (refused): backup venue mapped the same day; nothing else changes.

- [ ] **S2. Sign strings, order, checkout signage.** Owner: Human lead, with Mac 1 / C.
  Verify: every aisle's exact sign text as printed (case, digits, words), its `order`, side
  conventions for the target items (`sideWhenAscending`), checkout signage text, sign height,
  lighting notes, and 20 aisle-sign stills from chest height tilted ~15° up. Read signs from
  the cross-aisle at 3–6 m and note whether digits are legible from there in the stills. This
  is the input to `fixtures/stores/<storeId>.json` (schema in `01-SHARED-CONTRACTS.md` §6).
  If it fails (signs unreadable or absent): pick another store; the indoor leg is never cut.

- [ ] **S3. Entrance pinned.** Owner: Human lead.
  Verify: stand at the door with the demo phone, average 30 s of GPS fixes with accuracy
  ≤ 10 m, record `{lat, lng, radiusM: 35, pinnedBy: "venue-walk", pinnedAt}`. Do not use the
  Places centroid (50–100 m off for a big store). Also log the walk-in: GPS accuracy, course and
  speed from 40 m outside to 20 m inside, so `fixtures/track.json` reproduces the real entry
  lag.
  If it fails (no fix under 10 m at the door): take the median of a longer log and widen
  `radiusM`; the transition detector's manual `forceEnter()` is always wired anyway.

- [ ] **S4. Fixed-time signalized crossing chosen from WPRDC.** Owner: Mac 3 / B with Human lead.
  Verify: `operation_type = Fixed` in the WPRDC data, within ~150 m of the entrance, on the
  walking route, a pedestrian head visible from the near curb at 10–20 m, and the crossing
  bearing computed from the OSM crossing geometry and checked against a compass on site.
  Record the WALK interval length with a stopwatch across three cycles. If the nearest
  candidate is actuated, note the push button and prefer the next fixed one.
  If it fails (no fixed-time crossing near any acceptable store): demo at an actuated one with
  "Push button likely" in the script, and rehearse the button press with the spotter.

- [ ] **S5. Crossing video captured.** Owner: Human lead with Mac 1 / C, demo phone, chest
  mount, tilt ~10° up.
  Verify: 3–5 minutes per crossing in both signal states, at two times of day (one at the
  planned demo hour), plus 5 minutes of curb footage with vehicles passing and at least three
  vehicles approaching the camera; a second crossing if time allows. Hand-label signal-state
  spans and approaching-vehicle events (timestamps) the same day. These become
  `fixtures/perception/*.jsonl` inputs and the +6 h STOP test.
  If it fails (weather, no time): the +6 h gate cannot be run on real footage; use the
  public-dataset footage from V3 (§2) for STOP tuning and treat local frames as a +8 h task.

- [ ] **S6. Store route video.** Owner: Human lead with Mac 1 / C.
  Verify: one continuous walk from the door to the target aisle to checkout, chest height,
  tilted ~15° up, with the cane hand simulated; a second pass entering mid-store.

- [ ] **S7. Judging spot checked.** Owner: Human lead.
  Verify: cell signal on the demo phone at the expo location in Posvar Hall (the live demo
  falls back to fixtures if there is none); an outlet; where the judge will stand to feel the
  haptics.

---

## 5. Data and signal model v1, with numbers (see `10-CV-TRAINING-TRACK.md` for the procedure)

- [ ] **D1. Local frames labeled.** Owner: Windows / D.
  Verify: 100–300 frames per demo crossing extracted from S5, both states, both times of day;
  VLM first pass, hand-corrected; one time-of-day or one crossing held out and never trained
  on; class counts written down; dataset licence file started.
  If it fails: see V3 in §2 — the ladder moves up a rung now.

- [ ] **D2. Signal model v1 trained and on the demo phone.** Owner: Windows / D trains;
  Mac 1 / C runs it.
  Verify: YOLO11n or YOLOv8n at 640 px, ~50 epochs on Colab (< 1 h), exported to
  `models/ped-signal-v1.mlpackage`; in the spike it runs ≥ 15 fps on the centre band; on the
  held-out local frames record false-WALK precision, WALK/HAND recall at 10–20 m, and
  parallel-signal confusion. The gate values (> 95 %, > 80 %, < 2 %) are for +14 h; the
  phase-0 number tells you which rung is the plan of record on day one. Subject to R0.
  If it fails: the demo script is written for rung 2 or 3 from the start; the model keeps
  training in build hours 1–6 on the same notebook.

- [ ] **D3. Fixtures staged.** Owner: Windows / D.
  Verify: raw material for `fixtures/track.json` (S3 log), `fixtures/frames/<seq>.jpg` (S2
  stills, S5 frames), the crossing videos and labels, and the store JSON draft exist in a
  shared folder, ready to be committed at hour 0.

- [ ] **D4. Licences.** Owner: Windows / D.
  Verify: one file listing every dataset, model weight and its licence, ready for `models/`.

**Numbers to record in phase 0** (all measured on the demo phone; targets from
`01-SHARED-CONTRACTS.md` §11 and `09-PERCEPTION-MODULE.md`):

| Measurement | Target | Measured | Where it matters |
|---|---|---|---|
| ARKit video format chosen | ≥ 1280 wide @ 30 fps | | `09` §2 |
| COCO detector fps / ms per frame | ≥ 15 fps; 10–20 ms | | +6 h gate |
| Signal model fps on centre band | ≥ 15 fps | | +14 h gate |
| Depth ms per frame / fps | 30–60 ms; 10 fps **[verify]** | | V1 |
| OCR `.fast` ms on upper band | fits 3 fps | | indoor loop |
| First native build / incremental build | 20–40 min / ~2 min | | hour 0 |
| EAS build queue + build time | note | | T3 |
| Battery drain per hour, all models on | 15–25 %/h expected **[verify]** | | R15 |
| Warm to the touch after | ~10 min expected | | R28 |
| Signal v1 precision / recall / confusion (held-out) | > 95 % / > 80 % / < 2 % | | plan of record |
| Nemotron TTFT (5 calls) | < 1.5 s | | A1 |
| Claude Haiku end-to-end, 512×384 + schema | ~2–2.5 s | | A2 |
| Hotspot round trip phone → proxy host | note | | §7 |

---

## 6. Demo phone chosen and configured

- [ ] **P1. Demo phone named.** Owner: Human lead. The newest non-Pro iPhone on the team,
  A15 or later preferred (any A12+ runs ARKit; A15+ gives Neural Engine headroom); LiDAR not
  required. Record model, chip, iOS version, free storage (> 5 GB), and whose it is. A backup
  phone is named too and gets the same build.

- [ ] **P2. Settings.** Owner: phone owner, checked by Mac 2 / A.
  Keep-awake is the app's job (`useKeepAwake`), but set Auto-Lock to Never as a backstop;
  Guided Access enabled (Settings → Accessibility → Guided Access, triple-click side button) so
  a chest-mounted screen ignores touches; Low Power Mode off (it disables haptics); System
  Haptics on; a Focus mode that silences calls (a call interrupts the ARKit session);
  brightness low; Precise Location on for the app; Bluetooth paired to the demo headphones;
  Wi-Fi Assist irrelevant because the phone is the hotspot.

- [ ] **P3. Mount and headphones in hand.** Owner: Human lead.
  Verify: a chest mount or lanyard holds the phone in portrait at sternum height, back camera
  forward, tilt adjustable to ~10° (street) and ~15° (store); an aisle sign lands in the upper
  40 % of the frame from the cross-aisle; a signal head lands in the horizon strip from the
  curb; the four haptic patterns are distinguishable through the mount, not a pocket.
  Open-ear or bone-conduction headphones for the operator; a wired pair for the judge to hear
  the demo (the ElevenLabs track asks for "a demo we can hear"). Bluetooth adds 150–250 ms;
  urgent cues stay haptic.
  If it fails (no mount): hand-held at chest height with the body-offset calibration
  re-checked often; buy a mount before Saturday anyway.

- [ ] **P4. VoiceOver pass planned.** Owner: Mac 2 / A. Verify the spike's blank screen is
  navigable with VoiceOver on so the integration-phase pass is not the first time anyone has
  tried it.

---

## 7. Connectivity plan

- [ ] **C1. Proxy host ready in us-east, not the laptop.** Owner: Windows / D.
  Verify: an account on the chosen host; a placeholder deploy answers an HTTP GET from the demo
  phone over cellular; the five keys are set as environment variables there; the region is
  us-east. The real `server/` routes (`/api/vision`, `/api/plan`, `/api/tts`, `/api/stt`,
  `/api/route`, `/api/health`) are phase-1 code; the host and its deploy command are not.
  If it fails: the proxy runs on the Windows machine tethered to the hotspot and is reachable
  only over the LAN; Tier 1 latency rises; note it in the run-of-show.

- [ ] **C2. Hotspot path tested.** Owner: Windows / D with Mac 2 / A.
  Verify: the demo phone's hotspot up; Mac 2 and the Windows machine joined; `npx expo start
  --dev-client` on each reaches its phone; the phone keeps cellular for the APIs; the round trip
  phone → proxy host measured (table in §5). Hackathon Wi-Fi is assumed hostile (R17).
  If it fails (carrier blocks tethering): a second phone or a laptop hotspot; `--tunnel` as the
  last resort with slower reloads.

- [ ] **C3. Route coverage.** Owner: Human lead. Cell signal along the demo route, at the curb
  and inside the store on the demo carrier; note dead spots. Tier 0 and cached speech do not
  need network; the "Offline" notice path is rehearsed in phase 2.

- [ ] **C4. Offline replay proven on the spike.** Owner: Windows / D. Airplane mode on a
  running dev build keeps the JS bundle alive; a reload does not. The rehearsal rule "never
  shake or reload during the offline demo" is written into the run-of-show.

---

## 8. Team decisions recorded (in the team channel, with names, before the clock)

- [ ] **N1. Swift owner named** (Mac 1). This decides the camera owner (R29) and cannot wait.
- [ ] **N2. Agents A–D: humans or coding agents?** If any track is a coding agent, the human
  who owns its phone, venue, model-training and haptic-feel checkboxes is named here.
- [ ] **N3. Demo roles:** operator (wears the phone), narrator (never the operator), sighted
  spotter at the crossing, override hand on DebugPanel (`setManualSignal`, `forceEnter()`),
  timekeeper. Four people minimum for the live crossing beat; if fewer, the crossing is
  replayed from fixtures and only the store is live.
- [ ] **N4. Store and crossing chosen** (S1, S4) and the demo clock re-timed to the distance
  between them (~90 s outdoor of a 150 s demo, or replay the walk-up).
- [ ] **N5. Who has trained and exported a YOLO model before?** If nobody, the fallback ladder
  is the plan of record and D2 is an upside, not a dependency.
- [ ] **N6. Blind or low-vision tester:** available for a 10-minute indoor session with an O&M
  professional or sighted guide, or not. Never at a live crossing during the event.
- [ ] **N7. Cut order confirmed now:** voice input → live Nemotron (keep cached) → vehicle
  warnings → live signal model (keep alignment + map awareness + manual) → outdoor leg live →
  transition live. Never cut: indoor aisle guidance, the handoff announcement, haptic
  onboarding, the disclaimer.
- [ ] **N8. R0 answer recorded** and the spike directory location agreed (outside the repo).

Names table (fill in):

| Role | Name | Machine / phone |
|---|---|---|
| Swift owner (Agent C) | | Mac 1 |
| Core / demo-phone builder (Agent A) | | Mac 2 |
| Outdoor + crossing (Agent B) | | Mac 3 |
| Proxy / harness / CV track (Agent D) | | Windows |
| Demo phone owner | | model, chip, iOS |
| Operator | | |
| Narrator | | |
| Spotter | | |
| Override hand | | |
| Venue lead (store, manager, filming) | | |

---

## 9. Go / no-go for starting integration

Thirty minutes before the build clock starts, the Human lead reads this list aloud; each owner
answers GO, DEGRADE or NO-GO for their items with the evidence in hand. No item may be "in
progress" at the start: it is either done, or its failure branch is the plan.

**Blocking — integration does not start on the full plan without these:**

1. T2: a dev build with the `PerceptionModule` scaffold, an ARKit session and one CoreML model
   has run on the demo phone, with fps and build times recorded.
2. T3: the Windows user's phone has installed an EAS internal-distribution build once.
3. T4 and T5: permission strings verified; `expo@~57` pinned; `expo-av` absent; `expo-audio`
   plays and pans.
4. A2, A3, A4, A5: Anthropic, ElevenLabs, Google and Apple accounts work from a `curl` or a
   signed build. (A1 NVIDIA is DEGRADE-class: templates and OpenRouter exist.)
5. S1–S3: store chosen, manager asked, sign strings recorded, entrance pinned.
6. S4–S5: crossing chosen; at least one session of crossing and curb video captured and
   labeled.
7. P1–P3: demo phone named and configured; mount and headphones in hand.
8. C1–C2: proxy host answers from the phone over cellular; hotspot path tested.
9. N1–N3, N8: Swift owner, human-per-checkbox, demo roles, and the rules answer recorded.

**Degradable — start, with the fallback written into the run-of-show before the clock:**
D1–D2 signal data and model (→ rung 2 or 3 is the plan of record), V1 depth (→ no
`OBSTACLE_AHEAD`), V2 segmentation (→ no curb line), A1 NIM (→ templates + OpenRouter), V4
STT package (→ Scribe → keyboard dictation), A7 Colab (→ any GPU or no model), V5 geo
tracking (informational), C3 coverage (→ fixtures at dead spots), N6 tester (→ honest "not
yet" in the pitch).

**The rule.** If every blocking item is GO, start the clock and the gates in
`08-ROADMAP-AND-CONCERNS.md` stand as written. If any blocking item is NO-GO and the event
clock forces a start anyway, the first hours of the owning track go to that item alone, the
+6 h and +14 h gates slide by the time it takes, and that time comes out of phase-3 polish, not
out of the cut line: the +18 h cut still happens at +18 h. Two or more blocking NO-GOs in §1 or
§4 mean the demo plan of record is fixture replay for perception and the outdoor leg, with
only the store live, decided at the start and not revisited until the +14 h gate passes. Nobody
argues any of this at the +18 h cut line; it was decided here.
