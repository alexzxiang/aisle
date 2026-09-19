# 08 — Roadmap, Concerns & Optimizations (supersedes 00–07 where they conflict)

**Where things live now (rewrite of 2026-09-17).** Each topic below was worked out here first; the
canonical, agent-facing version now lives in the doc named. 08 remains the rationale, the risk
register and the errata record — read it for *why*, read the owning doc for *what to build*.
- Modes, events, services, store-map schema, latency budget → `01-SHARED-CONTRACTS.md`
- Native camera owner (ARKit `PerceptionModule`, models, schedule, JS events) → `09-PERCEPTION-MODULE.md`
- Core shell, haptics, speech queue, beacon, onboarding, disclaimer → `02-AGENT-A-core-shell.md`
- Outdoor legs, heading fusion, crossing flow (signalized + unsignalized), vehicle warnings → `03-AGENT-B-outdoor-crossing.md`
- Indoor OCR/fuzzy-match loop, navigator, active perception, item pick-up → `04-AGENT-C-perception-indoor.md`
- Proxy, health, TTS/STT routes, mocks/fixtures, transition fusion, demo tooling → `05-AGENT-D-harness-transition-demo.md`
- Integration order, gates, run-of-show, judge Q&A → `06-INTEGRATION-AND-DEMO.md`
- Sponsor tracks and provider specifics (NVIDIA, ElevenLabs, Google, Anthropic) → `07-SPONSOR-STACK.md`
- Signal-model data, training, export, evaluation gate → `10-CV-TRAINING-TRACK.md`
- Phase 0 (toolchain, accounts, venue walk, datasets, the [verify] checks) → `11-PHASE-0-CHECKLIST.md`
- Platform decision, three-tier rationale, safety/privacy posture, risk register R1–R29, open questions → this doc

Status: written 2026-09-17 from ten sourced research dossiers (NIM/Nemotron VL, Nemotron text
models, ElevenLabs, Expo SDK 57, Expo Go limits, Google Maps Platform, Claude vision, assistive
prior art, indoor CV realities, crosswalk research). Two dossiers (on-device CV stack on RN dev
builds; signal-model training data) did not complete; claims that depend on them are marked
**[verify]**. Facts marked **[verified]** were checked against primary sources during research.

Event window: **SteelHacks XIII runs 2026-09-19 11:00 → 2026-09-20 11:00 ET (~24 h)** [verified
from the event schedule module]. Docs 06's multi-day hour-by-hour plan is therefore wrong at the
root; the pre-event work now lives in `11-PHASE-0-CHECKLIST.md` and the phase order and gates
in `06-INTEGRATION-AND-DEMO.md`, summarized below under "Revised roadmap & go/no-go gates".

Direction from the team (2026-09-16/17), which this doc implements:
crossings are a headline feature; moving-vehicle warnings are required; Expo Go is no longer a
constraint if leaving it buys speed/accuracy; Claude Haiku/Sonnet does fast frame analysis where
cloud is acceptable; Nemotron does slower "directional navigation" work rather than image
analysis; a custom CV model for pedestrian signals is on the table; the haptic/audio design is the
analysts' call with a Soundscape-style beacon favoured; frame rate adapts to danger.

Flow confirmed 2026-09-17 (second pass), which this doc now also implements: the LLM may ask
the user to move the camera or themselves ("tilt up so I can see aisle names"); item pick-up
guidance is a stretch beat; unsignalized (stop-sign) crossings get a scan-left/scan-right flow;
haptics follow one rule everywhere — silence when on course, buzz growing with error; turns are
spoken then haptically confirmed; the team starts well before the event, so the timeline under
"Revised roadmap & go/no-go gates" is a phase plan, not a 24-hour clock.

---

## TL;DR — the 10 decisions that matter

1. **Leave Expo Go. Ship an Expo development build** (still React Native + Expo + TypeScript).
   Why: `expo-camera` has no frame access and is single-flight on iOS (~1 capture/s at best);
   Expo Go cannot run any on-device model. The accuracy target is unreachable inside it.
2. **Three-tier perception, routed by time-to-act.** Tier 0 on-device detectors at 15–30 fps for
   anything that changes in under ~5 s (signal state, vehicles, people/carts, sign text). Tier 1
   Claude Haiku 4.5 (~2–2.5 s end-to-end) only for semantic questions with slack. Tier 2 Nemotron
   text reasoning at events only. Why: a 1–2 s cloud answer is fine for "which aisle" and useless
   for "did the hand just turn to walk".
3. **Pedestrian-signal state comes from an on-device fine-tuned detector with silence-on-
   uncertainty** (OKO's architecture). The cloud VLM never decides signal state (GPT-4V scored 25%
   on "safe to cross" images). Why: it is the only design that is both fast and honest.
4. **The app informs the crossing decision; it never makes it.** Permitted: "Walk signal on",
   "Don't walk", "Countdown", "Can't see the signal", alignment cues. Forbidden anywhere in code or
   pitch: "safe", "clear", "go", "cross now", "no cars".
5. **Vehicle warnings are on-device geometric looming from a pretrained COCO detector, forward
   field of view only, STOP haptic + two words.** No speed/distance claims. Hearing stays the
   user's primary vehicle sensor, so the curb is a near-silent zone.
6. **Nemotron = the decision layer, not the eyes.** `nvidia/nemotron-3.5-lightning-30b-a3b`
   (thinking off, `nvext.guided_json`) compiles the route into ≤12-word legs, parses voice intents,
   resolves store-map ambiguity, judges when to announce a crossing. Never in the real-time path.
   Why: the SteelHacks Nemotron track is titled "Beyond the Chatbot" and asks for exactly this.
7. **ElevenLabs owns speech in and out:** pre-generated Flash v2.5 phrase cache + live Flash v2.5
   for variable text; Scribe for STT if on-device STT proves weak in store noise. The ElevenLabs
   track ("Out Loud") explicitly counts STT and wants "a demo we can hear".
8. **Channels:** haptics follow one rule everywhere — silence when on course, buzz rate and
   intensity growing with heading / cross-track error (dead zone ~12°, because the compass
   guarantees only ±20°) — plus TURN, STOP, CONFIRM: four patterns. Audio carries direction
   (spatialized beacon) and signal-state tempo; speech carries meaning. Nothing overlaps at the
   curb.
9. **Indoor stays the ordered-aisle model**, now with on-device OCR + fuzzy match (instant) and
   Claude only for ambiguity; pedometer as a prior; transition detection fused from five signals.
10. **Sequence by risk, not by calendar.** The team starts before the event, so phase 0
    (dev-build toolchain proven on the demo phone, accounts, crossing photos, store walk, datasets,
    signal model v1) is done before integration begins. The gates under "Revised roadmap &
    go/no-go gates" — measured versions in `06-INTEGRATION-AND-DEMO.md` — are relative to
    integration start; the crossing beat has a fallback ladder so it demos at every rung.

---

## What changed from docs 00–07, and why

| Topic | Docs 00–07 said | Decision now | Why |
|---|---|---|---|
| Street crossings | Explicit non-goal; disclaimer says "does not help with street crossings" | Headline feature: crossing-ahead awareness, alignment/veer, on-device signal state, vehicle-in-view alerts | Team decision. APS exists at ~5% of NYC and <2% of Chicago signalized intersections, so signal reading is real value; OKO proves the envelope is shippable |
| Platform | React Native + Expo, Expo Go implied; `expo-av` | Expo **development build**; `expo-audio`; one native Swift `PerceptionModule` (ARKit + CoreML + Apple Vision) owns the camera | Expo Go: no frame API, single-flight capture, `expo-av` removed in SDK 55, login required since 2026-09-03, dev-menu gesture collides with the DebugPanel gesture |
| Vision model | Nemotron Nano 2 VL for all vision, 1 frame / 2 s | Tier 0 on-device; Tier 1 Claude Haiku 4.5 (Sonnet 5 for the curb crop fallback); Nemotron out of the image path | Nemotron VL hosted latency is unpublished; the one independent measure is 4.66 s median TTFT (reasoning variant); `nvidia/nemotron-nano-12b-v2-vl` is absent from the public `/v1/models` list [verified 2026-09-17] |
| Nemotron role | OCR of aisle signs | Navigation reasoning / intent / ambiguity / judging (text) | Track brief; free-tier latency tail (multi-second, occasional 429/503) is acceptable only off the real-time path |
| Haptics / "beep faster" | Pulse-rate ramp = heading only; 4 patterns | Keep 4 haptic patterns; add audio beacon for direction; tempo-coded audio for signal state | Soundscape encodes direction, not distance; OKO encodes state as tempo; two haptic ramps would be ambiguous |
| Frame rate | Fixed 0.5 fps, never faster | Tier 0 continuous; Tier 1 adaptive 0.25–1 fps by mode | Adaptive cadence is rate-limit-safe (Anthropic Start tier 1,000 RPM) and latency-bound |
| Voice input | "I need eggs" spoken or typed | Push-to-talk → on-device STT (dev build) or ElevenLabs Scribe → Nemotron intent schema; keyboard dictation fallback | Both tracks reward it; store noise demands push-to-talk |
| Backup demo | "Airplane-mode build" | A real installed dev build with a fixture-replay mode | Now possible; it was impossible in Expo Go |
| Timeline | Multi-day hour-by-hour | 2-day pre-event prep + 24-h build with gates | Event is ~24 h |

