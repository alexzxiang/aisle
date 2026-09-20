# Grocery search failures: diagnostic handoff

Date: September 19, 2026, America/New_York. Trace timestamps below are UTC
(September 20 UTC corresponds to the September 19 evening store test).

## Scope and release status

This pass diagnoses and documents failures; it introduces no new runtime fixes.
The accompanying commit includes the previously uncommitted grocery-context,
local-cooldown and pause-recovery fixes. Those fixes pass automated tests but are
**not evidence that exploration works on a real store walk**.

Reviewed base: `17f42cc`. `origin/main` matched that base when fetched. Diagnostics
used the working tree with the earlier fixes, plus the local, ignored
`server/data/cache/trace.jsonl`. Raw logs, camera images and credentials are not
included. The trace has no app/proxy build identifier, so we cannot establish
which patch version produced each failure. In particular, its old pause wording
does not match the current working tree. Verify the running Metro bundle and
proxy before judging whether a patched path still fails.

## What the phone trace actually shows

The inspected file contained 10,313 records spanning 2026-09-19 18:19:30 UTC to
2026-09-20 02:48:57 UTC. It includes multiple sessions and environments. Counts
below describe logged decisions, not independent user trials or success rates.

For the window beginning 02:20 UTC:

- Banana tasks started with `context: home` at 02:20:45, 02:30:56, 02:38:11,
  02:42:32 and 02:45:54. A banana task at 02:35:21 used `store`.
- Of 68 logged `task_step` results, 34 were `low_confidence`, 33 `applied`, and
  one `stale`. Recorded latency: median 5,552 ms, p90 5,985 ms, max 10,017 ms.
  Low confidence does not establish that the camera or network failed.
- Mission traces contained 65 `search:scan`, 23 `search:paused`, five
  `search:advance`, and four `search:permission` keys. No `search:move` key was
  recorded in this window. Other geometry paths did emit walking instructions;
  the app is capable of saying “walk,” but exploration rarely reached that state.
- At 02:43:00 the model response said “This looks like a store aisle, not home.”
  At 02:43:05 it said “This looks like a store aisle, not a fridge.” Household
  search continued afterward. A model's prose is not an authoritative context update.
- At 02:43:09 the recognized user transcript was `Search`; at 02:43:12 the
  app said “Search paused. Say search again, or stop.” At 02:43:14 it said
  “I did not catch that. Say it again.” This confirms a recognized command
  failing after speech recognition, rather than simply a microphone failure.
- At 02:46:34 the user asked “Can I go forward to explore more of the grocery
  store”; the next reply was “Switch to explore more of the grocery store?”
- The last health sample reports depth present, depth about 5 fps, detector about
  7.5 fps, and thermal state `serious`. This does not prove depth was fresh at
  every blocked movement decision. It does contradict assuming depth was entirely absent.

## Prioritized issues

### P0 — Store context can still become home context

**Evidence:** trace task events above, plus a reproducible parser limitation.

[voice.ts](src/core/voice.ts), `act`, defaults an off-trip household-object request
to a home task when a store/home scene is unavailable. Bananas count as a household
object. [situate.ts](src/core/situate.ts), `whereaboutsFrom`, rejects location
statements with more than 60 characters after the prefix. In a read-only execution
of the current functions:

| Input | Location correction | Exploration request |
| --- | --- | --- |
| `I am in a grocery store` | accepted | no |
| `I am in a grocery store help me find where the bananas are if they are not nearby please explore to try to find them` | rejected | no |

The preceding fixes allow a short explicit store correction to restart a running
home mission and prioritize store context. They do not parse the location clause
out of a longer combined request. Automatic scene analysis is also restricted
during guided tasks; model prose does not repair mission context.

**Proposed work:** parse location, requested item and exploration intent as separate
fields from one utterance. Make explicit trip setting sticky until the user changes
it. Treat unknown setting as unknown, not a silent home assumption. Trace the
context value, source and reason for every transition.

**Acceptance:** the two inputs above both preserve `store` through repeated item
requests, pause recovery and item switches; ordinary home searches remain supported.

### P0 — Natural exploration requests are routed as new goals

[itemMission.ts](src/core/itemMission.ts), `exploreRequest`, accepts a small set
of exact phrases, plus room/aisle patterns. Current read-only diagnostic results:

| Input | `asked` |
| --- | --- |
| `explore` | true |
| `Should I go forward or explore some other area` | false |
| `Can I go forward to explore more of the grocery store` | false |

