# 05 — Agent D: Harness, Proxy, Transition, Training Track & Demo

You own the **infrastructure that keeps A, B and C unblocked** (mocks, fixtures, the proxy),
the **store-entry handoff** (the second most memorable beat for judges, after the crossing),
the **training runs** for the signal model, and **everything that makes the demo survive a
bad network, a bad model day or a late transition**. Do the harness first: B and C cannot
test a crossing or an aisle walk without it, and nobody walks to a store to debug a state
machine.

**Machine:** the Windows laptop. You develop JS/TS, Node and Colab; you cannot build the
iOS binary. You run your own `npx expo start --dev-client` and install native builds from
EAS internal-distribution links (`eas device:create` once, then whatever
`eas build --profile development --platform ios` the Mac owners publish). Every native
change (Swift module, new `.mlpackage`) reaches you only through that path, so ask for
builds in batches, not per commit.

**Owns:** `server/` (proxy core, `health`, `tts`, `stt`, `vision`), `mocks/`, `fixtures/`,
`src/transition/`, `training/`, demo tooling and the run-of-show.
**Never touches:** `src/core/`, `src/ui/`, `App.tsx`, `assets/audio/` (A); `src/outdoor/`,
`src/crossing/`, `server/routes/plan.ts`, `server/routes/route.ts` (B);
`modules/perception/`, `src/perception/`, `src/indoor/`, `models/` (C).
**Contracts:** every name below is from `01-SHARED-CONTRACTS.md` (§4 SensorService, §5
events, §7 PerceptionService, §8 SemanticVision, §9 Planner, §10 TransitionDetector, §12
mock mode). A contract change is flagged in the shared channel, never made here.

---

## Part 1 — Mock harness (DO THIS FIRST — others are blocked)

`EXPO_PUBLIC_MOCK=1` makes the whole app run with no store, no walking, no camera and no
API keys. The native `PerceptionModule` is never started; `requireNativeModule('Perception')`
must not even execute, so the composition root imports the mock factory and the real
factory behind the flag, not both eagerly.

### `mocks/sensors.ts` — implements `SensorService`