Doc-level consequences are itemized below under "Required doc changes & errata for 00–07". The two
hour-one deliverables that other agents import — `contracts.ts` and the stubs — come verbatim from
`01-SHARED-CONTRACTS.md`, which already carries every decision in this doc, before anyone else
starts.

---

## Perception architecture: three tiers and the time-to-act budget

### Question → tier

| Question | How fast the truth changes | Max acceptable latency | Cost of a wrong answer | Tier | Source |
|---|---|---|---|---|---|
| Pedestrian signal state (hand / walk / countdown) | Sub-second at transitions; WALK intervals as short as 4–7 s | < 0.5 s | Severe (false WALK) | 0 | fine-tuned detector |
| Vehicle approaching in forward view | < 1 s | < 0.5 s | Severe (miss) / high (false STOP mid-street) | 0 | COCO detector + looming |
| Person / cart directly ahead (indoor) | ~1 s | < 1 s | Low–medium (cane covers it) | 0 | COCO detector |
| Heading vs crossing/leg bearing (veer) | Continuous | < 200 ms | High during crossing | 0 (sensors) | `watchHeadingAsync` |
| Which aisle sign is in view | Changes every ~10 s at walking pace | ~3 s | Medium (wrong aisle, recoverable) | 0 OCR → fuzzy match; Tier 1 on ambiguity | OCR + store map |
| Storefront / entrance visible | ~10 s | ~5 s | Low (transition lags) | 1 | Claude Haiku |
| Crossing ahead? which street? signalized? | Static map fact | seconds, precomputed | Medium | 2 (precomputed at route time) | OSM + WPRDC + Nemotron |
| "I need eggs" / free-form intent | n/a | 2–4 s | Low | 2 | STT → Nemotron guided_json |
| Vehicles in a left/right scan frame (unsignalized crossing) | ~1 s | < 1 s detector; ~2 s Claude second opinion | Severe (miss) | 0 + 1 | COCO detector during the scan; Claude on the two stills |
| Camera/viewpoint request ("tilt up", "turn left a little") | n/a | ~2 s | Low | 1 | Claude `cameraRequest` field |
| Hand relative to target product (pick-up, stretch) | ~1 s | ~2 s per step | Low (retry) | 1 | Claude on successive frames |
| Next spoken instruction wording | Per leg | seconds, precomputed | Low | 2 (route compile) | Nemotron; deterministic template fallback |

### Tier 0 — on-device frame loop (Swift `PerceptionModule`) **[verify: per-stage ms]**

Everything in this tier runs inside the one native module specified in `09-PERCEPTION-MODULE.md`;
no JS camera package is installed. ARKit frame (30 fps, 1280×720, `ARFrame.capturedImage`) →
rotate and resize to model input (320–640 px) inside the module → CoreML inference on the Neural
Engine (Apple Vision for OCR) → lightweight tracker (IoU association across frames) → per-question
gate and temporal filter → rate-limited event to JS → haptic/audio. Budget per frame on an
iPhone 13–16 class: capture 0, resize 2–5 ms, YOLO-nano 10–20 ms (ANE), tracking < 2 ms,
decision < 1 ms → 15–30 ms. Per-mode schedule so four models never run at full rate together:
detector 15 fps, depth 10, segmentation 5–10 when enabled, OCR 3 (indoor only).
Frame-to-haptic latency target: < 150 ms.

Temporal filters: signal state changes after ≥5 of the last 8 frames agree; vehicle STOP requires
box-area growth > 40 % over 0.5 s on a track alive ≥ 0.3 s; OCR match requires the same normalized
string in 2 of 3 consecutive reads. Every filter's UNKNOWN state produces silence, never a guess.

### Tier 1 — Claude, slack-tolerant semantics [verified facts]

- Latency: Haiku 4.5 TTFT 0.66 s (Artificial Analysis, first-party endpoint, 10K-token workload);
  projected ~2–2.5 s end-to-end for one 640×480 frame + ~100 JSON tokens including upload and the
  proxy hop. Sonnet 5 non-reasoning TTFT ~1.09 s; with adaptive thinking ~1.9 s TTFT — pass
  `thinking: {type:'disabled'}` on the crossing crop path.
- Cost: images bill as ⌈w/28⌉×⌈h/28⌉ patches. 640×480 = 414 tokens ≈ $0.0004 on Haiku; all-in
  ~$0.0016/frame. A 3-minute demo at adaptive cadence costs cents; an hour at 1 fps ~$6–8.
- Rate limits are not the ceiling: Start tier is 1,000 RPM / 2M input tokens per minute per model.
- Structured outputs (`output_config.format`, `json_schema`) are GA on both models; keep ONE
  byte-stable superset schema (grammar compile is cached 24 h per schema) and warm it at proxy start.
- Prompt caching: minimum cacheable prefix is 4,096 tokens on Haiku 4.5 (a normal system prompt
  will not cache) and 1,024 on Sonnet 5 (cache the system prompt there; per-frame images do not
  invalidate a system-prompt cache).
- Anthropic's own OCR guidance: pre-resize, keep text legible, avoid heavy JPEG compression.
- No audio input: voice goes through a separate STT.

Adaptive cadence (only for Tier 1 now): INDOOR cruise 1 frame / 4 s; INDOOR near target order or
storefront check 1 / 2 s; CROSSING fallback crop 1 / 1 s with ≤3 in flight, sequence-numbered,
stale results dropped. Tiers change the period and pool size, never the architecture.

### Tier 2 — Nemotron text reasoning at events [verified facts]

- Primary `nvidia/nemotron-3.5-lightning-30b-a3b` (NVIDIA's own voice-agent default; built for
  tool calls, validation, classification), `chat_template_kwargs: {enable_thinking: false}`,
  `nvext: {guided_json: <strict schema>}`; fallback `nvidia/nemotron-nano-3-30b-a3b` (spelling
  varies by surface — read the authenticated `/v1/models` on day 0). Same-model failover via
  OpenRouter behind the proxy if the free endpoint 429s.
- Hosted latency is unpublished; assume 0.7–1.5 s TTFT and 1.5–4 s per ~100-token answer with a
  fat tail (multi-second to 90 s under load). Always stream; 1.5 s first-token deadline; on miss,
  play the deterministic cached phrase. Route only questions with ≥5 s of slack here.
- Job list: route compiler (all legs → ≤12-word "soon/now/confirm" phrases + crossing flags, one
  call at route fetch, then ElevenLabs pre-synthesizes the variable ones); intent parser; store-map
  disambiguator ("dairy" vs "eggs" → aisle); crossing-announcement judge (which OSM node is on the
  path, signalized or not, push-button likely from WPRDC operation type); "repeat / how far / where
  am I" responder. Evidence artifact for judges: a 1-page eval in the repo (intent accuracy on ~60
  utterances incl. noisy-ASR variants; instruction-wording A/B vs raw Google text).
- What never waits on Nemotron: signal state, vehicle STOP, all haptics, the beacon, leg
  advancement, the transition announcement.

### What still cannot be done, on any tier
Vehicle speed/distance; threats outside the camera's ~70° forward field (cross traffic, behind);
drivers disregarding signals; night signal reading without night training data; shelf-level item
detection; general indoor localization. Say each of these out loud in the pitch.

### Measurement protocol (pre-event Sept 18, repeat hour 2 of the event)
Twenty aisle-sign frames and twenty signal-head frames shot at the venues on the demo phone.
Tier 0: fps, per-frame ms, detector precision/recall per class, OCR match rate. Tier 1: p50/p95
end-to-end for Haiku and Sonnet with the final schema, JSON validity, accuracy. Tier 2: p50/p95
and `nvext` acceptance for each job schema, thinking actually off. All numbers land in DebugPanel.

