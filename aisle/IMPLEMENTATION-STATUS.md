# Aisle — Implementation Status

Written 2026-09-18 (evening before hacking opens) from the four track reports, the integration
report, and a fresh scan and test run of this checkout; refreshed the same day after the reviewer
round (commits `2d8dc4b` … `577fe25`, see §7). It is meant to be blunt. Read it before the
phase-0 go/no-go in `../11-PHASE-0-CHECKLIST.md` §9.

**One-paragraph summary.** Every subsystem in `00-PROJECT-BRIEF.md` exists as code, typechecks,
and passes its tests (60 Jest suites / 906 tests; 14 vitest files / 140 tests; the phrase and
dependency lints pass; the Swift engine typechecks against the iPhoneOS SDK). A walking-skeleton
test now drives the whole 01 §1 mode sequence, IDLE to DONE, through `composeApp` on D's replayers
— under Jest fake timers, on synthetic fixtures, not on a phone. None of it has ever run on a
phone, against a real API, at the venue, or with a trained model. The Swift `PerceptionModule` first compiled under Xcode on 2026-09-18 (unsigned arm64 device build, 0 errors; `libPerception.a` built and registered in `ExpoModulesProvider.swift`) but has still never run on a phone. There are
zero model weights, zero cached ElevenLabs phrases, zero API keys, zero real recordings, and the
store and crossing fixtures carry invented coordinates. The proxy is not hosted anywhere. What
the team has is a complete, well-tested **mock-mode** application and a complete but **unproven**
live path. The working tree is committed (HEAD `577fe25`); 19 of the reviewer's 20 issues are
closed in code; the 20th (empty phrase cache, G9/G39) closed on 2026-09-18 once the ElevenLabs key was available (`d62a026`).

Status words used below: **Implemented** = real code path, tested, nothing known missing in the
code; **Partial** = real code path with a named hole; **Stub** = interface and scaffolding, no
working behaviour; **Not started** = nothing usable. "Implemented" never means "verified on a
device" — see §5.

---

## 1. Keystone features (from `00-PROJECT-BRIEF.md`)

