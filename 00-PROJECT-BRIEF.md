# 00 — Project Brief (READ FIRST, ALL AGENTS)

## What we are building

A phone-only navigation aid for blind and low-vision users that takes a person
**along the street, across signalized and unsignalized crossings → into a grocery
store → to a requested item → to checkout**, using one standard iPhone. No LiDAR,
no Pro model, no glasses, no wearables beyond a lanyard or chest mount. The cane or
guide dog stays in the other hand; Aisle is a supplement to it.

Working name: **Aisle**.

Two things make it more than a route app:

- **Crossings.** At a signalized crossing Aisle aligns the user to the crossing
  bearing, reads the pedestrian signal on-device and ticks its state; at an
  unsignalized crossing it scans left and right and reports what its camera saw.
  It never says whether to cross.
- **The handoff.** Outdoor GPS navigation ends at a hand-pinned store entrance and
  indoor sign-reading navigation begins in a store nobody surveyed, from an aisle
  list a teammate typed in ten minutes.

## The demo we are building toward

One continuous, rehearsed run (~150 s; the outdoor leg with the crossing is ~90 s):

1. First launch: spoken disclaimer, then a one-minute haptic and beacon tutorial.
2. User holds the talk button: "I need eggs." (Typed input is the fallback.)
3. On foot: "Turn right in twenty feet." … "Turn right now" + TURN buzz; the COURSE
   buzz runs until they face the new leg, then one CONFIRM tap and silence.