---

## Platform & deployment

**Decision: Expo development build on iOS as the primary demo device, Expo SDK 57 pinned.**
Camera owner, decided and not optional: ONE native Swift `PerceptionModule`, built with the Expo
Modules API on ARKit world tracking (`gravityAndHeading`) and owned by Agent C on Mac 1. It runs
Apple Vision OCR, the CoreML detectors and monocular depth (segmentation later, optionally) and
exposes `snapshotJPEG(maxWidth)` for cloud calls — see `09-PERCEPTION-MODULE.md` for the module
and `01-SHARED-CONTRACTS.md` for its events. iOS allows one `AVCaptureSession` owner, so no other
camera client exists anywhere in the app. Everything in docs 00–07 that is not the camera pipeline
survives: Expo modules (`expo-location`, `expo-haptics`, `expo-sensors`, `expo-speech`,
`expo-audio`, `expo-keep-awake`, `expo-file-system`), zustand, the contracts, the proxy.

Why iOS: CoreML on the Neural Engine gives the best YOLO-nano latency; Core Haptics-class fidelity;
`watchHeadingAsync` true heading with a calibration tier; ARKit pose exists nowhere else; OKO's
precedent is iOS. The Swift module costs ~300–600 lines on one Mac and a named Swift owner, and
that cost is accepted: it is the only way to get ARKit pose, Apple Vision and the CoreML detectors
off a single camera session. Why not a Swift-only app: it discards the RN plan and the team's
contracts. Why not Flutter: no advantage over the RN dev build here.

Package set **[verify versions against Expo SDK 57 in phase 0 — `11-PHASE-0-CHECKLIST.md` V4]**:
the Expo modules above plus `expo-dev-client`, `expo-modules-core`, zustand and the on-device STT
module. The whole perception stack is native Swift inside `modules/perception/`, so no camera,
frame-processor or on-device-inference package appears in `package.json`. Pin `expo@~57`; do not
let `create-expo-app` drift to SDK 58.

Camera stacks considered and rejected (do not reopen):

| Package / path | Status | Why |
|---|---|---|
| `react-native-vision-camera` (+ `react-native-worklets-core`) | **REJECTED** | Cannot share the capture session with ARKit, so it costs the pose, plane detection and true-north world frame the course-keeping design depends on |
| `react-native-fast-tflite`, `vision-camera-resize-plugin` | **REJECTED** | Useful only as vision-camera frame processors; CoreML on the Neural Engine runs inside the module instead |
| A JS OCR plugin (`react-native-vision-camera-text-recognition` / ML Kit) | **REJECTED** | Apple Vision runs natively on `capturedImage`; a second camera client is not available anyway |
| `expo-camera` | **REJECTED** | No frame access and single-flight capture on iOS (~1 capture/s at best) |
| Android build / GPU-NNAPI inference budget | **REJECTED for this build** | The demo device is a non-Pro iPhone, nobody owns an Android path, and ARKit has no Android equivalent |

CI keeps this honest: Agent A's hour-one task greps `package.json` for `expo-av`, `expo-camera`
and `react-native-vision-camera` and fails on any of them (`02-AGENT-A-core-shell.md` Task 1).

Deployment path (paid Apple Developer team; every Mac signed in to it in Xcode): `npx expo
prebuild` → `npx expo run:ios --device` over USB, ~2 minutes after the first build. The Windows
user's iPhone is registered with `eas device:create` and installs from EAS internal-distribution
links (`eas build --profile development --platform ios`) while running its own
`expo start --dev-client`. Batch native changes (Swift module, new CoreML models) and publish them
through EAS so every phone stays current. TestFlight review is not viable in the window. First
native build is 20–40 minutes; prove the whole path on the demo phone in phase 0
(`11-PHASE-0-CHECKLIST.md` T1–T3), not at the event.

Backup: the same installed build carries `EXPO_PUBLIC_MOCK=1` fixture replay (track, recorded
crossing footage, pre-scored detections). This is the airplane-mode fallback docs 05/06 wanted.

Expo Go can still preview non-camera screens during development, but do not let anyone build
against it: `expo-av` is gone, the three-finger DebugPanel gesture opens Expo's menu, and the
login requirement bites on demo day.

---

## Crosswalk assistance

### Sub-flow and modes
The crossing cycle between outdoor legs is `OUTDOOR_NAV → APPROACH_CROSSING → AT_CURB →
CROSSING → OUTDOOR_NAV` (`01-SHARED-CONTRACTS.md` §1). There is no `CROSSED` mode: the event
`FAR_CURB_REACHED`, not a mode, closes the cycle and returns the machine to `OUTDOOR_NAV`. Events:
`CROSSING_AHEAD {street, signalized, pushButtonLikely, bearing}`, `SIGNAL_STATE {state: WALK |
DONT_WALK | COUNTDOWN | UNKNOWN, fresh: boolean}`, `VEHICLE_APPROACHING {direction}`, and
`FAR_CURB_REACHED`.

1. **Approach (map data, precomputed).** Google Routes has no crossing maneuver [verified], so join
   the route polyline to OSM `highway=crossing` nodes (Overpass, one bbox per route, cached) and to
   WPRDC's 783 signalized intersections (bundle as JSON). Oakland/Shadyside alone has 2,071
   crossing nodes, 58% untagged — treat untagged as "crossing, signal unknown". WPRDC
   `operation_type` Actuated/Semi → say "push button likely". Announce once at ~25 m: "Crossing
   ahead: Forbes. Signalized." Google's data must never trigger a walk cue (Maps ToS prohibits
   High Risk Activities; walking routes are beta and require the warning) [verified].
2. **At the curb.** Cane finds the curb. `TURN` + alignment ramp to the crossing bearing computed
   from the crossing node geometry (or the leg polyline). Compass best tier guarantees only ±20°
   [verified]; suppress alignment cues when `accuracy < 3` and say "compass uncertain" once.
   Camera-pointing guidance: phone at chest, tilted up ~10°.
3. **Signal reading (Tier 0).** Fine-tuned YOLO-nano with classes `ped_walk`, `ped_hand`,
   `ped_countdown` on a native-resolution center band (at 10–20 m the walk symbol is 13–33 px in a
   downscaled frame [verified from MUTCD symbol size and geometry]). Geometric gate: heading within
   ±20° of crossing bearing AND box within the horizon strip from accelerometer tilt AND nearest
   frame center — this is the defense against the parallel-vs-perpendicular misread, which is the
   most likely dangerous error. Temporal: ≥5 of 8 frames. **Onset rule:** if the app observed
   hand→walk, emit `fresh: true` immediately; if WALK was already showing when tracking began,
   emit `fresh: false` and say "Walk already on — wait for next" (O&M teaches not to start on an
   unseen-onset walk; MUTCD WALK can be as short as 4–7 s, then clearance at 3.5 ft/s).
4. **Feedback.** Tempo-coded audio tick (slow = don't walk, fast = walk, mid = countdown, none =
   unknown), exactly OKO's vocabulary; one spoken phrase only on transitions. Speech policy at the
   curb: nothing else may speak; beacon drops to a sparse tick; STOP haptic is the only haptic.
5. **Crossing in progress.** Alignment ramp holds the crossing bearing (baseline drift is ~5 m over
   a 22 m crossing; 60% of blind travelers end up outside the crosswalk without a far-side cue,
   26% with one [verified]); direction beacon toward the far curb; vehicle warnings active; signal
   ticker continues (a countdown starting mid-crossing = "Countdown" once, no advice).
6. **Far curb.** `CONFIRM`, resume the leg, beacon off.

### Permitted and forbidden language
Permitted phrases (all pre-generated in ElevenLabs): "Crossing ahead: <street>. Signalized." /
"Push button likely." / "Walk signal on." / "Walk already on — wait for next." /
"Don't walk." / "Countdown." / "Can't see the signal." / "Vehicle left|right|ahead." /
"Compass uncertain." Forbidden in code, UI, pitch and disclaimer: safe, clear, go, cross now,
no cars, you can cross.

Alignment is never spoken. Being on course is signalled by the absence of the course buzz, and
re-alignment after a turn by one `CONFIRM` tap — which is what keeps AT_CURB a near-silent zone.

### Model plan and gates **[verify dataset specifics]**
- Data: US-convention public sets (Roboflow Universe pedestrian-signal / crosswalk-signal
  projects; check licenses) — NOT ImVisible/LYTNet, which is red/green non-US signals — plus
  100–300 frames extracted from 3–5 minutes of video at each of the 2–3 demo crossings, both
  states, two times of day. Auto-label a first pass with a VLM, correct by hand.
