# Aisle

A phone-only navigation aid for blind and low-vision users, built for SteelHacks XIII.
It takes a person along the street, across a signalized or unsignalized crossing, into a
grocery store nobody surveyed, to a requested item and on to checkout, using one standard
iPhone. Haptics carry real-time signals, speech carries meaning, and the app **informs;
it never decides a crossing**. Full brief: [`../00-PROJECT-BRIEF.md`](../00-PROJECT-BRIEF.md).

Aisle is a prototype supplement to a cane or guide dog, not a safety device. The first
launch says so out loud before anything else.

## What is in this repository

| Path | What | Owner |
|---|---|---|
| `App.tsx` | Composition root: builds every service once, registers them, renders the screens | A |
| `src/core/` | Contracts, event bus, state machine, haptics, speech queue, beacon/ticker, sensor fusion, push-to-talk, persisted prefs, `composeApp.ts`, `trip.ts` | A |
| `src/ui/` | Home, onboarding, trip screen, DebugPanel, settings | A |
| `assets/audio/`, `scripts/` | Cached phrases, tone generation, the phrase lint | A |
| `src/outdoor/`, `src/crossing/`, `server/routes/plan.ts`, `server/routes/route.ts` | Routing, leg guidance, crossing controller, Nemotron job schemas and eval | B |
| `modules/perception/`, `src/perception/`, `src/indoor/`, `models/` | The Swift `Perception` module (ARKit, Vision OCR, CoreML), its JS bridge, Tier-1 vision client, indoor navigator | C |
| `server/` (core), `mocks/`, `fixtures/`, `src/transition/`, `training/` | The proxy, mock mode, fixtures, store-entry detector, CV training track | D |

Nobody edits another owner's directory; cross-track changes go through
[`../01-SHARED-CONTRACTS.md`](../01-SHARED-CONTRACTS.md) (flag, ack, then change).

## Requirements

- Node 20+, npm.
- **Expo SDK 57 development build.** Expo Go is not supported: the app needs the local
  `Perception` native module (`modules/perception`).
- iOS: Xcode 16+ with the iOS 17 SDK, CocoaPods, a paid Apple Developer team for device
  builds. There is no Android build.
- Forbidden dependencies (CI-checked by `npm run lint:deps`): `expo-av`, `expo-camera`,
  `react-native-vision-camera`. The camera belongs to the Swift module alone.

## Run in mock mode (no store, no walking, no camera, no keys)

Mock mode replays fixtures for sensors, perception, the Tier-1 vision client and the
planner; the route comes from the track fixture; speech and haptics stay real. It is the
demo backup and the environment every track develops against.

```bash
npm install
npx expo prebuild --platform ios          # once, or after a native change
npx expo run:ios --device                 # builds and installs the dev client
npm run start:mock                        # EXPO_PUBLIC_MOCK=1 expo start --dev-client
```

On the phone: type an item ("eggs") or hold the talk button. Long-press the mode word for
the DebugPanel: jump to any mode, scrub the replay track, force the store entry, set a
manual signal state, inject scan results, mute the beacon or ticker.

Without a running proxy, live text-to-speech falls back to `expo-speech` after its
budget, and the Tier-1/Tier-2 clients answer from fixtures.

## Run live

1. Start the proxy (keys stay there, never in the app):

   ```bash
   cd server && cp .env.example .env      # fill ANTHROPIC_API_KEY, NVIDIA_API_KEY, ELEVENLABS_API_KEY,
                                          # ELEVENLABS_VOICE_ID, GOOGLE_MAPS_API_KEY (OPENROUTER_API_KEY optional)
   npm install && npm run dev             # binds 0.0.0.0:8787; /api/health shows every upstream
   ```

   Or from the app root: `npm run proxy`.

2. Generate the cached phrases once (needs the ElevenLabs key locally):

   ```bash
   ELEVENLABS_API_KEY=… ELEVENLABS_VOICE_ID=… npm run gen:audio
   ```

   Until this runs, `assets/audio/manifest.ts` is empty and every phrase falls back to
   `expo-speech` (the DebugPanel shows which backend spoke last).

3. Point the app at the proxy and start the dev server:

   ```bash
   EXPO_PUBLIC_PROXY_URL=http://<host>:8787 npx expo start --dev-client
   ```

## Environment variables (app)

| Variable | Meaning | Default |
|---|---|---|
| `EXPO_PUBLIC_PROXY_URL` | `http(s)://host:port` of the proxy | `http://localhost:8787` |
| `EXPO_PUBLIC_PROXY_WS` | `ws(s)://host:port/ws` for the streamed vision channel | derived from the proxy URL |
| `EXPO_PUBLIC_MOCK` | `1` swaps in `mocks/` at the composition root; nothing else reads it | unset |

`EXPO_PUBLIC_*` values are inlined at bundle time; restart `expo start` after changing them.

## Build

**Mac (local device build):**

```bash
npx expo prebuild --platform ios --clean
npx expo run:ios --device                 # or open ios/Aisle.xcworkspace in Xcode
```