Replays `fixtures/track.json`. Every method in §4 must work: `subscribeHeading`,
`subscribeLocation`, `subscribeSteps`, `subscribePose` (re-emitted from the perception
mock), `getHeading`, `getFusedHeadingDeg`, `getLastFix`, `getStepsSince`,
`calibrateBodyOffset` (resolves `{offsetDeg: 0, ok: true}` after 5 s of replay),
`courseErrorFor` (computes a real `CourseError` from the replayed heading and fix against
the target bearing and line, so A's COURSE buzz is exercised, not stubbed).

```json
{
  "hz": 1,
  "samples": [
    { "t": 0,   "lat": 40.4501, "lng": -79.9350, "accuracyM": 6,  "courseDeg": 118, "speedMps": 1.3,
      "heading": { "trueHeadingDeg": 120, "accuracy": 3 }, "steps": 0 },
    { "t": 1,   "lat": 40.4498, "lng": -79.9361, "accuracyM": 9,  "courseDeg": 117, "speedMps": 1.3,
      "heading": { "trueHeadingDeg": 118, "accuracy": 3 }, "steps": 2 },
    { "t": 210, "lat": 40.4444, "lng": -79.9436, "accuracyM": 7,  "courseDeg": 95,  "speedMps": 1.1,
      "heading": { "trueHeadingDeg": 95,  "accuracy": 2 }, "steps": 290 },
    { "t": 214, "lat": 40.4443, "lng": -79.9436, "accuracyM": 8,  "courseDeg": null, "speedMps": 0.4,
      "heading": { "trueHeadingDeg": 96,  "accuracy": 1 }, "steps": 296 },
    { "t": 221, "lat": 40.4444, "lng": -79.9437, "accuracyM": 65, "courseDeg": null, "speedMps": null,
      "heading": { "trueHeadingDeg": 100, "accuracy": 1 }, "steps": 308 }
  ]
}
```

Build the track so it exercises the **real** entry profile, not a convenient one:
distance-to-entrance falls to a minimum (< 15 m), then rises or freezes while accuracy
holds 5–10 m for several seconds and then **steps** to ~65 m (not a climb), compass
`accuracy` drops to 1 near the steel storefront, steps keep accumulating. The transition
announcement on this track should land 5–15 s after the "door" sample, because that is
what the phone will do live. Also include: a signalized crossing (bearing, near and far
curb, a 4 s pause at the curb), a compass-accuracy-2 stretch (dead zone 18°), one
urban-canyon jump (accuracy 38 m, 40 m off the line, one fix) that must not advance a leg.

Playback controls: play, pause, scrub, speed (1×/4×), and **jump-to-mode** for every mode
in §1 (`OUTDOOR_NAV`, `APPROACH_CROSSING`, `AT_CURB`, `CROSSING`, `TRANSITION`,
`INDOOR_NAV`, `AT_ITEM`, `ITEM_PICKUP`, `CHECKOUT_NAV`). Jumping seeks the track to the
matching sample and the perception fixture to the matching offset; A's store still owns
the mode, so a jump emits the events that legally lead there (`CROSSING_AHEAD` →
`CURB_REACHED` …) rather than calling `setMode()` from your code.

### `mocks/perception.ts` — implements `PerceptionService`

Replays `fixtures/perception/*.jsonl`, one line per native event, recorded by the module's
own debug export on the demo phone (`09-PERCEPTION-MODULE.md` §10). Line shape, to agree
with C before either of you writes a byte:

```
{"t": 1234, "event": "onSignalState", "payload": {"state": "WALK", "fresh": true, "confidence": 0.91, "nOfM": 6}}
```

`t` is milliseconds from fixture start; the replayer re-bases to `Date.now()` and emits
through the same `on*` callbacks C's wrapper exposes, honouring the §7 rate limits.
`start(profile)` / `setProfile(profile)` select the fixture pack for that profile;
`setCrossingBearing`, `setCourseReference`, `setBodyOffsetDeg`, `setKnownSigns` are
recorded and shown in DebugPanel (so B and C can see that they called them) but do not
change playback. `snapshotJPEG(maxWidth)` returns `fixtures/frames/<seq>.jpg` re-encoded
to the requested width; `getTrackingState()` and `getStats()` return the recorded values
(`detectorFps` etc. from the phone, so nobody mistakes mock numbers for a measurement).

Fixture packs (one `.jsonl` each; C records, you curate and cut):

| Pack | Must contain |
|---|---|
| `outdoor-leg` | pose at 10 Hz, `onLateralOffset {source:'pose'}` drifting to +0.7 m then back, one `onObstacleAhead MID`, tracking `NORMAL` |
| `curb-walk-onset` | `UNKNOWN` for 6 s → `DONT_WALK` → `WALK fresh:true` → `COUNTDOWN` → `DONT_WALK`; 0.5 Hz heartbeats |
| `curb-walk-already-on` | first non-UNKNOWN state is `WALK fresh:false` |
| `curb-flicker` | 4-of-8 flicker that must stay `UNKNOWN`; a `LIMITED` tracking gap; 10 s of `UNKNOWN` (cant_see_signal path) |
| `vehicle-approach` | a parked-car track (constant area) that never fires; one `onVehicleApproaching {direction:'RIGHT', growth:1.6}` then silence for 4 s on the same track; `onDetections` ≤ 5 Hz |
| `scan-unsignalized` | the left and right scan windows with detections only, no `onVehicleApproaching` (SCAN_RESULT `none` path), and a variant that fires during the right scan |
| `indoor-aisle-walk` | `onOcrText` reads for aisles 1→3 at ≤ 3 Hz, 2-of-3 agreement, `onLateralOffset {source:'ocr_box'}`, one `onHazard PERSON_AHEAD`, `onDepth` closing at the end-of-aisle wall |
| `indoor-hard-cases` | a read matching nothing (`"A1SLE 7Z"`), two signs in one frame, two reads that skip 3 orders (must be ignored), reads with decreasing order (direction flip), 20 s with no read |

### `mocks/semanticVision.ts` and `mocks/planner.ts`

Replay `fixtures/vision/*.json` and `fixtures/plan/*.json` keyed by `question`/`job` +
`seq`. Unknown keys return `{ confidence: 0 }` / `{ fallback: true }`. Deliberately hard
cases, so the others' error handling is exercised before the venue: a `storefront`
response at confidence 0.3, one malformed body, one 4 s timeout, one response whose `seq`
is lower than the last applied (must be dropped, never spoken), a `scan_left` with
`vehiclesSeen: 'unclear'`, a `parseIntent` transcript with ASR noise ("I need x", "eggs
please uh"), and one `plan` reply with `fallback: true`.

### Wiring

The composition root (A's `App.tsx`) calls your `createMockServices()` from
`mocks/index.ts` when `process.env.EXPO_PUBLIC_MOCK === '1'`; otherwise the real
factories. That is the **only** place the flag is read. No `if (mock)` in feature code.
Speech and haptics stay real in mock mode: the point is to hear and feel the app.

---

## Part 2 — The Node proxy (`server/`)

One Node 20+ process, TypeScript, `server/index.ts`, HTTP + WebSocket on the same port.
Keys live in the host's secret store and in `server/.env` locally, never in the app:

```
ANTHROPIC_API_KEY=
NVIDIA_API_KEY=
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
GOOGLE_MAPS_API_KEY=
```

Commit `server/.env.example` with those five names blank. The client sends no keys and
receives none; every upstream call originates here.

### Routes

| Route | Upstream | Owner | Notes |
|---|---|---|---|
| `POST /api/vision` | Anthropic Messages, `claude-haiku-4-5`; `claude-sonnet-5` with `thinking: {type:'disabled'}` for `question: 'curb_crop'` only | D | body = `VisionRequest` (§8); streamed variant over the WebSocket below |
| `POST /api/plan` | NIM `nvidia/nemotron-3.5-lightning-30b-a3b`, `chat_template_kwargs: {enable_thinking: false}`, `nvext: {guided_json}`, `stream: true` | **B** (`server/routes/plan.ts`) | you host it, own the process, the deadline helper and the OpenRouter failover plumbing; B owns the five job schemas and templated fallbacks |
| `POST /api/tts` | ElevenLabs `POST /v1/text-to-speech/{voice}` (whole file) and `/stream`, `model_id: eleven_flash_v2_5` passed explicitly (the endpoint default is multilingual v2) | D | pre-synthesis of the ~40 cached phrases and of variable phrases at route/store load; B's route-load batch carries the allow-listed walking-beta sentence, which must not 422; `output_format` `mp3_44100_64` |
| `POST /api/stt` | ElevenLabs `POST /v1/speech-to-text`, `scribe_v2`, multipart, `keyterms` = the store's item and aisle words | D | fallback only; primary STT is on-device in the dev build. Min audio 100 ms |
| `GET /api/route` | Google Routes `computeRoutes` WALK with field mask; Overpass; bundled WPRDC JSON | **B** (`server/routes/route.ts`) | you host it |
| `GET /api/health` | all five upstreams individually | D | see below |

**Server-side language rule (a safety control, not a style rule):** every `speech`
string from Claude and every `text` on `/api/tts` is checked against the forbidden list —
safe, clear, go, cross now, no cars, you can cross — and against the 12-word limit. A
violation blanks `speech` (Claude) or returns 422 (`/api/tts`) and is logged. The client
lints too; the proxy is the second lock.

**The one exemption (do not widen it here).** The check targets those words in imperative or
advisory position — the app telling the user something about crossing — not every occurrence
of the letters. Two carve-outs, and only two: identifiers are not text (02's lint rule already
excludes `clearQueue` and friends), and **one string is allow-listed by exact hash** — Google's
mandatory walking-beta warning, which contains "clear sidewalks" and runs well past 12 words,
so the unexempted rule would 422 it and fail A's pre-commit grep. The allow-list entry is a
SHA-256 over the exact bytes, matched byte-for-byte: a paraphrase, a truncation, a re-cased
copy or any other sentence hashes differently and is still rejected, and the hash exempts that
sentence from the forbidden list **and** from the 12-word cap. It covers display and TTS of
that one sentence only — never a Claude `speech` string, never any other `/api/tts` text,
never reuse of the words elsewhere. `01-SHARED-CONTRACTS.md` §3 is the single place the
forbidden list and this allow-list are defined; the byte string itself is B's
(`03-AGENT-B-outdoor-crossing.md` Task 1 reads it from `RouteResponse.warnings`, Task 4
pre-synthesizes it through your `/api/tts` at route load, and `06-INTEGRATION-AND-DEMO.md`
checks it is visible on the route screen). Your check and A's `scripts/lint-phrases.ts` read
the same committed constant — agree the path with A, do not keep a second copy. If §3 does not
yet carry the sentence and its hash, flag it to A and B in the shared channel; a contract gap
is not a licence to loosen the regex locally.

### `/api/vision`

- Validate `question` against the enum, `seq` monotonic per connection, image long edge
  ≤ 1024; reject anything larger (the phone already resized; a 1280-wide upload is a bug).
- One **byte-stable superset** `VisionResponse` schema for every question, `speech`
  first, `additionalProperties: false`, sent as `output_config.format` json_schema.
  Grammar compile is cached 24 h per schema; **never** vary it per question.
- System prompt per question is a string constant in `server/prompts/vision.ts` and
  includes the store's `knownSigns` only when the request carries them; on the Sonnet
  path put `cache_control` on the system prompt (1,024-token minimum on Sonnet 5; Haiku's
  4,096 minimum means a normal system prompt will not cache there — do not chase it).
- `facts` are rendered as a short text block above the image; when `image` is absent the
  call is text-only (many turns need no pixels).
- `max_tokens: 300`, `maxRetries: 0`, 4 s timeout; on timeout or
  `stop_reason !== 'end_turn'` return `{ confidence: 0, seq }` and nothing else.
- Model routing: `curb_crop` → Sonnet 5, thinking disabled; everything else → Haiku 4.5.

### WebSocket streaming (vision → speech in ~1.3–1.5 s)

Path `/ws`, one persistent socket per phone, opened at app start and re-opened with
backoff. Messages are JSON except audio frames (binary, prefixed with `streamId`).

```
client → { type: 'vision', req: VisionRequest, priority: 'NAV' | 'INFO' }
client → { type: 'warm', mode: AppMode }          // on every mode change: no-image request, result discarded
server → { type: 'speech_start', streamId: seq }
server → <binary audio chunk, streamId>            // ElevenLabs mp3 frames as they arrive
server → { type: 'speech_end', streamId: seq }
server → { type: 'result', res: VisionResponse }   // full JSON, after speech
server → { type: 'error', seq, code }
```

Sequence per request: open the ElevenLabs TTS WebSocket at request start (in parallel
with Claude's TTFT, `model_id: eleven_flash_v2_5`, `output_format` mp3), stream Claude
with the structured-output schema, forward the tokens of `speech` as they arrive, send
`flush: true` the instant the string closes (the default `chunk_length_schedule` would
otherwise hold a < 120-character utterance), relay audio to the phone as `streamId = seq`,
then send the full `result`. If `speech` closes empty, close the ElevenLabs socket
without flushing and skip `speech_start`. ElevenLabs closes idle sockets after 20 s, so
open per request; do not try to keep one alive. Use `api.us.elevenlabs.io` to pin the US
cluster. Keep-alive agent to Anthropic. Concurrency guard: free-plan ElevenLabs allows 4
simultaneous Flash requests (10 if the hackathon Creator perk is redeemed on the key's
account **[verify]**), so TTS work goes through a semaphore of 4 and pre-synthesis batches
wait behind live speech, never the reverse. ≤ 3 vision requests in flight per socket;
a fourth is answered `{ confidence: 0 }` immediately.

Projected: capture 30 ms + upload 150 ms + TTFT 650 ms + first sentence 300 ms + TTS
200 ms. Put p50/p95 per question in `/api/health` and DebugPanel.

### Schema warm-up

At process start and every 20 minutes: one request per (model, schema) pair — Haiku +
`VisionResponse`, Sonnet + `VisionResponse`, and each of B's five Planner job schemas
against NIM (confirms `nvext.guided_json` acceptance and that thinking is actually off —
log the first 50 characters of each answer). The phone's `warm` message on mode change
re-fires the pair that mode will use. `/api/health` reports `schemasWarm` per pair with
the last warm time; a red pair before a demo is a stop-the-line item.

### `/api/health`

```json
{ "ok": true, "region": "us-east",
  "upstreams": { "anthropic": { "ok": true, "ms": 210 }, "nvidia": { "ok": true, "ms": 340, "modelSeen": true },
                 "elevenlabs_tts": { "ok": true, "ms": 180, "creditsLeft": 8120 }, "elevenlabs_stt": { "ok": true, "ms": 190 },
                 "google_routes": { "ok": true, "ms": 260 } },
  "schemasWarm": { "haiku:vision": "2026-09-19T15:02:11Z", "nim:routeCompile": "..." },
  "latency": { "vision.storefront": { "p50": 1900, "p95": 2800 } } }
```

Each check is cheap and cached 30 s: Anthropic model list; NIM authenticated
`GET /v1/models` (also asserts the Nemotron id is present — read the exact string here on
day 0, it varies by surface); ElevenLabs subscription endpoint for credits; a Scribe call
on a bundled 300 ms clip; one two-point `computeRoutes` cached 5 min. 10 s timeout per
check. DebugPanel polls every 15 s and shows one dot per upstream.

### `/api/plan` hosting duties (B owns the route)

You provide: the NIM client with `stream: true`, a 1.5 s first-token deadline helper that
resolves to B's templated fallback with `fallback: true` and `latencyMs`, same-model
failover to OpenRouter on 429/503 (needs its own key — flag it, it is not in the locked
list above), and `PlannerResult` envelope logging. Nothing time-critical calls this route;
if the phone ever awaits it inside AT_CURB or CROSSING, that is a bug in the caller.

### Hosting and the hotspot/LAN fallback

- Hosted in a **us-east** region on the team's chosen Node host **[verify: provider, plan,
  WebSocket support, cold-start behaviour]** so the phone reaches it over cellular with no
  dependency on venue Wi-Fi. The phone's proxy URL is `EXPO_PUBLIC_PROXY_URL`; DebugPanel
  can override it at runtime.
- The same process runs locally: `npm run proxy` binds `0.0.0.0:8787`. Fallback at the
  venue: laptop joined to the demo phone's hotspot, proxy bound to the hotspot IP,
  DebugPanel proxy override pointed at it. Hackathon Wi-Fi commonly isolates clients; do
  not plan on it for anything.
- Dev-server delivery of the JS bundle follows the same order: hotspot LAN first,
  `--tunnel` second (slow reloads), an EAS Update from the team account third. The demo
  phone never reloads its bundle during the run.
- Logs: one line per request with `seq`, question/job, model, ms to first token, ms
  total, `fallback`, and the language-rule verdict (`pass`, `blanked`, `rejected_422`, or
  `allowlisted` for the hashed walking-beta sentence, so the exempt lane stays visible).
  Keep 24 h; the Nemotron eval artifact (B, phase 3) is built from these lines.

---

## Part 3 — TransitionDetector (`src/transition/`)

The moment no existing tool handles: outdoor map guidance ends, indoor camera guidance
begins. Implement §10 exactly: `start(dest)`, `stop()`, `onEnter(cb)`, `forceEnter()`.
`dest` is `storeMap.entrance` from `fixtures/stores/<storeId>.json`, pinned by hand on
the venue walk — a Places centroid can be 50–100 m from the door and breaks everything
below.

### Signals and weights (`TransitionSignals`)

| Field | Condition | Weight |
|---|---|---|
| `distanceMinThenRise` | distance to `dest` reached a minimum < 15 m and has since risen by ≥ 5 m or frozen (no fix moved it by > 3 m for 6 s) | 0.3 |
| `accuracyStepUp` | `accuracyM` ≥ 2× the minimum-distance fix's accuracy, or > 30 m, on any fix after the minimum | 0.3 |
| `stepsSinceMin` | `getStepsSince(minimumFixTimestamp)` ≥ 15 | 0.2 |
| `storefrontFrame` | one `SemanticVision` `question: 'storefront'` answer with `storefront.visible && confidence ≥ 0.6`, using `snapshotJPEG(512)` and the current detections as facts; ≤ 1 call per 5 s; calls begin only when distance < `radiusM + 15` | 0.2 |
| `ambientLight` | Android only, bonus: light drop ≥ 70 % within 5 s; iOS has no sensor, leave 0 | bonus |

`confidence` = sum. **Fire at ≥ 0.6.** Fire **once per `start()`**, with a 10 s debounce
window during which every further signal update and every `forceEnter()` is a no-op (the
two sources racing is the double-fire case). `stop()` on `STORE_ENTERED` and on `* →
IDLE`; `start()` again resets everything. iOS holds 5–10 m for seconds after the door and
then snaps to ~65 m, so the live announcement lands 5–15 s after entry. That is
acceptable and the mock track reproduces it; do not tune the weights to make the fixture
feel snappy.

### `forceEnter()` — always wired

Bound to a large button in DebugPanel. Emits the same `TransitionSignal` with
`reason: 'MANUAL'`, `confidence: 1`. **Never demo without it.** If detection misfires in
front of judges, a teammate taps once and the story continues.

### What happens on fire

Your `onEnter` handler emits `STORE_ENTERED { reason, confidence }` on the bus and nothing
else; A's store moves the mode to `TRANSITION`, which switches the speech policy, stops
the beacon and sets the perception profile through their own subscriptions. Then the
announcement, scripted precisely:

```ts
haptics.play('CONFIRM');
speech.say({ cacheKey: 'entering_store', text: 'Arrived. Switching to store mode.', priority: 'NAV' });
// ≥ 4 s later, only if nothing is queued (INFO is dropped otherwise, which is fine):
speech.say({ text: 'Looking for aisle signs.', priority: 'INFO', dedupeKey: 'looking_for_signs' });
```

Five words, then four. The handoff should feel like the app *noticed* something, not like
a menu changed. Nobody narrates over it. The second line has no cache key in
`01-SHARED-CONTRACTS.md` §3 today; flag `looking_for_signs` to A rather than letting it
fall to `expo-speech` in a different voice.

---

## Part 4 — CV training track (`training/`)

Procedure, datasets, labels and export steps are in `10-CV-TRAINING-TRACK.md`; this part
is about ownership. You run it: on Colab (free T4 class), YOLO-nano at 640 px, ~50 epochs
(< 1 h per run), classes `ped_walk` / `ped_hand` / `ped_countdown`, local frames from the
recorded crossing video mixed with the US-convention public sets whose licences you
record in `training/LICENSES.md`. Deliverable per run: the CoreML `.mlpackage`, the
held-out confusion matrix and per-class precision/recall at 10–20 m, the licence list, and
a one-line changelog. You hand the package to C, who commits it under `models/` and
measures it on the phone; you never write to `models/` yourself. Signal model **v1 is a
phase 0 deliverable**, on-device before integration starts. The +14 h gate (false-WALK
precision > 95 %, WALK/HAND recall > 80 %, parallel-signal confusion < 2 % after C's
geometric gate, ≥ 15 fps) is measured on held-out local frames; you own the held-out
split and keep it out of every training run. Miss the gate → the crossing beat moves to
the next rung of the fallback ladder and you tell the narrator, not the other way round.
Cart fine-tune only if v1 clears the gate early.

---

## Part 5 — Demo tooling

### `DebugPanel` additions (A owns the component; you write the mock controls in `mocks/debug/` and A mounts them)

Trigger is a long-press on the mode label (three-finger tap and shake open Expo's dev
menu). Every control is a large labelled button; the panel is used with a cane in the
other hand.

- `FORCE ENTER STORE` → `forceEnter()`; `SKIP TO AISLE` and jump-to-mode for every mode
- Track scrubber, speed, current fixture pack name
- **Manual signal state:** `WALK (fresh)`, `WALK (already on)`, `DONT_WALK`, `COUNTDOWN`,
  `UNKNOWN`, `RELEASE OVERRIDE` → B's `CrossingController.setManualSignal(state | null)`.
  This is rung 4 of the fallback ladder and must work on the live build, not only in mock
- **Scan-result override:** `LEFT` / `RIGHT` × `none` / `distant` / `approaching` /
  `unclear` → emits `SCAN_RESULT { side, vehiclesSeen, source: 'claude' }`
- Health: one dot per upstream from `/api/health`, `schemasWarm`, proxy URL with a
  hosted/LAN toggle, socket state
- Numbers: `getStats()` (detector/depth/OCR fps, `frameToEventMs`, `thermalState`),
  Tier 1 p50/p95, Tier 2 first-token ms and `fallback` count, utterances per minute,
  battery
- Mode, last five events, last `TransitionSignals` with the running sum
- Replay-mode toggle for the installed build (below)

### `fixtures/` checklist

- [ ] `track.json` — full walk-up → crossing → store with the real entry-lag profile
- [ ] `perception/*.jsonl` — the eight packs in Part 1, recorded on the demo phone
- [ ] `frames/<seq>.jpg` — upright 512/640/1024 stills matching `snapshotJPEG` seqs
- [ ] `vision/*.json`, `plan/*.json` — every `question` and `job`, plus the hard cases
- [ ] `stores/demo-store-01.json` — entrance pinned on the venue walk, `signText` verbatim, `sideWhenAscending` checked by walking both directions
- [ ] `video/crossing-<id>-<state>-<time>.mp4` — 3–5 min per demo crossing, both signal states, two times of day, phone at chest tilted ~10° up
- [ ] `labels/crossing-<id>.json` — hand-labelled approaching-vehicle events and signal-state spans; this is what the false-alarm budget (< 1 per 5 min) and the +6 h STOP check are measured against
- [ ] `video/route.mp4` — store walkthrough, chest height, ~15° up, plus 20 aisle-sign stills
- [ ] `README.md` in `fixtures/` — how each file was recorded, by whom, on which phone

### The installed-build fixture-replay fallback

There is no separate "airplane-mode build". The backup is the **same dev build** running
from fixtures:

- Backup phone: a Release-configuration `expo run:ios` from a Mac owner with
  `EXPO_PUBLIC_MOCK=1` at bundle time, so it needs no dev server **[verify: embedded bundle
  in that configuration]**. Launch it once at the venue and leave it in the foreground.
- Demo phone: a runtime replay-mode toggle in DebugPanel that takes effect at the next
  `IDLE → ONBOARDING` (services are constructed per session, not per launch), so a dead
  proxy or a dead model day is one tap away from a full fixture run without a reinstall.
- Cached speech and haptics work offline by construction; live Tier 1/2 calls fail closed
  and `offline_notice` plays once. Test both phones with cellular off before every
  rehearsal.

### Connectivity plan (in order)

1. Demo phone on cellular → hosted proxy in us-east. No venue Wi-Fi involved.
2. Laptop joined to the demo phone's hotspot; local proxy on the hotspot IP; DebugPanel
   override. Same path serves the dev server for last-minute JS fixes (never during the run).
3. `--tunnel` / EAS Update for bundle delivery only.
4. Replay mode.

Pre-demo, 30 minutes out: all five health dots green, `schemasWarm` fresh, one real
`storefront` call round-tripped with audio, ElevenLabs credits above the run's need,
battery > 80 %, Low Power Mode off, Guided Access on, volume up, lanyard on, spare phone
in replay mode.

---

## Part 6 — Rehearsal support and run-of-show

You own the run-of-show in `06-INTEGRATION-AND-DEMO.md` and keep it true: every change to
what the app can do live is a line change there the same hour. Target 150 s; the outdoor
leg with its crossing is ~90 s of that. If a run exceeds 150 s, replay the walk-up from
fixtures and run live only from the crossing onward — do not shorten the crossing or the
handoff, they are the two beats judges remember.

Roles at every rehearsal: operator (phone, cane), narrator, a sighted spotter standing
with the operator at the crossing, and an override teammate on DebugPanel. Never the same
person twice.

| Rehearsal | When (from integration start) | Conditions | Pass |
|---|---|---|---|
| R1 | +12 to +14 h | fixtures only, both phones | every beat lands from mocks; transition fires once at 5–15 s; manual signal and forceEnter each used once |
| R2 | +14 to +18 h | live venue, timed, same hour as the demo | ≤ 150 s; STOP on a real vehicle or none fired falsely; handoff announced without narration over it |
| R3 | +18 to +21 h | after the cut line, backup phone in replay mode | the run-of-show matches the cut list; failure drills below pass |

Failure drills (each rehearsed at least once): proxy unreachable (`offline_notice`, Tier 0
continues); signal `UNKNOWN` for 10 s (`cant_see_signal`, manual override, wording
switches to the fallback rung); transition not fired at 15 s (forceEnter, nobody
notices); Wi-Fi dead (hotspot path); speech stuck (`CRITICAL` flush works). Time every
beat; record the numbers in the run-of-show. The cut order if behind is fixed (voice
input → live Nemotron → vehicle warnings → live signal model → outdoor leg live →
transition live); indoor aisle guidance, the handoff announcement, the haptic onboarding
and the disclaimer are never cut.

---

## Definition of done

- [ ] `EXPO_PUBLIC_MOCK=1` runs the whole flow with no camera, no keys and no network; B and C never wait on hardware
- [ ] `mocks/sensors.ts` and `mocks/perception.ts` implement every §4 / §7 method; the perception replayer consumes the module's own export format, agreed with C
- [ ] Jump-to-mode works for every mode; the eight perception packs and the hard cases exist and are used by B and C's tests
- [ ] Proxy hosted in us-east with all six routes; `/api/health` reports five upstreams and `schemasWarm`; keys only server-side; `.env.example` committed
- [ ] WebSocket vision → ElevenLabs streaming measured on the demo phone: first audio ≤ 1.5 s p50 for `storefront`; stale `seq` never spoken
- [ ] Server-side forbidden-word and 12-word rule blanks or rejects; tests cover the exemption both ways — the hashed walking-beta sentence pre-synthesizes through `/api/tts` and logs `allowlisted`, a paraphrase of it and every other "clear"/"safe" sentence still 422
- [ ] Transition fires once on the replay track between 5 and 15 s after the door; debounce holds against a racing `forceEnter`; `STORE_ENTERED` is the only thing emitted
- [ ] `forceEnter` and the manual signal-state override wired and used in a live rehearsal
- [ ] Signal model v1 `.mlpackage` delivered to C with metrics and licences before integration start; held-out split kept apart; gate result reported at +14 h
- [ ] Recorded crossing footage and labels in `fixtures/`; the +6 h STOP check and the false-alarm budget are measured against them
- [ ] Backup phone in replay mode and the demo phone's runtime replay toggle both verified with cellular off
- [ ] Hotspot/LAN proxy path verified at the venue; DebugPanel override switches without a reload
- [ ] Three timed rehearsals completed with all four roles; failure drills passed; run-of-show in `06-INTEGRATION-AND-DEMO.md` matches what is live