- Train YOLOv8n/YOLO11n at 640 px, ~50 epochs on a free Colab T4 (< 1 h); export CoreML
  (`.mlpackage`) — the only format this build loads. A TFLite int8 export stays optional and
  unused, since the Android path is rejected. Owner and procedure: `10-CV-TRAINING-TRACK.md`.
- Gate (hour ~14 of the event, on held-out local frames): false-WALK precision > 95%, WALK/HAND
  recall > 80% at 10–20 m, parallel-signal confusion < 2% after the geometric gate, on-device
  ≥ 15 fps. Miss the gate → next rung of the ladder.

### Fallback ladder (each rung is demoable)
1. On-device detector (target).
2. Claude Sonnet 5 on a zoomed center crop at 1 fps, thinking off, strict schema, UNKNOWN unless
   confident; announce with the lag stated ("Signal read is delayed").
3. Alignment + veer + map-derived "crossing ahead, signalized" + vehicle-in-view; no state claim.
4. Manual signal-state button on a teammate's DebugPanel (always wired, like `forceEnter`).

### Demo plan
Pick a **fixed-time** signal (WPRDC `operation_type = Fixed`, e.g. along Forbes/Fifth) near the
store rather than an actuated one; rehearse at the same hour as the demo; a sighted spotter stands
with the operator; the narrator names OKO as prior art and states the envelope before the beat.

### Unsignalized crossings (stop sign, no pedestrian signal)
Map data says no `crossing:signals` (or the detector finds no signal head within 10 s). Flow:
`AT_CURB` → align to the crossing bearing (silence = aligned) → speech: "No signal here. Point the
camera left." → 2 s scan window: on-device vehicle detector at full rate on every frame; one still
frame to Claude with a strict schema `{vehiclesSeen: none|distant|approaching, confidence}` →
"Now right." → same → 2 s listening pause → speech reports perception, never permission:
"No vehicles seen to the left. No vehicles seen to the right. Listen, then cross." or "Vehicle
approaching from the right." If either the detector or Claude reports `approaching`, the report
says so; if Claude's confidence is low or the frame is dark/blurred: "Can't see well to the left."
Then `CROSSING` as in the signalized flow (course-error buzz, beacon to the far curb, vehicle
warnings live). The two scan stills are the only cloud calls at an unsignalized crossing; the
detector, not Claude, is what fires STOP if a vehicle looms during the scan or the crossing.
Why the wording: the only peer-reviewed VLM evaluation on this question scored 25 % and confused
approaching with distant vehicles; the report format gives the user the same facts without a
promise the sensors cannot keep.

---

## Moving-vehicle and hazard warnings

**Design (Tier 0).** Pretrained COCO YOLO-nano classes car, bus, truck, motorcycle, bicycle,
person; IoU tracker; per-track box-area growth and bottom-edge descent over a 0.3–0.7 s window.
Fire `VEHICLE_APPROACHING` when growth > 40 % within 0.5 s on a track ≥ 0.3 s old, box center in the
lower two-thirds, and the same track has not fired in the last 4 s. Output: `STOP` haptic + one
cached phrase "Vehicle left / right / ahead" (direction from box x-position). Never "clear".

**Modes.** Active in OUTDOOR walking and CROSSING; at AT_CURB it is active but its speech is the
only speech allowed; indoors the same loop runs on person (and cart via a small fine-tune or a
"large moving rectangular object" heuristic — cart is not a COCO class) with `OBSTACLE_AHEAD`
semantics and INFO priority, because the cane already covers it.

**Honest limits (say them).** Monocular looming gives approach, not speed or distance. A chest-
mounted phone sees ~70° forward: cross traffic at a curb is mostly out of frame until the user
turns toward it; nothing behind is seen. VLMs "confuse approaching vs distant vehicles" [verified,
peer-reviewed], which is why this is geometric and on-device rather than a Claude question. Even
OKO declines vehicle detection. Night and rain degrade detection; parked cars and flowing cross
traffic must not fire (growth threshold + track age handle most of it).

**False-alarm budget.** A false STOP mid-crossing is dangerous. Target < 1 false alert per 5
minutes of curb footage; evaluate on recorded curb video with hand-labeled approaching events.
Frame-to-haptic latency target < 150 ms; measure it.

**Audio-masking policy.** The user's hearing is the primary vehicle sensor. At the curb the app is
near-silent (signal ticker only); the beacon is sparse; onboarding recommends open-ear /
bone-conduction headphones and says why.

---

## Outdoor navigation, sensors, the audio beacon & Nemotron's role

**Routing.** Use Routes API `computeRoutes` (WALK) with a field mask; steps carry a `maneuver`
enum and plain-text instructions (no HTML) [verified]. Compute `startBearing` from the first two
polyline points of each step. Display Google's walking-beta warning. Pricing is per-SKU free
monthly caps since March 2025, not a $200 credit; volumes here are trivial.

**Store and entrance.** Places returns a centroid, not the door. For a big-box store the centroid
can sit 50–100 m from the entrance, which breaks a 35 m entrance geofence. Pin the entrance
manually in `fixtures/stores/<id>.json` during the venue walk; use Places only to find the store.

**Leg advancement.** Two consecutive fixes inside 15 m, as 03 says; additionally require the fix
accuracy ≤ 20 m or widen the radius to 25 m, otherwise urban-canyon jumps skip legs.

**Heading.** `expo-location.watchHeadingAsync` (`trueHeading`, `accuracy` 0–3) replaces the
magnetometer plan in 02 Task 5 [verified]. Best tier = < 20° uncertainty, so a dead zone tighter than ~12° would buzz on
sensor noise; keep 12° when `accuracy == 3`, widen to 18° at `accuracy == 2`, and suppress the
course buzz (say "compass uncertain" once) below that. Add cross-track error against the leg
polyline so "drifting into the road" is caught by two independent sensors, and use the fused estimate as the
contract: buzz when `crossTrackM > 0.5` toward the roadway side (`01-SHARED-CONTRACTS.md` §2,
`02-AGENT-A-core-shell.md` Task 3), heading error being fine or not. Raw GPS alone is 5–30 m, so
in the degraded case (no pose, no curb line) it can only confirm a gross excursion, never fire the
buzz on its own.

**Turns.** At ~20 m: "Turn right in twenty feet." At the maneuver point (two consecutive fixes
inside 15 m): "Turn right now." + `TURN`, then the course-error buzz runs against the next leg's
bearing until it falls inside the dead zone → silence → one `CONFIRM` tap. No "hot/cold" ramp
anywhere any more; silence is the reward.

**The direction beacon (replaces "beep faster as you get closer").** Soundscape's beacon encodes
direction, not distance: a steady spatialized pulse toward the target with an extra tick when the
target is inside the forward window; it deliberately does not change with distance because a
constantly changing signal fatigues [verified]. Adopt it. `expo-audio` exposes no pan or balance
property [verified], so direction comes from two hard-panned loops (`beacon_L.mp3`,
`beacon_R.mp3`) played on two players whose volumes follow a constant-power law from the relative
bearing (`02-AGENT-A-core-shell.md` Task 5, `11-PHASE-0-CHECKLIST.md` T5); if that fails, a
pre-rendered set of five to seven pan positions switched by heading bucket. A native
`AVAudioPlayer.pan` in the module is an upgrade for after phase 2, not a prerequisite. Play it
during approach to a maneuver point (last ~40 m), toward the far curb while crossing, and toward the entrance in the final 40 m outdoors.
Silent whenever speech plays, at AT_CURB except a sparse tick, and indoors. Distance is spoken,
not beeped ("Twenty feet"). Onboarding teaches it in one 10-second exercise: "turn until the pulse
is centered".

**Nemotron's role ("Beyond the Chatbot").** At route fetch, one guided_json call turns the step
list into a leg script: ≤12-word phrases per leg (soon / now / confirm), crossing legs flagged with
street and signal status, push-button hints from WPRDC. ElevenLabs pre-synthesizes the variable
phrases immediately, so by the time the user walks, everything spoken outdoors is cached audio.
During the walk Nemotron answers only "repeat", "how far", "where am I" and re-plans after a
missed turn, each as a schema-bound single turn with a 1.5 s first-token deadline and a templated
fallback. The pitch line: Nemotron routes, classifies, judges and decides; it never chats.

**Demo clock.** The outdoor leg with a crossing is now ~90 s of a 150 s demo. Choose a store whose
entrance is within ~150 m of the fixed-time crossing, or replay the walk-up from fixtures and go
live only for the crossing and the store.

