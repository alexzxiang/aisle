# 06 — Integration, Timeline & Demo

Who this is for: whoever is running integration, the narrator, and the operator. It says in
what order things must land, what is measured at each gate, what gets cut, and exactly what
happens for three minutes in front of judges. Rationale lives in `08-ROADMAP-AND-CONCERNS.md`;
names of modes, events and services are the ones in `01-SHARED-CONTRACTS.md`.

Fixed anchors [verified]: hacking opens Sat 2026-09-19 11:00 ET; submission closes Sun 11:00;
judging is expo-style, live, indoors in Posvar Hall, roughly 11:15–13:00 Sun. There is no GPS,
no crossing and no store on the judging floor. NVIDIA Nemotron AMA: Sat 14:00–14:45, 1501
Posvar (Agent B attends with the model-id and `nvext` questions). Pre-event application code
is disallowed by the rules except open-source libraries; planning, accounts, data, venue notes,
datasets and a trained model file are preparation, not app code — confirm with organisers
before phase 0 starts on anything that compiles (open question 1 in
`08-ROADMAP-AND-CONCERNS.md`).

---

## Dependency order (by phase, not by clock)

```
PHASE 0  toolchain + data, before integration        (see 11-PHASE-0-CHECKLIST.md)
   human   demo phone chosen (newest non-Pro iPhone, A15+); scratch dev build with the
           Expo Modules scaffold + one CoreML model runs on it via `npx expo run:ios --device`
   human   accounts + keys: Anthropic, NVIDIA NIM (authenticated /v1/models), ElevenLabs
           (redeem the SteelHacks Creator month on the key-holding account), Google Maps
           billing + Routes, paid Apple Developer team, EAS device registration for the
           Windows user's phone, Colab
   human   venue walk: store chosen, entrance pinned, sign strings + order + checkout signage
           → fixtures/stores/<storeId>.json; fixed-time signalized crossing within ~150 m
           chosen; 3–5 min video per crossing, both states, two times of day; store route video
   D       datasets + licences; local frames labelled              ← CV TRAINING TRACK starts
   D→C     signal model v1 exported to models/ped-signal-v1.mlpackage (10-CV-TRAINING-TRACK.md)
   C       [verify] checks closed: Depth Anything V2 CoreML build + ms; segmentation export or
           dropped; ARKit video format + geo-tracking availability; battery/thermal on the
           demo phone; package versions against Expo SDK 57

PHASE 1  build tracks, all against D's mocks
   A  h0–1  src/core/contracts.ts verbatim from 01 + stubs      ← SERIALIZATION POINT 1
   A        HapticService (COURSE/TURN/STOP/CONFIRM), SpeechService + cache player, SensorService
            fusion, beacon + ticker, ONBOARDING, DebugPanel, push-to-talk
   B        Routes fetch + OSM/WPRDC join, routeCompile via Planner, legs + turns,
            CrossingController (signalized + unsignalized), server/routes/plan.ts, route.ts
   C        PerceptionModule (ARKit, COCO + tracker, looming, depth, OCR, signal gate),
            src/perception/PerceptionService.ts, src/indoor/ navigator
   D        server/ core + /api/health + tts/stt/vision routes, mocks/ + fixtures/ + jump-to-mode,
            TransitionDetector, demo tooling (fixture recorder/replayer), training/
   C        PerceptionModule running on the demo phone, getStats() live ← SERIALIZATION POINT 2

PHASE 2  integration + live venue runs (gates +6 h / +14 h / +18 h count from here)
   A        composition root wired; mocks off outdoors; one demo phone
   D        fixtures re-recorded from the module on the demo phone (real jsonl, real frames)
   all      live venue run 1 (crossing + store, daylight), fix, live venue run 2, timed

PHASE 3  rehearsals + pitch
   all      rehearsal 3 under judging-floor conditions; backup phone; eval artifact; slides;
            failure-mode checklist; run-of-show final
```

Two hard serialization points: **A's `contracts.ts`** (nobody imports anything until it lands;
budget one hour, not four) and **C's `PerceptionModule` running on the demo phone** (until then
B's crossing controller, A's pose fusion and D's real fixtures all run on synthetic data).
Everything else parallelises. The CV training track (D, `training/`, per
`10-CV-TRAINING-TRACK.md`) runs beside all of it and hands one file to C; it never blocks
phase 1 because rung 2–4 of the crossing ladder demo without it.

Chicken-and-egg to plan around: `fixtures/perception/*.jsonl` are recorded by the module's own
debug export, so real fixtures exist only after serialization point 2. D hand-authors synthetic
jsonl in the 01 §12 format first (it is what everyone develops against), then replaces it with
recordings from the phase-0 crossing and store videos replayed through the module, then with the
live-run recordings from phase 2. Same format at every step; the replayer never changes.

