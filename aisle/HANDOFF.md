# Aisle — handoff notes (for a person or a model picking this up cold)

## Latest recovery checkpoint — September 19, living-room mission/audio

Read [RECOVERY-CHECKPOINT.md](RECOVERY-CHECKPOINT.md) first; it supersedes older
in-progress notes below. Main pulled through `f2ed7ff` (sharper native snapshots and
camera-strip contrast). Local fixes preserve an explicit fridge retrieval mission,
keep fresh CV guidance running during slow cloud calls, prevent stale/ambient
responses from interrupting the task, and repair voice-session routing/volume.
480 prepared clips are bundled (392 added), normalized with an idempotent v2 script.
Task speech no longer waits for ElevenLabs. Cloud vision requests have runtime
client IDs so reloads cannot poison the server's sequence tracking.

Verified: app lint; 1105 full-suite tests plus two new playback tests; server types
and 189 tests; native typecheck and 113 checks; signed iPhone build/install. Phone
was locked, so launch and physical rehearsal remain outstanding. Unlock/open Aisle
and use the supervised eggs/fridge checklist in the recovery document. No claim of
safe autonomous navigation, calibrated distance, or reliable physical pickup.
Changes are local/unpushed. Existing services: Metro 8081, proxy 8787.

Last updated 2026-09-19 after "round 6" (Stream A: eyes). Read this first, then
`TEAM-PLAN.md` (who does what), then `IMPLEMENTATION-STATUS.md` (the dated log of
what was verified and how). The design documents that shaped the code are one
directory up (`../00-PROJECT-BRIEF.md` … `../11-PHASE-0-CHECKLIST.md`); the code
comments cite them as "01 §3", "09 §2" etc.

## What this is
A phone app for blind users: outdoor walking guidance with crossings, camera awareness
("You are looking at a person opening a refrigerator on your right."), guided tasks
("find the eggs in my fridge" → steps confirmed by the camera), and grocery-store aisle
guidance. iPhone only (ARKit). Expo SDK 57 development build + a Node proxy that holds
every API key. Repo: https://github.com/alexzxiang/aisle (private; `main` is protected
only by CI — see `.github/workflows/ci.yml`).

## The moving parts (and the one file that wires them)
```
aisle/
  App.tsx                      platform edges (expo backends) → composeApp → screens
  src/core/composeApp.ts       THE wiring: every service is built here, in data-flow order
  src/core/contracts.ts        every type shared between tiers; change with both sides in one PR
  src/core/store.ts            zustand state machine: modes + legal transitions (01 §1)
  src/core/bus.ts              typed event bus; the store drives transitions from events
  src/core/situate.ts          awareness loop: narration, "you seem to be … is that right?"
  src/core/guidedTask.ts       "find the eggs": plan → steps → camera-confirmed
  src/core/trip.ts             a trip: item or place → route → store handoff → indoor
  src/core/destinations.ts     "take me to the CVS on Forbes" → store map or /api/places
  src/core/voice.ts            push-to-talk → STT → intent (proxy or local) → act
  src/core/speech.ts           the ONE speech queue: cached phrases + live TTS, mode policy
  src/core/phrases.ts          every fixed line, its category, and the forbidden words
  src/core/haptics.ts          COURSE buzz rule (silence on course), TURN/STOP/CONFIRM
  src/perception/semanticVision.ts  Tier 1 client: builds VisionRequest (still + facts), gates, applies
  src/perception/PerceptionService.ts  wraps the native module; mode → profile; reflexes
  modules/perception/          the Swift PerceptionModule (ARKit, CoreML, Vision) + its TS bridge
  src/outdoor/ src/crossing/ src/indoor/ src/transition/   the walking, curb, aisle, handoff logic
  src/ui/                      screens (Home, Nav, Onboarding, Settings, Debug), white liquid glass
  mocks/ fixtures/             replayers so the whole graph runs under Jest with no phone
  server/                      the proxy (Express + ws): vision, plan, tts, stt, route, places, health
```
Three tiers of "seeing": Tier 0 on-device (ARKit pose, COCO YOLO11n, Depth Anything,
Apple OCR, Apple scene classifier), Tier 1 Claude Haiku/Sonnet through `/api/vision`
(structured JSON, `speech` first), Tier 2 Nemotron through `/api/plan` with Claude Haiku
racing as understudy (`server/lib/claudePlan.ts`).

