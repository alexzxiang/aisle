# 02 — Agent A: Core Shell & Shared Services

**You are the spine.** Three other agents are blocked until your contracts file and stub
implementations exist. Ship stubs in hour one, refine after. You also own the two things the
user feels most: the haptic rule and the speech queue. Everything you build runs on-device
and never waits on the network.

**Machine:** Mac 2 (builds the demo phone). **Owns:** `src/core/`, `src/ui/`, `App.tsx`,
`assets/audio/`, `scripts/` (audio generation, phrase lint), `eas.json`, `app.json`.
**Never touches:** `src/outdoor/`, `src/crossing/`, `src/perception/`, `src/indoor/`,
`src/transition/`, `modules/perception/`, `models/`, `server/`, `mocks/`, `fixtures/`,
`training/`. Contract changes are flagged in `01-SHARED-CONTRACTS.md` first, never made
unilaterally.

---

## Hour-one deliverable (blocking for everyone else)

Before building anything else, create and commit:

1. `src/core/contracts.ts` — every type from `01-SHARED-CONTRACTS.md`, verbatim, types only.
   Includes the twelve `AppMode`s, `HapticPattern` + `CourseError`, `SpeechRequest`,
   `SensorService` (with `Pose`, `TrackingState`, `courseErrorFor`), the full `AppEvent`
   union (`CROSSING_AHEAD`, `SIGNAL_STATE`, `VEHICLE_APPROACHING`, `SCAN_RESULT`,
   `FAR_CURB_REACHED`, `COURSE_DEVIATION`, `OBSTACLE_AHEAD`, `CAMERA_REQUEST`, `USER_ACTION`,
   `ITEM_HAND_GUIDANCE`, ...), `StoreMap`, `PerceptionService`, `VisionRequest/Response`,
   the Planner jobs, `CrossingController`, `TransitionDetector`.
2. `src/core/stubs.ts` — no-op `HapticService`, `SpeechService`, `SensorService`, `EventBus`
   that log every call with a timestamp. `EventBus` must actually work (it is trivial and
   everyone needs it on hour one); the rest may log.
3. `src/core/bus.ts` — the real `EventBus`: typed `emit`/`on`, synchronous dispatch, every
   event stamped `{ts, seq}` into a ring buffer of 200 for the DebugPanel and latency
   measurement.
4. `src/core/store.ts` skeleton with `mode`, `setMode()` and the legal-transition table.

Push this first. Agents B, C, D import from it immediately. Anything in `contracts.ts` that
differs from 01 is a bug, not a decision.

---

## Task 1 — Project scaffold (Expo development build, SDK 57 pinned)

No Expo Go anywhere: `expo-av` is gone, the login requirement bites on demo day, and the
native `PerceptionModule` cannot load in it. The app is a development build from day one.

```bash
npx create-expo-app aisle --template blank-typescript
cd aisle
# pin before installing anything else; SDK 58 is in beta and create-expo-app may drift
npm pkg set dependencies.expo="~57.0.23"
npx expo install expo-dev-client expo-audio expo-haptics expo-location expo-sensors \
  expo-speech expo-file-system expo-keep-awake expo-speech-recognition
npm i zustand
npx expo install --check      # every expo-* at its SDK 57 version, nothing else
```

Expected SDK 57 versions [verified 2026-09-16]: `expo-audio ~57.0.5`, `expo-haptics
~57.0.3`, `expo-location ~57.0.18`, `expo-sensors ~57.0.3`, `expo-speech ~57.0.3`,
`expo-file-system ~57.0.7`, `expo-keep-awake ~57.0.2`, `react-native 0.86.3`.
`expo-speech-recognition 57.1.0` is a config plugin (dev build only).

**Must be absent from `package.json`:** `expo-av`, `expo-camera`,
`react-native-vision-camera`. Add a CI grep for all three. The camera belongs to Agent C's
Swift module (`09-PERCEPTION-MODULE.md`), full stop.

### `app.json`

