# Voice and demo updates

- Generated nine bundled ElevenLabs clips using the configured voice: camera processing, match verification, exploration announcements, waiting, camera retry, tracking recovery, and the next-search prompt. Normalized the new clips and previously unnormalized search clips.
- Exploration announces its intention, then allows five seconds for an objection before proceeding. “Wait” holds exploration; “stop” remains available. Tracking and path checks still govern walking instructions.
- Successful guided tasks stop old guidance, say “Task complete,” then invite another item or environment.
- Target and environment appear above the camera. The taller talk button sits lower; conversation history is in the scroll area below the overview.
- OpenImages cart detections now require repeated overlapping boxes at confidence 0.8 or greater. This reduces isolated false detections; it can also delay or miss real carts. Depth obstacle checks remain independent.
- Bottle label aliases include reusable bottles, thermoses and flasks. The vision prompt supports opaque metal bottles, including a neon green demo bottle. Requests containing bottle appearance constraints require model confirmation rather than a generic detector box or remembered generic bottle bearing.

## Before the demo

### Room exit regression

Explicit “leave,” “exit,” and “get out of” requests now select room/aisle exploration. The explorer retains that objective while scanning, filters destinations to the requested portal type, and tells semantic vision to locate actual openings rather than item supports. It clears the objective after a tracked passage crossing or an explicit area transition. Missing detector output does not certify that a whole room is empty. Bowl/basket exploration destinations require at least two agreeing semantic observations at confidence 0.85; this does not retrain or correct the detector itself. Real doorway acquisition and crossing still need a supervised device walk, particularly after tracking loss.

Rebuild the native iOS app for cart filtering and label aliases. Restart the proxy for the vision prompt and reload JavaScript for voice/UI changes. No detector weights were retrained: label aliases only help if the installed model emits those labels. Test the actual green metal bottle, competing green objects, real carts, and speech interruption on a device. Screen layout has automated coverage but has not been visually checked on a device in this pass.