Venue windows are the real constraint on phase 2, not the hour table: the store closes in the
evening (Forbes Street Market reportedly 21:00–22:00; Giant Eagle Shadyside 23:00 [verify
day-of]) and the signal model has no night training data. Live run 1 must therefore happen in
Saturday daylight, whatever the gate clock says, and live run 2 either Saturday before close or
Sunday 07:30–09:30 [verify opening time] before submission. If integration starts at 11:00 Sat,
that means the +6 h gate is checked at the curb, not at a desk.

---

## Integration rules

- Branch per agent: `agent-a-core`, `agent-b-outdoor-crossing`, `agent-c-perception-indoor`,
  `agent-d-harness`. Merge to `main` only through the composition root `App.tsx`, which
  **Agent A alone edits**. `App.tsx` wires HapticService, SpeechService, SensorService, EventBus,
  PerceptionService, SemanticVision, Planner, CrossingController, TransitionDetector and the
  indoor navigator, and is the one place `EXPO_PUBLIC_MOCK=1` swaps in `mocks/`.
- Nobody edits another agent's directory (ownership: A `src/core/`, `src/ui/`, `App.tsx`,
  `assets/audio/`; B `src/outdoor/`, `src/crossing/`, `server/routes/plan.ts`, `route.ts`;
  C `modules/perception/`, `src/perception/`, `src/indoor/`, `models/`; D `server/` core,
  `mocks/`, `fixtures/`, `src/transition/`, `training/`). A needed change in someone else's
  module is a message, not a commit. The trained model file crosses from D to C the same way:
  a PR into `models/` that C merges.
- Contracts changes are flagged, never made unilaterally: post in the shared channel, get an
  ack from every consumer, then edit `01-SHARED-CONTRACTS.md` and `contracts.ts` in one commit.
  A silent signature change is the single most likely cause of a lost hour.
- Native changes (Swift, `.mlpackage`, `app.json` permissions) are batched and merged to `main`
  before any Mac builds the demo phone, and shipped to the Windows user's phone with
  `eas build --profile development --platform ios`. The Windows user never blocks on a native
  change: JS-only work runs on the last EAS build with their own `expo start --dev-client`.
- Integrate on **one designated demo phone**, built from Mac 2 (A). Mac 1 (C) builds its own
  test phone for module work. Chasing haptic or thermal differences across four phones the night
  before is a trap. The backup phone is the Windows user's, on the last EAS build, in mock mode.
- Every live run is recorded: DebugPanel stats, the module's jsonl export, and a phone-camera
  video from a spotter. A live run that is not recorded produced no fixture and no evidence.
- Forbidden words (safe, clear, go, cross now, no cars, you can cross) are rejected by the lint
  rule in code; the same grep runs over the slides, the script and the README before phase 3 ends.

---

## Gates and the cut order

Relative to integration start (phase 2, hour 0). The gates are about risk; do not move them to
fit the calendar.

| Gate | Measured | Miss → |
|---|---|---|
| **+6 h** | Tier 0 loop live on the demo phone: COCO detector ≥ 15 fps; STOP fires on recorded curb footage with frame → haptic < 150 ms in DebugPanel; < 1 false alert per 5 min | Second person onto C's module; drop haptic polish and the beacon variants; B's crossing controller stays on synthetic signal events |
| **+14 h** | Signal model on held-out local frames: false-WALK precision > 95 %, WALK/HAND recall > 80 % at 10–20 m, parallel-signal confusion < 2 % after the geometric gate, ≥ 15 fps on-device | Drop to rung 2 (Sonnet 5 curb crop, "Signal read is delayed") or rung 3 (alignment + map awareness + vehicles, no state claim) per `03-AGENT-B-outdoor-crossing.md`; the run-of-show wording switches the same hour |
| **+18 h cut line** | Every beat is walked once on the demo phone, live where it works, fixtures where it does not | Anything not working live is replaced by its fixture. No new live paths after this hour |

Cut order when behind (first → last): voice input (keyboard dictation stays) → live Nemotron
calls (cached `routeCompile` / `crossingAnnounce` outputs stay) → vehicle warnings (STOP for hard
obstacles stays) → live signal model (alignment + map-derived crossing awareness + manual
`setManualSignal` stay) → outdoor leg live (replay it) → transition live (`forceEnter`).

Never cut: indoor aisle guidance, the handoff announcement, haptic onboarding, the disclaimer.