```json
{
  "expo": {
    "name": "Aisle", "slug": "aisle", "version": "0.1.0",
    "ios": {
      "bundleIdentifier": "edu.steelhacks.aisle",
      "infoPlist": {
        "NSCameraUsageDescription": "Aisle reads signs and signals through the camera.",
        "NSLocationWhenInUseUsageDescription": "Aisle needs your location to guide you.",
        "NSMotionUsageDescription": "Aisle counts steps to estimate progress.",
        "NSMicrophoneUsageDescription": "Aisle listens only while you hold the talk button.",
        "NSSpeechRecognitionUsageDescription": "Aisle turns your request into text on this phone.",
        "NSLocalNetworkUsageDescription": "Development server discovery.",
        "UIRequiredDeviceCapabilities": ["arkit"]
      }
    },
    "plugins": [
      "expo-dev-client", "expo-location", "expo-sensors", "expo-audio",
      ["expo-speech-recognition", { "speechRecognitionPermission": "Aisle turns your request into text on this phone.",
                                     "microphonePermission": "Aisle listens only while you hold the talk button." }]
    ]
  }
}
```

The strings are read aloud by iOS; keep them honest and short. All six must exist before
the first `prebuild`, or someone rebuilds native code to add one. Do not add
`UIBackgroundModes`: the phone stays unlocked and foregrounded (Task 5) by design.

### `eas.json` (for the Windows user; Macs build locally)

```json
{
  "cli": { "version": ">= 16.0.0" },
  "build": {
    "development": {
      "developmentClient": true, "distribution": "internal",
      "ios": { "simulator": false }, "channel": "development"
    }
  }
}
```

Flow: `eas device:create` (registers the Windows user's iPhone UDID against the paid Apple
Developer team) → `eas build --profile development --platform ios` → install from the link →
`npx expo start --dev-client` on Windows. Free-plan queue can be 90+ minutes at peak
[verified]; **batch native changes** (Swift module, new CoreML models, new permission
strings) and rebuild for the Windows phone at most twice a day. JS-only changes never need a
rebuild. Mac users: `npx expo prebuild` once, then `npx expo run:ios --device` (~2 min after
the first 20–40 min build). Re-run on the demo phone the morning of the demo.

### Directory layout (create all, even empty — prevents merge conflicts)

```
App.tsx                      composition root (A): wires bus, store, services, screens
src/
  core/       contracts.ts stubs.ts bus.ts store.ts haptics.ts speech.ts phrases.ts
              audio.ts sensors.ts voice.ts                                   (A)
  ui/         HomeScreen.tsx NavScreen.tsx OnboardingScreen.tsx DebugPanel.tsx (A)
  outdoor/    .gitkeep   (B)      src/crossing/    .gitkeep   (B)
  perception/ .gitkeep   (C)      src/indoor/      .gitkeep   (C)
  transition/ .gitkeep   (D)
modules/perception/   .gitkeep   (C — Swift + JS bridge, Expo Modules API)
models/               .gitkeep   (C — .mlpackage + licences)
server/               .gitkeep   (D proxy core; B owns routes/plan.ts, routes/route.ts)
mocks/  fixtures/     .gitkeep   (D)
training/             .gitkeep   (D — CV track)
assets/audio/         cached phrases, beacon_L.mp3, beacon_R.mp3, tick.mp3   (A)
scripts/              generate-audio.ts  lint-phrases.ts                     (A)
```

`App.tsx` calls `useKeepAwake()` at the top of the tree and constructs every service once.
Mode-driven behaviour lives in each service's own store subscription; `App.tsx` passes no
mode around.

---

## Task 2 — State machine (`src/core/store.ts`)

Zustand store:

```ts
{
  mode: AppMode,                       // one of the twelve in 01 §1
  firstRun: boolean,                   // gates ONBOARDING and the disclaimer
  trainingMode: boolean,               // default true: haptics are spoken too
  speechRate: number,                  // 0.8–1.6, expo-audio playbackRate
  targetItem: string | null,
  storeId: string | null,
  targetAisleId: string | null,
  targetSide: Side | null,
  currentAisleOrder: number | null,
  activeCrossingId: string | null,
  lastFix: GeoFix | null,
  heading: HeadingSample | null,
  bodyOffsetDeg: number,
  lastEvents: Array<AppEvent & { ts: number }>,   // ring of 10 for the DebugPanel
  setMode(m: AppMode): void,           // validates legal transitions, logs illegal ones
}
```