The `Perception` pod is autolinked from `modules/perception` (check with
`npx expo-modules-autolinking resolve -p ios`). CoreML models are bundled from `models/` by
`plugins/withCoreMLModels.js` on every `prebuild` (it copies them to `ios/models/` and adds
them to the app target; Xcode compiles `.mlpackage` → `.mlmodelc`). A checkout without weights
still builds and the engine reports the missing model.

**Getting the model weights** (git-ignored, exported per machine — `models/LICENSES.md`):

```bash
npm run models:venv     # once: Python 3.12 venv with ultralytics + coremltools (numpy<2)
npm run models:coco     # COCO YOLO11n → models/coco-yolo-nano.mlpackage (vehicles, people)
npm run models:depth    # Apple's Depth Anything V2 Small → models/depth-anything-v2-small.mlpackage
npx expo prebuild --platform ios   # re-run after adding a model so it is bundled
```

The pedestrian-signal model (`ped-signal-v1`) comes from the training track
(`training/README.md`); until it exists the crossing beat runs on rungs 2–3 (03 §fallback).

**Signing (first device build on a Mac):** Xcode → Settings → Accounts → add the team's
Apple ID → Manage Certificates → *Apple Development*. Set `expo.ios.appleTeamId` in
`app.json` to the 10-character Team ID so `prebuild` and EAS carry it; otherwise pick the
team once in `ios/Aisle.xcworkspace` → Signing & Capabilities. On the phone: Developer Mode
on, then trust the developer under Settings → General → VPN & Device Management.

**EAS (internal distribution, for the teammate without a Mac):**

```bash
eas device:create                          # register the phone's UDID once
eas build --profile development --platform ios
```

Install from the link, then run your own `npx expo start --dev-client`. Native changes
(Swift, models, permission strings) are batched; JS-only changes never need a rebuild.

## Checks

```bash
npm run lint          # tsc, forbidden-deps grep, forbidden-phrase lint
npm test              # Jest (jest-expo), tests live next to the code
npm run test:server   # the proxy's vitest suite
npm run test:all
```

The phrase lint rejects the words *safe, clear, go, cross now, no cars, you can cross* in
any string literal under `src/`, `server/`, `mocks/`, `fixtures/` and `App.tsx`, and caps
spoken text at twelve words. The speech service enforces the same at runtime.

## How the pieces meet

- `App.tsx` builds the platform edges (expo-haptics, expo-audio, expo-speech,
  expo-location/sensors, expo-speech-recognition, expo-file-system, the native module) or
  D's mocks, then calls `src/core/composeApp.ts`, which wires the whole graph and registers
  the six shared services in `src/core/services.ts`.
- `src/core/trip.ts` turns an item request into one outdoor session (B's controller and
  runner, built per trip), starts it with the store-JSON entrance once the item resolves,
  runs D's handoff announcement on `STORE_ENTERED`, and tears everything down on abort.
- Only the store writes `mode`; every other module emits events and subscribes.

## Documents

- [`00-PROJECT-BRIEF.md`](../00-PROJECT-BRIEF.md), [`01-SHARED-CONTRACTS.md`](../01-SHARED-CONTRACTS.md)
- Agent briefs: [`02` core shell](../02-AGENT-A-core-shell.md), [`03` outdoor and crossing](../03-AGENT-B-outdoor-crossing.md), [`04` perception and indoor](../04-AGENT-C-perception-indoor.md), [`05` harness, transition, demo](../05-AGENT-D-harness-transition-demo.md)
- [`06-INTEGRATION-AND-DEMO.md`](../06-INTEGRATION-AND-DEMO.md), [`07-SPONSOR-STACK.md`](../07-SPONSOR-STACK.md), [`08-ROADMAP-AND-CONCERNS.md`](../08-ROADMAP-AND-CONCERNS.md), [`09-PERCEPTION-MODULE.md`](../09-PERCEPTION-MODULE.md), [`10-CV-TRAINING-TRACK.md`](../10-CV-TRAINING-TRACK.md), [`11-PHASE-0-CHECKLIST.md`](../11-PHASE-0-CHECKLIST.md)
- Nemotron eval: [`server/routes/plan.eval.md`](server/routes/plan.eval.md). Fixtures: [`fixtures/README.md`](fixtures/README.md). Training data and licences: [`training/README.md`](training/README.md), [`training/LICENSES.md`](training/LICENSES.md), [`models/LICENSES.md`](models/LICENSES.md).

## Attribution

Speech is synthesized with **ElevenLabs** (`eleven_flash_v2_5`, Scribe for speech-to-text).
Route compilation, intent parsing and disambiguation run on **NVIDIA Nemotron**
(`nvidia/nemotron-3.5-lightning-30b-a3b` via NIM). Scene questions go to Claude. Walking
directions come from the Google Routes API and are in beta; the app displays Google's
warning on the home screen. Crossing locations come from OpenStreetMap contributors and the
WPRDC signalized-intersection dataset. Street and store video never leaves the phone.
