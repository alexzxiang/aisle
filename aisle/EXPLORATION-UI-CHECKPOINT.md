# Exploration, vision, speech and UI checkpoint

Base: 4a7251e, pulled from main. Requested: verify model-led exploration,
expand cached audio and visual vocabulary, increase semantic image size,
and move camera/task above thumb-accessible talk and bounded chat.

Findings: a native heuristic rewrites arbitrary wide objects near people as
carts. Fifteen-word search speech is accepted by the mission but the actual
speech queue still applies twelve words. 1024 is a special curb crop, so larger
full-scene snapshots need a separate allowed size. Most requested furniture
classes already exist; adding names alone does not train a detector.

Work: remove cart relabeling; map supported additional Open Images categories;
preserve fifteen-word indoor search through playback; add prepared exploration
clips; use 1280-long-edge full-scene snapshots; camera/task/talk/chat/type layout.
Native tests, app/server checks and cached-audio generation will be recorded here.

Implemented:
- Removed shape/person-based cart relabeling; actual detector identities survive.
- Exposed pastry/croissant/baked goods, picnic baskets, strawberry, watermelon,
  grapefruit, and shellfish/shrimp mappings. Existing models already cover eggs,
  bottles, bowls, shelves, doors, tables, desks and many fruits. These are mappings,
  not new trained weights. Meat still needs semantic-camera fallback; animal
  chicken/turkey labels must not be presented as packaged meat.
- Preserved up to fifteen words of guided exploration through the actual speech
  queue (outdoor remains twelve). Walking-word suggestions without usable current
  path evidence become a cached hold-still instruction. This lexical guard is not
  a general semantic safety proof; real-world navigation still needs device trials.
- Generated nineteen ElevenLabs search clips and registered them (499 total).
  Exact prepared wording uses bundled audio; arbitrary LLM replies still require
  dynamic speech. Normalization could not run: ffmpeg is not installed. Once
  available, run `npm run audio:normalize`. Some clips exceed the soft two-second
  duration target; no claim of on-device audio quality testing is made.
- Full-scene situate/task-step snapshots now request a 1280-pixel long edge
  (typically 960x1280 portrait), with matching native/proxy acceptance. The 1024
  horizon crop is unchanged. This does not change detector input resolution and
  does increase image payload; measure latency on the target phone/network.
- Camera above Task/item/environment; bottom talk/chat controls, bounded scrolling
  transcript, Home typing last, no Home practice/settings shortcuts. Small-screen
  and large-text layouts scroll. Keyboard avoidance keeps typing accessible.

Verification: native full-module Swift typecheck and 118 engine checks passed;
unsigned iOS build succeeded; proxy typecheck and all 221 tests passed. App lint
and all 92 suites / 1407 tests passed; the additional guided-layout regression
then passed with all 80 screen tests and another typecheck. Real camera accuracy, VoiceOver, keyboard layout and
audio volume need a phone smoke test. No deployment or GitHub push performed.

Handoff: deploy the updated proxy and rebuild the native app before testing 1280
snapshots (an old native binary cannot accept the new size). Test a chair/bowl
beside a person without a false cart label; scan pastries/fruit; explore with
missing and blocked depth; acquire the target and confirm geometry takes over;
check the full fifteen-word playback and both screen layouts on a small phone.

Follow-up: larger camera and persistent cart report
- Removed Home's 240-point cap; both screens now allow half-window preview height,
  reserving 360 points on shorter windows. Explicit panel height keeps available
  width rather than allowing the aspect ratio to narrow the preview.
- Removed the no-op cart heuristic call from the live engine as well. Added
  regression coverage for wide bowls/chairs/tables/baskets/bottles beside people.
- The snapshot upgrade is 768 to 1280 on the long edge (about 2.78x pixels at
  unchanged aspect). Local detectors remain at their exported model input sizes;
  neither preview size nor larger LLM snapshots increases detector input detail.
- Persistent cart labels may indicate an old native binary: the Swift removal
  requires rebuilding/installing, not a Metro refresh. Device inspection reports
  Tyler's iPhone unavailable, so no updated app could be installed or inspected.

Follow-up: exploration / camera-wait oscillation across environments

Confirmed code causes:
- Model-led narration was gated on store context only.
- `observe` could reject a stale/moved-view frame but the caller still spoke its
  model sentence, contradicting the search controller's missing-view warning.
- Missing-view prompts could fire every five seconds, even during analysis.
- A user redirect did not invalidate a model request already in flight.
- All store landmarks containing `table` were excluded, including display tables.
- JS word mapping matched desk as table, and produce bin as trash can.

Changes: observation acceptance now gates narration; narration works across home,
store and classroom; a spoken model turn reserves the scan cadence and clears
redundant canned explanations. When model speech is absent there is still a
deterministic scanning fallback. Pending analysis holds its instruction; missing
view reminders are limited to one per thirty seconds before the existing slower
outage retry. Requests for a different view trigger stationary camera scanning,
not unverified walking. Consumed redirects invalidate in-flight replies.

Store display tables are permitted without reintroducing household fruit-bowl
destinations. Specific support mappings precede generic object words. Model
prompts explicitly cover kitchen islands, classroom desks/cubbies, produce islands,
display tables/bins/endcaps and shelves; structures absent from local model labels
remain exact named semantic landmarks rather than invented detector classes.
No detector was retrained. Consent, position/depth checks, opening validation,
item lock-on and reach geometry remain authoritative.

Checks: app lint/typecheck and 92 suites / 1429 tests passed; proxy typecheck and
23 suites / 221 tests passed. Regression cases include six-second model latency
in all three contexts, stale replies, mid-request redirects, missing-view prompt
frequency, actual store display destinations and support-word identities.
Phone testing still required: replay the apartment stall and capture search_rejected
traces (missing_search, stale_or_duplicate, capture_pose_missing, viewpoint_changed)
if analysis cannot recover. Do not loosen geometric freshness to hide a latency
problem. Deploy the prompt changes to the proxy as well as refreshing app JS.
Live speech can still fall back from ElevenLabs to system TTS on synthesis failure;
voice timbre alone does not identify which controller made a decision.