`setMode` **rejects illegal transitions** (table in 01 §1), logs a loud warning and emits
`ERROR {scope: 'store'}`. A wrong mode transition is the most likely cause of a confusing
failure in a live demo; make it visible, never silent. Only the store writes mode. B, C and
D emit events; the store subscribes to the bus and drives every transition:

| Event (emitter) | Transition |
|---|---|
| `ITEM_REQUESTED` (A) | sets `targetItem`; `IDLE → ONBOARDING` if `firstRun`, else waits for `ROUTE_READY` |
| onboarding finished + `ROUTE_READY` (B) | `ONBOARDING → OUTDOOR_NAV` |
| `CROSSING_AHEAD` (B) | `OUTDOOR_NAV → APPROACH_CROSSING`; sets `activeCrossingId` |
| `ROUTE_READY` while approaching (B, re-plan) | `APPROACH_CROSSING → OUTDOOR_NAV` |
| `CURB_REACHED` (B) | `APPROACH_CROSSING → AT_CURB` |
| `CROSSING_STARTED` (B) | `AT_CURB → CROSSING` |
| `FAR_CURB_REACHED` (B) | `CROSSING → OUTDOOR_NAV`; clears `activeCrossingId` |
| `STORE_ENTERED` (D) | `OUTDOOR_NAV → TRANSITION`; speak `entering_store`; auto `→ INDOOR_NAV` when it ends (3 s cap) |
| `TARGET_AISLE_REACHED` (C) | `INDOOR_NAV → AT_ITEM`; sets `targetSide` |
| first `ITEM_HAND_GUIDANCE` (C, stretch) | `AT_ITEM → ITEM_PICKUP` |
| `ITEM_HAND_GUIDANCE {hint: 'touching'}` or `step ≥ 8`, or user tap "next" | `ITEM_PICKUP / AT_ITEM → CHECKOUT_NAV` |
| `CHECKOUT_REACHED` (C) | `CHECKOUT_NAV → DONE` |
| abort (big button hold 2 s, `parseIntent` = `abort`, DebugPanel) | `* → IDLE` |

`STORE_ENTERED` arriving in `APPROACH_CROSSING`/`AT_CURB`/`CROSSING` is logged and dropped
(illegal by 01 §1); D's detector should not fire there, and if it does the crossing wins.
On `IDLE` every service stops: COURSE off, beacon off, ticker off, queue flushed, and
Agent C's `PerceptionService.stop()` is called from `App.tsx`. On leaving `ONBOARDING`,
`App.tsx` calls `PerceptionService.start(profile)`; the profile-per-mode mapping is C's
subscription (01 §7), not yours.

---

## Task 3 — HapticService (`src/core/haptics.ts`)

Four patterns. Not five. Silence is the reward; the old hot/cold ALIGNED ramp does not exist.

### Discrete patterns (`play`)

```
TURN    : impactAsync(Light) → Medium → Heavy, 110 ms apart      ("rotate now")
STOP    : notificationAsync(Error) + 3× impactAsync(Heavy) 70 ms apart (~350 ms)
CONFIRM : impactAsync(Light) ×1                                  ("acknowledged / arrived / re-aligned")
```

`expo-haptics` on iOS is UIFeedbackGenerator transients only: no continuous event, no
custom duration [verified]. STOP is therefore a dense burst, not a true long buzz. Optional
phase-2 polish, behind a flag and the same interface: a ~100-line local Expo module
(`modules/haptics/`, Core Haptics) giving STOP one 400 ms continuous event and COURSE a real
intensity-modulated buzz. It is the first thing dropped if the +6 h gate slips; do not start
it before Task 5 is done.

`play()` fires in < 100 ms, fully on-device. `STOP` pre-empts COURSE for 1 s; COURSE resumes
without a CONFIRM. In `trainingMode` each `play()` also speaks a one-word label
(`INFO`, dedupe 3 s): "turn", "stop", "okay".

### COURSE (`startCourse(getError)` / `stopCourse()`)

A continuous service polling `getError()` at 10 Hz. The same rule runs on route legs, at
the curb, mid-crossing and down an aisle, so it is learned once.