Cutting a live path is not failure: the same installed build carries the fixture, the haptics
and speech still fire for real, and the judge cannot tell the difference in their hand. What they
can tell is a demo that stalls.

---

## Demo run-of-show (target 2.5–3 minutes)

Reality of the floor: judging is indoors at a table. The outdoor leg, the crossing and the
transition **are replayed from fixtures on the installed build** — real haptics, real speech, real
beacon and ticker — with the venue video of the same live run playing on a laptop beside the
phone, in sync (D's demo tooling starts both from one tap). Live in the room: onboarding in the
judge's hand, push-to-talk, aisle OCR on printed signs brought to the table, the item beat on a
real carton. The narrator says which is which; a judge who catches you passing replay off as
live will discount everything else.

| Time | Beat | Source | Notes |
|---|---|---|---|
| 0:00 | Problem in one sentence | — | "Getting to a store is solved. Crossing the last street and finding eggs inside is not, if you are blind." |
| 0:10 | Onboarding excerpt: judge holds the phone | live | They rotate off the bearing: COURSE buzz grows; back on: silence; TURN; one CONFIRM. Then STOP once. Say "silence is the reward" and nothing else |
| 0:30 | "I need eggs" | live, cached fallback | Push-to-talk → on-device STT → Planner `parseIntent` → "Eggs. Route ready: two legs, one crossing." If the network is slow the templated fallback speaks; do not wait |
| 0:45 | Outdoor leg, one turn | fixture | "Turn right in twenty feet" → "Turn right now" + TURN → COURSE until aligned → CONFIRM. Narrate one line: the buzz means off course, silence means on course |
| 1:05 | Crossing beat, envelope first | fixture + video | Narrator, before anything plays: "It reads the pedestrian signal like OKO does, keeps you aligned, warns about vehicles it can see. It never decides when to cross." Then: "Crossing ahead: Forbes. Signalized." → curb: TURN, ticker slow → "Walk signal on" + fast ticker → far-curb beacon → "Vehicle right" + STOP from the recorded curb footage → CONFIRM at the far curb. Do not talk over it |
| 1:40 | Transition | fixture | Track with the real entry-lag profile; "Entering store. Eggs: aisle three." Let it land; this and the crossing are the two moments judges remember |
| 1:55 | Aisle | live | Operator raises the printed "1 PRODUCE" sign, then "3 DAIRY": AISLE_IDENTIFIED after 2 of 3 reads → "Aisle three. Eggs on your right." DebugPanel on screen for five seconds: OCR reads, detector fps, frame → event ms. Proves it is live |
| 2:20 | Item (stretch) | live | Carton on the table: "Reach out." → "Higher." → "Touching." + CONFIRM. If ITEM_PICKUP was cut, skip straight to checkout; "Eggs on your right" is the guaranteed payoff |
| 2:35 | Checkout → DONE | jump-to-mode | "Checkout ahead." Completes the arc; five seconds |
| 2:40 | Honest limits | — | Script below, twenty seconds, verbatim |

Limits script: "What it cannot do: judge speed or distance of a vehicle; see cross traffic or
anything behind the ~70° forward view; know whether a driver will stop; read a signal at night;
find a product on a shelf. Video never leaves the phone except sparse still frames to Claude.
It is a supplement to a cane or guide dog and it says so on first launch."

Beats that may be replayed from fixtures: outdoor leg, crossing (signal states, vehicle event,
far curb), transition. Beats that must be live: onboarding haptics, aisle OCR. Beats that are
live with a fallback: "I need eggs" (keyboard), item (skip). Bring open-ear headphones for the
operator and a wired pair for judges: the ElevenLabs track asks for "a demo we can hear".

Teammate on the DebugPanel throughout: `setManualSignal`, `forceEnter`, jump-to-mode. If a live
beat misfires they tap; nobody notices; the story continues. One person narrates, one operates,
never the same person.

Optional live vehicle STOP: the phone pointed at a laptop playing the curb footage full-screen
fires the looming detector in rehearsal on some screens and not others (refresh and exposure).
Rehearse it three times in the room; if it fires all three, keep it; otherwise the fixture event
is the vehicle beat and you say so.

---

## Pitch framing

Lead with the handoff and the crossing envelope, not with "AI describes the scene". Judges who
have seen Be My AI or Seeing AI will pattern-match you to that in the first sentence and stop
listening.

> "Navigation apps stop at the door and fall silent at the curb. We built the two hard parts:
> a crossing aid that reads the signal, holds your line and warns about vehicles it can see,
> without ever deciding for you, and a handoff into a store nobody surveyed, from an aisle list
> a teammate typed in ten minutes."

Name the prior art yourself; it reads as rigour. OKO reads pedestrian signals on-device, is
silent when unsure, won a 2024 Apple Design Award and is now owned by a traffic-signal company;
we reproduce its envelope and add alignment, the far-curb beacon and vehicle-in-view warnings.
Soundscape's beacon is where our direction audio comes from. GoodMaps, Waymap and Lazarillo
continue indoors, but only after surveying or beacon installs; Seeing AI's indoor mode needs
LiDAR; NaviLens needs codes on the signs. ShopTalk showed blind shoppers execute verbal aisle
directions with 100 % accuracy, which is why an ordered aisle list is enough. Aira and Be My Eyes
put a human or a VLM in the loop; our wedge is "get to the right aisle independently, ask for
help only for the final pick". Last year's winners included an accessible-navigation hack
(BetterPath); assume the judges are not naive.

Two sentences to land for the sponsor judges: "Nemotron routes, classifies, judges and decides;
it never chats." and "Speech beats a screen because the user's eyes are on the cane and their
ears are on the traffic; twelve words, four seconds apart, or nothing."

Privacy line, once: "Street and store video never leaves the phone. Only sparse still frames are sent
to Claude, only text to Nemotron and ElevenLabs." Check each provider's retention page the night
before and be able to say what it says.

---

## Anticipated judge questions

**"How is this different from OKO?"**
Same envelope on signal state: on-device model, silence on uncertainty, tempo-coded feedback,
never "safe". Three additions: a geometric gate (heading within ±20° of the crossing bearing,
horizon strip, nearest centre) against reading the parallel crosswalk's head; an onset rule that
refuses a WALK it did not see begin; and what happens around the signal: alignment at the curb,
course-holding and a far-curb beacon while crossing (baseline drift is ~5 m over a 22 m
crossing), vehicle-in-view warnings, and the walk before and the store after. OKO does none of
those; it is also iOS-only and does not detect vehicles at all.

**"What if your WALK is stale?"**
We track onset. If the first state seen after arming is already WALK, the app says "Walk already
on — wait for next", because a WALK can be as short as four to seven seconds and O&M teaches not
to start on an unseen onset. A fresh WALK requires the app to have observed DONT_WALK → WALK,
with five of the last eight frames agreeing. Cloud reads never set signal state; on the fallback
rung the phrase carries "Signal read is delayed".

**"What can't the vehicle warning see?"**
Anything outside the ~70° forward field: cross traffic at the curb until the user turns toward it,
everything behind. It sees approach, not speed or distance: box growth over half a second on a
track older than 0.3 s. Night and rain degrade it. The only peer-reviewed test of a general VLM
on "is it safe to cross" scored 25 % and confused approaching with distant vehicles, which is why
this is geometric and on-device and why the curb is a near-silent zone: hearing stays the primary
vehicle sensor. Even OKO declines to detect vehicles; we warn, we never declare the road free of them.

**"How do you use Nemotron beyond a chatbot?"**
Five schema-bound jobs, none conversational, none in the real-time path: it compiles the Google
route into ≤ 12-word leg phrases, judges which OSM crossing node is on the path and whether a
push button is likely, parses push-to-talk intents, disambiguates "dairy" vs "eggs" against the
store map, and answers "repeat / how far / where am I". Thinking off, `guided_json`, streamed,
1.5 s first-token deadline with a templated fallback; everything is precomputed at route load so
the walk is cached audio. Evidence: the one-page eval in the repo (intent accuracy on ~60
utterances including noisy-ASR variants; wording A/B against raw Google text) and at least one
failure we found.

**"Why ElevenLabs?"**
The phrase set is closed and terse by design, so ~40 phrases are pre-generated with Flash v2.5
and shipped as files: instant, offline, one voice. Street names and aisle labels are synthesized
at route and store load, not during the walk. Claude's streamed `speech` field is piped into the
ElevenLabs WebSocket so the first spoken word lands around 1.5 s. Scribe is the STT fallback in
store noise. Why speech beats a screen: the user cannot look at one, and the ears are the one
channel we deliberately keep almost empty at the curb.

**"Have you tested with blind users?"**
Answer with what is true. If not: say so, say it is the first thing you would do, and be specific
("whether four haptic patterns survive a noisy store; whether the curb is quiet enough"). If a
10-minute indoor session happened, say what changed because of it. Never at a live crossing during
the hackathon without an O&M professional or sighted guide. Also true and worth saying: it runs
with VoiceOver on, every control is labelled, nothing hides behind a gesture iOS already uses.

**"Hasn't this been done?"** In pieces: name the list in the pitch section. Nobody does the
crossing envelope plus the handoff into an unsurveyed store on a phone people already own.

**"How do you localize indoors without LiDAR?"** We do not localize absolutely. The store is an
ordered aisle list; on-device OCR reads the overhead sign, fuzzy-matches it against the map
(edit distance ≤ 2, digits exact, two of three reads), and navigation is order comparison plus a
step-count prior. ARKit pose keeps the user centred in the aisle. Claude is asked only when the
text matches nothing or two things.

**"What about latency?"** Anything with a time-to-act under five seconds is on-device: frame to
haptic under 150 ms, measured in DebugPanel. Claude answers questions with slack (which aisle,
storefront, "tilt the camera up") in about 1.5 s to first word. Nemotron runs at events with a
1.5 s deadline and a fallback. Nothing time-critical waits on the network.

**"Is this safe?"** It is a prototype supplement; cane or guide dog assumed; the disclaimer is
spoken on first launch. Every harm has a named control: false WALK → onset rule, geometric gate,
5-of-8, precision gate above 95 %; missed vehicle → stated field of view and a quiet curb; false
STOP mid-crossing → track age, growth threshold, false-alarm budget; wrong aisle → whitelist,
2-of-3, recoverable. Google data informs where a crossing is and never triggers a walk cue.

---

## Failure-mode checklist (run 30 minutes before the slot)

- [ ] Demo phone: battery > 80 %, cool to the touch, Low Power Mode off, screen dim, Guided
      Access on, volume up, `useKeepAwake` active, chest mount or lanyard fitted
- [ ] The installed build launches; disclaimer plays; onboarding COURSE / TURN / STOP / CONFIRM felt
      on this phone by the narrator
- [ ] `GET /api/health` green for all five upstreams; Claude schema warmed; Nemotron model id
      accepted with `nvext`; ElevenLabs quota and concurrency confirmed on the key account
- [ ] Laptop tethered to the phone hotspot; proxy reachable over it; venue Wi-Fi not in the path
- [ ] Full fixture replay run end-to-end once, timed, with the venue video in sync on the laptop
      (video file local, not streamed)
- [ ] Manual overrides verified: `setManualSignal`, `forceEnter`, jump-to-mode, keyboard dictation
- [ ] Printed aisle signs ("1 PRODUCE", "3 DAIRY", "CHECKOUT") and the carton on the table; OCR
      reads the signs under the room's light from arm's length; DebugPanel shows fps and ms
- [ ] Open-ear headphones for the operator, wired pair for judges, both tested with `duckOthers`
- [ ] Backup phone: last EAS build, `EXPO_PUBLIC_MOCK=1`, same fixture set, charged
- [ ] Cached audio plays with the radio off (airplane mode for ten seconds, then back on)
- [ ] Google walking-beta warning visible in the route screen; forbidden-word grep clean on slides,
      script and README; ElevenLabs attribution in the README
- [ ] Nemotron eval artifact and dataset licences committed and linked from the README
- [ ] Narrator and operator named; limits script on a card; envelope sentence memorised
- [ ] Provisioning: the paid team profile is not the 7-day kind, but confirm the build still opens
      after the phone was locked overnight

---

## If you finish early

In priority order:

1. A 10-minute indoor session with a blind or low-vision tester, with an O&M professional or
   sighted guide present, never at a live crossing. It will change the demo and it is the most
   credible thing you can say on stage.
2. A full VoiceOver pass of the app: one live region, no double-speaking, every control labelled.
3. Tighten utterances: every phrase to its shortest form, regenerate the cache once, re-time the
   run-of-show.
4. Extend the Nemotron eval: more utterances, one more failure found and written up. Sponsor
   judges asked for evidence; more evidence is cheap.
5. A second mapped store (the backup venue) to show the store-map format generalises.
6. Do **not** add features from the non-goals in `00-PROJECT-BRIEF.md`, do not add a fifth haptic
   pattern, do not let the app speak more. Depth in one venue beats breadth everywhere.

---

## Definition of done (integration)

- [ ] `contracts.ts` landed in hour 0–1 of phase 1; every later change flagged and acked
- [ ] `PerceptionModule` running on the demo phone before phase 2; `getStats()` visible in DebugPanel
- [ ] +6 h, +14 h and +18 h gates measured and written down with numbers, not adjectives
- [ ] Two live venue runs recorded (jsonl, DebugPanel stats, spotter video); fixtures regenerated
      from the second
- [ ] Run-of-show under three minutes in rehearsal 3, with the replay and live beats labelled
- [ ] Backup phone carries the same build and fixture set in mock mode
- [ ] Eval artifact, licences, attribution and the limits script in the repo
- [ ] Failure-mode checklist run once in rehearsal and once on the morning
