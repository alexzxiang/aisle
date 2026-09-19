# Aisle — handoff notes (for a person or a model picking this up cold)

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
cd aisle && npm run lint && npx jest                    # typecheck + phrase/deps lint + 1031 tests
cd aisle/server && npx tsc --noEmit && npx vitest run   # 162 tests
cd aisle && npm run ios:check                           # Swift compiles
# live, with the proxy up:
curl -s localhost:8787/api/health | head -c 300
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