## Running it
```bash
# proxy (keys live in server/.env, git-ignored; ask Alex)
cd aisle/server && npm install && npm run dev        # http://0.0.0.0:8787, /api/health probes every upstream
# app, on a Mac with the dev build installed on an iPhone
cd aisle && npm install && npx expo start --dev-client   # the app finds the proxy on Metro's host automatically
```
No phone: `npx jest` (1031 tests) runs the whole app graph on the mocks, including the
keyboard voice path (`src/core/composeApp.test.ts`); `cd server && npx vitest run` (162).

## Rebuilding the iOS app (needed whenever anything under `modules/perception/ios` or a
native dependency changes; JS changes only need Metro)
```bash
cd aisle
npm run ios:check              # compiles app + Swift module, no device, no signing — do this first
npm run ios:device             # plug the iPhone in, unlock it, tap Trust → build, install, launch
```
By hand, the same steps: `cd ios && pod install` (the module is a local pod with a glob
file list — a NEW .swift file is invisible until this runs), then
`xcodebuild -workspace ios/Aisle.xcworkspace -scheme Aisle -configuration Debug
-destination "id=<udid>" -allowProvisioningUpdates -derivedDataPath /tmp/aisle-dd build`,
then `xcrun devicectl device install app --device <udid> /tmp/aisle-dd/Build/Products/Debug-iphoneos/Aisle.app`.
The udid comes from `xcrun devicectl list devices`. Signing is automatic with team
`S88T76V4WJ` (`plugins/withAutomaticSigning.js`). If `ios/` is missing or stale:
`npx expo prebuild --platform ios --clean` regenerates it (never committed). CoreML
weights are not in git: `models/README.md` says how to export them into `models/`;
`plugins/withCoreMLModels.js` copies them into the Xcode target.

Symptoms and causes we have already met:
- "Offline. Signal reading and directions still work." → the phone could not reach the
  proxy. Since round 5 the default proxy URL is Metro's host on :8787; if you set
  `EXPO_PUBLIC_PROXY_URL`, it must be the Mac's LAN IP, not localhost.
- "Rebuild the app to see the camera" / a red "Unimplemented component
  ViewManagerAdapter_Perception_PerceptionPreviewView" → the installed binary predates a
  native change. Rebuild. Metro prints `[perception] preview view linked (…)` on first render.
- `WARN Unable to get the view config for ExpoBlurView` → same: old binary without expo-blur.
- xcodebuild "Unable to find a destination" → phone unplugged/locked; `devicectl` says `unavailable`.

