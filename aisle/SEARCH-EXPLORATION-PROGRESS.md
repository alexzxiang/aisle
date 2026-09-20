# Search exploration repair log

Base: `eec8a26`. Read `GROCERY-SEARCH-DIAGNOSTICS.md` before implementation.

## Acceptance and progress

1. **Environment and commands (implemented and regression tested):** explicit setting stays sticky; location and item extracted separately from long utterances; classroom/unknown avoid household defaults (including planner fallback); natural explore/resume commands retain the item. Movement questions ask consent. Two agreeing confident task frames can correct an inferred setting, but never an explicit user setting. Store refrigerated cases no longer insert home fridge-opening missions.
2. **Explore versus inspect (implemented):** weak areas get twelve seconds, grounded promising areas up to thirty-five seconds; defer inconclusive areas rather than claim absence. Prefer observed exits or a validated model destination, then exploration headings. Walking remains gated by tracking, fresh path evidence and consent. Generic legs stop after three steps/about two metres and inspect anew. Five-minute search budget offers continuing or asking for help.
3. **Observation/recovery (implemented):** pans wait for inference and a captured view after the previous prompt. Tracking loss stops walking/hand guidance but continues camera requests. Independently confident search evidence survives low overall confidence. Opening pauses recover on new landmarks or available coverage headings. Full resume sentences work; explicit exploration can leave a fridge inspection.
4. **Model input (implemented):** `search.strategy` carries relevance, proposed action, observed landmark and short reason. Controller validates candidates; explanatory facts may be spoken but arbitrary model walking instructions are not executed. Shared vision prompt changes remain one added paragraph. Distant signs alone cannot establish the occupied department.
5. **Depth (implemented, native unverified):** ARKit scene depth is capability-gated. Current high-confidence LiDAR samples supply left/center/right metres; missing/sparse returns and tilted camera fall back to existing monocular depth. Relative values are never presented as metres. Metric range bounds segment steps with a one-metre buffer. Requires iOS rebuild and measured-distance acceptance, unavailable on this Windows host.
6. **Verification (completed for JavaScript/TypeScript):** full app run: **92 suites / 1,391 tests passed**. After final container-reentry regression and small follow-ups: **five affected suites / 88 tests passed**, including the additional regression. Proxy: **23 files / 220 tests passed**. Final app `npm run lint` (typecheck, dependency rules, phrase rules) and proxy `npm run typecheck` passed. `git diff --check` passed. No live paid-model evaluation, Swift compilation, or phone walk was performed.

## Findings in the original code

- Unknown section currently counts as plausible for up to sixty seconds of shelf scanning.
- Repeated signs can set occupied section without arrival evidence.
- Scan prompt interval is four seconds, shorter than reported five-to-six-second inference.
- Tracking recovery exits the guided tick before camera requests.
- Top-level low confidence drops even independently confident search observations.
- Closed-fridge insertion is not restricted to home context.
- Current mission runner already applies `reasoned.next` on its explorer return path, but can force a transitioned mission back into its previous scan phase.

No phone walk or native build has been run for this repair yet. Automated checks do not establish real-world navigation performance.

## Where to resume

- `src/core/searchExplorer.ts`: dwell budgets, short movement segments, inference-aware scans, sign/arrival distinction, structured strategy ranking and explanation, recovery. Trace events: `search_decision`, `search_leave`, `search_rejected`, `search_movement`.
- `src/core/guidedTask.ts`: camera polling through tracking loss, independent search confidence, inferred context correction, store/home barrier separation, container exit without reinsertion. Trace events: `search_context`, `search_observation`.
- `src/core/itemMission.ts`: persist transitions before handing control to exploration, context-aware priors, natural exploration requests and consent.
- `src/core/situate.ts`, `voice.ts`, `composeApp.ts`: explicit setting persistence, combined utterances, classroom support, removal of furniture-only home assumptions.
- `src/core/searchObservation.ts`, `server/schemas/vision.ts`, `server/prompts/vision.ts`: backward-compatible optional strategy on the phone; new proxy schema and one added task prompt paragraph. Old responses continue to use controller/category heuristics.
- `modules/perception/ios/Engine/{ARSessionManager,PerceptionEngine,Events}.swift`: capability detection, confidence-filtered portrait LiDAR corridor samples and metric bridge fields. `src/core/explorationMap.ts`: metric step bound. Non-LiDAR devices retain Depth Anything plus AR tracking; these relative readings are not calibrated distances.
- `src/core/searchRecovery.test.ts`, `adaptiveSearch.test.ts`, and updated existing tests cover the reported behaviors. The long combined grocery request is replayed through `composeApp.test.ts`.

## Device acceptance still required

1. Rebuild the iOS development client (native changes cannot arrive through Metro alone), restart the proxy, and confirm both run this working tree. See [Apple scene-depth capability documentation](https://developer.apple.com/documentation/arkit/arconfiguration/framesemantics-swift.struct/scenedepth) and [confidence-map documentation](https://developer.apple.com/documentation/arkit/ardepthdata/confidencemap).
2. Supervised store test: say the long location+bananas request from the report. Show unrelated shelves/two empty bowls. Expect a quick aisle overview and proposal to leave, not repeated container inspection. Say yes, follow short turn/walk segments, then expose actual produce and expect closer inspection. Timer expiry means deferred/inconclusive, never proven absent from an aisle.
3. Show a distant produce sign without local produce. It may guide destination choice; it must not label the current spot produce or trigger local shelf inspection. A sign's apparent image size is not an arrival measurement.
4. Repeat in an apartment and classroom. Check explicit setting persists despite shared furniture. Home supports rooms and intentional fridge inspection; classroom uses surfaces/floor/openings; store never inserts a home fridge-opening sequence.
5. Interrupt tracking/network for twenty seconds; verify continued camera attempts and an explanatory stop. Restore sensors, then say `Continue trying to search for the bananas`. Also test `Can I go forward to explore more of the grocery store`: same item, movement proposal, no goal-switch loop.
6. LiDAR iPhone: measure obstructions at one, two, three and five metres; check left/right orientation, high-confidence coverage, camera pitch, reflective freezer doors and moving people. `search_movement.path.meters` must be plausible; walking segments shrink with available range. Verify non-LiDAR fallback separately. Three sampled corridors do not establish full-body clearance, glass detection, steps/drop-offs or reach distance. The one-metre buffer and twelve/thirty-five-second search budgets require field tuning.

Changes are local and uncommitted. Do not interpret green automated tests as completion of the supervised acceptance walk.