4. **Beat one — the crossing.** "Crossing ahead: Forbes. Signalized." At the curb the
   COURSE buzz aligns them; the ticker runs slow. The signal changes: "Walk signal
   on", ticker fast, beacon toward the far curb. They cross on their own decision;
   CONFIRM at the far curb. (Unsignalized variant: "No signal here. Point the camera
   left." … "No vehicles seen to the left. No vehicles seen to the right. Listen,
   then cross.")
5. **Beat two — the handoff.** Five to fifteen seconds after the door: "Entering the
   store." Beacon off, GPS ignored, camera reads overhead signs.
6. "Aisle three, dairy." COURSE keeps them centred; "Obstacle ahead" if depth sees
   one. Arrival: "Eggs on your right."
7. Stretch beat: "Reach out." One word per step — "higher", "left", "touching."
8. "Checkout ahead." … "You've reached checkout."

The crossing (4) and the handoff (5) are the two moments judges remember. Nobody
narrates over either. The same installed build with `EXPO_PUBLIC_MOCK=1` replays
every step from fixtures if a live path breaks. Run-of-show: `06-INTEGRATION-AND-DEMO.md`.

## Why this framing (context, do not re-litigate)

Name the prior art yourself; the judges know it (last year's winners included an
accessible-navigation hack).

- **OKO** (AYES, iOS, Apple Design Award 2024) reads WALK / DON'T WALK / countdown
  with an on-device model, encodes state as tempo, and gives no feedback when it
  cannot read the signal; its terms say it "cannot identify if drivers are
  disregarding those signals." We reproduce that envelope, add curb alignment,
  far-curb beaconing and vehicle-in-view warnings, and keep its rule: silence, never
  a guess.
- **Microsoft Soundscape** (discontinued 2023, open-sourced) proved the direction
  beacon: a spatialized pulse encoding direction, not distance. It is our audio
  direction channel.
- **GoodMaps** positions indoors from the phone camera, but only in LiDAR-surveyed
  venues; **Waymap** and **Lazarillo** continue indoors after surveying or beacon
  installs. Our handoff goes into an unmapped store.
- **ShopTalk** (Utah State) showed blind shoppers follow verbal, template-based aisle
  directions with 100 % retrieval and no camera. Aisle-level guidance is a solved
  interaction; we add sign-reading confirmation and the outdoor half.
- **Be My AI** describes scenes with a large VLM; ASSETS 2024 studies found blind
  users over-trust rich descriptions. We do the opposite: terse facts, structured
  outputs, no cloud model in any time-critical path.

Our claim: a goal-directed, haptic-first trip that includes the crossing and the
handoff, on a non-Pro phone, with every safety-relevant perception on-device.

Why crossings are in scope: accessible pedestrian signals exist at ~5 % of New
York's and < 2 % of Chicago's signalized intersections; the average blind traveller
drifts ~5 m over a 22 m crossing and ends outside the crosswalk 60 % of the time
without a far-side cue, 26 % with one. Why the cloud never decides a crossing: the
only peer-reviewed test of a general VLM judging crossing risk for blind users
scored 25 % and confused approaching with distant vehicles.

## Non-negotiable design principles

1. **Haptics carry real-time signals. Speech carries meaning.** Everything with a
   time-to-act under ~5 s (signal state, vehicles, obstacles, drift) is decided
   on-device and lands as a haptic or a ticker change in < 150 ms. Speech never
   stands between the user and a hazard.
2. **Silence is the reward.** The COURSE buzz is silent when on course and grows with
   heading or cross-track error; there is no hot/cold ramp. When the user turns and
   re-aligns, one CONFIRM tap, then nothing.
3. **Exactly four haptic patterns:** COURSE, TURN, STOP, CONFIRM. STOP means a
   vehicle approaching or a hard obstacle, nothing else. Do not add a fifth.
4. **Terse.** ≤ 12 words, ≤ 2 s of audio, 4 s minimum gap outside CRITICAL, numbers
   written as words. Never narrate a scene. At the curb the app is near-silent so
   the user can hear traffic.
5. **Teachable in one minute.** Onboarding pairs each pattern and each audio channel
   with its spoken meaning; a judge can learn it before the demo.
6. **Latency budget is a hard constraint.** Tier 0 frame → haptic < 150 ms; Tier 1
   first spoken word ~1.5 s; Tier 2 first token < 1.5 s or the templated fallback.
   Numbers in `01-SHARED-CONTRACTS.md` §11; stale beats slow, always.
7. **The app informs; it never decides a crossing.** Permitted: "Walk signal on",
   "Walk already on — wait for next", "Don't walk", "Countdown", "Can't see the
   signal", "Vehicle left|right|ahead", "Compass uncertain". Forbidden everywhere —
   code, UI, pitch, disclaimer: **safe, clear, go, cross now, no cars, you can cross.**
   Google Maps data may say where a crossing is; it never triggers a walk cue.
8. **Perception reports, not permission.** At an unsignalized crossing the wording is
   "No vehicles seen to the left. No vehicles seen to the right. Listen, then cross."
   or "Vehicle approaching from the right." or "Can't see well to the left." The
   user gets the same facts a sighted companion would state, without a promise the
   sensors cannot keep.

## Explicit non-goals (do NOT build these)

| Not building | Why |
|---|---|
| Shelf-level product *detection* ("that exact carton") | Still where academic systems fail. Aisle-level plus "on your right" is the win condition. The stretch beat guides the *hand* with Claude hints on a distinctive package and gives up after 8 steps; it detects nothing. |
| Vehicle speed or distance claims | Monocular looming gives approach, not metres or km/h. We say "Vehicle right", never how far or how fast. |
| Anything outside the forward ~70° field of view | Cross traffic at a curb and everything behind are unseen until the user turns. Hearing stays the primary vehicle sensor; say so in the pitch. |
| Open-lane / queue-length detection at checkout | Dynamic scene analysis. Out of scope. |
| Payment, scanning, cashier interaction | A different product. Staff and accessible self-checkout exist. |
| General-purpose indoor SLAM | Pre-typed store map + ordered aisles + sign reading + ARKit relative pose is enough. No venue survey. |
| Continuous scene narration | Actively harmful. See principle 4. |
| Night or rain signal reading, drivers running lights | No training data for the first; no sensor for the second. State both limits out loud. |

If a task tempts you toward any row, stop and note it in your agent log.

## Safety posture

Aisle is a prototype mobility **supplement**. Cane or guide dog assumed present at
all times. The app reports what it perceives — signal state, alignment, an
approaching vehicle in view, the aisle it reads — and the user decides.

**Disclaimer, first launch, spoken, ≤ 12 s, skippable after the first run:**

> "Aisle is a prototype, not a safety device. Keep using your cane or guide dog.
> Aisle reads walk signals and warns about vehicles it can see; it cannot see
> everything and never decides when to cross."

Each harm has one named control: false WALK → onset rule + geometric gate + 5-of-8
frames + precision gate > 95 %; missed vehicle → stated FOV limit + near-silence at
the curb; false STOP mid-crossing → track age + growth threshold + false-alarm budget
< 1 per 5 min; wrong aisle → whitelist + 2-of-3 reads, recoverable by design; stale
cloud read → sequence numbers, freshness windows, "delayed" wording on the fallback
rung. Connectivity loss: Tier 0, haptics and cached speech continue; cloud calls
fail closed to silence.

**Privacy:** Tier 0 keeps street and store video on the phone. Claude receives only
sparse stills (storefront check, aisle ambiguity, the two scan stills, the curb-crop
fallback); Nemotron and ElevenLabs receive only text. Say this to judges. Ask the
store manager before filming. Open-ear or bone-conduction headphones for any user
and for the demo. No live-crossing test with a blind user during the hackathon
without an O&M professional or sighted guide.

## Tech stack (locked — do not substitute; rationale in `08-ROADMAP-AND-CONCERNS.md`)

- **Expo development build, Expo SDK 57 pinned**, React Native + TypeScript, zustand.
  No Expo Go dependency anywhere. `expo-audio` (never `expo-av`), `expo-location`
  (`watchHeadingAsync` with accuracy tier), `expo-haptics`, `expo-sensors`
  (Pedometer), `expo-speech` (fallback), `expo-keep-awake`, `expo-file-system`.
- **Demo device:** one non-Pro iPhone, A15+ preferred. iOS is primary; there is no
  Android build unless a second person owns it.
- **Toolchain:** paid Apple Developer account. The three Mac users build locally with
  `npx expo run:ios --device`; the Windows user installs native builds via EAS
  internal distribution and runs their own dev server. Native changes are batched
  and republished through EAS. Phase-0 proof of the whole path on the demo phone:
  `11-PHASE-0-CHECKLIST.md`.
- **Camera owner:** one native Swift `PerceptionModule` (Expo Modules API, ARKit
  world tracking `gravityAndHeading`), owned by Agent C. It runs Apple Vision OCR, a
  COCO YOLO-nano detector, the fine-tuned pedestrian-signal model (`ped_walk`,
  `ped_hand`, `ped_countdown`), Depth Anything V2 small and optionally a
  walkable-surface segmentation model; emits rate-limited events; `snapshotJPEG(maxWidth)`
  is the only way pixels leave it. `react-native-vision-camera` and `expo-camera` are
  not used. Spec: `09-PERCEPTION-MODULE.md`; training: `10-CV-TRAINING-TRACK.md`.
- **Three perception tiers.** Tier 0 on-device for anything time-critical. Tier 1
  Claude Haiku 4.5 (structured outputs, `speech` first in the schema, streamed into
  ElevenLabs; Sonnet 5, thinking disabled, only for the curb-crop fallback) for
  slack-tolerant semantics and active perception ("Tilt the camera up"). Tier 2
  Nemotron `nvidia/nemotron-3.5-lightning-30b-a3b` on NIM (thinking off, guided JSON,
  streamed, 1.5 s first-token deadline, templated fallback, OpenRouter failover) for
  route compilation, intent parsing, store-map disambiguation, crossing-announcement
  judging and "repeat / how far / where am I". Nothing time-critical waits on
  Tier 1 or 2.
- **Outdoor data:** Google Routes API `computeRoutes` WALK (beta warning displayed),
  OSM `highway=crossing` via Overpass, WPRDC signalized-intersection data; store
  entrance pinned by hand in `fixtures/stores/<id>.json`.
- **Speech:** ElevenLabs `eleven_flash_v2_5`, ~40 pre-generated cached phrases, live
  synthesis only for street names and aisle labels, pre-synthesized at route/store
  load. Voice input: push-to-talk, on-device STT, ElevenLabs Scribe as the fallback
  in noise, keyboard dictation as the zero-risk fallback.
- **Proxy:** Node, hosted in us-east (not the laptop). `POST /api/vision`,
  `POST /api/plan`, `POST /api/tts`, `POST /api/stt`, `GET /api/route`,
  `GET /api/health`. Keys stay server-side: `ANTHROPIC_API_KEY`, `NVIDIA_API_KEY`,
  `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `GOOGLE_MAPS_API_KEY`. Never ship a
  key in-app. Detail: `07-SPONSOR-STACK.md`.

### Sponsor stack (REQUIRED — these are prize tracks)

- **NVIDIA — "Beyond the Chatbot: Best Use of NVIDIA Nemotron."** Brief: "We have
  enough chatbots. Use NVIDIA Nemotron for something else… routes requests,
  classifies something, judges another model's output, makes a decision, or sits
  somewhere in a bigger pipeline," plus "some evidence that it works: an eval,
  comparison, benchmark, or even a failure you found." Our answer: Nemotron is the
  decision layer, not the eyes — it compiles the route into ≤ 12-word legs, parses
  intents, resolves "dairy vs eggs", judges which OSM node is the crossing and
  whether to say "push button likely". Evidence artifact: a one-page eval in the
  repo (intent accuracy on ~60 utterances including noisy-ASR variants; leg-wording
  A/B against raw Google text). Agent B owns it.
- **ElevenLabs — "Out Loud: Best Project Built with ElevenLabs."** Brief: "voice or
  audio as a real part of how your project works, not a feature bolted on," "a demo
  we can hear — bring headphones in case the room is loud," and "a sentence on why
  speech beats a screen for your use case." Our answer: every word the user hears is
  Flash v2.5, streamed from Claude's `speech` field for live semantics and cached for
  the closed phrase set; Scribe covers STT in store noise. The sentence: the user
  cannot see a screen, and their hands hold a cane and a phone.

Both tracks stack. Nemotron never touches an image; the earlier "leads OCRBench v2"
line is gone and must not reappear.

## Agent ownership map

Agents may be humans or coding agents. Every venue walk, photo, phone-handling and
haptic-feel task needs a named human; the machine owners below are those humans.

| Agent | Machine | Owns | Directories |
|---|---|---|---|
| **A** | Mac 2 | Core shell, state machine, `contracts.ts`, HapticService, SpeechService, beacon + ticker, SensorService, onboarding, DebugPanel, demo-phone builds | `src/core/`, `src/ui/`, `App.tsx`, `assets/audio/` |
| **B** | Mac 3 | Outdoor routing, OSM/WPRDC crossing join, leg script, CrossingController (signalized + unsignalized flows), Nemotron job schemas and eval | `src/outdoor/`, `src/crossing/`, `server/routes/plan.ts`, `server/routes/route.ts` |
| **C** | Mac 1 (Swift owner) | `PerceptionModule` (ARKit, Vision OCR, CoreML, signal model), JS bridge, SemanticVision schema, indoor navigator, store map format | `modules/perception/`, `src/perception/`, `src/indoor/`, `models/` |
| **D** | Windows | Proxy core, health, tts, stt, vision routes; mocks and fixtures; transition detector; demo tooling; CV training track | `server/` (except B's two routes), `mocks/`, `fixtures/`, `src/transition/`, `training/` |

Per-agent briefs: `02-AGENT-A-core-shell.md`, `03-AGENT-B-outdoor-crossing.md`,
`04-AGENT-C-perception-indoor.md`, `05-AGENT-D-harness-transition-demo.md`.

**No agent edits another agent's directory.** All cross-agent communication goes
through `01-SHARED-CONTRACTS.md`, which is frozen: flag a change, get an ack from
every consumer, then change the doc and `contracts.ts` in one commit. Never edit it
unilaterally.

## Build order priority

Sequence by risk, not by calendar. Phases, not a 24-hour clock:

- **Phase 0** (before integration; `11-PHASE-0-CHECKLIST.md`): toolchain proven on
  the demo phone, accounts and keys, venue walk with entrance pin and crossing choice,
  crossing video and store stills, datasets, signal model v1 running on-device, the
  five [verify] checks closed.
- **Phase 1:** the four build tracks against mock mode.
- **Phase 2:** integration on the demo phone and live venue runs. Gates relative to
  integration start: **+6 h** Tier 0 loop live with STOP firing on recorded curb
  footage; **+14 h** signal model false-WALK precision > 95 %, recall > 80 %,
  parallel-signal confusion < 2 %; **+18 h** cut line — anything not working live is
  replaced by fixtures.
- **Phase 3:** rehearsals and pitch.

**Cut order if behind (drop first → last):** voice input → live Nemotron (keep cached
outputs) → vehicle warnings → live signal model (keep alignment + map awareness +
manual button) → outdoor leg live (replay it) → transition live (manual `forceEnter`).

**Never cut:** indoor aisle guidance, the handoff announcement, the haptic
onboarding, the disclaimer.

A flawless crossing-plus-store demo with a replayed walk-up beats a shaky
end-to-end one. The crossing beat has a fallback ladder (on-device model → Sonnet
curb crop → alignment + map awareness only → manual); it demos at every rung.
