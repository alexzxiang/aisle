# Aisle — team plan v2 (2026-09-19 evening): make it actually guide

v1 got the machinery running: camera from launch, 51 object classes on-device, Apple's
scene classifier, scene memory, routes in 6–8 s, hand loop, hold-to-talk. The living-room
test still fails, and the reasons are specific:

1. **The AI does not turn what the camera sees into an instruction.** The detector reports
   `fridge ahead (close)`; the words that come out are "Bear left." That is because every
   spoken step comes from a language model reading a still, and nothing on the phone turns
   a detected target into "Fridge ahead, five steps. Walk forward." deterministically.
2. **Hand guidance has no hand.** COCO has no hand class, so the loop asks Claude for both the
   hand and the target every two seconds. Apple ships an on-device hand-pose detector
   (`VNDetectHumanHandPoseRequest`, 15 fps). We do not use it.
3. **Speech-to-text hears the app talking.** The mic opens while the voice is still speaking,
   nothing pauses it, and anything the parser does not recognise becomes "Say the item
   again." — so questions ("is the fridge open?", "how far is it?") get a non-answer.
4. **The street walk has never been verified** and the screen shows a small camera with a
   transcript nobody blind needs.

Four streams, four owners, disjoint files. Same rules as v1 (bottom of this file). CI is
the integrator.

| Stream | Owner | Owns | Goal in one line |
|---|---|---|---|
| **A — Perception → instructions** | Alex | `modules/perception/**`, `src/perception/**`, `src/core/sceneMemory.ts`, `src/core/guide.ts` (new), `models/**`, `training/**` | The phone itself says "fridge ahead, five steps" and "hand left" from what it sees, at 15 fps, no model round trip |
| **B — Hearing & dialogue** | Poon | `src/core/voice.ts`, `situate.ts`, `guidedTask.ts`, `handGuide.ts`, `describer.ts`, `phrases.ts`, `assets/audio/**` | It hears the person (not itself), understands questions, and every step it speaks has a direction and a distance |
| **C — Brain** | ahlqn | `server/**`, `src/outdoor/plannerJobs.ts`, `fixtures/plan/**`, `fixtures/vision/**` | Claude returns *positions* (boxes), not prose; an eval on real phone frames says how often it is right |
| **D — Screen & street** | Tyler | `src/ui/**`, `src/outdoor/**` (except plannerJobs), `src/crossing/**`, `src/core/haptics.ts`, `README.md`, `DEMO-SCRIPT.md` | Camera-first screen; the route is provably right and the walk is field-tested |

Shared files (`contracts.ts`, `store.ts`, `composeApp.ts`, `App.tsx`, `server/schemas/vision.ts`,
`server/prompts/vision.ts`): tiny separate PRs, both sides of a contract in one, announced in chat.

## A — Perception → instructions (Alex)

The design change: **guidance is computed on the phone from geometry; the language model
only names things.** Two new deterministic sources feed one new module, `src/core/guide.ts`:

