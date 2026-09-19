# Living-room recovery — 2026-09-19

Latest depth/voice repair: [DEPTH-VOICE-CHECKPOINT.md](DEPTH-VOICE-CHECKPOINT.md).
Implementation and automated verification are complete; measured distance calibration,
phone microphone acceptance, and the PR/team decisions are recorded there. See
[DEPTH-VOICE-VALIDATION.md](DEPTH-VOICE-VALIDATION.md) for reproduction and phone steps.

User: Alex (person A). Request: pull teammate changes, restore audible/fast speech,
expand prepared speech, and reliably carry "eggs from my fridge" through approach,
opening, item identification, hand guidance and completion. Keep this file current.

## Latest — empty speech captures after CV recovery

User confirms CV is back. Trace contains one recognized "Eggs" between many empty
captures that were misclassified as unclear intents. Speech changes: continuous
recognition until button release, preserve partial text against empty final result,
wait for native end/recording finalization before fallback upload or playback reset,
serialize duplicate releases and new capture startup, remove delayed playback reset
that could interfere with the next recording. Empty capture now emits a dedicated
notice at most once per 15 seconds, never increments unclear-item/confirmation
counters and never discards the pending goal. Add voice_capture diagnostics (error,
ended, hasClip, resultCount, transcriptLength, STT source; not recorded audio).

Full app lint and 1137 tests passed before the last pending-confirmation regression
and delayed-reset removal; targeted voice checks run after those final changes.
This is JS-only; full reload is sufficient. Real microphone recognition still needs
the user's retest; do not claim capture accuracy from mocks.

## Latest — detector stopped / reconciliation audit

Trace: detector events stop after timestamp 1789846268367 (last frame had chair and
table), while later cloud task requests continue. This is not merely the UI hiding
boxes. No native detector-code changes between f2ed7ff and 1ba837a; the YOLO compiled
model remains in the installed app bundle. The precise runtime cause of the stall
is NOT established from the old trace (it lacked native heartbeat telemetry).

Fixed concrete recovery defects: native restart reclaims ARSession delegate/queue;
binding clears failed-start state; live app monitors detector events, logs FPS,
model-load messages, profile and frame age, and attempts at most two restarts after
15 seconds of silence. Empty detection arrays reset the heartbeat; backgrounded
apps never recover the camera. Snapshot calls now reject stopped/stale frames
instead of letting cloud vision describe the last room forever.

Audit also found the dedicated TalkButton still signalled readiness before native
capture (only the background hold gesture had been updated); both now wait for the
start promise. Voice-port release no longer parses an empty recording after a
failed microphone start. Existing trace contains an audio-capture startup error.

App lint/typecheck + 1135 tests, server 202 tests, Swift 113 checks passed before
the final voice-port regression. Native rebuild/install underway. See final handoff
for launch result; detection recovery must be observed on the real phone before
claiming resolution. Changes are local at this checkpoint.

Native **BUILD SUCCEEDED** and installation succeeded. Launch failed because the
iPhone was locked. Unlock and open Aisle to collect `perception_health` traces.
Final voice-port regression passes (four adapter tests). No live detection recovery
has yet been observed; do not describe this as a confirmed field fix.

## Latest — team reconciliation and recording readiness

Checkpointed previous work at `1eba080`, merged origin/main through `de7b6b1`;
automatic documentation merge preserved both entries, no unresolved conflicts.
Included D's transcript stability changes and C's opt-in vision-frame/eval tools.
Frame capture remains off by default; do not push private frames or service keys.

Compound explicit home requests normalize "take me to my fridge and find my eggs"
to "eggs in my fridge" and start directly, without confirmation. Other uncertain
goals retain confirmation, but two unclear answers exit it instead of looping.
Mic begin now awaits native audiostart; UI shows Starting microphone until then,
only announces Listening once capture starts. Low-confidence nonempty STT can use
the existing Scribe fallback too. This does not eliminate native startup time or
guarantee recognition accuracy; speak after Listening.

Turns name approximate five-degree increments; forward steps remain approximate.
Visible-target turn haptics repeat every 1.5 seconds independently of speech.
Static relative depth alone no longer produces a stop in the approach guide:
requires closing evidence or a large central detected obstruction. Tiny closing
noise does not trigger the separate guided-task obstacle reflex. These are
heuristic filters, NOT calibrated obstacle detection or a verified traversable path.
Rehearse with a sighted helper and cane; physical room performance remains unproven.

## Starting point

- `git pull --ff-only`: already current, main `9065e0b`. Poon's microphone,
  confirm-back and unknown-question PRs are included. No changes made by the user
  in the initial working tree.