- **Dead zone** by `compassAccuracy`: 12° at 3, 18° at 2. At 1 or 0: no course buzz, say
  `compass_uncertain` once (dedupe 30 s), keep polling.
- **Roadward drift:** an error also exists when `crossTrackM > 0.5` toward `roadSide` **and**
  `sign(headingErrorDeg)` points toward `roadSide` (two agreeing signals). Drift away from
  the road relies on heading alone. `roadSide: 'NONE'` (indoors) uses heading and
  `|crossTrackM| > 0.5` from either side.
- **Hysteresis:** error must persist 0.5 s to start, and sit inside the dead zone 0.5 s to
  stop. Minimum burst 150 ms. Buzz fatigue is a safety failure.
- **Ramp** (pulse train on `expo-haptics`): let `e = |headingErrorDeg| − deadZone` (plus
  20° per 0.5 m of qualifying drift). Interval `clamp(600 − 8·e, 150, 600)` ms; style
  Light for `e < 15`, Medium to 40, Heavy above. A change in `getError()` is audible in the
  buzz in < 200 ms.
- **Re-alignment:** the first time the error re-enters the dead zone after `play('TURN')`,
  fire one `CONFIRM`, then silence. No other automatic CONFIRM.
- **Side:** a single motor carries magnitude only. Direction comes from the beacon when it
  is active (Task 5); when it is not, and the error has persisted > 5 s, say
  `course_hint_left` / `course_hint_right` once (`NAV`, dedupe 8 s). These are A-side keys,
  deliberately **not** the Tier-1 prompts `turn_left_a_little` / `turn_right_a_little` that
  01 §3 lists and `04-AGENT-C-perception-indoor.md` emits: that pair is gated "never while
  the COURSE buzz is active" (01 §8, streaming contract item 4), which is exactly when this
  hint is needed. Two mechanisms, two keys, one gate keyed by `cacheKey` (Task 4), so
  neither silences the other. The two new keys are an A-side addition to 01 §3's cache-key
  list; flag them there before any other agent uses them.
- Emit `COURSE_DEVIATION {meters, side}` on the bus when the roadward rule trips (once per
  episode), so the DebugPanel and B's controller can see it.

Test every pattern through a lanyard-mounted phone at chest height, not in a pocket — the
vision legs need the phone in view. Low Power Mode disables haptics; recording audio
sessions suppress them on iOS (see Task 5).

---

## Task 4 — SpeechService (`src/core/speech.ts`) — ElevenLabs, two tiers

You own the ElevenLabs integration. Model `eleven_flash_v2_5` for everything (Turbo is
deprecated). Flash does no text normalization: numbers are written as words by the caller
and re-checked here (a digit in `text` is rejected in dev).

### Cached tier (build first)

- `src/core/phrases.ts`: the ~40 canonical phrases keyed exactly as 01 §3 lists them
  (`disclaimer`, `compass_uncertain`, `crossing_ahead_signalized`, ..., `offline_notice`),
  plus the two A-side COURSE side-hint keys `course_hint_left` / `course_hint_right`
  (Task 3) — an addition to 01 §3, flagged there before anyone else calls them.
  The text in this file is the only permitted wording; other agents pass `cacheKey`s.
- `scripts/generate-audio.ts`: one ElevenLabs call per phrase, ≤ 4 in flight (free-plan
  concurrency), writes `assets/audio/<cacheKey>.mp3`. Commit the files; regenerate only
  when text changes. One voice ID across cached and live tiers (voice choice in
  `07-SPONSOR-STACK.md`), or the seam is audible.
- Preload every file with `expo-audio` at module scope; replay is `seekTo(0); play()`.
  Cached phrase → audio out < 50 ms. Verify in airplane mode.

### Live tier

- Only text containing runtime-variable words (street names, aisle labels). B and C call
  `prefetch(text): Promise<string>` at route load / store load; it POSTs `/api/tts`, writes
  the clip to the `expo-file-system` cache directory and returns a runtime `cacheKey`, so
  nothing is synthesized during the walk. (`prefetch` is an A-side extension; flag it for
  01 §3 before B relies on it.)