1. **Target-relative walking instruction.** Given the goal word ("fridge"), the detector's
   box for that class (or scene memory's bearing when it left the frame) and the depth-grid
   nearness / box height, emit one of: `"Fridge ahead, about N steps. Walk forward."`,
   `"Fridge to your right. Turn right a little."`, `"Fridge behind you. Turn around."`,
   `"Turn slowly to the left so I can see the fridge."` (memory says it was left),
   `"I have not seen the fridge yet. Turn slowly."` Steps from height: a fridge box
   filling 80 % of the frame height is ~1 step, 40 % is ~3, 20 % is ~6 (calibrate on the
   phone with a tape measure — 20 minutes, write the table into the code). Speak on change
   or every 4 s; the LLM's `task_step` speech becomes a fallback for targets the detector has
   no class for (eggs).
2. **Hand pose on-device.** `VNDetectHumanHandPoseRequest` in the engine (new stage `hand`,
   10 fps, only while a hand loop runs) → `onHandPose { indexTip, wrist, confidence }` in
   normalized frame coords. The hand guide then steers with math: hand tip vs target box
   (the target box comes from the detector for detectable things, from Claude's new
   `target.box` — Stream C — for eggs/milk), thresholds in frame fractions:
   `dx > 0.08 → "Left." / "Right."`, `dy > 0.08 → "Higher." / "Lower."`, both inside →
   `"Reach forward."`, depth says the hand is at the target's plane → `"Grab it."`
   Ten words a second are too many: one word per 700 ms, only when it changes.
3. **Ultra-wide.** ARKit reports `1920x1440@30 wide` on the iPhone 16 (no ultra-wide format).
   Add an `AVCaptureSession` on `.builtInUltraWideCamera` used **indoors only** (AWARE /
   GUIDED_TASK profiles) for detector + stills; ARKit for OUTDOOR/crossing where pose drives
   the haptics. It is a mode switch (~1 s); the preview follows whichever runs.
4. **Session export for the others.** `startDebugExport` already writes events; add the
   stills the phone sent (already JPEG in memory) with their facts to the same file, so B and
   C can replay a living-room run offline. One switch in the DebugPanel; files land in the
   app's Documents and come off with Finder.
5. Later: the pedestrian-signal model (venv is ready: `training/.venv`).

Acceptance (the living-room test, phone in hand): stand 4 m from the fridge facing 45° away
→ within 3 s: "Fridge ahead to your right. Turn right a little." → face it: "Fridge ahead,
about five steps. Walk forward." → at the door: "Fridge close. Reach for the handle."
Hand test: open fridge, eggs on a shelf, hand out → "Higher." … "Left." … "Grab it." within
20 s, no more than one word per second.

## B — Hearing & dialogue (Poon)

1. **Stop talking when the mic opens.** `voice.begin()` must `speech.clearQueue()` and stop
   the current utterance before the recogniser starts, and hold new speech until `end()`.
   Today the app narrates into its own microphone; that alone explains half the bad
   transcripts. Add a short earcon (a cached "listening" tick) so the person knows to speak.
2. **Transcript hygiene.** Strip the app's last spoken sentence from the transcript if it
   echoes back; prefer the Scribe result over Apple's when both exist and they disagree
   (Scribe gets the domain words); keep `VOICE_VOCABULARY` growing with what people actually
   say (log every final transcript to the conversation with its parsed intent so we can see
   the misses).
3. **Questions get answers.** Anything that is not a command — "is the fridge open", "what is
   on the shelf", "how many steps", "which way is the door" — goes to the camera as a `free`
   question with the words, or to scene memory ("which way is X"), never to "Say the item
   again." Intent `unknown` should be rare; when it happens say "I did not catch that. Say it
   again." and nothing else.
4. **Confirm-back on the big ones.** Before a task or a route starts: "Eggs in your fridge —
   right?" / "The CVS on Forbes — right?" (yes / no, `intercept`). One question, not more.
5. **Every step has a direction and a distance.** `guidedTask` speaks Stream A's `guide.ts`
   instruction when a target is known and only falls back to the model's words otherwise;
   the observation step says *why* ("Turn slowly to the left so I can see the kitchen."),
   the reach step says "Hold out your hand" once and then only hand words. Cadence: a new
   instruction on change or every 4 s, a reassurance at 12 s of silence, never two
   sentences in a row.
6. Phrases: the new fixed words go through `phrases.ts` + `gen:audio` (normalized).

Acceptance: 20 spoken commands/questions from `DEMO-SCRIPT.md`, phone held normally, room
quiet: ≥ 18 parsed to the right intent, every one answered with something specific.

## C — Brain (ahlqn)

1. **Positions, not prose.** Add `target: { box: [x,y,w,h] | null; confidence }` to the vision
   schema (shared-file PR with A): `task_step` and `hand_guidance` must locate the step's
   target in the still. Add `hand: { box | null }` too, as the fallback when Vision hand pose
   is unavailable. `speech` for these questions becomes secondary; A's `guide.ts` speaks.
2. **Eval on real frames.** Stream A's session export gives you stills + facts from the real
   living room; build `server/routes/vision.eval.ts` over 30 of them with hand-labelled
   answers (target box within 0.1, setting right, "done" right) and print precision per
   question. Iterate the prompts against it, not against feelings. Haiku vs Sonnet per
   question by measured accuracy × latency.
3. **taskPlan that fits the room.** Plans must start from `facts.scene / description / seen`;
   a plan for "eggs in my fridge" in a kitchen is two steps (face the fridge, open it, reach),
   not five. Golden set of five contexts in `plan.eval.ts`.
4. **Latency.** Keep the planner race honest (`plannerRace.ts`): p50 per job in the log;
   `parseIntent` under 1.5 s p50 or flip it to Haiku-first permanently.
5. **Route script quality.** `routeCompile` output read aloud end to end for two real routes
   (D records them): every leg's "soon / now / confirm" lines must name the street and a
   distance in words. Fix the prompt or the template where they do not.

Acceptance: the vision eval prints ≥ 80 % target-box hits on the exported frames; taskPlan
golden set passes; `/api/plan parseIntent` p50 < 1.5 s over a day of logs.

## D — Screen & street (Tyler)

1. **Camera-first screen.** On Home and Nav the camera takes ~60 % of the height; the
   transcript becomes a two-line strip under it that expands to full height on tap (or a
   swipe up) and collapses back. Blind users never need it open; sighted helpers do.
   Keep the Quiet toggle, the scene line, hold-to-talk, and the ≥ 4.5:1 contrast tests.
2. **Route preview and proof.** When a route arrives, speak a one-line summary ("Nine legs,
   one point two kilometres, first turn left on Forbes in sixty feet.") and add a DebugPanel
   "Route" section listing every leg (instruction, distance, bearing) and every crossing, so
   correctness is checkable before walking. Record two demo routes into
   `server/data/fixtures` (`npx tsx data/record-demo-route.ts`) so the demo does not depend
   on Google being up.
3. **The walk test protocol** (write it into `DEMO-SCRIPT.md`, run it twice): Forbes ↔ Craig,
   phone in hand, screen recording on. Note at each leg: did the "soon" line come 60 ft
   before, the "now" line at the corner, the "confirm" line after? Did the COURSE buzz stay
   silent facing the leg and grow turning away (body offset set in Settings)? At the curb:
   did it announce the crossing, read the signal, say the far curb? File each miss as an
   issue with the transcript.
4. **Mock walk in the simulator.** `EXPO_PUBLIC_MOCK=1` replays the recorded track; make
   sure every spoken line of a full walk is in the transcript and readable on the screen.

Acceptance: a screen recording of one full Forbes → Craig walk with every instruction audible
and correct, plus the two recorded routes committed.

## The tests everyone runs
- **Living room:** open app → within 3 s something true about the room → "You seem to be in
  a living room. Right?" → yes → "find the eggs in my fridge" → confirm-back → steps with
  direction + distance → at the fridge, hand words → "Grab it." → "Done."
- **Street:** the D protocol above.
Paste the transcript (screen or `IMPLEMENTATION-STATUS.md`) into the PR when it fails.

## Rules that keep merges boring
- CI runs `npm run lint && npx jest` (app) and `tsc && vitest` (proxy) on every PR; red is not merged.
- Branch per task named by stream letter; `git pull --rebase origin main` every morning.
- PRs small and single-stream; anyone may merge a green PR in another stream; squash-merge.
- `IMPLEMENTATION-STATUS.md` is append-only, one dated paragraph per stream.
- Generated things have one owner: `assets/audio/**` → B, `ios/` (never committed) → A,
  `server/data/fixtures/**` → D, `models/*.mlpackage` (never committed) → A.
- Secrets stay in `server/.env`; CI has none and needs none.
- Rebuild the phone (`npm run ios:device`) whenever `modules/perception/ios` changes; JS
  changes only need a Metro reload. `HANDOFF.md` has the recipe and the symptoms we have met.