- Prior validation: app types pass; 1091/1092 Jest tests pass. The failed test is
  phrase lint scanning runtime `server/data/cache/trace.jsonl`. Server 188 tests pass.
- SDK 57 versioned docs read as required by AGENTS.md.

## Confirmed defects / work in progress

- `guidedTask.tick` awaits cloud vision before scheduling its next geometry update.
- `speakGeometry` sets an arrival completion for any non-reach step, including opening.
- An early return after geometric arrival exits without scheduling another task tick.
- A reply for an old step can be applied after manual advancement (same run identity).
- `semanticVision.apply` still emits/speaks movement prompts on silent requests.
- `renderFacts` truncates userText to 200 characters; step details follow scene memory.
- `handGuide` treats 2D fingertip overlap as successful pickup; needs user confirmation.
- Audio output issue under investigation: recording session restoration, fallback voice,
  playback cancellation and missing prepared geometry phrases.

## Intended implementation and acceptance

1. Preserve a fridge retrieval mission with explicit approach/open/find/reach checkpoints.
2. Run fresh detector guidance independently of slow/failed semantic requests.
3. Keep scene narration and stale replies from overriding an active mission.
4. Prepare a broad, deterministic instruction vocabulary and immediate speech fallback.
5. Test full fridge flow, stalled vision, stale replies, cancellation and playback pacing.
6. Record actual verification and device-only unknowns here and in HANDOFF.md.

## Checkpoint 1 — implementation, verification in progress

The local phone trace proves the main cause: "Lead me to the eggs" started an
OUTDOOR route; later fridge TASK_REQUESTED events were ignored outside IDLE.
"Bear left" came from that wrong street route, not object guidance.

Implemented (not yet fully verified): explicit indoor intent and route replacement;
fridge mission with approach/open/find/reach/confirm stages; independent geometry
clock; stale-step guards; silent vision suppresses prompts too; full 500-character
task context; exact-text prepared speech lookup; immediate local fallback during
tasks; hard 500-ms synthesis deadline elsewhere; speech suppression during mic use;
one-second hand cue pacing; playback cancellation guards; reset audio mode from
measurement to default and explicit volume one. Runtime traces excluded from lint.

Generated vocabulary: 392 new phrases underway (480 total), 13 household targets,
one through twenty steps, direction/search/arrival variants, mission prompts.
Normalize only these new clips with `bash scripts/normalize-audio.sh --prepared`.
Generation running under exec session 8854 at checkpoint time.

Live proxy doctor: all required services healthy. TTS probe: HTTP 200, 262 ms total,
14254 bytes. Slow ElevenLabs is NOT established as the cause of the field failure.
iPhone 16 is paired/available. Changes so far are JS/server/assets; no new native
binary required. Physical audibility/calibration still requires a phone rehearsal.

App typecheck and phrase lint pass at checkpoint 1. Targeted tests initially showed
six assertions expecting old behavior; five updated, long disclaimer auto-key
exemption fixed. Need re-run, add regressions, run full suite + server checks.

## Checkpoint 2 — integrated main, automated gates green