| # | Feature | Status | Where | What remains |
|---|---|---|---|---|
| 1 | Contracts, event bus, state machine, service registry, composition root | Implemented | `src/core/contracts.ts`, `bus.ts`, `store.ts`, `services.ts`, `composeApp.ts`, `trip.ts`, `App.tsx` | Nothing in code. `App.tsx` itself has no Jest test (it imports expo backends); the graph is covered by `composeApp.test.ts` with fakes. |
| 2 | Outdoor navigation (Routes fetch, legs, turns, re-plan, beacon target) | Implemented | `src/outdoor/*`, `server/routes/route.ts`, `server/routes/crossings.ts`, `server/data/` | Never fetched a live route: no `GOOGLE_MAPS_API_KEY`; the Forbes/Bouquet `computeRoutes` fixture is **hand-authored from the documented shape, not captured**. Overpass never called live. Google Maps ToS question on speaking street names unresolved (Mapbox is the drop-in). |
| 3 | Signalized crossing (align, read signal, ticker, far-curb beacon, onset rule) | Partial | `src/crossing/CrossingController.ts`, `crossingLogic.ts`, `src/core/audio.ts` | Controller logic is complete and tested on synthetic events; since the review the crossing start is pose-first (> 1.5 m along the bearing with NORMAL tracking; ≥ 4 steps only as the no-pose fallback, suppressed during a scan window and when heading is > 45° off), and curb → far curb runs end to end in Jest (`src/walkingSkeleton.test.ts`, `mocks/endToEnd.test.ts`) on synthetic 10 Hz poses. Rung 1 (on-device signal model) **does not exist** — no `ped-signal-v1.mlpackage`. Today the ladder starts at rung 2 (Sonnet curb crop, itself never called live) and realistically at rung 3/4 (alignment + map awareness + `setManualSignal`). Near/far curb positions and bearing unverified at any real crossing. |
| 4 | Unsignalized crossing (scan left/right, worst-of report) | Partial | `src/crossing/CrossingController.ts`, `crossingLogic.ts` | Same dependency: the detector that feeds `SCAN_RESULT` has no weights and has never run. Claude side of the scan never called live. The scan window now races snapshot + Claude against the 3 s freshness budget; the report is paced 1.5 s per line and flushed on step-off, but it stays at CRITICAL (class `scan`, the one non-hazard class A's policy admits) — reviewer #8 asked for it off CRITICAL, B kept it because NAV is newest-wins and would drop the middle line. Never heard at a real crossing. |
| 5 | Vehicle warnings (looming tracker → STOP + phrase) | Partial | `modules/perception/ios/Engine/VehicleTracker.swift`, `src/perception/PerceptionService.ts` (`bindPerceptionToApp`), `src/crossing/VehicleAlert.ts` | Tracker is written and passes 94 synthetic checks on macOS; never compiled for iOS, never run on footage; COCO weights absent. `VehicleAlert` (B) is deliberately **not constructed** because it would double every STOP — B must strip play/say from it. Frame → haptic < 150 ms unmeasured. False-alarm budget unmeasured. **Update 2026-09-18:** `coco-yolo-nano` (YOLO11n COCO, validated on a reference image) and `depth-anything-v2-small` (Apple CoreML, Apache-2.0) are installed under `models/` and bundled by `plugins/withCoreMLModels.js`; an unsigned arm64 build contains both compiled `.mlmodelc` files (5.3 MB + 48 MB) plus manifests. Still missing: `ped-signal-v1` (needs crossing data + training). |
| 6 | PerceptionModule (ARKit, Vision OCR, CoreML registry, thermal, snapshot, JS bridge) | Partial | `modules/perception/ios/**`, `modules/perception/index.ts`, `expo-module.config.json`, `Perception.podspec` | Engine files typecheck with `swiftc -typecheck` against the iPhoneOS SDK; `PerceptionModule.swift` (the Expo wrapper) has **never been compiled** — this Mac has the iOS 26.5 SDK headers but no installed iOS platform, so `xcodebuild` exits 70. Autolinking and `pod install` succeed (Perception pod linked after two fixes: deployment target 17.0, relative podspec resource paths). Whether CocoaPods compiles a resource `.mlpackage` to `.mlmodelc` is unconfirmed. Horizon-row sign convention, depth thresholds, OCR box scale are uncalibrated guesses. **Update 2026-09-18:** `coco-yolo-nano` (YOLO11n COCO, validated on a reference image) and `depth-anything-v2-small` (Apple CoreML, Apache-2.0) are installed under `models/` and bundled by `plugins/withCoreMLModels.js`; an unsigned arm64 build contains both compiled `.mlmodelc` files (5.3 MB + 48 MB) plus manifests. Still missing: `ped-signal-v1` (needs crossing data + training). |
| 7 | CoreML models (COCO nano, ped-signal-v1, Depth Anything V2 small, optional walkable-seg) | Partial | `models/README.md`, `manifest.json`, `LICENSES.md` only | **No weights of any kind.** Without them every model-driven stream (`onDetections`, `onVehicleApproaching`, `onSignalState` from the model, `onDepth`, `onObstacleAhead`) is silent; only ARKit pose and Vision OCR would work. Depth Anything CoreML build not located; licence unverified. **Update 2026-09-18:** `coco-yolo-nano` and `depth-anything-v2-small` present, validated, and bundled (verified in an arm64 build); `ped-signal-v1` not started (needs crossing data + training); `walkable-seg` optional. |
| 8 | Indoor OCR matcher, navigator, centring, obstacles, checkout, item pickup | Implemented | `src/indoor/*` | Pure JS is complete and tested against all 04 edge cases. Depends on Vision OCR from the uncompiled module; never read a real sign. Claude `aisle_disambiguate` path never called live. |
| 9 | Transition (store-entry handoff, five-signal fusion, forceEnter, announcement) | Implemented | `src/transition/TransitionDetector.ts`, `announce.ts`, `src/core/trip.ts` | Tuned and tested only on the synthetic `fixtures/track.json` entry profile. Never fired on a real door. |
| 10 | Speech: two-tier ElevenLabs (cached phrases + live/streamed) with expo-speech fallback | Partial | `src/core/speech.ts`, `speechBackend.ts`, `phrases.ts`, `scripts/generate-audio.ts`, `assets/audio/manifest.ts`, `server/routes/tts.ts`, `server/lib/elevenlabs.ts` | `AUDIO_MANIFEST` now holds all 65 phrases (closed 2026-09-18, `d62a026`); the disclaimer, onboarding and every curb/vehicle phrase play from bundled mp3. Tier-1 streamed speech is **disabled** (`STREAMED_SPEECH_RELAY_AVAILABLE = false`): A's player fetches `GET /api/tts/stream/<id>`, D's proxy only relays audio as binary WebSocket frames — the two halves do not meet. Live TTS first-audio < 400 ms and cached < 50 ms unmeasured. Since the review `say()` with a phrase-table key speaks `PHRASES[key]` (mismatched caller text throws in dev, is replaced and reported in prod), CRITICAL bypasses the mode table only for `always` / `vehicle` / `obstacle` / `scan`, cooldowns arm only on an accepted enqueue, and the disclaimer has one owner (`OnboardingScreen`). None of that puts an mp3 in the bundle. |
| 11 | Voice input (push-to-talk, on-device STT, Scribe fallback, keyboard) | Implemented | `src/core/voice.ts`, `src/ui/TalkButton.tsx`, `server/routes/stt.ts` | Never exercised with a microphone. Push-to-talk clips are now persisted only when Scribe upload is configured and deleted after use (was: every clip kept forever). No live partial transcript (no `onPartial`). Volume-button PTT cut (no API). Keyboard path is planner-free by design. |
| 12 | Nemotron planner jobs (routeCompile, parseIntent, disambiguate, crossingAnnounce, answer) + eval | Partial | `src/outdoor/plannerJobs.ts`, `planner.ts`, `server/routes/plan.ts`, `plan.eval.ts`, `plan.eval.md`, `server/lib/nim.ts`, `deadline.ts` | Code is complete with validators and deterministic templates. **Never called NIM.** Model id `nvidia/nemotron-3.5-lightning-30b-a3b` is a guess to be read from `/v1/models`; `nvext.guided_json` acceptance unverified. `plan.eval.md` is a **template-only run** (model column `n/a`, human rating column empty). The sponsor-track "evidence" currently proves the fallback works, not Nemotron. **Update 2026-09-18 (live):** with the NVIDIA key, the hosted endpoint rejects `nvext.guided_json` (400) and stalls on streaming, so `server/lib/nim.ts` now uses non-streaming `json_object` + schema-in-prompt; parseIntent / disambiguate / crossingAnnounce answer from Nemotron in 0.4–1.9 s, routeCompile ~4 s (occasional 8 s deadline miss → template), answer validated (template when a reply breaks the digits / 12-word rule). |
| 13 | Claude semantic vision (Tier 1: storefront, aisle disambiguation, scan stills, curb crop, hand guidance) | Partial | `src/perception/semanticVision.ts`, `server/routes/vision.ts`, `server/ws/visionSocket.ts`, `server/lib/anthropic.ts`, `server/schemas/vision.ts`, `server/prompts/vision.ts` | HTTP path wired and used; WS path built and tested against fakes but never opened by the app (see #10). Never called Anthropic; structured-output schema, Haiku 4.5 / Sonnet 5 ids, thinking-disabled param unverified live. p95 < 3 s unmeasured. |
| 14 | Haptics (COURSE/TURN/STOP/CONFIRM) and audio channels (beacon, ticker, session) | Implemented | `src/core/haptics.ts`, `audio.ts`, `assets/audio/beacon_*.wav`, `tick.wav`, `scripts/generate-tones.ts` | Never felt on a phone. Roadward COURSE buzz now needs ≥ 5° of heading toward the road, drift is capped at 30°, and only perception (`pose` / `curb`) cross-track counts — GPS/DR cross-track is zeroed in `sensors.courseErrorFor`; tuned on paper against 01 §2's fatigue rule, never against a wrist. Haptics-while-ARKit-runs and haptics-with-`allowsRecording` (phase-0 T4) unverified. Bluetooth latency unmeasured. Optional Core Haptics module not built (phase-2 polish). |
| 15 | Onboarding + spoken disclaimer + settings | Implemented | `src/ui/OnboardingScreen.tsx`, `onboardingSteps.ts`, `SettingsSheet.tsx`, `src/core/prefs.ts` | Verified only through `react-test-renderer`; no VoiceOver pass. Since the review every step speaks only `onboarding_*` / `disclaimer` keys (the whole tutorial becomes cacheable once G9 lands), the talk button is tap-to-toggle under a screen reader, and the iOS hero announcement rule is decided (`src/ui/DESIGN.md` rule 9: `announceForAccessibility` only when app speech did not carry the hero change within 1.5 s). None of it has been heard through VoiceOver; the double-speech check on device is still open. |
| 16 | DebugPanel, mocks, fixtures, jump-to-mode, manual overrides | Partial | `src/ui/DebugPanel.tsx`, `IntegrationControls.tsx`, `mocks/**`, `fixtures/**` | Mocks and panel are complete; since the review the perception packs are keyed by `AppMode` (curb pack arms on the AT_CURB edge), `curb-walk-onset` carries 10 Hz poses and a vehicle beat, steps emit on change, and `mocks/endToEnd.test.ts` drives OUTDOOR_NAV → CROSSING through `composeApp`. **Every fixture is synthetic** (`fixtures/README.md`: "State today: everything is SYNTHETIC"); `stores/demo-store-01.json` and `crossings/demo.json` are hand-written placeholders; frames are three identical placeholder JPEGs; `indoor-aisle-walk` has no CHECKOUT sign (G37). Missing on the panel: battery (needs `expo-battery`), `/api/health` dots, proxy-URL override / LAN toggle, socket state, runtime replay toggle. A DebugPanel jump to `APPROACH_CROSSING` flickers through `OUTDOOR_NAV` once. |
| 17 | Proxy (`/api/vision`, `/ws`, `/api/plan`, `/api/tts`, `/api/stt`, `/api/route`, `/api/health`) | Implemented | `server/**` | Code complete, 140 tests against faked upstreams (the speech lane now blanks any string with a digit, mirroring the client lock), `.env.example` for the five keys. **Not deployed anywhere**, no keys, no real upstream call ever made, WS vision → first audio ≤ 1.5 s p50 unmeasured. No `GET /api/tts/stream/:id` (see #10). OpenRouter failover key not in the locked key list. |
| 18 | CV training track (data, labelling, YOLO training, CoreML export, gate scoring, report) | Stub | `training/**` | Five scripts compile and print `--help`; `score_gate.py` verified on synthetic data. **No video, no frames, no labels, no dataset survey, no run, no export**; `eval/ped-signal-v1-report.md` is all `TBD`; `LICENSES.md` dataset rows unfilled. |
| 19 | Builds (dev build on the demo phone, EAS internal distribution) | Partial | `app.json`, `eas.json`, `ios/` (generated) | `expo prebuild --clean` + `pod install` succeed with Perception linked. `xcodebuild` **fails on this Mac** (no iOS platform component installed). No `expo run:ios --device` has ever completed. No EAS build has been requested; no device UDIDs registered. |

Tally: 8 Implemented, 9 Partial, 1 Stub, 1 Not started.

---

## 2. Not implemented, and why

Consolidated from the five track reports plus a scan of the tree for `TODO`, `FIXME`, `not
implemented`, `stub`, `placeholder`, `[verify]` and `synthetic`. The scan (re-run after the review
commits) found no `TODO`/`FIXME` markers in source, and the only `test.failing` / `skip` in the
tree is the walking skeleton's G37; the gaps are declared in headers, READMEs and fixture metadata
instead.
Grouped by what unblocks them.

### 2a. Blocked on Xcode / a provisioned Mac / the demo phone

| # | Gap | Owner | Why it is open | What finishes it |
|---|---|---|---|---|
| G1 | Xcode compile of the generated project; first compile of `PerceptionModule.swift` and the Engine under the iOS toolchain | A (builds), C (fixes) | This Mac's Xcode 26.6 has SDK headers but no iOS platform or simulator runtimes; `xcodebuild` exits 70 ("iOS 26.5 is not installed" / "Found no destinations") | `xcodebuild -downloadPlatform iOS` (multi-GB) or another Mac; then `npx expo prebuild --platform ios && npx expo run:ios --device` **Resolved 2026-09-18:** iOS 26.5 platform installed on this Mac; `xcodebuild -sdk iphoneos … CODE_SIGNING_ALLOWED=NO build` → BUILD SUCCEEDED. Remaining: install on the iPhone 16 over USB (`npx expo run:ios --device`). |
| G2 | On-device perception verification: ARKit video format, detector ≥ 15 fps, depth ≥ 10 fps, OCR 3 fps, frame → haptic < 150 ms, thermal `.serious` downshift, NEAR/MID/FAR wall-walk calibration, 0.5 m taped-line drift, horizon-row sign convention, Vision ROI mapping, Depth Anything output format, snapshot bytes | C | No phone, no build, no weights | G1 + G14, then a DebugPanel session reading `getStats()` and `nativeLog()`; flip `Geometry.swift` horizon sign if mirrored; scale `ObstacleEstimator` / `OcrReader` constants |
| G3 | `.mlpackage` inside a CocoaPods resource bundle: does Xcode compile it to `.mlmodelc`? | C | Needs a pod install with weights present | One `pod install` + build with any `.mlpackage` in `models/`; `ModelRegistry` already looks up both extensions |
| G4 | On-device audio/haptics: cached phrase < 50 ms, chunked Tier-1 MP3 playback in AVPlayer, live TTS first audio < 400 ms, haptics firing while ARKit runs and with `allowsRecording: false`, Bluetooth latency | A | Backends exercised only through injected fakes | Phase-0 T4/T5 on the demo phone; if chunked MP3 without Content-Length stalls, D buffers server-side |
| G5 | Visual and VoiceOver verification of every screen; the iOS hero announcement rule (`DESIGN.md` rule 9) and the tap-to-toggle talk button under VoiceOver; `accessibilityRole='alert'` behaviour on the error line | A | Verified with `react-test-renderer` and an `AccessibilityInfo` fake only; the policy is decided in code, not heard | `expo run:ios --device` + the phase-2 VoiceOver pass (06 "If you finish early" #2) |
| G6 | Frame → haptic < 150 ms on recorded curb footage (the +6 h gate) | B / C | `VehicleAlert.lastHandlerMs` measures only the JS side; native `frameToEventMs` needs the module on a phone | G1 + G14 + S5 footage |
| G7 | EAS internal-distribution build for the Windows user's phone (phase-0 T3) | A / D | Never requested; no UDIDs registered | `eas device:create`, `eas build --profile development --platform ios`; budget the free-plan queue |
| G8 | Offline replay proven (airplane mode keeps the bundle alive; no reload) | D | Needs an installed build | Phase-0 C4 on the spike |

### 2b. Blocked on API keys / hosting / network

| # | Gap | Owner | Why it is open | What finishes it |
|---|---|---|---|---|
| G9 | ~~Cached ElevenLabs phrases~~ **Closed 2026-09-18 (`d62a026`)**: 65 phrases generated with `eleven_flash_v2_5`, 1.0 MB of mp3 + `manifest.ts`/`manifest.json` committed | A | — | Remaining nit: six onboarding lines run 2.0–4.3 s (over the 2 s budget); shorten the text or raise the onboarding playback rate, then regenerate those keys. |
| G10 | Live Google Routes call and a captured demo-route fixture | B | No `GOOGLE_MAPS_API_KEY`; current `computeRoutes-forbes-bouquet.json` is hand-authored | Key in `server/.env`, then `npx tsx data/record-demo-route.ts` from `server/` after the venue walk; check `routes.warnings` carries the walking-beta text |
| G11 | Live Overpass query proven on the Oakland bbox (`sources.overpass === 'live'`) | B | No network calls made | One live `/api/route` |
| G12 | Nemotron live: exact model id from `GET /v1/models`, `nvext.guided_json` acceptance, `max_completion_tokens` honoured, thinking off, TTFT; the model column of `plan.eval.md` | B / D | No `NVIDIA_API_KEY` (and NIM key approval can take days — 11 A1) | Key(s) in `server/.env`; `GET /api/health` (`modelSeen`); `NVIDIA_API_KEY=… npx tsx routes/plan.eval.ts`; set `NVIDIA_MODEL` if the id differs |
| G13 | Anthropic live: structured outputs (`output_config.format`), Haiku 4.5 and Sonnet 5 ids, thinking-disabled on Sonnet, image round trip, tier/spend cap | D | No `ANTHROPIC_API_KEY` | Key; `WARMUP_ON_START=1` and `GET /api/health/warm` all green before anything is demoed |
| G14 | Proxy hosted in us-east; WS vision → first audio ≤ 1.5 s p50 from the phone; stale-seq-never-spoken verified live | D | No host account, no keys, no device | Node host with WebSocket support in us-east, the five keys in its secret store, `EXPO_PUBLIC_PROXY_URL` / `_WS` on the phone, one real `storefront` round trip |
| G15 | OpenRouter failover key | Team | Not in the locked five-key list (05 Part 2 flagged it) | Decision + `OPENROUTER_API_KEY`; without it there is no same-model failover, only templates |
| G16 | ElevenLabs concurrency: semaphore assumes 4 (free plan) | D / A | Creator perk not confirmed on the key-holding account | Redeem the perk (11 A3), raise `server/lib/semaphore.ts` to 10 |
| G17 | `training/vlm_label.py` calls Anthropic directly, not through the proxy | D | The proxy's vision route is bound to the byte-stable `VisionResponse` schema; labelling uses a different one | Acceptable as-is with `ANTHROPIC_API_KEY` in the labelling environment only; add `/api/label` if the team objects |

### 2c. Blocked on the venue walk and capture sessions

| # | Gap | Owner | Why it is open | What finishes it |
|---|---|---|---|---|
| G18 | Real fixture recordings: `perception/*.jsonl`, `track.json`, `frames/<seq>.jpg`, `video/crossing-*.mp4`, `video/route.mp4`, `labels/crossing-*.json` | D | Everything is generated by `fixtures/tools/generate.mjs`; frames are three identical placeholder JPEGs | Demo phone + C's module debug export (09 §10) + venue sessions (11 S5, S6); then `node fixtures/tools/generate.mjs --index-only && npm test` |
| G19 | `fixtures/stores/demo-store-01.json`: real entrance pin (30 s GPS average ≤ 10 m), verbatim `signText`, `sideWhenAscending` walked both ways, `packageHint`; `fixtures/crossings/demo.json`: real OSM nodes and curbs | D (file), human lead + C (walk) | Coordinates are the synthetic track's; "Demo Grocery" is invented; `pinnedBy: "venue-walk"` is aspirational | 11 S1–S4; hand-edit the two files; `setKnownSigns` vocabulary follows |
| G20 | Near/far curb positions and crossing bearing checked at the demo crossing | B | `crossingData.ts` derives curbs from footway endpoints or ±6 m from the cluster centre | Venue walk; widen `CURB_FALLBACK_OFFSET_M` for a four-lane road if needed |
| G21 | Mock route served by D along the replay track (`fixtures/route/demo.json`) | D / B | `server/data/fixtures/route-demo.json` is at Forbes/Bouquet, ~1 km from the synthetic track, so it would put the runner off-route; integration derives the route from `track.json` meta instead (`src/core/fixtureRoute.ts`) | Record a route along the same track the sensor replayer plays; `fixtureRoute.ts` then goes away |
| G22 | Leg-wording A/B blind ratings in `plan.eval.md` | B (human raters) | Word counts filled; Rating column empty | Three teammates rate at walking pace |
| G23 | Rehearsals R1–R3, failure drills, hotspot/LAN round trip, backup phone in replay mode, `forceEnter` and `setManualSignal` used live | D / all | Human and venue tasks; tooling exists | Phase 2–3 with the wired build |

### 2d. Blocked on model weights and training data

| # | Gap | Owner | Why it is open | What finishes it |
|---|---|---|---|---|
| G24 | Weights under `models/`: `coco-yolo-nano(-416)`, `ped-signal-v1`, `depth-anything-v2-small`, optional `walkable-seg`, plus per-model manifests | D → C | Weights arrive as D's PR; nothing has been downloaded, exported or converted | Export COCO nano via `training/export_coreml.py`; train and export the signal model (G25); locate Depth Anything (G26); C merges and rebuilds |
| G25 | Signal model v1: dataset survey + licences (V3), local frame capture and labelling (D1), leave-one-crossing-out run, export, device eval CSV, report numbers; the +14 h gate (false-WALK precision > 95 %, recall > 80 %, parallel confusion < 2 %) | D (train), C (run) | No video captured, so no frames, so no run; `eval/ped-signal-v1-report.md` is all `TBD` | 11 S5 → `extract_frames.py` → `vlm_label.py` + hand correction → Colab `train_yolo.py --run v1 --heldout <id>` → `export_coreml.py` → PR to `models/` → C device replay → `score_gate.py states` |
| G26 | Depth Anything V2 small CoreML build located, licence recorded | D / C | 10 §8 `[verify]` item; not resolvable offline | Find Apple's/HF's conversion, record repo + commit + licence in `training/LICENSES.md`, deliver via the `models/` PR; else a two-hour coremltools attempt; else drop depth (no `OBSTACLE_AHEAD`) |
| G27 | Mock `snapshotJPEG` returns the fixture frame's real size instead of re-encoding to the requested width | D | No native image library in the app | Provide 512/640/1024 stills keyed by `seq` in `fixtures/frames` |

### 2e. Cross-track contract work (code changes someone still has to make)

| # | Gap | Owner | Why it is open | What finishes it |
|---|---|---|---|---|
| G28 | Tier-1 streamed speech: A's `SpeechService.playStream(id)` fetches `GET /api/tts/stream/<id>`; D's proxy relays audio only as binary WS frames | D **or** A | Two tracks built two halves of one feature against different assumptions; wiring `speech_start → noteStream` today would silence Claude's `speech` field, so the WS is never opened and Tier 1 runs over HTTP (speech spoken via `say()` with the 1.5 s live budget) | Either D adds `GET /api/tts/stream/:streamId` (buffer per seq) or A adds a chunk-sink player fed by `onAudioChunk` / `onSpeechEnd`; then flip `STREAMED_SPEECH_RELAY_AVAILABLE` in `src/core/composeApp.ts` and open the socket on `TRANSITION` |
| G29 | `VehicleAlert` (B) plays STOP + phrase on the same bus events C's reflex already handles synchronously | B | Constructing it would double every STOP, so `composeApp` does not construct it | B strips play/say (counters + cut-line toggle only); integration then wires it for `getStats()` |
| G30 | DebugPanel: battery %, `/api/health` dots, proxy-URL override / LAN toggle, socket state, runtime replay-mode toggle (05 Part 5) | A | Out of the composition pass; `expo-battery` not in `package.json` (adding deps was outside the UI task); mock is a bundle-time flag | Add `expo-battery`; a small health poller; persist a proxy URL in `prefs.ts`; a per-session mock swap if the runtime toggle is wanted |
| G31 | Live partial transcript while holding the talk button | A | `voice.ts` keeps recogniser results internal; `TalkButton` already accepts an optional `onPartial` port | Expose `onPartial(cb)` on `VoiceInput` |
| G32 | Pre-commit hook / CI step running `npm run lint:phrases && npm run lint:deps` | Orchestrator | Git root is the parent repo; no hook manager; repo-level decision | Add the hook or CI step |
| G33 | Markdown lint of `06-INTEGRATION-AND-DEMO.md` flags quoted judge questions containing a forbidden word | Human | They are quotes of judges, not app text | Decide whether docs are in scope of the lint; no code change |
| G34 | Optional Core Haptics module (continuous STOP, intensity-modulated COURSE); volume-button push-to-talk | A | Phase-2 polish behind a flag / no hardware-button API in SDK 57 | Only if the +6 h gate is met; otherwise cut |
| G35 | Contract flags raised by B and not acted on unilaterally: `SpeechService.prefetch` as a shared cache path, `useOutdoorStore.beaconTarget` as the shared beacon slice, `turn_*_soon` canonical wording vs the 20 m trigger, B's extra files under `server/routes/` | A / B / D | Need acks in the shared channel (the `roadSide 'NONE'` cross-track flag is now settled in `haptics.ts`: NONE buzzes only with heading agreement) | Ack or reject each; most are already consumed by `composeApp` as-is |
| G36 | Google Maps ToS on text-to-speech of Routes street names | B / team | Not checked | Read the clause; Mapbox Directions is the drop-in if the answer is no |
| G37 | `CHECKOUT_NAV → DONE` from a real landmark read: `fixtures/perception/indoor-aisle-walk.jsonl` carries no CHECKOUT / REGISTERS / LANES sign, so the indoor controller never emits `CHECKOUT_REACHED`; the walking skeleton injects it DebugPanel-style after a 15 s wait and keeps a `test.failing` on the real path | C / D | Fixture gap, not a controller gap (the landmark class is covered in `src/indoor/*.test.ts`) | Add a checkout sign read to the pack (or a hard-cases pack); promote the `test.failing` in `src/walkingSkeleton.test.ts` |
| G38 | ~~SDK patch pins~~ **Closed 2026-09-18 (`47ed2d1`)**: `expo install --fix` applied; `--check` clean; typecheck + 906 tests green | A | — | — |
| G39 | ~~Reviewer issue #1 (empty `AUDIO_MANIFEST`)~~ **Closed with G9 (`d62a026`)** | A | — | — |

Also found by the scan and left as-is on purpose: `src/ui/copy.ts` `WALKING_BETA_FALLBACK` (a
display fallback; `App.tsx` passes B's real `WALKING_BETA_WARNING` via `betaNotice`);
`models/README.md` / `manifest.json` `[verify]` on Depth Anything input size and licence (G26);
`server/lib/semaphore.ts` `[verify]` on concurrency (G16).

---

## 3. How to run what exists today

There is no installed build anywhere yet. The commands below are what the README says and what
integration proved up to the point where the Mac lacked an iOS platform.

### Checks that pass right now (no keys, no device)

```bash
cd /Users/alexxiang/steelhacks/aisle
npm install
npm run typecheck        # 0 errors
npm test                 # 60 suites / 906 tests (incl. src/walkingSkeleton.test.ts, mocks/endToEnd.test.ts)
npm run test:server      # 14 files / 140 tests (vitest, upstreams faked)
npm run lint             # tsc + forbidden-deps grep + forbidden-phrase lint
npx expo install --check # clean since 47ed2d1 (G38 closed)
bash modules/perception/tests/run.sh   # 94 synthetic Swift engine checks (macOS SDK, no ARKit)
xcrun -sdk iphoneos swiftc -typecheck -target arm64-apple-ios17.0 -parse-as-library modules/perception/ios/Engine/*.swift   # 11 files, exit 0
SKELETON_TRACE=1 npx jest src/walkingSkeleton.test.ts   # prints the mode/say/event timeline of one full mock trip
```

### Mock mode on a development build (the demo backup; needs a provisioned Mac + iPhone)

```bash
npx expo prebuild --platform ios --clean   # succeeds here; Perception pod links
npx expo run:ios --device                   # unblocked 2026-09-18 (iOS platform installed; unsigned arm64 build succeeds); needs the iPhone on USB
npm run start:mock                          # EXPO_PUBLIC_MOCK=1 expo start --dev-client
```

On the phone: type "eggs" or hold the talk button; long-press the mode word (1.5 s) for the
DebugPanel: jump to any mode, scrub the replay track, FORCE ENTER STORE, manual signal state,
scan-result override, network on/off, beacon/ticker mute. Sensors, perception, Tier-1 vision and
the planner replay from `fixtures/`; the route is derived from `fixtures/track.json`; speech and
haptics are real. Without a proxy, variable phrases (street names, aisle arrival) wait the 1.5 s
live budget and then speak through `expo-speech`; prefetch before `ROUTE_READY` is capped at 2.5 s.

Mock mode has only ever been exercised through the Jest harness (`src/core/composeApp.test.ts`,
`mocks/replayers.test.ts`, `mocks/endToEnd.test.ts`, `src/walkingSkeleton.test.ts`). No human has
seen it on a screen.

### Proxy

```bash
cd server && cp .env.example .env    # ANTHROPIC_API_KEY, NVIDIA_API_KEY, ELEVENLABS_API_KEY,
                                     # ELEVENLABS_VOICE_ID, GOOGLE_MAPS_API_KEY; OPENROUTER_API_KEY optional
npm install && npm run dev           # 0.0.0.0:8787; GET /api/health shows each upstream
```

`WARMUP_ON_START=0` runs it offline. With no keys every upstream reports down and the routes
answer with their fallbacks (`{confidence: 0}` vision, templated plan, 503 on tts/stt, recorded
fixture on `/api/route` when the endpoints match). Nothing in `server/` has ever talked to a real
upstream.

### Live app against the proxy

```bash
npm run gen:audio      # only after editing phrases.ts (assets/audio is committed; G9 closed)
EXPO_PUBLIC_PROXY_URL=http://<host>:8787 npx expo start --dev-client
```

`EXPO_PUBLIC_*` is inlined at bundle time; restart Metro after changing it.

---

## 4. Phase-0 items still open (`../11-PHASE-0-CHECKLIST.md`)

Every checkbox in the document is unticked. What the repository can and cannot vouch for:

**Verifiable from the repo as done or partly done**

- T4 permission strings: all six `NS*UsageDescription` keys and `UIRequiredDeviceCapabilities: ["arkit"]` are in `app.json` (`expo config --type introspect` confirms). Not verified as prompting once and granted on a phone.
- T5 / V4 SDK pin: `expo ~57.0.23`, `expo-av` absent, `expo-audio ~57.0.5`, `expo-speech-recognition ^57.1.0`, `react-native 0.86.3`; `npx expo install --check` clean. The two-player constant-power pan is implemented (`src/core/audio.ts`) but never heard through headphones.
- A8 open data: WPRDC signalized-intersections CSV (783 rows) is committed as `server/data/wprdc-signals.json` with licence. Overpass fixture is recorded for the Oakland bbox but no live query has run from this code.
- D3 fixtures staged: staged as **synthetic**, not as raw venue material.
- D4 licences: `models/LICENSES.md` and `training/LICENSES.md` exist; dataset rows are empty pending V3.
- N7 cut order: recorded in `00`/`06`; not re-confirmed by the team.

**Open, blocking for the full plan (11 §9)**

- R0 / N8: organiser answer on pre-written code, model weights and a hosted empty server — not recorded. Every artifact in this repo is app code under the strict reading.
- T1: Xcode able to build to a physical iPhone on at least two Macs — the one Mac tried could not until 2026-09-18 (no iOS platform); it now builds for arm64 (unsigned).
- T2: throwaway spike with the module scaffold, an ARKit session and one CoreML model running on the demo phone, with fps and build times — not done.
- T3: EAS internal build installed on the Windows user's phone — not done.
- T4 device half, T5 device half — not done.
- A2 Anthropic, A3 ElevenLabs (Creator perk, voice chosen), A4 Google Routes (project, billing, key restriction), A5 Apple Developer (team, UDIDs, bundle id signs) — no evidence of any account or key.
- S1–S3 store chosen, manager asked, sign strings, entrance pinned — not done; fixtures are invented.
- S4–S5 crossing chosen from WPRDC, video captured and labelled — not done.
- P1–P3 demo phone named and configured, mount and headphones — not done.
- C1 proxy host in us-east answering from the phone; C2 hotspot path — not done.
- N1–N3 Swift owner, human per checkbox, demo roles — the names table in 11 §8 is empty.

**Open, degradable (fallback must be written into the run-of-show before the clock)**

- A1 NVIDIA NIM key + authenticated `/v1/models` + one guided-JSON call + OpenRouter key — not done (templates exist).
- V1 Depth Anything CoreML on the phone (ms per frame) — not done (drop depth if it fails).
- V2 walkable-seg export — not done (optional; off by default in `ModelRegistry`).
- V3 pedestrian-signal dataset survey + licences — not done.
- V5 ARKit geo-tracking availability — not checked (informational).
- A6 Expo/EAS team account, A7 Colab T4 + one-epoch export loading in Xcode — not done.
- D1–D2 local frames labelled, signal model v1 on the phone with held-out numbers — not done; **rung 2/3 is the plan of record today by default**.
- C3 route cell coverage, C4 offline replay on the spike — not done.
- N4–N6 store/crossing chosen and clock re-timed, YOLO experience, blind tester — not recorded.
- P4 VoiceOver pass planned — not done.
- The "Numbers to record in phase 0" table (video format, fps, depth ms, OCR ms, build times, battery, thermal, model P/R, Nemotron TTFT, Claude e2e, hotspot RTT) — every cell empty.

Under 11 §9's rule, two or more blocking NO-GOs in §1 or §4 make fixture replay for perception
and the outdoor leg the plan of record with only the store live. As of this file, §1 and §4 are
entirely NO-GO.

---

## 5. Test and build status (integrator's report, re-run on this checkout)

| Check | Integrator reported | Re-run 2026-09-18 for this file |
|---|---|---|
| `npm run typecheck` (app) | clean | 0 errors |
| `npm test` (Jest, jest-expo) | 58 suites / 851 tests | 60 / 906 pass, 2.6 s (after the review round; see §7) |
| `npm test` in `server/` (vitest) | 14 files / 137 tests | 14 / 140 pass |
| `tsc --noEmit` in `server/` | clean | clean |
| `npm run lint:phrases` | ok | ok (phrase table, string literals, fixtures) |
| `npm run lint:deps` | ok | ok |
| `npx expo install --check` | — | was "up to date"; on the §7 re-run **two outdated pins** (G38) |
| Swift engine `swiftc -typecheck` (iphoneos, arm64, iOS 17) | exit 0 (C) | exit 0, 11 files, no diagnostics |
| `modules/perception/tests/run.sh` (macOS harness) | 94 / 94 (C) | 94 / 94 |
| `PerceptionModule.swift` compile | **never** | — |
| `npx expo-modules-autolinking resolve -p ios` | lists `perception` | — |
| `npx expo prebuild --platform ios --clean` | succeeded (3rd run, 100 pods incl. Perception) | — |
| `xcodebuild … -sdk iphoneos` | **exit 70** ("iOS 26.5 is not installed"; no destinations) → **BUILD SUCCEEDED** on 2026-09-18 after installing the platform | — |
| `npx expo run:ios --device` | never completed | — |
| EAS build | never requested | — |
| `python3 -m py_compile training/*.py` + `--help` | pass (D) | not re-run |

Caveats on the numbers:

- All 906 + 140 tests run against fakes, injected fetches, scripted sensor sources and synthetic
  fixtures. They prove internal consistency, not that a single external assumption (Expo API
  behaviour on device, Anthropic/NIM/ElevenLabs/Google response shapes, ARKit/Vision/CoreML
  behaviour, MP3 streaming in AVPlayer) holds.
- The Nemotron eval (`server/routes/plan.eval.md`) reports 98.3 % intent accuracy **for the
  deterministic template**, not for Nemotron. One failure found ("how fart is it" → unknown).
- `scripts/lint-phrases.test.ts` lints the whole tree, so any track adding a forbidden word to a
  string literal fails `npm test` for everyone — intended.
- Two cross-directory edits were made during integration and must be acknowledged by their
  owners: `modules/perception/ios/Perception.podspec` (C; resource paths made relative so
  `pod install` passes) and `app.json` (A-owned; `expo-build-properties` deployment target 17.0,
  without which autolinking silently skipped the Perception pod).
- The working tree is committed: `git status` is empty at `577fe25`. Each fixer committed only
  its own track's files; the attribution trailer differs between commits (two names), which is
  cosmetic.

---

## 6. What to do first (in the order it unblocks the most)

1. Install the iOS platform on a Mac (or use one that has it) and get `npx expo run:ios --device`
   through once. Until then the Swift module is unverified text and no other device item can move.
2. Get keys and generate the phrase cache (G9). A demo whose disclaimer is spoken by `expo-speech`
   undercuts the ElevenLabs track before the first beat.
3. Decide G28 (streamed Tier-1 speech) in one message: it is a one-file change on either side.
4. Venue walk with the demo phone: entrance pin, sign strings, crossing choice, crossing and curb
   video (G18–G20). Every fixture and the whole training track are waiting on it.
5. Host the proxy (G14) and run `/api/health/warm` against real upstreams once, early, so the
   Anthropic tier settles and the Nemotron model id is known before the AMA.
6. Accept now that rung 1 of the crossing ladder (on-device signal model) is an upside, not a
   dependency, and write the run-of-show for rung 2/3.
7. `npx expo install --fix` (G38) before the first `expo run:ios`, and when mock mode misbehaves
   on the phone run `SKELETON_TRACE=1 npx jest src/walkingSkeleton.test.ts` first — it is the only
   record of what the mock trip is supposed to do second by second.

---

## 7. Verification (2026-09-18, after the reviewer round)

Run by the verifier on a clean tree at `577fe25` from `/Users/alexxiang/steelhacks/aisle`.
Everything below is the gate output as printed, trimmed to the result lines.

| Gate | Command | Result |
|---|---|---|
| App typecheck | `npm run typecheck` (`tsc --noEmit`) | exit 0, no output |
| Jest | `npx jest` | `Test Suites: 60 passed, 60 total` / `Tests: 906 passed, 906 total` / `Time: 2.592 s` |
| Phrase lint | `npm run lint:phrases` | `lint-phrases: ok (phrase table, string literals, fixtures)` |
| Dependency lint | `npm run lint:deps` | exit 0, no output |
| Server tests | `cd server && npm test` (vitest 5.0.1) | `Test Files 14 passed (14)` / `Tests 140 passed (140)` / `Duration 692ms` |
| Server typecheck | `cd server && npx tsc --noEmit` | exit 0, no output |
| Swift engine typecheck | `xcrun -sdk iphoneos swiftc -typecheck -target arm64-apple-ios17.0 -parse-as-library modules/perception/ios/Engine/*.swift` | 11 files, exit 0, no diagnostics |
| Swift macOS harness | `bash modules/perception/tests/run.sh` | `94 passed, 0 failed` |
| SDK pins | `npx expo install --check` | **fails**: `expo-build-properties@57.0.20 - expected version: ~57.0.21`, `expo-location@57.0.18 - expected version: ~57.0.19` (G38; not one of the named gates, left for A) |
| `PerceptionModule.swift` / `xcodebuild` / device build | — | compiled 2026-09-18 (unsigned arm64 build, 0 errors); not yet run on a phone |

**Walking skeleton** (`npx jest src/walkingSkeleton.test.ts --verbose`): 12 / 12 pass. Ten
assertions on the main run (mode sequence IDLE → OUTDOOR_NAV → APPROACH_CROSSING → AT_CURB →
CROSSING → OUTDOOR_NAV → TRANSITION → INDOOR_NAV → AT_ITEM → CHECKOUT_NAV → DONE with zero
illegal transitions; one ROUTE_READY / four legs / one crossing / no re-plan; CROSSING_AHEAD ≤ 25 m,
CURB_REACHED from the 2 s stop, CROSSING_STARTED after the step-off, FAR_CURB_REACHED and
"Far curb."; "Walk signal on." at the curb after DONT_WALK; VEHICLE_APPROACHING → STOP haptic in
the same tick then the CRITICAL phrase; one fused STORE_ENTERED inside the 5–15 s post-door window
and TRANSITION within the 3 s cap; TARGET_AISLE_REACHED {a3, RIGHT} and "Aisle three. Eggs on your
right."; every utterance ≤ 12 words, digits as words, no forbidden term, at `say()` and at the
backend; zero `fetch` / `WebSocket`), one on the stale-WALK run ("Walk already on. Wait for next.",
never "Walk signal on."), and one bookkeeping check that the only inputs beyond ITEM_REQUESTED were
the user's "next" at the item and the checkout injection.

**Known-gap list carried by the skeleton** (`test.failing`, so it counts as a pass until the code
catches up):

1. G37 — `indoor-aisle-walk` has no CHECKOUT sign, so CHECKOUT_NAV → DONE needs an injected
   `CHECKOUT_REACHED` instead of the navigator's landmark match. Owner C / D.

Two gaps the skeleton opened earlier in the session (curb stillness never accruing; the leg gap at
the crossing forcing a spurious re-plan) closed with D's `482e215` and were promoted to hard
assertions; they are no longer in the list. The skeleton depends on D's mode-keyed packs and the
retimed `track.json` — against the pre-`482e215` mocks it stalled at the near curb.

**Reviewer issues** (`review-issues.json`, 20 items): 19 closed in code — A #2, #3, #4, #5, #6, #7,
#10, #18, #19 (`b092dec`, `ff2e9e6`, `6b0535e`), B #8, #15, #16, #20 (`1070ce8`), C #9 (`2d8dc4b`),
D #17 (`482e215`), and #11, #12, #13, #14 already in `e38261a` (re-verified in the tree:
`store.ts` handles CROSSING_ABORTED through one bus handler, `LegRunner` gates STORE_ENTERED on the
store's mode, `TransitionDetector.forceEnter` respects only the debounce, the approach announcement
is spoken). #1 (empty `AUDIO_MANIFEST`) is open as G9 / G39 and cannot close without ElevenLabs
keys. One reviewer fix was deliberately not applied as written: #18's cross-track source flag was
gated in `sensors.courseErrorFor` instead of on `CourseError`, because 01 §2 freezes that type.
One was applied differently from the reviewer's first choice: #8 keeps the scan report at CRITICAL
(paced and flushed) rather than moving it to NAV; A's CRITICAL class list admits `scan` for it.

**What this round did not change.** No phone, no key, no venue, no weights, no Xcode compile of
the module, no hosted proxy. The 906 + 140 tests still prove internal consistency between four
agents' code and their own fakes. The status words in §1 are unchanged: 8 Implemented, 9 Partial,
1 Stub, 1 Not started.

## Live verification from the Mac — 2026-09-18 evening (proxy with real keys)

Proven end-to-end through the proxy (`/api/health` green for Anthropic, NVIDIA, ElevenLabs
TTS + STT, Overpass; Google Routes red until the Routes API is enabled on project
188682982044 — Google's own message; regenerating the key does not help):

| Path | Result |
|---|---|
| `/api/stt` (ElevenLabs Scribe) | spoken clip "I need eggs" → `{"text":"I need eggs"}` in 374 ms |
| `/api/vision` (Claude Haiku 4.5, structured output, 512 px image) | full `VisionResponse` in 2.5 → 2.1 → 1.4 s warm; first cold call hit the old 4 s cap → slack-tolerant questions now 6 s (`curb_crop` stays 4 s) |
| `/api/plan` (Nemotron 3.5 Lightning) | hosted endpoint rejects `nvext.guided_json` (400) and stalls on streaming → non-streaming `json_object` + schema-in-prompt; parseIntent / disambiguate / crossingAnnounce / answer answer from Nemotron in 0.4–1.9 s; routeCompile ~4 s with occasional 8 s deadline misses on the free tier (templates cover them); digits in replies are spelled out before validation |
| `/api/tts` live tier (Flash v2.5) | 200, valid mp3, 1.3 s for a whole non-streamed clip (variable phrases are pre-synthesized at route/store load, so this is off the walk) |
| `/api/route` | Google failing → disk cache → **recorded route when both ends match** (Forbes/Bouquet: 200, `google: fixture`, live Overpass crossings) → otherwise 502 and the app now speaks "Route unavailable. Try again shortly." (new cached phrase, 66 total) |

Not yet exercised (needs the phone in live mode): ARKit camera + on-device detector/depth/OCR fps,
hold-to-talk → on-device STT, the DebugPanel readouts. Proxy route counters were empty at
20:48, i.e. the phone has not connected live yet.

**Degraded route mode (2026-09-18, `241492c`).** When `/api/route` fails with an http/shape error (Google Routes disabled — the current state until the API is enabled on project 188682982044 — or a 5xx), the trip speaks "No route data. Heading straight to the store." and installs a one-leg ARRIVE route on the bearing to the pinned entrance, so perception, the transition and the indoor flow still run; crossings are not announced on that leg (nothing is known about them). Network/timeout errors keep the offline notice. The Home-screen banner "Couldn't plan the route. Check the connection…" seen on the first live attempt was this server-side failure wearing the connection wording; the degraded scope now reads neutrally.