- `playStream(streamId, priority)`: the Tier 1 path (01 §8). The proxy relays ElevenLabs
  audio at `GET /api/tts/stream/<streamId>`; play it as an `expo-audio` URL source. Chunked
  MP3 without `Content-Length` through AVPlayer is **[verify in phase 0]**; if it stalls,
  D's proxy buffers the clip and serves it with a length (adds ~300–600 ms) and the
  streaming budget in 01 §11 is re-measured. Live first audio < 400 ms measured on-device.
- Any `say()` without a `cacheKey` and without network falls back to `expo-speech`. iOS
  mutes `expo-speech` when the ring switch is silent [verified]; `expo-audio` plays in
  silent mode by default. Onboarding tells the user to keep the switch on ring; the
  DebugPanel shows which backend spoke last.

### Queue rules (enforced here, never by callers)

- One **current playback handle** across cached player, live player and `expo-speech`.
  `CRITICAL` stops whichever is active, flushes everything below it, and plays at once.
- `NAV` queues, max one pending (newest wins). `INFO` is dropped if anything is queued.
- `dedupeKey` within `cooldownMs` (default 8000) is dropped silently.
- Never more than one utterance per 4 s outside `CRITICAL`; utterance ≤ 2 s.
- `text` > 12 words: throw in dev, truncate at 12 in prod, emit `ERROR {scope: 'speech'}`.
- **Forbidden words:** safe, clear, go, cross now, no cars, you can cross. Runtime check on
  every `text` (regex on word boundaries; identifiers such as `clearQueue` are not text) —
  throw in dev, drop + `ERROR` in prod. `scripts/lint-phrases.ts` greps `phrases.ts`,
  `src/**`, `server/**`, `fixtures/**` string literals for the same regex and fails the
  pre-commit hook. Run it on the pitch script in `06-INTEGRATION-AND-DEMO.md` too.
- Mode policy from 01 §3, read from the store, not from callers: OUTDOOR_NAV /
  APPROACH_CROSSING — leg instructions, crossing facts, `compass_uncertain`; **AT_CURB —
  signal transitions, vehicle alerts, scan reports, `compass_uncertain`, nothing else**;
  CROSSING — vehicle alerts, `countdown`, `far_curb`; indoor modes — aisle facts, obstacle,
  camera/user prompts; any mode — disclaimer, `offline_notice`, abort. A request outside the
  policy is dropped and counted in the DebugPanel, not spoken.
- `cameraRequest` / `userAction` prompts (C emits `CAMERA_REQUEST` / `USER_ACTION`; you
  speak them as `tilt_camera_up`, `turn_left_a_little`, `turn_right_a_little`): ≤ 6 words,
  ≤ 1 per 3 s, never while COURSE is buzzing (01 §8 item 4, restated in 04). The gate is on
  **that key class**, not on the words: A's own `course_hint_left` / `course_hint_right`
  (Task 3) are exempt, the one `NAV` utterance the gate lets through while the buzz runs
  (`CRITICAL` was never gated). At AT_CURB and CROSSING the mode policy above drops the
  side hint anyway, which is the intended near-silence at the curb.
- `setRate(rate)`: `expo-audio` `setPlaybackRate` with pitch correction, 0.8–1.6, applied
  to every player. One file set serves all rates.
- Utterances per minute is counted here and shown in the DebugPanel. Above ~8 the app is
  too chatty and someone's priorities are wrong.

---

## Task 5 — Audio channel manager (`src/core/audio.ts`)

Owns the audio session and the two non-speech channels. Speech (Task 4) has priority over
both; the ticker and the beacon never play together.

### Audio session

At start: `setAudioModeAsync({ playsInSilentMode: true, interruptionMode: 'duckOthers',
shouldPlayInBackground: false, allowsRecording: false })`. `duckOthers` lowers VoiceOver and
music instead of stopping them [verified]. `allowsRecording` flips to `true` only for the
push-to-talk window (Task 7) and back the moment recording stops: a recording-category
session moves Bluetooth headsets to low-fidelity HFP and suppresses haptics on iOS
[verified]. Bluetooth adds 150–250 ms; urgent cues stay haptic. Guided Access on during use.