---

## Transition detection

The 05 heuristic (accuracy > 30 m for two fixes inside the radius) is directionally right and
temporally wrong. Verified behaviour: iOS often holds 5–10 m accuracy for seconds after entering,
then snaps to ~65 m when it falls back to Wi-Fi positioning — a step, not a climb — and Apple's
own definition makes the accuracy radius a 63–68% bound. Purpose-built detectors need 3–4 s;
naive heuristics lag 10–20 s.

Fusion (fire once, 10 s debounce, manual always wired):
- distance-to-entrance reached a minimum < 15 m and is now rising or frozen (weight 0.3)
- accuracy step-up ≥ 2× or > 30 m (0.3)
- ≥ 15 pedometer steps since the minimum-distance fix (0.2)
- one Tier-1 storefront/door frame positive, max one call per 5 s (0.2)
- ambient light drop (Android only; bonus, not required)
Fire at ≥ 0.6. Expect the live announcement 5–15 s after the door; that is acceptable, and the
mock track should reproduce exactly this profile so rehearsals feel like reality.

Demo emphasis: the crossing beat is now the most memorable moment for judges; the transition is
the second. Do not narrate over either.

---

## Indoor guidance

**Loop.** On-device OCR at 3–5 fps on the upper band of the frame (signs hang overhead; phone
tilted up ~15° indoors) → normalize → fuzzy match (edit distance ≤ 2, plus digit exact-match)
against `signText` of the store map → `AISLE_IDENTIFIED` after 2 of 3 agreeing reads. Claude
Haiku is called only when OCR yields text that matches nothing or matches two aisles, at most
once per 4 s, with the known-sign list in the prompt and a strict schema. Nemotron Nano 2 VL /
OCR v2 leave the image path entirely (team decision; also the VL id is not in the public model
list).

**Prior.** Pedometer steps since the last confirmed sign × ~0.7 m stride estimates progress
between reads (±1.5 aisles over 50 m); it drives "keep going" cadence and catches "you've passed
it" earlier than the next sign.

**Navigator edge cases to handle in code:** non-numeric labels (`DAIRY`) — order comes from the
map, not the text; cross-aisles and end-caps — ignore reads that skip more than 2 orders unless
repeated; entering mid-store — first confident read sets `currentOrder`; walking the wrong way —
two consecutive reads with decreasing order flips direction and the LEFT/RIGHT side; two signs in
one frame — take the larger box; no read for 20 s — "Keep going, looking for a sign" once (INFO).
**Schema fix:** `itemIndex.side` is direction-agnostic in 01 §6; store `sideWhenAscending` and
invert when travelling in descending order.

**alignmentOffset.** From a VLM it is noise. From the OCR/detector bounding boxes it is usable:
the horizontal offset of the aisle-sign box or shelf-edge lines from frame center, smoothed over
1 s, feeds the shared alignment ramp.

**Posture conflict.** Overhead signs want tilt-up; hazards want forward. Resolution: chest-height
phone, ~15° up, on a lanyard or chest mount; a 0.5× ultra-wide lens (if the phone has one)
captures both. Rehearse with a cane in the other hand.