Supersedes the in-progress notes above. Fast-forwarded to `f2ed7ff` (D's PR #11):
Lanczos still resizing, camera-overlay contrast, repaired/expanded Swift harness.
No local fixes overwritten. Poon's earlier confirmation/microphone fixes remain.
Reviewed C's `75ae2cb`: shorter plans are useful in principle, but its direct reach
after opening omits explicit item localization. Not merged; the fridge mission
keeps approach → open → identify item → hand alignment → user-confirmed pickup.

- Generated all 392 new clips, 480 total. ALL clips normalized with peak compression
  and loudness normalization v2. Sample fridge instruction measures -16.3 LUFS
  (previously roughly -23); re-running normalization skips unchanged hashes.
- Exact prepared task phrases play locally; other task speech uses local synthesis
  immediately. Other live synthesis has a hard 500-ms fallback deadline.
- Mic capture suspends speech, restored sessions use default mode/doNotMix, playback
  explicitly uses volume one. Hand cue pacing is one second, not four.
- Fresh on-device detections guide approach independently of cloud latency. Geometry
  cannot complete opening. Old-step and old-hand-session responses are ignored.
- Explicit home commands replace mistaken outdoor routes and retain the requested
  item. Repeating a fridge request cannot erase the eggs goal.
- Mission/step facts go first in each vision request, with a 500-character allowance.
  Silent vision cannot emit unrelated instructions. Background cloud situating pauses
  during tasks, so it cannot supersede task evidence or ask room-confirmation questions.
- Each HTTP vision transport sends a runtime client ID: reload sequence resets no
  longer collide with the proxy's per-client stale-response tracking.
- Obstacle guidance says stop/check with cane, not an unverified lateral sidestep.
  Image overlap means aligned, NOT verified contact or successful pickup.

Verification: app lint/typecheck + 75 suites / 1105 tests; server typecheck + 189
tests; native engine typecheck + 113 checks all passed after integration. Additional
native playback regression tests and a signed iPhone build are being run next.
The build script now stops on xcodebuild failure instead of installing an old binary.

### Resume / physical acceptance

1. Run `npm run lint`, `npm test -- --runInBand`, server typecheck/tests and
   `bash modules/perception/tests/run.sh` after any further edits.
2. Rebuild with `npm run ios:device` (D's snapshot change IS native). Full app reload,
   not only Fast Refresh: `App.tsx` keeps its composed services in a singleton.
3. With a sighted helper/cane, say "Get eggs from my fridge" and confirm. Verify no
   outdoor route; fresh fridge direction repeats while cloud waits. Point away:
   stale boxes must not produce fresh walking claims.
4. Near/aligned with fridge, verify opening is a separate checkpoint. Say "the door
   is open" or show the interior. Eggs must be localized, not replaced by fridge box.
5. Show outstretched hand and eggs together. Direction cues should be audible and
   responsive; alignment leads to a pickup question, never automatic success.
6. Confirm holding the item; only then finish. Test cancel/repeat/new goal, airplane
   mode prepared audio, and repeated mic recordings for volume regressions.

Not yet established: recognition accuracy in Alex's living room, actual speaker
audibility, calibrated distances, hand depth/contact. Tests cannot establish safe
independent navigation. Do not claim production readiness or guaranteed pickup.
No changes pushed. Local edits/assets plus this file are the recovery checkpoint.

## Checkpoint 3 — installed on iPhone

## Confirmation-loop follow-up

## Walking / audio / handle follow-up

Phone trace showed relative-depth arrival ending approach early, followed by many
open-step model instructions. A small fridge box plus high relative nearness no
longer counts as arrival; large-box evidence is also required. Guidance repeats
every four seconds, changed cues have a 2.5-second floor, turns pulse TURN and
new forward alignment pulses CONFIRM. Geometry logs now rely on actual speech
playback logging instead of adding a second prompt for every queued cue.

Four-second speech watchdog was cutting off longer clips: now ten seconds, still
released immediately by the normal finished event. Cached ElevenLabs clips remain;
uncached task speech remains immediate local TTS. Native play-after-seek exceptions
are contained in speech and tone backends; stopped/disposed tones cannot later play.
This addresses plausible Session lookup failed paths, not a proven native stack root cause.

The open stage first runs hand guidance toward the actual fridge handle (never the
appliance box). Alignment does not open the door or complete the mission. One failed
handle attempt resumes door observation rather than looping forever. Saying "the
door is open" still advances. Food/hand prompts distinguish eggs, citrus, cartons;
model-only hand hints now require a fresh target box with confidence >= 0.7.
These prompt changes are not evidence of improved accuracy on real food images.

Verification: app lint/typecheck and 1119 tests pass. Server checks run alongside.
Physical retest: long cached sentence must finish; small distant fridge must keep
approach active; turns pulse; handle hand guidance then opening; egg/carton target
with up/left/right hand cues; ambiguous orange/egg must not cause a confident reach.

User reported confirmation looping. Actual phone trace shows two recognized
"That is correct" replies followed by "I did not catch that". The local yes matcher
omitted this phrase and discarded the pending mission before generic planner/vision
fallback. Fixed: accept common affirmative combinations, normalize punctuation and
curly apostrophes, retain pending mission on empty/ambiguous answers and ask yes/no
locally. Explicit cancellation/replacement commands still exit confirmation.
Nine regressions cover kitchen/eggs phrasing, natural affirmatives and retry after
unclear input. Voice suite: 66 passed; app lint/typecheck passed. Sent full Metro
reload so singleton services pick up the fix. Physical retest remains required.

### Previous installation result

Two additional speech-backend regressions pass (lazy cached playback, cancellation
during seek, full-volume/session fallback); app typecheck also passes. Total app
coverage is now 1107 tests across 76 suites (1105 full-run + two new targeted tests).
Signed native build **BUILD SUCCEEDED**, installed on Alex's paired iPhone.
Launch was denied because the device is locked. Unlock and open Aisle manually;
no physical walkthrough or listening test has been performed. Metro remains on
port 8081; proxy on 8787. Build script now reports launch failures explicitly too.