### Direction beacon (Soundscape-style: direction, not distance)

- `beacon.setTarget({ bearingDeg } | null)`; it reads `SensorService.getFusedHeadingDeg()`
  at 10 Hz and pans by relative bearing. Steady pulse every 1 s; an extra short tick when
  the target is inside the ±15° forward window. Never changes with distance (a constantly
  changing signal fatigues); distance is spoken ("twenty feet").
- **Pan without a pan API.** `expo-audio` exposes no pan or balance property [verified].
  Ship `beacon_L.mp3` (hard-left) and `beacon_R.mp3` (hard-right), play both looped on two
  players and set their volumes by a constant-power law from the relative bearing. Restart
  both together on every target change to limit loop drift. If a native audio module is
  ever written, `AVAudioPlayer.pan` is the upgrade; not before phase 2.
- Active windows, set by B / D through `setTarget`: last ~40 m before a maneuver point,
  toward `farCurb` during CROSSING, last 40 m to the entrance. Off indoors.
- Ducked to silence while any speech plays; at AT_CURB only when the ticker is silent
  (state UNKNOWN or unsignalized crossing) and then one pulse per 3 s toward the crossing
  bearing.

### Signal-state ticker (OKO-style tempo)

- `ticker.setState(SignalState)`, driven by `SIGNAL_STATE` from the bus in AT_CURB and
  CROSSING. `tick.mp3` on a timer: DONT_WALK 1 tick/s, COUNTDOWN 2/s, WALK 4/s, UNKNOWN
  silent. Tempo, not speech, carries the state; B's controller speaks the transitions.
- Continues into CROSSING; stops at `FAR_CURB_REACHED` or mode change. A change in state
  reaches the ticker in < 150 ms end-to-end (C's frame → your timer restart).

Priority: speech > ticker (AT_CURB) / beacon (CROSSING, outdoors) > nothing. Both channels
subscribe to the store; on IDLE both stop.

---

## Task 6 — SensorService (`src/core/sensors.ts`)

- **Heading:** `expo-location.watchHeadingAsync` → `trueHeading`, `accuracy` 0–3 (3 = < 20°).
  Never the raw magnetometer. `headingOrientation` is portrait by default, which matches a
  chest-mounted portrait phone.
- **Location:** `watchPositionAsync` with `Accuracy.BestForNavigation`, ~1 Hz; publish
  `GeoFix` with `courseDeg` null under 0.5 m/s.
- **Steps:** `expo-sensors` `Pedometer.watchStepCount`; `getStepsSince(ts)` from a
  timestamped ring. Stride prior 0.7 m; not delivered in background (another reason for
  keep-awake).
- **Pose:** `subscribePose` re-emits Agent C's `PerceptionService.onPose` (10 Hz) and
  `onTrackingState`; in mock mode both come from D's replayer.
- **Fused heading (`getFusedHeadingDeg`)**: ARKit `yawDeg` plus a correction
  `offset = circularMean(trueHeading − yaw)` over the last 10 s of samples taken while
  `accuracy ≥ 2` and tracking `NORMAL`, minus `bodyOffsetDeg`. Tracking not NORMAL → gated
  `trueHeading` alone. Compass below 2 with tracking NORMAL → yaw + last offset for ≤ 30 s,
  then `null`. The fused sample inherits the compass tier from the last offset refresh, so
  `CourseError.compassAccuracy` stays honest.
- **`calibrateBodyOffset()`** — the "walk straight for five seconds" routine, run from
  onboarding and re-armed whenever GPS course and fused heading disagree by > 10° for
  > 10 s while `speedMps > 0.5`. Offset = circular mean of `courseDeg − trueHeading` over
  the window; `ok` when the spread is < 15°. Pass the result to
  `PerceptionService.setBodyOffsetDeg` (C applies it before every heading comparison).
- **`courseErrorFor(target)`** returns the producer for `startCourse`:
  `headingErrorDeg = wrap(fused − bearingDeg)`; `crossTrackM` from, in order of trust,
  C's `onLateralOffset` (`source` pose or curb, < 1 s old), else dead reckoning
  (`Σ sin(headingError) × 0.7 m` per step since the last anchor) against `line`, re-anchored
  by GPS only when `accuracyM ≤ 10`; `roadSide` passed through. Call
  `PerceptionService.setCourseReference({bearingDeg})` when a target is set so C's drift
  line matches yours.
- `EXPO_PUBLIC_MOCK=1` delegates every subscription to D's replayer in `mocks/` (`05-AGENT-D-harness-transition-demo.md`)
  (`fixtures/track.json`); import it lazily so a missing mock never crashes a real build.

---

## Task 7 — Voice input (`src/core/voice.ts`, first thing cut)

Push-to-talk only: large on-screen target (hold to talk) plus the volume button if the dev
build exposes it. Flow: `allowsRecording: true` → `expo-speech-recognition` with
`requiresOnDeviceRecognition` (16 kHz mono, `iosCategory` set so playback is not
re-routed) → transcript → `POST /api/plan {job: 'parseIntent'}` → one ≤ 12-word `reply` via
`say()` → `allowsRecording: false`. Store noise fallback: D's `POST /api/stt` (ElevenLabs
Scribe). Zero-risk fallback that always ships: a `TextInput` with keyboard dictation on
`HomeScreen`. `ITEM_REQUESTED {source}` records which path was used. End-to-end 2–4 s;
COURSE pauses during the utterance because iOS suppresses haptics while recording.