**Active perception (Claude may direct the camera).** Every Tier-1 response schema carries an
optional `cameraRequest: up|down|left|right|closer|none` and `userAction: none|turn_left|
turn_right|walk_forward|stop|reach`. The speech layer turns these into ≤ 6-word prompts ("Tilt the
camera up", "Turn left a little"). Cadence: one request per 3 s, and never while a haptic ramp is
active. This is the correct job for a 1–2 s model and the reason the indoor loop tolerates cloud
latency.

**Item pick-up (stretch beat).** After `TARGET_AISLE_REACHED`: "Face the shelf on your right.
Reach out." Claude on successive frames (~2 s each) reports the hand relative to the target
package (`left|right|higher|lower|touching|not_seen`) with a strict schema; speech says one word
per step; `CONFIRM` on `touching`. Give up after 8 steps ("Ask staff for help finding it") —
shelf-level detection in clutter is where academic systems still fail, so demo on a distinctive
package and keep "Eggs on your right" as the guaranteed payoff.

**Venue.** Walk the store on Sept 18: exact sign strings, order, checkout signage, lighting,
entrance coordinates; record a full-route video for fixtures; ask the manager about filming.

---

## Audio, voice input, and haptics

**Channel allocation (the rule that keeps the app quiet):**
- Haptics: course-error buzz (silence when on course; rate and intensity grow with heading error
  beyond a ~12° dead zone and with GPS cross-track drift toward the roadway), TURN, STOP, CONFIRM.
  Four. STOP is reserved for vehicle approach and hard obstacles. The same rule runs on legs, at
  the curb, mid-crossing and down an aisle, so it is learned once.
- Audio (non-speech): direction beacon; signal-state ticker (tempo). Never both at once — the
  ticker wins at AT_CURB, the beacon wins while CROSSING.
- Speech: meaning only; ≤ 12 words; the 4 s minimum gap stands outside CRITICAL; at AT_CURB only
  signal transitions and vehicle alerts may speak.

**ElevenLabs.** Flash v2.5 is the lowest-latency model; Turbo is deprecated [verified]. Flash does
not normalize text — write numbers as words yourself ("twenty feet"). Pre-generate the closed
phrase set (now ~40 phrases including crossing and vehicle lines); live Flash only for street
names and aisle labels, and pre-synthesize those at route/store-load time so nothing is live
during the walk. Free-plan concurrency is 4 simultaneous Flash requests — batch the pre-synthesis.
Speaking rate: `expo-audio` `playbackRate` with pitch correction speeds up cached files on-device,
so one file set serves all rate settings.

**Voice input.** Push-to-talk (large on-screen target + volume-button gesture if available):
record 16 kHz mono → on-device STT in the dev build (Apple Speech / Android) with ElevenLabs
Scribe as the accuracy fallback in store noise → Nemotron guided_json `{intent, item, reply}` →
one ≤12-word reply. End-to-end 2–4 s. Keyboard dictation on a `TextInput` is the zero-risk
fallback. Do not route STT through NVIDIA's hosted ASR: it is gRPC-only via NVCF and a day of
plumbing [verified]. Keep recording mode off except during the utterance (iOS switches Bluetooth
headsets to low-fidelity HFP while recording).

**Haptics on the dev build.** `expo-haptics` still works; a Core Haptics module can add sharper
patterns later. Verify all four patterns through a lanyard-mounted phone, not a pocket — the
vision legs require the phone in view. `useKeepAwake`; Low Power Mode off; screen on.

**Screen readers.** Every control labeled; the nav screen is a single live region; app speech uses
`duckOthers`; VoiceOver users will run the app with VoiceOver on — test that path once.

---

## Safety, privacy, trust, and app accessibility

**Posture.** A prototype mobility *supplement*. Cane or guide dog assumed at all times. The app
reports what it perceives (signal state, alignment, an approaching vehicle in view, the aisle it
reads); the user decides. OKO's wording is the model: "can only identify pedestrian signals; it
cannot identify if drivers are disregarding those signals"; silence when it cannot read [verified].

**Language rules per mode.** OUTDOOR: instructions and crossing facts only. AT_CURB: signal
transitions, vehicle alerts, "compass uncertain". CROSSING: vehicle alerts, "Countdown", "Far
curb". INDOOR: aisle facts and "Obstacle ahead". Nowhere: safe, clear, go, cross now, no cars.

**Harm model and the control that bounds each:** false WALK → onset rule + geometric gate + N-of-M
+ precision gate > 95 %; missed vehicle → stated FOV limit + hearing protected by the silence
policy; false STOP mid-crossing → track-age and growth thresholds + false-alarm budget; wrong aisle
→ whitelist + 2-of-3 + recoverable by design; stale cloud reads → sequence numbers + freshness
windows + "delayed" wording on the fallback rung.

**Disclaimer (first launch, spoken, ≤ 12 s, skippable after first run):** "Aisle is a prototype,
not a safety device. Keep using your cane or guide dog. Aisle reads walk signals and warns about
vehicles it can see; it cannot see everything and never decides when to cross." Replace 02 Task 8's
text (which says the app does not help with crossings).

**Privacy.** Tier 0 keeps street and store video on the phone — say this to judges; it is a
genuine advantage of the new architecture. Only sparse frames go to Claude (storefront checks,
OCR ambiguity, curb-crop fallback) and only text to Nemotron and ElevenLabs. Bystanders' faces in
those frames are not stored by the app; check each provider's retention page before the pitch and
state it in one sentence. Ask the store manager before filming.

**Battery and thermal.** Continuous camera + on-device inference at 15 fps + GPS + network is a
real load: expect noticeable warmth in 10 minutes and 15–25 %/hour drain **[verify on the demo
phone]**. Run detectors every other frame, drop OCR to 3 fps indoors, stop Tier 0 entirely when
IDLE, keep the screen dim, start the demo above 80 %.

**Connectivity loss.** Tier 0 and haptics continue; cached speech continues; Tier 1/2 calls fail
closed (silence, not guesses); the app says "Offline — signal reading and directions still work"
once. Rehearse it.

**Testing with blind users.** Valuable and credible if done; never at a live crossing during the
hackathon without an O&M professional or sighted guide, and never as a first exposure to the
haptic vocabulary. If time allows, an indoor 10-minute session is the right ask.

**Accessibility of the app itself.** Large targets, labeled controls, no visual-only state,
works with VoiceOver on, one-thumb operation, nothing behind gestures Expo or iOS already use.

**Terms.** Google Maps ToS High Risk Activities: route data informs, never triggers. Walking
routes: display the beta warning. Anthropic usage policy: no safety-critical decision is delegated
to the model. Dataset licenses for the signal model: record them in the repo.

---

## Course-keeping, the 1–2 s voice pipeline, and setup edge cases (third pass)

### Detecting drift "even a little bit" — the fused lateral estimate
Heading alone cannot do it: the compass guarantees ±20° and measures orientation, not position;
GPS is 5–30 m. The design is a fused estimate, all on-device:
- **Fast heading:** gyro-stabilized yaw from DeviceMotion (sub-degree over 10–30 s) corrected by
  `trueHeading` (absolute); gate on the compass `accuracy` tier; fall back to gyro-only for ≤ 30 s
  and say "compass uncertain" once.
- **Meters of drift:** integrate heading error × pedometer stride between GPS fixes (dead
  reckoning) against the leg polyline; GPS re-anchors when accuracy ≤ 10 m.
- **Camera curb line:** on-device walkable-surface segmentation (Cityscapes-class model: road /
  sidewalk / wall / building; export to CoreML **[verify model + fps]**) gives the road edge's
  position in the frame → lateral offset ±0.2–0.5 m, independent of GPS and compass.
- **Wall / obstacle ahead:** monocular depth (Depth Anything V2 small; Apple publishes a CoreML
  build **[verify]**, ~30–60 ms on recent iPhones): the centre-bottom region closing faster than
  walking pace → STOP. Indoors the same two models give aisle centring (floor / shelf boundaries)
  and end-of-aisle walls.
- **Rule:** course buzz when estimated drift toward the roadway exceeds ~0.5 m OR heading error is
  outside the dead zone for > 0.5 s (hysteresis); "toward the road" requires two agreeing signals
  (heading + curb line) to avoid buzz fatigue. Nothing in this loop touches the network.
- **Phone-to-body offset:** heading assumes the phone faces the walking direction. Calibrate at
  start ("walk straight for five seconds": compare `trueHeading` to GPS course while speed >
  0.5 m/s) and re-check whenever course and heading disagree > 10 s. A chest mount makes this
  stable; a hand-held phone does not.
- **ARKit pose (decided — this is why the Swift module exists):** iOS allows one camera owner
  (`AVCaptureSession`), and the ARKit-based native `PerceptionModule` (Expo Modules API) is it.
  It emits 6-DoF pose from visual-inertial odometry (centimetre-level relative drift, works
  indoors, no LiDAR needed — any A12+ iPhone), plane detection (floors, walls, shelf faces), a
  true-north-aligned world frame steadier than the raw compass, and runs Apple Vision OCR + the
  CoreML detectors natively on `capturedImage`, exposing a JPEG snapshot for Claude. Without a Pro
  there is no metric scene depth — Depth Anything (monocular) covers wall/obstacle distance. Check
  whether ARKit geo tracking supports Pittsburgh **[verify]** (≈1 m absolute outdoors if so).
  Costs: ~300–600 lines of Swift on Mac 1; tracking degrades in low light / blank walls (fall back
  to IMU); no ultra-wide; ~20–30 %/h battery. ARKit measures drift at ±0.05–0.1 m against
  ±0.3–0.5 m (estimated) for heading fusion + curb segmentation alone — which is the degraded
  mode when tracking is lost, not a second camera stack.

### Picture → analysis → first spoken word in ~1.3–1.5 s (Claude tier)
1. Stream; put `speech` first in the schema; start TTS when that string closes; pipe Claude's
   tokens into ElevenLabs' WebSocket input stream (TTFB ~100–200 ms).
2. ≤ 40 output tokens (terse enums, one utterance).
3. 512×384 thumbnail (266 tokens) unless text must be read; centre crop for signs; send the
   on-device facts (detections, OCR, depth summary) as text with the image — grounded prompting is
   faster and more accurate, and many turns then need no image.
4. Persistent WebSocket to a proxy hosted in us-east (not the laptop); keep-alive to Anthropic;
   grammar precompiled; warm-up request on every mode change.
5. Call only on scene change (frame difference / detector-state change) or user speech.
6. Haiku 4.5 for the loop; Sonnet 5 with thinking disabled only for the curb-crop fallback.
Projected: capture 30 ms + upload 150 ms + TTFT 650 ms + first sentence 300 ms + TTS 200 ms.
The haptic tier answers at < 150 ms regardless.

### Setup edge cases (paid Apple account; iPhones; three Macs + one Windows machine)
- Three Mac users build locally (`npx expo run:ios --device`, ~2 min after the first build) and
  can own Xcode-side debugging; install Xcode on all three now. The Windows user develops JS/TS,
  the Node proxy, fixtures and the Colab training, runs their own `expo start --dev-client`, and
  installs native builds from EAS internal-distribution links (`eas device:create`, `eas build
  --profile development --platform ios`). Batch native changes (Swift module, new CoreML models)
  and publish them via EAS so every phone stays current.
- Ownership (locked; see `00-PROJECT-BRIEF.md`): Mac 1 = `PerceptionModule` (ARKit, Vision OCR,
  CoreML, signal model), `src/perception/`, `src/indoor/`, `models/`;
  Mac 2 = core app, haptics, speech, sensors, demo-phone builds; Mac 3 = outdoor + crossing flow,
  Google/OSM/WPRDC, Nemotron jobs and `server/routes/plan.ts`; Windows = the proxy (`server/`),
  harness/fixtures, `src/transition/`, demo tooling, model training. The proxy is D's, never C's.
- One camera owner: the `PerceptionModule` ARKit session. Nothing else opens a capture session
  and no preview view is mounted.
- Demo phone: no Pro is available; any A12+ iPhone runs ARKit VIO, and A15+ gives Neural Engine
  headroom for the models. Pick the newest non-Pro on the team; LiDAR is not required.
- Thermal schedule: detector 15 fps, depth 10, segmentation 5–10, OCR 3 (indoor only), on the
  Neural Engine; disable what the mode does not need.
- `app.json` permission strings before the first build: camera, precise location, motion,
  microphone, speech recognition, local network.
- Rotate frames once inside the module (`capturedImage` is sensor orientation, not upright).
- Bluetooth audio adds 150–250 ms; urgent cues stay haptic.
- Guided Access on during use (chest-mounted screen gets touched).
- Buzz fatigue is a safety failure: hysteresis, minimum duration, two-sensor agreement.

---

## Risk register

| ID | Risk | Sev | Lik | Mitigation | Owner | When |
|---|---|---|---|---|---|---|
| R1 | Dev-build toolchain (Xcode, provisioning, pods, the Swift module) not working on the demo phone | Crit | Med | Phase-0 spike: `expo run:ios --device` with the `PerceptionModule` scaffold, a running ARKit session and one CoreML model on the demo iPhone (`11-PHASE-0-CHECKLIST.md` T1–T3); EAS internal distribution as the second install path | human | phase 0 |
| R2 | Signal model under-performs on local crossings (domain shift, glare, distance) | Crit | Med | Local frames from the actual crossings; gate at hour 14; fallback ladder; fixed-time signal for the demo | human + C | pre-event → h14 |
| R3 | Parallel-vs-perpendicular signal misread | Crit | Med | Heading ±20° gate, horizon strip, nearest-center rule, confusion measured < 2 % | C | build |
| R4 | Stale WALK acted on | Crit | Med | Onset rule (fresh vs already-on), N-of-M, "wait for next" phrase | C | build |
| R5 | False STOP mid-crossing from parked/cross-flow vehicles | High | Med | Growth + track-age thresholds; false-alarm budget on recorded footage | C | build |
| R6 | Team plans a 36-h build for a 24-h event | Crit | High | `11-PHASE-0-CHECKLIST.md` before the clock starts; +14 h and +18 h cut lines in `06-INTEGRATION-AND-DEMO.md` | human | now |
| R7 | Expo SDK drift to 58 / Expo Go login / `expo-av` imports break hour-one stubs | High | High | Pin `expo@~57`; `expo-audio`; no Expo Go dependency | A | h0 |
| R8 | Compass heading worse than 20° near cars/steel → alignment flutter or wrong lock | High | Med | Gate on `accuracy`; say "compass uncertain"; calibrate figure-8 in onboarding | A/B | build |
| R9 | Entrance geofence on a Places centroid misses by 50–100 m | High | High | Manual entrance pin from the venue walk | human + C | pre-event |
| R10 | Nemotron free endpoint slow/429 during demo | Med | High | Precompute all route/store jobs; stream + 1.5 s deadline; templated fallback; OpenRouter failover | B (`server/routes/plan.ts`) / D (proxy core) | build |
| R11 | Claude structured-output first-use grammar compile adds latency in the demo | Med | High | Warm every schema at proxy start; never vary the schema | D (`/api/vision` route) / C (schema) | integration |
| R12 | Transition fires 10–20 s late or double-fires | Med | High | Five-signal fusion; single fire; mock track reproduces the lag | D | build |
| R13 | Audio masking at the curb hides traffic | High | Med | Near-silence policy; sparse ticker; open-ear headphones recommended | A | build |
| R14 | Phone posture: cane in one hand, phone must face forward/up | High | High | Lanyard/chest mount; rehearse with a cane | human | pre-event |
| R15 | Thermal throttling / battery during rehearsals + demo | Med | Med | Detector every other frame; stop Tier 0 when idle; > 80 % at start; spare phone | A | integration |
| R16 | OCR misreads a sign as another aisle | Med | Med | Whitelist + edit distance ≤ 2 + 2-of-3; digits must match exactly | C | build |
| R17 | Hackathon Wi-Fi blocks LAN dev server / proxy | Med | High | Laptop tethered to phone hotspot; proxy bound to hotspot IP; fixture replay | D | demo |
| R18 | Vehicle detector fires on nothing at night / in rain | Med | Low | Demo in daylight; thresholds; state the limit | C | demo |
| R19 | Speech queue becomes chatty with new crossing phrases | Med | Med | Channel-allocation policy; utterances/min counter in DebugPanel | A | integration |
| R20 | Dataset license or judge asks for evidence of Nemotron use | Med | Med | License file; 1-page eval artifact (intent accuracy, wording A/B) | B | h20 |
| R21 | Store refuses filming / demo | Med | Low | Ask on Sept 18; backup venue (campus market) mapped | human | pre-event |
| R22 | VoiceOver double-speaks with app TTS | Low | Med | `duckOthers`, single live region, test once with VoiceOver on | A | integration |
| R23 | Judges pattern-match to "AI describes the scene" | Med | Med | Lead with the handoff and the crossing envelope; name OKO/ShopTalk yourself | human | pitch |
| R24 | Build will not open after an overnight lock (stale EAS build, revoked certificate) | Med | Low | Paid Apple Developer team, so the 7-day free-ID expiry does not apply; re-run the build the morning of anyway and keep a Mac at the venue | human | demo |
| R25 | Vehicle/hazard STOP and crossing STOP feel identical → confusion | Med | Med | STOP means stop, always; the spoken two words disambiguate | A | build |
| R26 | Heading ≠ walking direction (hand-held phone rotated) → course buzz points the wrong way | High | Med | Chest mount; start-up calibration vs GPS course; re-check on disagreement | A/human | build |
| R27 | Segmentation / depth models fail to export or run too slowly on-device | High | Med | Verify CoreML builds in phase 0; degrade to heading + dead reckoning only | C | phase 0 |
| R28 | Thermal throttling from running four models concurrently | High | Med | Per-mode model schedule; Neural Engine; measure surface temp during rehearsal | C | integration |
| R29 | A second camera client is added by accident (preview view, `expo-camera`) and fights the ARKit session | High | Low | `PerceptionModule` is the decided sole camera owner; CI grep keeps `expo-camera` and `react-native-vision-camera` out of `package.json`; no preview view anywhere | C | phase 0 |

---

## Revised roadmap & go/no-go gates

Timeline note: the team is not bound by the 24-hour event clock. Read "pre-event" below as
**phase 0** (do it first, take the time it needs — including signal-model v1 trained and running
on-device) and the hour table as **phase 1, relative to integration start**. The gates and the
cut order still apply; they are about risk, not the calendar.

### Pre-event (Sept 17–18) — everything with lead time; check hackathon rules on pre-written code
(planning, accounts, data, environment setup are normally allowed; app code typically is not)
- [ ] **Human:** Mac with Xcode; `expo run:ios --device` of a scratch dev build containing the
      `PerceptionModule` scaffold, a running ARKit session and one CoreML model, on the demo
      iPhone (R1; `11-PHASE-0-CHECKLIST.md` T1–T3).
- [ ] **Human:** accounts and keys: Anthropic (confirm Start-tier limits visible), NVIDIA NIM
      (authenticated `/v1/models`, confirm `nemotron-3.5-lightning` id and `nvext` acceptance),
      ElevenLabs (voice chosen, quota), Google Maps billing + Routes enabled, Apple ID on the
      phone, Colab/GPU access.
- [ ] **Human:** walk the demo route: choose the store, pin its entrance, choose a fixed-time
      signalized crossing within ~150 m; shoot 3–5 min of video per crossing in both states at
      two times of day; walk the store and record sign strings, order, checkout signage; ask about
      filming.
- [ ] **Human:** download candidate US pedestrian-signal datasets; check licenses; extract and
      label local frames (VLM first pass, hand-corrected).
- [ ] Confirm the locked ownership map (`00-PROJECT-BRIEF.md`): A (Mac 2) — `src/core/`,
      `src/ui/`, `App.tsx`, `assets/audio/`; B (Mac 3) — `src/outdoor/`, `src/crossing/`,
      `server/routes/plan.ts` and `route.ts`; C (Mac 1, Swift owner) — `modules/perception/`,
      `src/perception/`, `src/indoor/`, `models/`; D (Windows) — `server/` (proxy core, health,
      tts, stt, vision), `mocks/`, `fixtures/`, `src/transition/`, demo tooling, `training/`.
      C never touches `server/`. If any "agent" is an AI coding agent, a human owns every
      checkbox above and every venue task.

### Event (24 h, Sept 19 11:00 → Sept 20 11:00 ET)
| Hour | Track A core | Track B outdoor/Nemotron | Track C perception | Track D harness/proxy |
|---|---|---|---|---|
| 0–1 | `contracts.ts` verbatim from `01-SHARED-CONTRACTS.md`, stubs pushed | — | `PerceptionModule` scaffold builds and emits its heartbeat event | Proxy skeleton, `/api/health` across all five upstreams |
| 1–4 | Haptics, speech queue, `expo-audio` cache player, sensors via `watchHeadingAsync` | Routes fetch + OSM/WPRDC crossing join; Nemotron route-compiler schema | `PerceptionModule` ARKit session live; stock COCO detector at 15 fps; Apple Vision OCR | Mock sensors + vision fixtures + jump-to-phase |
| 4–8 | Onboarding, DebugPanel (long-press trigger), beacon (two hard-panned loops) | Legs, turn haptics, crossing sub-flow states, curb speech policy | Vehicle looming + STOP; OCR → fuzzy match → navigator | Transition fusion on the mock track |
| **6 gate** | | | **Tier 0 frame loop running on the demo phone at ≥ 15 fps with STOP firing on recorded curb footage.** Miss → drop custom haptics polish; put a second person on C | |
| 8–12 | Voice push-to-talk + STT + Nemotron intent | Nemotron jobs precomputed and cached; ElevenLabs pre-synthesis of variable phrases | Signal model v1 (trained pre-event or in hours 1–6) on-device; geometric gate; onset rule | Fixtures from recorded crossing + store video |
| 12–14 | Integration on the demo phone, mocks off outdoors | | Signal model measured on held-out local frames | Rehearsal 1 (fixtures) |
| **14 gate** | | | **Signal model: false-WALK precision > 95 %, recall > 80 %, confusion < 2 %.** Miss → rung 2 (Sonnet crop) or rung 3; demo script switches wording | |
| 14–18 | Live venue run 1 (crossing + store) | Fix what broke | Fix what broke | Rehearsal 2 (live), timed |
| **18 cut line** | Anything not working live is replaced by fixtures. Order of cuts: voice input → Nemotron live calls (keep precomputed) → vehicle warnings (keep STOP for obstacles) → live signal read (keep alignment + map awareness) → live transition (keep manual) | | | |
| 18–21 | Polish utterances, disclaimer, VoiceOver pass | Nemotron eval artifact (1 page) | Battery/thermal check | Rehearsal 3; backup phone with fixture build |
| 21–24 | Pitch, slides with the envelope statement, failure-mode checklist, sleep in shifts | | | Run-of-show final |

### Cut priority if behind (drop first → last)
voice input → live Nemotron (keep cached outputs) → vehicle warnings → live signal model (keep
alignment + map awareness + manual) → outdoor leg live (replay it) → transition live (manual).
Never cut: indoor aisle guidance, the handoff announcement, the haptic onboarding, the disclaimer.

### Day-0 checklist ordered by cost of late discovery
1. Dev build installs and runs the `PerceptionModule` ARKit session on the demo phone.
2. Nemotron model id + `nvext` accepted; Claude schema warms. 3. Signal-model frames exist and are
labeled. 4. Entrance pinned; crossing chosen; store mapped. 5. Phone hotspot + laptop + proxy path
works. 6. ElevenLabs voice and cache generated. 7. `expo@~57` pinned; `expo-av`, `expo-camera` and
`react-native-vision-camera` absent. 8. Lanyard/chest mount in hand.

---

## Required doc changes & errata for 00–07

These changes have been applied in the rewrite of 2026-09-17 (see the index at the top of this doc
for where each topic now lives); the table is kept as the record of what changed and why.

| Doc | Current text | Change to | Kind | Source |
|---|---|---|---|---|
| 00 Non-goals | "Street-crossing guidance, traffic/curb detection — not building"; "Outdoor obstacle detection from video — not building" | Remove both rows; add "Crossing assistance (signal state, alignment, vehicle-in-view) within the safety envelope in `08-ROADMAP-AND-CONCERNS.md`"; keep "shelf-level detection", "queue detection", "payment", "SLAM", "continuous narration" as non-goals | direction | team |
| 00 Tech stack | "React Native + Expo … `expo-av`"; Nemotron Nano 2 VL for all vision | Expo **development build**; `expo-audio`; a native Swift `PerceptionModule` (ARKit + CoreML + Apple Vision) as the only camera owner; Claude Haiku 4.5 Tier 1; Nemotron 3.5 Lightning Tier 2 | direction + errata | Expo SDK 55 removed `expo-av` from Expo Go [verified] |
| 00 Sponsor stack | "Nemotron Nano 2 VL … leads OCRBench v2" | Nemotron text model as decision layer; drop the OCRBench claim (not verified; the VL id is absent from the public model list) | direction + errata | NIM `/v1/models` 2026-09-17 |
| 01 §1 AppMode | 8 modes | Add `APPROACH_CROSSING`, `AT_CURB`, `CROSSING` — no `CROSSED` mode, `FAR_CURB_REACHED` returns to `OUTDOOR_NAV`; allow `OUTDOOR_NAV ↔ APPROACH_CROSSING` cycles | direction | Crosswalk assistance |
| 01 §5 Events | no crossing/vehicle events | Add `CROSSING_AHEAD`, `SIGNAL_STATE {state, fresh}`, `VEHICLE_APPROACHING {direction}`, `FAR_CURB_REACHED` | direction | Crosswalk assistance + Moving-vehicle warnings |
| 01 §4 Sensors | heading from magnetometer, rolling median | `watchHeadingAsync` with `accuracy` tier exposed; gate on it | errata | Expo docs [verified] |
| 01 §6 Store map | `itemIndex.side` | `sideWhenAscending`, inverted by travel direction; add `entrance` pinned manually | errata | Indoor guidance |
| 01 §7 VisionService | one cloud call per frame | Split: `PerceptionService` (Tier 0 events) + `SemanticVision` (Tier 1) | direction | Perception architecture |
| 01 §9 Latency table | "Camera frame → Nemotron result < 2.5 s; one frame every 2 s" | Tier 0 frame→haptic < 150 ms; Tier 1 p95 < 3 s adaptive; Tier 2 first token < 1.5 s or fallback | direction | Perception architecture |
| 02 Task 1 | `npx expo install … expo-av`; Expo Go | dev-build package set; `expo-audio` | errata | [verified] |
| 02 Task 5 | magnetometer heading | `watchHeadingAsync` | errata | [verified] |
| 02 Task 7 | DebugPanel "three-finger tap" | long-press on the mode label (three-finger tap opens Expo's dev menu; shake too) | errata | Expo docs [verified] |
| 02 Task 8 | "Aisle does not help with street crossings" | disclaimer text under "Safety, privacy, trust" | direction | Safety, privacy, trust |
| 03 Scope | "no camera outdoors; refuse crossing work" | crossing sub-flow owned by B (flow) and C (perception) | direction | Crosswalk assistance |
| 03 Task 1 | "$200/month free credit"; Directions API | per-SKU free caps since March 2025; Routes API with field mask; walking-beta warning displayed | errata | Google pricing/Routes docs [verified] |
| 04 all | Nemotron VL prompt, 2 s cadence, ≤1024 px JPEG q60 | Tier 0 OCR + fuzzy match; Claude ambiguity calls; 640×480 frames for Tier 1 (414 tokens) | direction | Perception architecture + Indoor guidance |
| 05 Part 2 | GPS-degraded ×2 fixes, 0.6/0.4 fusion | five-signal fusion under "Transition detection"; expect 5–15 s lag | errata | iOS/Android accuracy behaviour [verified] |
| 05 Part 3 / 06 checklist | "airplane-mode backup build" | fixture-replay mode inside the installed dev build | direction | Platform & deployment |
| 06 Dependency order | "Hour 0–1 … Hour 24+" multi-day | phase plan in `06-INTEGRATION-AND-DEMO.md`, with `11-PHASE-0-CHECKLIST.md` before it | errata | event schedule [verified] |
| 06 Judge Q&A | "we deliberately excluded street crossings" | envelope statement: reads signals like OKO, keeps the user aligned, warns of vehicles it can see, never decides | direction | Crosswalk assistance + Safety, privacy, trust |
| 07 §1 | Nano 2 VL details, "leads OCRBench v2", credits system | Nemotron 3.5 Lightning, `enable_thinking:false`, `nvext.guided_json`; NIM free tier has no credits, unpublished per-model rate limits | errata | NVIDIA forum/staff statements [verified] |
| 07 §2 | Flash v2.5 (correct); `expo-av` preload | keep Flash v2.5; `expo-audio`; write numbers as words (Flash does no normalization); free-plan concurrency 4 | errata | ElevenLabs docs [verified] |
| 07 §3 | keys for 3 providers | add `ANTHROPIC_API_KEY`; `/api/vision` (Claude), `/api/plan` (Nemotron), `/api/tts`, `/api/stt`, `/api/route`, `/api/health` all five upstreams | direction | Perception architecture |

---

## Open questions for the team

1. Hackathon rules: what may be prepared before 11:00 on Sept 19 (environment, datasets, labeled
   frames, accounts are usually fine; app code usually is not)? This decides how much of
   `11-PHASE-0-CHECKLIST.md` is allowed; it is that doc's item R0.
2. Which of the three Mac users owns the Swift `PerceptionModule`, and which non-Pro iPhone is
   the demo phone? (Decides the camera owner, R1 and the Neural Engine numbers.)
3. Are Agents A–D four humans, or AI coding agents with fewer humans? Every venue, photo, phone-
   handling and haptic-feel task needs a named human.
4. Which store and which fixed-time signalized crossing? (Needs the Sept 18 walk; the demo clock
   depends on the distance between them.)
5. Does anyone on the team have trained and exported a YOLO model before? If not, the signal
   model starts on Sept 17 with the fallback ladder as the plan of record, not the exception.
6. Is there access to a blind or low-vision tester for a 10-minute indoor session, with an O&M
   professional or sighted guide?
7. Which two things get cut first if the +18 h cut line arrives with a broken live path — the
   order under "Cut priority if behind" is the recommendation; confirm it now, not at 3 a.m.

Two items in this doc remain **[verify]**: exact dev-build package versions/lead times and the
specific US-convention signal datasets. Both are cheap to check on Sept 17 and are listed first in
the day-0 checklist.
