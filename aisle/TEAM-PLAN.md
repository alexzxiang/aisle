# Aisle — team plan for the last stretch (4 people, no merge fights, no integrator)

Written 2026-09-19. The app builds, installs, talks, and the camera runs from launch.
What's weak is what the user feels: it doesn't reliably know where it is, it doesn't
find the eggs, it talks too little, and it sees a narrow slice of the room. This plan
splits that into four streams that touch **disjoint files**, plus the rules that keep
`main` green without anyone playing integrator (CI does that: `.github/workflows/ci.yml`
runs the same gates you run locally on every PR).

## The four streams and who owns which files

| Stream | Owner | Owns (edit freely) | Never edits |
|---|---|---|---|
| **A — Eyes & the model** | Alex (Mac, Xcode, the training data) | `modules/perception/**` (Swift + `index.ts`), `src/perception/**`, `plugins/withCoreMLModels.js`, `models/**`, `training/**` | `src/core/**`, `src/ui/**`, `server/**` |
| **B — Voice & behaviour** (what it says, when) | Mac or Windows: pure TS + Jest | `src/core/situate.ts`, `guidedTask.ts`, `describer.ts`, `prompts.ts`, `voice.ts`, `phrases.ts`, `assets/audio/**` (+ their tests) | `server/**`, `src/perception/**`, `src/ui/**` |
| **C — Brain** (proxy, prompts, planners, places) | Windows-friendly: Node + vitest | `server/**`, `src/outdoor/plannerJobs.ts` (job prompts/schemas/templates), `fixtures/plan/**` | `src/core/**` except `plannerJobs.ts`, `src/ui/**`, native |
| **D — Screens & the walk** (UI, UX, routes, haptics) | Mac + own iPhone | `src/ui/**`, `src/outdoor/**` (except `plannerJobs.ts`), `src/crossing/**`, `src/core/haptics.ts`, `src/core/audio.ts`, `server/routes/route.ts` + `server/data/**` (the route recorder), `README.md` | `src/perception/**`, `server/**` except the two route files |

Everyone has an iPhone; the three Mac users each build to their own phone (Xcode, ⌘R on the
Aisle scheme, or `npx expo run:ios --device`). The Windows teammate takes B or C — both run
fully under Node.

**Shared files — nobody owns them, everybody may touch them, one rule:** `App.tsx`,
`src/core/composeApp.ts`, `src/core/contracts.ts`, `src/core/store.ts`,
`server/schemas/vision.ts`, `server/prompts/vision.ts`. A change there is its own tiny
PR (only those files, both sides of a contract in one PR), posted in the group chat with
"shared file"; the first teammate to see it reviews and merges within the hour; everyone
rebases. Never bundle a shared-file change into a feature PR.

## What each stream does, in priority order

### A — Eyes & the model (Alex): see more, see it bigger, recognise signals on-device
Root causes found on 09-19: the ARKit format policy picked the smallest 30 fps format, which
on the demo phone is 16:9 — that crops the sensor's top and bottom (floor and shelf), the
"narrow horizontal band". And every still sent to Claude was 384×512: too small to tell an
egg carton from a milk carton. Both are fixed in code but **need a rebuild**
(`VideoFormatPolicy` now prefers ultra-wide → 4:3 → 30 fps; `SnapshotEncoder` accepts 768).

1. Rebuild, then read the DebugPanel's `videoFormat=` line. Note the exact format and lens
   (`… ultrawide` / `… wide`). If ARKit offers no ultra-wide format on the iPhone 16, add an
   `AVCaptureSession` on `.builtInUltraWideCamera` for **snapshots only** (ARKit keeps
   pose / depth / preview). Success = a 768-px still with ~110° FOV from `snapshotJPEG`.
2. Snapshot latency on-device: `snapshotJPEG(768)` ≤ 80 ms (JPEG 0.7 and one reused
   `CIContext` if not). Preview: no crop in the portrait panel; aspect-fit if the format
   ends up 16:9 after all.