---

## Task 8 — Onboarding (`src/ui/OnboardingScreen.tsx`)

A haptic vocabulary nobody has learned is just confusing buzzing. Under 90 s, fully spoken,
first launch and from a "practice" button. Disclaimer first (Task 10), then:

```
"Aisle uses four vibrations and two sounds. Let's learn them."
"When you are on course, Aisle is silent. Turn away from the target and feel the buzz
 grow."                          [COURSE live against the current heading, 10 s]
"Turn back until it stops."     [silence → CONFIRM]
"This is 'turn'."               [TURN]
"This is 'stop'. It means a vehicle or an obstacle."   [STOP]
"This is 'okay'."               [CONFIRM]
"This pulse points where to walk. Turn until it is centred."   [beacon, 10 s exercise]
"At a crossing, slow ticks mean don't walk, fast ticks mean walk, medium means countdown.
 No ticks means Aisle cannot see the signal."  [ticker: 3 s each state]
"Keep your cane or dog. Use open-ear headphones so you can hear traffic. Wear the phone
 on the lanyard, screen out. Keep the ring switch on."
"Now walk straight for five seconds."         [calibrateBodyOffset]
```

Then `trainingMode` (default on): every haptic is paired with its one-word label until the
user turns training off in settings. Onboarding is never cut.

---

## Task 9 — DebugPanel (`src/ui/DebugPanel.tsx`)