## Verifying without the phone (what I run after every change)
```bash
cd aisle && npm run lint && npx jest                    # typecheck + phrase/deps lint + 1320 tests
cd aisle/server && npx tsc --noEmit && npx vitest run   # 215 tests
cd aisle && npm run ios:check                           # Swift compiles
# live, with the proxy up:
curl -s localhost:8787/api/health | head -c 300
grep -E 'vision ready|VISION BROKEN' <proxy log>       # the one line that matters before a demo
curl -s -X POST localhost:8787/api/plan -H 'content-type: application/json' \
  -d '{"job":"parseIntent","input":{"transcript":"find the eggs in my kitchen","mode":"IDLE","knownItems":["eggs"]}}'
curl -s "localhost:8787/api/places?q=cvs&street=forbes&lat=40.4433&lng=-79.9436&radiusM=4000&limit=3"
```
`IMPLEMENTATION-STATUS.md` has the vision calls with real photos (kitchen, street,
DON'T WALK, COUNTDOWN) and what came back.

## Where round 6 left Stream A (eyes)
Done in code, compiled (`ios:check` green), installed on Alex's iPhone 16 at 12:10 on 09-19:
1. **Field of view.** `VideoFormatPolicy` (ARSessionManager.swift) prefers the ultra-wide
   lens if ARKit offers it, then 4:3 over 16:9, then 30 fps, then fewest pixels. The
   DebugPanel's `videoFormat=WxH@fps wide|ultrawide` line tells you what the phone chose.
   **Unverified on the device: whether the iPhone 16 exposes an ultra-wide ARKit format.**
   If it says `wide`, the plan is an `AVCaptureSession` on `.builtInUltraWideCamera` for
   snapshots indoors (ARKit cannot share the camera; it's a mode switch) — TEAM-PLAN A.1.
2. **Stills** are 576×768 for the room questions (was 384×512) and come from the sharpest
   frame of the last second (`SharpFrameKeeper.swift`), not the live blurred one.
3. **Scenery classes.** 27 COCO classes now survive the native filter (see `DetectionClass`
   in Events.swift / `SCENE_DETECTION_CLASSES` in contracts.ts). They draw on the overlay,
   fill the "Sees:" strip, and go to Claude as `onDeviceSees: fridge right (large, close)`.
   The vehicle / hazard / signal logic still uses its own class sets.
4. **Apple scene classifier** (`SceneClassifier.swift`, stage `scene`, 2 fps indoors) →
   `onSceneClass` → `situate.ts` (`classifySceneLabels`): two agreeing readings become
   "You seem to be in a kitchen by a fridge. Correct?" in about a second, no network.
   The labels also ride to Claude as `facts.sceneLabels`.
5. **Narration** (`situate.ts`): every 4 s, "You are looking at …", INFO priority, never
   the same words within 30 s. The proxy now repairs long / digit speech instead of
   blanking it (`server/lib/language.ts`, verdict `repaired`).

Added later on 09-19 (round 6b, all Stream A): 24 food / kitchen COCO classes (51 scenery
classes in all — `FOOD_DETECTION_CLASSES` in contracts.ts); every detection carries `near`
from the depth grid's cell under it; the depth summary carries the grid's left / right bottom
cells and Claude reads `path: ahead blocked, left open`; scene memory (`sceneMemory.ts`) keeps
bearings for everything seen — detector boxes and Apple-classifier things like `egg` /
`milk_carton` — and answers "where's the X?" before the planner ("The eggs are to your
left." / "I have not seen a cereal yet."). Note there is no on-device *box* for eggs: COCO has
none; Claude's task_step reads them from the 768-px still, and Apple's classifier says
"egg 0.4" image-wide.

Not done / next for A: verify 1 on the device (one DebugPanel line), the ultra-wide
capture path if needed, the heading-tagged scene memory ("where's the couch?" answered
from the last minute of detections + ARKit yaw — `Geometry.yawDeg` is already per frame),
the pedestrian-signal model (`training/`, `models/manifest.json` names the file and
classes; `training/score_gate.py` decides if it ships), a 30-minute thermal soak with
the camera up in IDLE.

## Round 6c additions (same day, later)
`src/core/handGuide.ts` (the reach step steers the hand), `src/ui/HoldToTalk.tsx` (hold anywhere
to talk), `scripts/normalize-audio.sh` (cached phrases at −16 LUFS; `gen:audio` runs it),
`server/routes/crossings.ts` `warmOverpassArea` (the demo area's crossings cached at proxy
start, `server/data/cache/`, git-ignored) and the proxy's `plannerRace` (Stream C's). The
route path is 6–8 s; if "Offline" ever comes back, read the proxy log's `route` lines first.

## Round 7 (Stream A): geometry speaks
`src/core/guide.ts` turns detector boxes / memory bearings into the walking instruction
(steps from `CLASS_HEIGHT_M` and the depth grid); `src/core/handGuide.ts` steers the hand from
`onHandPose` (Vision hand pose, `HandTracker.swift`) against a target box; `guidedTask.ts`
speaks geometry first and mutes the model's sentence. The own arm is class `hand`. The step
count is a formula (distance ≈ height / (1.4 × box height)), not yet calibrated on the phone.

## Round 7b (Stream A): the proxy was lying, and the phone now keeps a diary
Two things found while chasing "it sees the fridge but cannot guide me to it":
- **Every Claude vision call had been failing since round 7.** The Messages API rejects
  `minItems`/`maxItems` on arrays in `output_config` schemas; `target.box` carried them, so
  the proxy's warm-up said `warm failed` (nobody read it) and `/api/vision` answered
  `200 { confidence: 0 }` to everything, which the phone treats as "low confidence, stay
  quiet". Fixed; a schema test forbids those keywords; the proxy now prints one line on
  boot — `vision ready` or `VISION BROKEN: …` — and the phone says "Camera brain not
  answering. Check the proxy." after four dead answers in a row (`DEAD_STREAK`). **When
  the app is silent and "confused", check the proxy log for `VISION BROKEN` first.**
- The guided task aimed its walking instruction at the plan step's `lookFor` ("kitchen
  counter") rather than the goal's place; `stepTarget()` now prefers the place when the
  detector knows it. `guide.ts` also sidesteps when the depth grid's bottom-centre cell
  is nearer than `PATH_BLOCKED`.

**Trace:** the phone posts one JSON line per decision to `POST /api/trace`; the proxy
appends to `server/data/cache/trace.jsonl`. After a run:
```bash
tail -200 aisle/server/data/cache/trace.jsonl | jq -c 'select(.kind!="seen") | {at,kind,text,target,decision,role,step,status}'
tail -200 aisle/server/data/cache/trace.jsonl | jq -c 'select(.kind=="seen") | .top'
```
Kinds: `guide` (target aimed at, instruction kind/steps/degrees, model box), `task_step`
(status, speech, done, box, latency), `seen` (top detector boxes, once a second), `said`
(every transcript line, both roles), `event` (task/hand/camera/error bus events).

## Round 8 (Stream A, with Codex's checkpoints merged): the item navigator, and a mic that hears "yes"
Read `RECOVERY-CHECKPOINT.md` for what Codex did between rounds 7b and 8 (fridge mission with
open/find/reach/confirm stages, prepared ElevenLabs clips for every guide line, detector
heartbeat/restart, playback watchdog). Round 8 on top of it:
- **`src/core/itemMission.ts`** — "find X on the Y" at home is a navigator, not a plan:
  phases `approach_item → reach → confirm`, with `approach_place → scan_place` when only the
  place is in view, `find_place` (remembered bearing, else the room question "I think the
  table is in the kitchen. Is that right?") and `find_door` (Claude boxes the doorway). Pure
  `decide(goal, state, snapshot)` + a runner that paces lines (2 s floor between different
  lines, 4 s repeat, 8 s for scan lines) and holds a flickering track 1.5 s. `guidedTask`
  delegates to it when `parseMissionGoal(goal)` matches and the context is home; fridge goals
  stay on `fridgeMission`. Claude (`task_step`, every 3 s, silent) is told `Look for: <what the
  navigator is chasing>` and its `target.box` steers things the detector has no class for.
- **`src/core/yesNo.ts`** — the one yes/no parser. Use it for every open question.
- **`voice.ts`**: tasks start without a read-back unless on-device confidence < 0.45; routes
  still confirm. `begin()` waits for the previous *capture* only (`capturing`), utterances are
  understood in order (`processing`). Short holds get a tail (`SHORT_HOLD_MS`, `SHORT_HOLD_TAIL_MAX_MS`).
  `voice_capture` trace lines now carry `startMs` (press → recogniser live): **read this first**
  when someone says the mic cuts off their first word; anything over ~400 ms means the audio
  session switch is the cost and the fix is native (keep `playAndRecord` up permanently).
- **Transcript** owns its touches (`transcript-touch-guard`) so resting a finger on it never
  opens the mic through the hold-anywhere layer — that was the "cannot scroll for a few
  seconds" bug (mic start blocks the main thread for the audio-session switch).
- Trace kinds added: `mission` (phase, key, line, what Claude is asked to box).
  ```bash
  tail -300 aisle/server/data/cache/trace.jsonl | jq -c 'select(.kind=="mission" or .kind=="said" or .kind=="voice_capture") | del(.received)'
  ```

**Speed, honestly:** the detector runs 15 fps cold and 7.5 fps once the phone reports thermal
`serious` (the engine halves every rate; the 16:00 trace shows `thermalState: serious` after
forty minutes). The slowness people felt was the decision loop (twelve seconds to the first
line), now gone. Upscaling the still sent to Claude adds nothing (no new pixels); running the
detector at 960/1280 costs 2–4× and would deepen the throttle. The right next step for far
small things is a centre-crop zoom pass on alternate detector frames (same 640 model, 2×
effective resolution) in `PerceptionEngine.swift`, and a lighter `HOME_TASK` profile (depth 5,
OCR 0) so the phone stays cool — both native, both need `npm run ios:device`.

## Round 9 (Stream A): more things, talk cues, gated pivots, coaching
- **Two detectors indoors.** `oiv7-yolo-nano` (Open Images V7, YOLOv8n) alternates frames with
  COCO nano in INDOOR_NAV / ITEM_PICKUP / AWARE (`PerceptionEngine.runDetector`,
  `detectorParity`); outdoors COCO keeps every frame. Labels → classes in
  `OpenImagesLabels.kept` (VehicleTracker.swift), score ≥ 0.35. The engine emits every live
  track (`IoUTracker.live(maxMissedFrames: 1)`), not one frame's raw list. The package is
  git-ignored: export it once per Mac (`models/README.md` has the line; ~10 s, no GPU) or the
  engine runs COCO alone and logs `oiv7-yolo-nano: not loaded (optional)`. JS side:
  `HOME_DETECTION_CLASSES` (contracts), `classForWords` synonyms, `CLASS_HEIGHT_M`, preview colours.
- **`training/brev/oiv7_home.py`** narrows that model to the ~110 kept labels and fine-tunes it
  on Brev (README there). Same label names → drop-in replacement.
- **Talk cues.** `voice.ts` `cues.listening()` fires when the recogniser is live (LISTEN haptic +
  `listen.wav`), `cues.sent()` the moment the mic closes on release (SENT haptic + `sent.wav`).
  Earcons: `scripts/generate-tones.ts`, `AudioChannels.earcon()`. Nothing else taps.
- **Pivots are gated.** A different spoken goal while a mission/trip runs → "Switch to X?"
  (`pendingConfirm.kind` `switch_task` / `switch_route`); yes pivots through `abort()`, no says
  "Keeping …". "Stop" / "cancel" still stop at once; typed input pivots directly.
- **Coaching.** `coachHand()` (guide.ts): push / other way / pull back / reach further vs grab,
  using the fingertip's depth nearness (`HandPoseEvent.near`, new native field) against the
  target box's. Navigator (`itemMission.decide`): "Keep going. Three steps more.", "Keep walking
  forward." after `MISSION_STALL_MS`, and "Stop. You passed the bananas." when a thing ≤ 2 steps
  away drops out of the bottom of the frame or behind within `MISSION_OVERSHOOT_MS`.
- Native changed (classes, second detector, hand `near`): **rebuild with `npm run ios:device -- --clean`**
  (the `--clean` matters: the Xcode project only picks up a new `.mlpackage` at prebuild).

## Round 10 (Stream A, on Codex's checkpoint): what to do when the camera sees nothing
`src/core/searchExplorer.ts` runs under the navigator whenever a home or store task has no
item and no place in view (and scene memory has no bearing for the place — that is tried
first, for `MISSION_MEMORY_MS`). Claude's `task_step` now returns a `search` observation
(`src/core/searchObservation.ts`; schema in `server/schemas/vision.ts`): the item's own
box, a barrier (closed fridge/freezer), the readable current-area sign, foods in view, the
view, quality, and up to three navigable landmarks with boxes. The explorer:
1. scans (store: both shelf faces then the aisle; home: left, right, behind — 4 s each),
2. narrates the place ("Milk and yogurt here. This seems to be dairy." → "Bananas should be
   in produce. Let me find the way."),
3. proposes a landmark (the item's section first, then aisle ends / doorways / surfaces,
   never an area already searched) and asks: "May I guide you toward the produce section?",
4. walks there by geometry through `itemLine` ("Produce display at one o'clock. Turn right a
   little, then walk eight steps." / "Keep going. Three steps more." / "… just ahead. Slow
   down." / "Here. Let me look around this spot."), with a lost-landmark grace and a 45 s cap,
5. with nothing to head for: "No landmark yet. Walk forward five steps, then I will look
   again." up to three times, then "No way on from here. Ask someone nearby, or say search again."
Memory (`memory()`, in the DebugPanel state as `searchAreas`): every place with its sign,
section, foods and outcome; `context()` tells Claude what was checked. A closed fridge or
freezer seen mid-search converts the run into the fridge mission (approach → open → find →
reach → confirm). The reach for a *food* waits for Claude's own item box within
`REACH_CONFIRM_MS` ("Hold the camera on it. Let me confirm it is the bananas.") because the
COCO detector confuses eggs and oranges; the approach itself is still steered by the
detector at fifteen frames a second.
Voice: "search again" / "keep looking" restart the scan; "where have we looked" answers from
memory; "no" to a proposal refuses that landmark; "stop" ends everything.
Cost: a task_step now returns ~300 more tokens (4–5 s round trip on Haiku); `FRESH_MS`
(8 s) and the vision timeout (8 s) are set around that. Not yet run on the phone.

## Round 11 (Stream A): reasoning when the camera does not see the thing
`src/core/hypotheses.ts` + the navigator (`itemMission.decide`). The order of thought, each
step one spoken line:
1. **The item itself** — in view (detector, or Claude's `search.item` box) → chase it; seen
   earlier → its bearing.
2. **The stated place** ("on the table") → walk there, scan it (`MISSION_SCAN_GIVE_UP_MS` 15 s).
3. **Where such things usually are** (`usualPlaces`: eggs → fridge; bananas → counter, table,
   bowl; keys → table, counter, desk, couch, nightstand, by the door; cereal → cabinet, shelf …),
   ranked by prior × evidence (in view 1.0, remembered 0.8, unseen 0.5), said as a hypothesis:
   "No keys in view. They are usually on the table." Claude's landmarks count as evidence
   (a boxed counter is a counter to walk to).
4. **Containers** (fridge, cabinet, drawer, wardrobe…): "The bottle may be inside the fridge.
   Open it, then say open." → "open" → "Point the camera inside the fridge and pan slowly."
   ("can't open it" rules it out). Dairy with no stated place goes straight to the fridge
   mission (Poon's `likelyFridgeGoal`, with its handle / open / find / reach stages).
5. **Elimination**: a place scanned without the item is dropped and named — "Not on the table.
   Maybe on the counter." → … → "I have checked the table, the counter and the desk. Where
   else should I look?" `tried` also goes to Claude in userText ("Checked without finding it").
6. **Looking around before asking**: the stated place nowhere in sight → the explorer's poses
   for `MISSION_ASK_ROOM_AFTER_MS` (12 s), only then "I think the table is in the kitchen. Is
   that right?" → doorway search.
7. **The person redirects at any time**: "try the cabinet", "it's on the table", "check the
   fridge" (`statedPlaceIn`) → "Okay. Trying the cabinet."; "where have we looked?" answers
   from `tried`.
The explorer (`searchExplorer`) takes a tick only when the navigator flags `explore` (nothing
geometric to say). Tests: `hypotheses.test.ts`, `itemMission.test.ts` (elimination, container,
redirect), `adaptiveSearch.test.ts`.

## Round 12 (Stream A): the errand parse, and exploring big spaces by coverage
- **"Go to the fridge to get the eggs" ended at the fridge door.** `itemOfGoal` read it as a
  fridge-only errand. `normalizeGoal()` (handGuide.ts) rewrites "<place> to get / and grab /
  for <item>" into "<item> in my <place>" before every parser (explicitHomeGoal, fridgeMission,
  parseMissionGoal); `fridgeMission` builds the five stages for anything that names a thing and
  ends at the door only for a bare "the fridge". Test: `normalizeGoal.test.ts`.
- **Coverage exploration** (`src/core/explorationMap.ts`): ARKit position at 10 Hz on a 1.5 m
  grid — visited cells, scanned cells, blocked headings per cell. When the explorer has no
  landmark to head for it picks the heading with the most unvisited cells the depth grid does
  not veto (ahead preferred, then a quarter turn, then around): "Turn left, then walk about ten
  steps. New ground there." → "Keep turning left." until aligned → "Drifting right. A little to
  the left." → "Stop here. Let me look around." (6 m, 10 steps or 15 s; a blockage stops it at
  once and is remembered). Five-minute budget, then "I have covered this area. Ask someone
  nearby." Without a position (mocks) the old five-steps-three-times fallback runs.
- **The right section gets a close search first**: apples and oranges in view while hunting
  bananas → "This is the right section. Let me search these shelves closely." (upper, middle,
  lower) before any proposal to leave.
`coverage()` on the explorer reports visited/scanned cells (DebugPanel via `searchAreas` soon).

## Round 13 (Stream A): the silent lines, and obstacles with names
- **Why "not on the table" felt stuck:** the walking lines were thirteen to sixteen words
  ("No bananas yet. Table just to your left. Turn left a little, then walk two steps."), and in
  dev the speech service *threw* on anything over twelve — the person heard nothing while the
  reasoning chain ran perfectly in the log. Now: `fitWords()` (phrases.ts) trims a long line
  to its action sentence and the service never throws for length (still throws in dev for
  forbidden words and digits); every template fits twelve words by construction ("slightly
  left" for under fifteen degrees, no "No bananas yet." prefix on the walk — the hypothesis
  line already said why; "Checked the table, counter and bowl. Where else?"); a test walks every
  kind × a two-word name × "seventeen steps". A usual place that is nowhere in sight gets an
  eight-second look, not fifteen, before the next guess.
- **Obstacles say what, where, how far, and the open side** (`src/core/obstacleWords.ts`):
  "Chair ahead, close. Open on your right." / "Person on your left, two steps. Open on your
  right." / "Something close ahead. Stop." — the biggest low box in the reflex's direction
  (never the hand), steps from its height, sides from the depth grid. Wired into both reflex
  speakers (`PerceptionService` CRITICAL, `indoor/obstacles.ts` INFO) through
  `describeObstacle` from composeApp; the cached "Obstacle ahead." remains the fallback when
  nothing is known.

## Round 14 (Stream A): unstuck — explore on demand, and the obstacle reflex stops nagging
- **"Obstacle ahead" on repeat while standing at a table** was the reflex reading closing-rate
  noise from panning. `bindPerceptionToApp` takes `suppressObstacle(e)`; composeApp answers
  true when the phone is stationary (< 0.15 m/s over two seconds of ARKit pose), when the
  mission is deliberately at a surface (scan_place / open_place / reach / confirm, the fridge's
  open / find / confirm stages), or when the thing the reflex sees *is* the mission's target
  (walking up to the fridge). The haptic and the line are skipped; the bus event still fires.
  The same described line repeats no sooner than eight seconds (four for a new one).
- **Explore on demand.** "explore", "look somewhere else", "it's not here", "next aisle",
  "another room", "move on" → `mission.explore()` → the current place is marked tried and the
  explorer leaves at once (`exploreNow`): a fresh landmark of the wanted kind without asking
  ("Okay. Heading for the aisle end."), else a coverage leg ("Okay. Walk forward about ten
  steps. New ground that way."), else the plain advance. Works for the fridge search too.
- **The explorer has the tick while it moves.** Its lines (legs, drift nudges, arrivals) win
  over the navigator's; the navigator holds its guesses (`exploring` in the snapshot) instead of
  hopping hypotheses silently under a moving explorer; when the explorer is quiet the
  navigator's new-guess line still goes out. A leg not ticked for eight seconds is dropped.

## Round 15 (Stream A): the table that was "left… right… left…"
A remembered bearing within a few degrees of straight ahead flips sign with every head wobble,
and each flip was "news" to the line pacing. Three guards in `itemMission`: under twenty
degrees the line is "Table should be straight ahead. Hold the camera level."; a remembered side
must hold for two ticks before it replaces the other side; and turning toward a remembered
bearing that never brings the thing into view times out after `MISSION_MEMORY_MS` (12 s) —
"I cannot find the table I remembered. Let me look around." — after which that memory is
ignored for `MISSION_MEMORY_DOUBT_MS` (30 s) and the explorer takes over. The guide also walks
to a table the detector holds at half confidence (0.5, was 0.6), which is often why the
"remembered" path was running while the table was in plain view.

## Things a newcomer trips on
- Speech is a single queue with a mode policy (`src/core/speech.ts`): one pending NAV
  item (newest wins), INFO dropped if anything is queued, 4 s minimum gap, CRITICAL
  pre-empts. When "it didn't say X", it usually said something newer instead. The
  transcript panel logs what was queued, not only what played.
- Every spoken line is ≤ 12 words, digits as words, never `safe / clear / go now / cross
  now / no cars / you can cross`. `npm run lint:phrases` scans string literals. The proxy
  applies the same rule to Claude's `speech`.
- Vision questions are a closed enum (`VisionQuestion`) with per-question min interval,
  snapshot width and scene gating in `semanticVision.ts`; the server schema/prompt are in
  `server/schemas/vision.ts` and `server/prompts/vision.ts`. Adding a question or a
  response field means: contract, client coerce/empty, mock, server schema/empty/coerce,
  prompt, and the vision schema tests (field order is asserted).
- The mode → perception profile table is `src/perception/profile.ts`; IDLE now runs the
  indoor schedule so the camera is up from launch (the obstacle reflex is off in IDLE).
- Nemotron's hosted endpoint rejects `nvext.guided_json` and stalls on streaming; the
  proxy uses non-streaming `json_object` with the schema in the prompt, a first-token
  deadline, the Haiku understudy, then the local template. Read `server/routes/plan.ts`.
- Cached ElevenLabs phrases: `src/core/phrases.ts` → `npm run gen:audio` (needs the key)
  → `assets/audio/*.mp3` + `manifest.ts`. A new phrase without audio falls back to
  expo-speech; still commit the audio.
- Google Routes is disabled on the Google project (188682982044) until someone enables the
  Routes API and unrestricts the key; the route path degrades to a straight-line leg.

## Git / process
`git log` is the narrative; every commit message says why. CI runs the gates on every PR.
Commits are authored as Alex; the assistant lines are `Co-Authored-By`. Secrets never enter
the tree (`server/.env`, checked before every push).