3. **The pedestrian-signal model** (the on-device path the crossing flow was designed for;
   today the curb reading is Claude, which got DON'T WALK / COUNTDOWN right at 0.85 on real
   photos, in ~3 s). Data: the public PTL / ImVisible set plus phone captures of
   Pittsburgh signals in `training/`; YOLO11n at 320, classes `ped_walk`, `ped_hand`,
   `ped_countdown` (`models/manifest.json` already names the file and classes); export to
   CoreML; `training/score_gate.py` decides if it ships. Log precision/recall per class in
   the PR. The COCO detector's `traffic light` class can crop the region first.
4. Thermal: a 30-minute soak with the camera up in IDLE. If the phone goes `serious`,
   drop the IDLE schedule (detector 5 fps, no depth) in `ModelRegistry.swift`.

Test: on device, the kitchen test below and a real curb. Unit: `npx jest src/perception`.

### B — Voice & behaviour: make it talk like a guide
The loops exist (`situate.ts` narrates and asks "You seem to be …, is that right?";
`guidedTask.ts` plans steps and confirms them with the camera). Tune them until the kitchen
test passes with a blindfold on.

1. **Kitchen test as a Jest scenario.** In `guidedTask.test.ts`, script the real sequence:
   "find the eggs in my kitchen" → look → plan → steps, with vision responses that mimic
   what Haiku actually returns (see `fixtures/plan/taskPlan.json` and the live examples in
   `IMPLEMENTATION-STATUS.md`). Every behaviour change starts by making this test say
   what you want.
2. **Cadence.** Narration every 5 s at INFO is the floor; try 4 s. Add a spoken nudge when
   nothing new was said for 15 s in a guided task ("Still with you. Keep turning slowly.").
3. **Step quality.** Steps come from Nemotron/Haiku (`taskPlan`); the observation step now
   closes itself. When `task_step` returns `cameraRequest` / `userAction`, say them as
   directions ("Turn a little left."). Keep every line ≤ 12 words, digits as words —
   `npm run lint:phrases` enforces it.
4. **Questions.** "Is that right?" for scene changes exists. Add one for the goal when the
   parse is uncertain: "Eggs in your kitchen — did I get that right?" (voice `intercept`).
5. **Phrases.** New fixed lines go in `phrases.ts`; generate audio with
   `set -a; . ./server/.env; set +a; npm run gen:audio` (needs the ElevenLabs key locally —
   ask Alex). Commit the mp3s + manifest in the same PR. You are the only stream that
   commits `assets/audio/**` (binary conflicts are unmergeable).

Test: `npx jest src/core` (no phone needed). Live: the keyboard path in the app.

### C — Brain: faster, smarter answers
1. **Latency.** The proxy races Haiku behind Nemotron (`lib/claudePlan.ts`): Nemotron wins
   when it answers in time, Haiku when it misses, the template last. Log both and pick per
   job: if Nemotron's p50 stays > 3 s for `parseIntent`, flip that job to Haiku first. Keep
   Nemotron for `routeCompile` (the "directional navigation" story).
2. **taskPlan quality.** It receives `facts.scene` and `facts.description`. Write 5 golden
   inputs (kitchen/fridge, living room/keys, store/eggs, street/entrance, unknown) in
   `server/routes/plan.eval.ts` and iterate the prompt until every plan starts from what the
   camera said. Same for `task_step` in `server/prompts/vision.ts` (a shared file — small PR):
   it must always return a direction.
3. **Places.** `GET /api/places` ranks by street hint and handles apostrophes. Add
   "nearest" vs "the one on X" reply text, and a 502 → last-cached-result path. Overpass is
   flaky; keep the 10-minute cache.
4. **Eval.** `cd server && set -a; . ./.env; set +a; npx tsx routes/plan.eval.ts` prints
   model vs template, latency and fallback rate per job; put the numbers in the PR.
5. **Health.** `/api/health` already probes every upstream; add a one-line
   `npm run doctor` that prints it in colour so a teammate can tell a dead key from a dead
   network in five seconds.

Test: `cd server && npx tsc --noEmit && npx vitest run`. Live: `curl` against
`http://<mac-ip>:8787` (exact calls in `IMPLEMENTATION-STATUS.md`).

### D — Screens & the walk: UI, UX, routes, haptics
1. **Google Routes.** Enable the Routes API on Google project 188682982044 and remove the
   key's API restriction (Alex has the console login; do it together on day one). Then
   record two demo routes into `server/data/fixtures/` with
   `cd server && npx tsx data/record-demo-route.ts` so the walk works even if Google is down
   at the demo. Until then the app walks a straight-line degraded leg.