Opened by a **1.5 s long-press on the mode label** (three-finger taps belong to VoiceOver
and shake opens Expo's dev menu). Every other agent debugs through it; build it by hour four.

Live readouts: mode; `trueHeading` / accuracy tier / ARKit yaw / tracking state / fused
heading / body offset; GPS lat, lng, accuracy, course, speed; steps; current `CourseError`
(heading error, cross-track, source); **per-tier latency** — Tier 0 `frameToEventMs` and
per-model fps / thermal state from `PerceptionService.getStats()`, Tier 1 last and p95
end-to-end plus first-audio time per `seq`, Tier 2 first-token ms and `fallback` flag per
job; last `SIGNAL_STATE` with `fresh`/`nOfM`; utterances per minute and the last backend
that spoke; policy-dropped speech count; battery; last 10 events with timestamps.

Manual overrides (all always wired, none cut): jump-to-mode; manual signal state
(`CrossingController.setManualSignal`, fallback rung 4); `forceEnter`
(`TransitionDetector`); training toggle; speech-rate slider; beacon / ticker mute;
re-run `calibrateBodyOffset`; mock on/off and fixture pick (D's replayer); abort.

---

## Task 10 — Disclaimer, privacy line and app accessibility

First launch, spoken, ≤ 12 s, skippable after the first run, cache key `disclaimer`:

> "Aisle is a prototype, not a safety device. Keep using your cane or guide dog. Aisle reads
> walk signals and warns about vehicles it can see; it cannot see everything and never
> decides when to cross."

Also shown as text on `HomeScreen` together with Google's walking-routes beta warning
(B supplies the string; you display it) and one privacy sentence: video stays on the phone;
only occasional still frames are sent to the cloud.

Accessibility of the app itself: every control labelled; the nav screen is one live region;
large targets, one-thumb operation; nothing behind gestures iOS or Expo already use; works
with VoiceOver on (`duckOthers`, no double speech) — test that path once in phase 2.
Connectivity loss: cached speech and haptics continue; say `offline_notice` once.

---

## Order of work (relative to integration start; phase plan, not a clock)

0–1 h contracts, stubs, bus, store skeleton pushed · 1–4 h haptics, speech queue, cached
player, sensors · 4–8 h onboarding, DebugPanel, beacon, ticker · 8–12 h push-to-talk ·
12–14 h integration on the demo phone, mocks off · 18–21 h utterance polish, disclaimer,
VoiceOver pass. Do the demo-phone `expo run:ios --device` of an empty dev build in phase 0
(`11-PHASE-0-CHECKLIST.md`), not here.

---

## Definition of done

- [ ] `contracts.ts` verbatim from 01, stubs and a working bus pushed within hour one; `expo@~57` pinned; `expo-av`, `expo-camera`, `react-native-vision-camera` absent and CI-checked
- [ ] Dev build installs on the demo phone via `expo run:ios --device`; Windows phone runs the same build from an EAS internal-distribution link; all six permission strings present before first prebuild
- [ ] Illegal mode transitions logged loudly and never applied; every event in Task 2 drives its transition in mock mode
- [ ] TURN / STOP / CONFIRM distinguishable through a lanyard-mounted phone; STOP pre-empts COURSE
- [ ] COURSE: silent inside the dead zone at rest (no flutter), dead zone follows the compass tier, `compass_uncertain` once below tier 2, roadward rule needs two agreeing signals, 0.5 s hysteresis both ways, one CONFIRM on re-alignment after TURN, buzz change < 200 ms
- [ ] Speech queue provably drops repeats, enforces the 4 s gap, rejects > 12 words and digits in dev, CRITICAL interrupts every backend through one handle, mode policy silences everything at AT_CURB except signal, vehicle and scan speech
- [ ] The "never while COURSE is buzzing" gate keys off the Tier-1 prompt keys only (`tilt_camera_up`, `turn_left_a_little`, `turn_right_a_little`); `course_hint_left` / `course_hint_right` still speak during the buzz, and both keys are flagged for 01 §3
- [ ] Forbidden-word lint runs on pre-commit and at runtime; zero hits in `src/`, `server/`, `fixtures/`, phrases and pitch script
- [ ] All ~40 phrases generated with one voice, bundled, playing in airplane mode; `prefetch` caches variable phrases at route/store load; `playStream` first audio measured on-device [verify chunked playback]
- [ ] `expo-speech` fallback fires on network failure; ring-switch behaviour documented in onboarding
- [ ] Beacon pans by relative bearing with the two-player law, extra tick inside ±15°, silent over speech, off indoors, sparse at the curb only when the ticker is silent; ticker tempos match the four states and never overlap the beacon
- [ ] Audio session: `duckOthers`, plays in silent mode, `allowsRecording` true only during push-to-talk; haptics verified firing with the camera module running
- [ ] Heading from `watchHeadingAsync`; fused heading within ±20° of `trueHeading` outdoors; `calibrateBodyOffset` returns `ok` on a straight 5 s walk and feeds `setBodyOffsetDeg`; `courseErrorFor` uses C's lateral offset when fresh, dead reckoning otherwise
- [ ] Onboarding end to end in under 90 s including beacon and ticker; training mode pairs words with haptics
- [ ] DebugPanel opens on long-press, shows per-tier latency, fps, utterances/min, last events, and every manual override works with VoiceOver on
- [ ] Disclaimer text exactly as Task 10, spoken on first launch; privacy line and walking-beta warning displayed
- [ ] App runs fully in `EXPO_PUBLIC_MOCK=1` with zero real sensors, camera or API keys
