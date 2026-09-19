# Aisle — team plan for the last stretch (4 people, no merge fights)

Written 2026-09-19. The app builds, installs, talks, and the camera runs from launch.
What's weak is what the user actually feels: it doesn't reliably know where it is, it
doesn't find the eggs, it talks too little, and it sees a narrow slice of the room.
This plan splits that into four streams that touch **disjoint files**, with the rules
that keep `main` green and merges trivial.

## The four streams and who owns which files

| Stream | Owner | Owns (edit freely) | Never edits |
|---|---|---|---|
| **A — Eyes** (native perception) | Mac + Xcode person | `modules/perception/**` (Swift + `index.ts`), `src/perception/**`, `plugins/withCoreMLModels.js`, `models/**`, `training/**` | `src/core/**`, `src/ui/**`, `server/**` |
| **B — Voice & behaviour** (what it says, when) | Windows-friendly: pure TS + Jest | `src/core/situate.ts`, `guidedTask.ts`, `describer.ts`, `prompts.ts`, `voice.ts`, `phrases.ts`, `assets/audio/**` (+ their tests) | `server/**`, `src/perception/**`, `src/ui/**` |
| **C — Brain** (proxy, prompts, planners, places, routes) | Windows-friendly: Node + vitest | `server/**`, `src/outdoor/plannerJobs.ts` (job prompts/schemas/templates), `fixtures/plan/**` | `src/core/**` except `plannerJobs.ts`, `src/ui/**`, native |
| **D — Integrator & walk** (Alex) | owns the phone and the keys | `App.tsx`, `src/core/composeApp.ts`, `src/core/contracts.ts`, `src/core/store.ts`, `src/ui/**`, `src/outdoor/**` (except plannerJobs), `src/crossing/**`, `src/core/haptics.ts`, docs, demo script | — |

Shared files (`contracts.ts`, `phrases.ts`, `server/schemas/vision.ts`, `server/prompts/vision.ts`) change only
through the integrator or a 5-minute PR announced in the group chat and merged before anything
that depends on it. Both sides of a contract change (client + server) go in **one** PR.

## What each stream does, in priority order

### A — Eyes: see more, see it bigger, see it faster
Root causes found on 09-19: the ARKit format policy picked the smallest 30 fps format, which
on the demo phone is 16:9 — that crops the sensor's top and bottom (floor and shelf), the
"narrow horizontal band" you saw. And every still sent to Claude was 384×512: too small to
tell an egg carton from a milk carton. Both are fixed in code but **need a rebuild**
(`VideoFormatPolicy` now prefers ultra-wide → 4:3 → 30 fps; `SnapshotEncoder` accepts 768).

1. Rebuild, then read the DebugPanel's `videoFormat=` line. Report the exact format the
   phone chose and its horizontal FOV. If ARKit offers no ultra-wide format on the
   iPhone 16, say so — that decides whether we want a second capture path.
2. If ultra-wide is unavailable through ARKit: prototype an `AVCaptureSession` on
   `.builtInUltraWideCamera` for **snapshots only** (ARKit keeps pose/depth/preview).
   Success = a 768-px still with ~110° FOV in `snapshotJPEG`, no second preview.
3. Snapshot latency: measure `snapshotJPEG(768)` on-device; target ≤ 80 ms. If it's
   slower, lower JPEG quality to 0.7 and reuse one `CIContext`.
4. Preview: confirm no crop in the portrait panel (aspect-fill of a 4:3 frame in a 3:4 view
   should be edge to edge). If the format is 16:9 after all, switch the view to aspect-fit.