When the local intercept declines, voice intent parsing can interpret the sentence
as a different destination/task and ask to switch. The trace confirms this happens.

**Proposed work:** recognize requests to explore, approach, continue and ask about
movement while retaining the active item. Distinguish “may I go forward?” from
unconditional movement consent. Confirm the route action, not a nonsense new goal.

**Acceptance:** replay the actual utterances above; goal remains bananas and the
response is a concrete route proposal or the specific reason no route is available.

### P0 — Pause recovery fixed in code, but remains conditional and unverified live

The prior implementation stopped `task_step` requests whenever search was paused
and accepted `search again` but not `search`. This created the observed deadlock.
The accompanying earlier fix polls while paused at intervals of at least five
seconds, accepts short resume commands, and recovers on usable evidence.

Remaining paths in [guidedTask.ts](src/core/guidedTask.ts) and
[searchExplorer.ts](src/core/searchExplorer.ts):

- Missing/unready AR pose returns from the task tick before camera requests.
- Only `applied` semantic results feed search observations. Half of the recent
  logged responses were `low_confidence`; relaxing movement rules would not fix
  the missing observation stream.
- Accepted images can still be rejected by search when capture pose is missing,
  image age exceeds 12 seconds, movement exceeds one metre, or yaw changes by
  more than 25 degrees during inference.
- Recovery from “no opening” requires an eligible new destination. Identical
  scenery can keep it stopped. Budget and confined-scan pauses still exist.
- Short `continue` works now; arbitrary sentences such as “Continue trying to
  search for the bananas” are not guaranteed to reach that same command path.

**Proposed work:** separate “walking stopped,” “actively gathering evidence,”
“waiting for consent,” and “user ended search.” Keep the search goal alive while
recovering sensors. Expose the exact blocking gate and next recovery action.
Preserve obstacle/tracking movement stops; remove indefinite passive search states.

**Acceptance:** injected camera failures, tracking interruptions and low-confidence
frames never create a silent command loop. Camera recovery resumes observation;
unresolved failures explain what is needed. No movement starts solely on a timer.

### P1 — Panning can invalidate the observations needed to leave

The controller requests scan changes every four seconds, but recent model latency
was commonly five to six seconds. A user following the scan can rotate more than
25 degrees before the corresponding response returns. Search then discards its
current-view landmarks. Historical trip observations may still be saved, but that
does not provide a fresh box for steering. This feedback loop is a **code-supported
hypothesis**, not a measured rejection count: the trace lacks rejection reasons.

Movement also needs an accepted landmark/route, consent, ready tracking, and depth
less than one second old. A portal needs repeated confidence of at least 0.8 plus
an `open_passage`/`cross_aisle` boundary. Any missing input can prevent walking.

**Proposed work:** synchronize scan prompts with capture/analysis progress; retain
historical semantic landmarks without steering from stale image coordinates.
Log candidate rejection and movement veto reasons. Add a replay where frames take
six seconds and the user follows each pan prompt.

### P1 — A distant produce sign can trigger a local shelf search

In `searchExplorer.observe`, a repeated sign observed while stationary can become
`area.sign` and set the current section. There is no range or arrival test here.
The subsequent section match can trigger upper/middle/lower shelf prompts before
the user reaches that department. This directly fits the reported far-wall symptom,
although the trace cannot establish the wall's physical distance.

[distance.ts](src/core/distance.ts) estimates range from a box and assumed object
size. [guide.ts](src/core/guide.ts) defaults unknown objects to a height of 0.8 m.
A section sign, shelf bank and aisle opening have very different real sizes.
AR camera position is not automatically a measured 3D position for that sign.

Native [ObstacleEstimator.swift](modules/perception/ios/Engine/ObstacleEstimator.swift),
`normalizeInPlace`, rescales nine depth cells using that frame's minimum and maximum.
The resulting 0–1 nearness is not metres. Using 0.7 to veto movement can be sensitive
to camera pitch, floor and shelf composition. Whether this blocked this specific
walk is unknown because per-decision depth values are not logged.

**Proposed work:** distinguish “department visible ahead” from “currently in that
department”; require approach/arrival evidence before local shelf scanning. Treat
unknown-size landmark distances as uncertain. Validate depth against measured
aisle distances and, where available, calibrated native geometry.

**Acceptance:** view a sign about 30 feet away; announce it as distant and propose
an observed approach. Do not issue arm's-length shelf instructions immediately.

