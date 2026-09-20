# Voice and demo updates

- Generated nine bundled ElevenLabs clips using the configured voice: camera processing, match verification, exploration announcements, waiting, camera retry, tracking recovery, and the next-search prompt. Normalized the new clips and previously unnormalized search clips.
- Exploration announces its intention, then allows five seconds for an objection before proceeding. “Wait” holds exploration; “stop” remains available. Tracking and path checks still govern walking instructions.
- Successful guided tasks stop old guidance, say “Task complete,” then invite another item or environment.
- Target and environment appear above the camera. The taller talk button sits lower; conversation history is in the scroll area below the overview.
- OpenImages cart detections now require repeated overlapping boxes at confidence 0.8 or greater. This reduces isolated false detections; it can also delay or miss real carts. Depth obstacle checks remain independent.
- Bottle label aliases include reusable bottles, thermoses and flasks. The vision prompt supports opaque metal bottles, including a neon green demo bottle. Requests containing bottle appearance constraints require model confirmation rather than a generic detector box or remembered generic bottle bearing.

## Before the demo

### Room exit regression

Revisit diagnostics: places are phone XYZ waypoints in the current tracking coordinate epoch. Reuse requires proximity within 0.8 m and a current/directly connected walked node; initial recovery uses 0.25 m. This is not visual loop closure or object identity. Local deferrals last two minutes and cover a three-metre graph distance from the original anchor. The expanded cooldown is now rebuilt when walked edges are added, so later-created waypoints no longer evade it; expansion never uses expanded neighbors as new anchors. `search_revisit` traces every five seconds during explorer ticks expose `created`, `returned` (transitions to existing nodes, not stationary frames), `deferChecks`, `deferHits`, `currentPlace`, `trackingReady`, `deferred`, and `remainingMs`. Hit/check counts measure policy queries, not unique physical revisits. No field hit rate has been measured yet. Different unaligned coordinate epochs remain disconnected.

Doorway follow-up: revisit memory does not decide whether a doorway is visible. The previous failure came from portal gates: two agreeing observations, exact kind filtering, and repeated failure speech. Aisle exits now accept a verified cross aisle reported as either `aisle_end` or `doorway`; portal evidence persists through one uncertain frame and matches modest box/name drift. Explicit exit mode ignores the recent-destination and visited-aisle filters. It keeps requesting left, right, rear and floor-bearing views instead of declaring failure after one sweep. `search_exit_evidence` traces the raw portal classifications and confirmed hit counts.

Blur follow-up: the first repeated unusable view asks for a brief steady hold. Continued blur requests a left view and then a right, floor-bearing view. It no longer enters a repeating camera pause solely because 45 seconds elapsed.

### Object recognition expansion

The Open Images detector now retains Hat, Cowboy hat and Sun hat as `hat`. Milk, juice, pizza, generic headphones and bottles were already available. AirPods/earbuds map to the headphones search class, but generic headphones cannot verify the requested subtype. Metal/reusable bottles also require semantic appearance confirmation. Wallets and packaged meats have no reliable dedicated local label in the installed models; semantic vision now checks shape, visible contents and labels and requests a closer angle when identity is uncertain. Live-animal Chicken remains unmapped to packaged meat. “Find my wallet/AirPods/hat” is parsed as an indoor guided task.

Follow-up: the mission controller now gives committed travel priority before evaluating visible or remembered supports, including silent ticks. Its model request also suppresses support hypotheses during travel. Generic explicit exploration selects a room/aisle exit according to the environment. A visible target cannot cancel the explorer's explicit exit intent. Local item-specific deferrals are now consulted by support retry logic: a pan back to a table does not revive it merely because strict absence evidence is missing. These deferrals use trip place IDs and the existing three-metre walked-edge neighborhood, expire after two minutes, and do not claim absence or carry coordinates across unaligned tracking epochs.

Round 19 (04:31 apartment trace, standing in a doorway with an unexplored room ahead): the
exit-intent path only ever accepted a model-boxed doorway, and with none confirmed it swept the
camera and repeated “No exit confirmed. Describe its direction, or ask someone nearby.” every nine
seconds. Now: a bare “explore” is not a doorway request (`prefer` stays null: a confirmed opening,
else a coverage leg into unvisited ground, else another landmark); “next room” / “leave” keep the
doorway intent but walk legs into unvisited floor while no doorway is confirmed (`EXIT_LEGS_MAX`
failed legs, then the sweep, then `EXIT_UNCONFIRMED` once and the 45 s pulse); a doorway named
once holds the person still for the confirming frame; “there is an opening in front of me, can I
go that way” / “can I go forward” is a `forward` request that walks the heading the person points
at (depth veto unchanged) instead of a permission question; the item in view ends any exit intent
(the navigator locks on). Blurred/dark frames: one hold-still, then new angles, then the ordinary
look-around and move-on — never the same line in a loop. `leaveStalledView` no longer waits on a
pending inference past twice the area budget, and never pauses on top of one.

Explicit “leave,” “exit,” and “get out of” requests now select room/aisle exploration. The explorer retains that objective while scanning, filters destinations to the requested portal type, and tells semantic vision to locate actual openings rather than item supports. It clears the objective after a tracked passage crossing or an explicit area transition. Missing detector output does not certify that a whole room is empty. Bowl/basket exploration destinations require at least two agreeing semantic observations at confidence 0.85; this does not retrain or correct the detector itself. Real doorway acquisition and crossing still need a supervised device walk, particularly after tracking loss.

Rebuild the native iOS app for cart filtering and label aliases. Restart the proxy for the vision prompt and reload JavaScript for voice/UI changes. No detector weights were retrained: label aliases only help if the installed model emits those labels. Test the actual green metal bottle, competing green objects, real carts, and speech interruption on a device. Screen layout has automated coverage but has not been visually checked on a device in this pass.