5. Stretch: the pedestrian-signal model. Public PTL data → YOLO11n at 320 → CoreML → drop
   into `models/`. Only start this if 1–4 are done; the Claude curb reading works today
   (DON'T WALK / COUNTDOWN 0.85 on real photos).

Test: on device, the kitchen test below. Unit: `npx jest src/perception`.

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
   closes itself. Add: when `task_step` returns `cameraRequest`/`userAction`, say them as
   directions, not prompts ("Turn a little left." beats "Turn left a little."). Keep every
   line ≤ 12 words, digits as words — `npm run lint:phrases` enforces it.
4. **Questions.** "Is that right?" for scene changes exists. Add one for the goal when the
   parse is uncertain: "Eggs in your kitchen — did I get that right?" (voice `intercept`).
5. **Phrases.** New fixed lines go in `phrases.ts`; generate audio with
   `set -a; . ./server/.env; set +a; npm run gen:audio` (needs the ElevenLabs key locally;
   ask Alex). Commit the mp3s + manifest in the same PR. You are the only stream that
   commits `assets/audio/**` (binary conflicts are unmergeable).

Test: `npx jest src/core` (no phone needed). Live: keyboard path in the app.

### C — Brain: faster, smarter answers
1. **Latency.** The proxy now races Haiku behind Nemotron (`lib/claudePlan.ts`): Nemotron
   wins when it answers in time, Haiku when it misses, the template last. Log both and
   pick per job: if Nemotron's p50 stays > 3 s for `parseIntent`, flip that job to Haiku
   first. Keep Nemotron for `routeCompile` (the "directional navigation" story).
2. **taskPlan quality.** It now receives `facts.scene` and `facts.description`. Write
   5 golden inputs (kitchen/fridge, living room/keys, store/eggs, street/entrance,
   unknown) in `server/routes/plan.eval.ts` and iterate the prompt until every plan starts
   from what the camera said. Same for `task_step` in `server/prompts/vision.ts`: it must
   always return a direction.
3. **Places.** `GET /api/places` ranks by street hint and handles apostrophes. Add
   "nearest" vs "the one on X" disambiguation reply text, and a 502 → cached-last-result
   path. Overpass is flaky; keep the 10-minute cache.
4. **Routes.** Once Google Routes is enabled (project 188682982044, Alex), record two demo
   routes into `server/data/fixtures/` with `npx tsx data/record-demo-route.ts` so the walk
   works even if Google is down at the demo.
5. **Eval.** `cd server && set -a; . ./.env; set +a; npx tsx routes/plan.eval.ts` prints
   model vs template, latency and fallback rate per job; put the numbers in the PR.

Test: `cd server && npx tsc --noEmit && npx vitest run`. Live: `curl` against
`http://<mac-ip>:8787` (see `IMPLEMENTATION-STATUS.md` for the exact calls).

### D — Integrator & the walk (Alex)
1. Merge PRs (small, one stream each), keep `main` green, rebuild the phone when A lands.
2. Enable Google Routes; then walk Forbes ↔ Craig with the phone: haptics dead zone,
   body offset, crossing prompts. Log what the voice said vs. what you saw.
3. UI: camera panel size, transcript, the scene line, a "Quiet" toggle on the Nav screen.
4. The 3-minute demo script and the pitch slide with the architecture diagram.

## The kitchen test (everyone runs it; A and B own passing it)
Phone in hand, standing in a kitchen doorway, app freshly opened.
1. Within 10 s it says something true about the room ("You are looking at …").
2. Within 30 s it asks "You seem to be in a kitchen …. Is that right?" — say **yes** → "Got it."
3. Say **"find the eggs in my fridge"** → "Eggs in my fridge. Got it." → "Let me see your
   surroundings." → one description → first step within ~10 s.
4. Steps name sides and things it actually saw. The fridge step closes when the door is
   open (or when you say **yes** to "It looks like the fridge door open. Is that right?").
5. "Done. Task complete." with the eggs in hand. Say **stop** at any point → back to Home.

Write the transcript (the app keeps it on screen) into your PR when it fails.

## Rules that keep merges boring
- Branch per task: `a/ultrawide-format`, `b/kitchen-scenario`, `c/haiku-understudy`, `d/quiet-toggle`.
  Rebase on `main` every morning (`git pull --rebase origin main`), never merge `main` into your branch.
- PRs small and single-stream. Title starts with the stream letter. Green `npm run lint && npx jest`
  (app) and `npx tsc --noEmit && npx vitest run` (server) before you open it.
- Don't reformat files you don't own; don't run a formatter over the repo.
- `IMPLEMENTATION-STATUS.md` is append-only: add a dated paragraph under your stream's letter, never edit older text.
- Generated things have one owner: `assets/audio/**` → B, `ios/` (never committed) → A, `server/data/fixtures/**` → C.
- Secrets stay in `server/.env` (git-ignored). Ask Alex for keys; never paste them in chat or commits.
- If two of you must touch the same file, say so in chat first and do it in one PR.

## Setup for the two non-Mac teammates
You can do B and C fully without a phone: `cd aisle && npm install && npx jest` (app, mock services) and
`cd aisle/server && npm install && cp .env.example .env && npm run dev` (proxy; fill only the
keys you need). The composition test (`src/core/composeApp.test.ts`) runs the whole app graph
under Jest, including the keyboard voice path — extend it rather than reaching for the phone.
