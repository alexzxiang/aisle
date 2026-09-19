# Depth and voice repair checkpoint

## Scope and baseline

Requested: prevent premature reach prompts, preserve freezer retrieval stages, repair
truncated/unreliable voice capture, filter OCR noise with store context, and make model
availability metadata honest. Keep progress and remaining validation here.

Baseline: clean worktree at `5a3c029`. Read `AGENTS.md` and Expo SDK 57 reference.
Do not enable paid macOS CI or change model routing/cost policy as part of this repair.
Glass-door visibility is not evidence that a door is open.

## Findings

- `fridgeMission` excludes freezer while `itemMission` defers freezer requests.
- `guide.stepsFromBox` converts frame-relative depth into absolute distance caps;
  arrival uses rounded steps, so one step can mean over one metre.
- Scene memory also labels relative nearness / box area as physical proximity.
- `voice.end()` returns the previous utterance's pending result even when a new
  recording exists. This can leave the new microphone session running indefinitely.
- Recording upload errors currently discard usable Apple transcripts.
- Semantic vision forwards every OCR token without a confidence/context gate.
- GitHub CLI is unavailable, but authenticated GitHub API access works through the
  existing Git credential helper. Never print credential values to logs.
- Located all 107 frames in `server/data/cache/frames` (ignored local data).
  Frame `1789850161774-18-18` visibly shows a hand reaching the fridge handle;
  its cropped box is approximately `[0.012, 0.006, 0.977, 0.994]`.
  The recordings have no measured distance/lens calibration labels. Asked user
  for those; image inspection is not a tape-measure calibration.

## Work plan

1. Separate metric reach evidence from relative depth; cover freezer stages and
   false arrival with regressions. Validate any available real recordings.
2. Fix recording ownership, finalization, cancellation, and fallback preservation;
   add regressions for consecutive recordings while planning remains pending.
3. Filter OCR by confidence/context, update manifest installation semantics.
4. Run relevant JS/proxy tests and Swift harness; document device verification and
   calibration limitations. Update this checkpoint after each feature.

## Completed

- Depth implementation: separate size-based metres from relative depth and rounded
  steps; cropped fridge heights use width; reject invalid/low-confidence boxes;
  require distinct frame evidence in fridge arrival streaks. The estimate uses
  a 70 cm fridge-width prior and a 70 cm reach threshold, pending measurement.
- Freezer now enters the fixed five-checkpoint mission. Fridge approach and item
  reach cannot be completed by a cloud `done` claim or mere item visibility.
- Memory and proxy descriptions no longer translate relative depth/area to close.
- Voice implementation: result ownership is per recording; continuous iOS chunks
  accumulate; a later partial is retained; Scribe failure preserves local words.
  The mic reopens during uploads/planning; UI errors are isolated per attempt;
  failed startup restores audio and does not claim Listening. Native startup
  listener cleanup and dictation task hint are set in the JS recognizer adapter.
- OCR: confidence/context gate before semantic facts; numeric aisle signs remain
  available in stores; stale facts expire. Model manifests use `expected` for
  locally installed, git-ignored weights.
- Local native verification: iOS engine typecheck + Swift harness: 113 passed.
- Full app verification: lint/typecheck and 82 Jest suites / 1,241 tests passed.
  Final relevant rerun: 106 tests passed, including one additional object-dimension
  regression (current app total: 1,242). Final lint and diff whitespace checks pass.
- Full proxy verification: typecheck and 23 Vitest files / 212 tests passed.
  Final prompt rerun: 11 passed.
- `npx tsx scripts/audit-depth.ts` reads 107 frames / 96 usable fridge frames;
  old/new centered reach candidates: 3/18. Zero measured labels: this does NOT
  establish accuracy or a measured false-positive rate.
- Authenticated PR lookup: #13 (`0091ce7`) and #14 (`5a3c029`) both open/mergeable,
  app/proxy check runs completed successfully. Legacy combined commit status is
  "pending" because there are no legacy statuses; the actual check runs are green.
  Asked whether to merge, since #14 also enables the Sonnet cost decision the user
  explicitly identified for the team. No remote writes or merges performed.

## Remaining external validation / decisions

- Implementation is finished and changes remain in the working tree. No commit,
  push, dependency install, paid CI activation, or model-routing change performed.
- Reload Metro and restart the proxy. No native source change requires a rebuild.
- Run the phone acceptance pass in `DEPTH-VOICE-VALIDATION.md`, supplying measured
  distances and real microphone transcripts. Do not claim device calibration or
  microphone accuracy based on these unit tests or unlabelled captured frames.
- Paid macOS CI and Sonnet call costs remain team decisions. The native harness
  was run locally. Glass-door opening still needs physical/user confirmation.
- If the user authorizes merging #13/#14, recheck the exact head SHAs and check
  runs first. These PRs do not contain the new uncommitted repair.