2. **The walk.** Forbes ↔ Craig with your phone: does the COURSE buzz stay silent when you
   face the leg and grow as you turn away? Set the body offset in Settings first. Do
   crossing prompts land at the curb? Write down what the voice said vs. what you saw;
   fix what's yours (`src/outdoor`, `src/crossing`, `haptics.ts`), file the rest in chat.
3. **UI/UX.** Camera panel size vs. transcript on small phones; the scene line; a
   **Quiet** toggle on the Nav screen (narration off, guidance on); the Stop button's arm /
   hold behaviour with VoiceOver on; a first-launch card that says what to say. Keep the
   white liquid-glass look (`src/ui/theme.ts`) and the ≥ 4.5:1 contrast tests.
4. **Onboarding.** The vibration lesson (`OnboardingScreen`) should end with one practice
   question: "You seem to be indoors. Is that right?" so users learn the yes / no loop.
5. **Demo script.** The 3-minute run (open → narration + "you seem to be…" → "find the
   eggs in my fridge" → "take me to the CVS on Forbes") with the exact phrases that hit the
   fast paths, plus a one-slide architecture diagram for the pitch.

Test: `npx jest src/ui src/outdoor src/crossing`. Live: your phone, plus the iOS simulator
in mock mode (`EXPO_PUBLIC_MOCK=1 npx expo run:ios`) for pure UI work.

## The kitchen test (everyone runs it; A and B own passing it)
Phone in hand, standing in a kitchen doorway, app freshly opened.
1. Within 10 s it says something true about the room ("You are looking at …").
2. Within 30 s it asks "You seem to be in a kitchen …. Is that right?" — say **yes** → "Got it."
3. Say **"find the eggs in my fridge"** → "Eggs in my fridge. Got it." → "Let me see your
   surroundings." → one description → first step within ~10 s.
4. Steps name sides and things it actually saw. The fridge step closes when the door is
   open (or when you say **yes** to "It looks like the fridge door open. Is that right?").
5. "Done. Task complete." with the eggs in hand. Say **stop** at any point → back to Home.

Paste the transcript (the app keeps it on screen) into your PR when it fails.

## Rules that keep merges boring (no integrator needed)
- **CI is the integrator.** `.github/workflows/ci.yml` runs `npm run lint && npx jest` (app)
  and `tsc && vitest` (proxy) on every PR and on `main`. Red CI → not merged, no exceptions.
  Run the same locally before you push; it's faster than waiting.
- Branch per task: `a/ultrawide-format`, `b/kitchen-scenario`, `c/haiku-first-parse`,
  `d/quiet-toggle`. Rebase on `main` every morning (`git pull --rebase origin main`); never
  merge `main` into your branch.
- PRs small and single-stream, title starts with the stream letter. Any teammate may approve
  and merge a green PR in someone else's stream; the author merges their own only when nobody
  answers in an hour. Squash-merge so `main` reads one line per PR.
- Don't reformat files you don't own; don't run a formatter over the repo.
- `IMPLEMENTATION-STATUS.md` is append-only: add a dated paragraph under your stream's
  letter, never edit older text.
- Generated things have one owner: `assets/audio/**` → B, `ios/` (never committed) → A,
  `server/data/fixtures/**` → D, `models/*.mlpackage` (never committed) → A.
- Secrets stay in `server/.env` (git-ignored). Ask Alex for keys; never paste them in chat
  or commits. CI has no keys and needs none.
- If two of you must touch the same file, say so in chat first and do it in one PR.

## Setup
```bash
git clone https://github.com/alexzxiang/aisle.git
cd aisle/aisle && npm install                       # app (Node 20+)
cd server && npm install && cp .env.example .env    # proxy; fill only the keys you need
```
B and C need no phone: `npx jest` runs the whole app graph on the mocks
(`src/core/composeApp.test.ts` even drives the keyboard voice path end to end), and the
proxy runs against faked upstreams under vitest. Live behaviour: `cd server && npm run dev`,
then `npx expo start --dev-client` from `aisle/` on a Mac — the app finds the proxy on the
Mac that runs Metro automatically.