### P1 — Household priors and class-level memory can dominate the search

[hypotheses.ts](src/core/hypotheses.ts) explicitly lists countertop, table, bowl
and fridge for bananas. Those are programmatic priors, not spontaneous LLM choices.
Correct store context avoids ordinary home candidates, but existing stated/working
places have their own path (`itemMission.decide` checks store behavior only when
there is no working place). A store landmark name filter cannot repair a mission
already running through the home hypothesis controller.

The detector/memory can refer to a generic bowl class, while exploration matches
landmarks by name or image overlap. Neither gives a guaranteed persistent identity
to each bowl. Changing viewpoints or names can defeat simple cooldowns, and a
class-level memory can steer toward a different instance. This is a likely contributor
to alternating containers, not a proven object-tracking diagnosis from these logs.

Also audit `createMissionRunner.tick`: it computes `reasoned.next` but several
explorer return paths occur before `state = next`. Proposed hypothesis transitions
may not be persisted on those ticks. Reproduce whether this repeats decisions or
forgets attempted places before changing the state-ownership contract.

**Proposed work:** context-aware weak priors, instance/location-specific attempts,
and one authoritative owner of mission progress. Distinguish “already tried here”
from verified absence. Permit a real produce bin with visible merchandise; the
current lexical bowl ban is only a narrow workaround.

### P1 — The LLM does not own the action loop

`AISLE_SCANS`, `SHELVES`, `CORRIDOR_SCANS` and mission decisions produce most guidance.
`guidedTask` suppresses model speech when geometry/mission owns the turn. Prompts
request observations and prohibit invented movement; speech is generally limited
to twelve words. This explains why asking the LLM to be more flexible has limited effect.

**Proposed architecture:** let the model propose structured actions (inspect a
specific region, approach an observed display, leave via a confirmed portal,
revisit remembered dairy, ask consent), with evidence, uncertainty and a stopping
condition. Let the controller validate geometry and execute short movement segments.
Allow varied explanations of the selected action. Free-form “walk forward” speech
alone cannot supply missing depth, portal topology or persistent object identity.

## Instrumentation and team work order

| Priority | Suggested owner | Deliverable |
| --- | --- | --- |
| P0 | Voice/session | Combined location+item+exploration parsing; sticky explicit setting; trace replay |
| P0 | Search controller | Recovery states with no passive deadlock; one mission-state owner |
| P1 | Perception/native | Depth freshness and veto audit; target range uncertainty; capture/pose alignment |
| P1 | Search/memory | Distant-sign versus occupied-area distinction; instance-specific attempts and exits |
| P1 | Planner | Structured action proposals and grounded explanations integrated with controller |
| P1 | Integration | Supervised grocery replay and acceptance walk, including the exact failing utterances |

Add one diagnostic record per decision with app/proxy revision, session and task ID,
setting/source, mission phase, search phase/pause cause, parsed user action, frame
sequence/capture/response times, rejection reason, pose/tracking age, yaw delta,
depth age/values, candidate scores/rejections, chosen route and consent state.
Current `task_step` traces omit `search` observations and capture geometry; mission
traces omit these vetoes. Do not infer them from a generic spoken “scan” message.

Recommended real-store sequence: start with a long combined store declaration;
search bananas; inspect two adjacent empty containers; expose a distant produce
sign; request exploration in natural language; traverse an observed aisle exit;
temporarily interrupt tracking/network; resume; then request milk at previously
passed dairy. Record timestamps and measured distances. A pan or elapsed time is
not proof that a new aisle was reached or an old aisle was cleared.

## Diagnostics run for this handoff

- `cd aisle && npm test -- --runInBand`: **91 suites, 1,372 tests passed**.
- `cd aisle && npm run lint`: typecheck, dependency and phrase checks passed.
- `cd aisle/server && npm test`: **23 files, 217 tests passed**.
- `cd aisle/server && npm run typecheck`: passed.
- Executed current `exploreRequest` and `whereaboutsFrom` with the inputs above;
  reproduced the unresolved parser failures without modifying code.
- Read local traces and inspected control flow. No new store walk, metric depth
  calibration, native rebuild or live model evaluation was performed.

Existing tests validate selected branches and synthetic geometry. They do not
validate the full phone+latency+speech+tracking loop. Prior fixes should be treated
as partial improvements until the acceptance walk succeeds.
