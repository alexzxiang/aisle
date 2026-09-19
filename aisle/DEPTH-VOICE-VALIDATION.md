# Depth and voice repair — 2026-09-19

Resume/status: [DEPTH-VOICE-CHECKPOINT.md](DEPTH-VOICE-CHECKPOINT.md).

## Behavior changes

- Fridge and freezer retrieval keep approach → open → locate item → reach →
  confirm pickup. The user's freezer wording is preserved.
- Relative inverse depth is never converted into metres or used to shorten a
  walking estimate. Arrival uses unrounded estimated distance, not a rounded
  one-step count. Low-confidence/invalid boxes cannot establish arrival.
- The guide estimates distance from object dimensions and portrait lens geometry.
  A fridge whose height is cropped uses its width. A full-height fridge uses the
  longer of height/width estimates. Two different source frames must support
  arrival; polling the same still twice does not count.
- Cloud `done` cannot close fridge approach or item approach. Locating eggs is
  insufficient: the item must also be centered and estimated within reach before
  hand guidance starts. Door opening remains a separate checkpoint.
- Remembered bearings and cloud detection descriptions no longer claim physical
  proximity from image area or relative depth.
- Voice accumulates iOS continuous-recognition segments, preserves trailing partial
  words, and assigns release/results to the correct recording. Capture can restart
  while earlier transcription or planning runs. Upload failures retain local words.
  Startup failure no longer displays a successful Listening state; errors from an
  older answer cannot cancel a newer recording.
- Semantic OCR facts require confidence and plausible tokens. Store context keeps
  standalone aisle numbers; kitchen noise and price tags are filtered. Facts expire
  after three seconds. Raw OCR/map-matching behavior is preserved.
- Model manifest `expected` means locally installed/exported weights are required;
  runtime availability still comes from successful native model loading.

## What is and is not calibrated

`distance.ts` uses a pinhole projection: normalized horizontal focal length is
`1 / (2 * tan(horizontalFov / 2))`; normalized vertical focal length is multiplied
by `3/4` for the portrait frame. Known-height/width priors turn box size into an
estimate. Wide/ultra-wide defaults remain 56°/100° horizontal FOV. The fridge width
prior is 0.70 m, height prior 1.70 m, and reach threshold is 0.70 m from the camera.
These are explicit assumptions, not measured depth. Different appliances, lenses,
occlusion, and the user's phone/arm position can change the error.

The 107 saved captures are in git-ignored `server/data/cache/frames`. Ninety-six
contain a usable fridge detection. Replay changes centered reach candidates from
3 to 18, including the frame where a hand visibly reaches the handle
(`1789850161774-18-18`). That is a behavior comparison, not an accuracy score.
No tape-measured distance labels are present, so metre error and premature-reach
rates are currently unknown. No private images were added to version control.

Read-only replay, from the app directory:

```sh
npx tsx scripts/audit-depth.ts server/data/cache/frames
```

To measure error, supply a JSON object keyed by frame ID as the second argument:

```json
{
  "your-measured-frame-id": {
    "distanceM": 0.8,
    "hfovDeg": 56,
    "widthM": 0.7,
    "heightM": 1.7
  }
}
```

Values above demonstrate the schema, not labels for any saved frame.
The audit accepts measured dimensions/FOV and prints mean absolute error and
premature-reach counts. It does not silently retune application constants.

## Phone acceptance pass

Reload Metro and restart the proxy for these TypeScript changes. No native sources
changed in this repair. Use the existing development client.

1. Measure the fridge and mark camera-to-handle distances of 2 m, 1.5 m, 1 m,
   0.7 m and 0.5 m. Hold the phone as the actual user will. Record both the camera
   distance and whether the user can physically reach without stepping.
2. Say “eggs in my fridge.” At the distant marks, confirm it never advances to
   opening/reaching. Approach, center the fridge, and check that arrival is stable
   with the top/bottom cropped. Repeat with different lighting and phone angles.
3. Open the door. Put the eggs on a near shelf, then farther back. Merely seeing
   the far carton must not start hand guidance. Center the reachable carton and
   verify the reach prompt, hand guidance, and explicit pickup confirmation.
4. Repeat “eggs in the freezer.” Verify the same checkpoints and the freezer name.
   For a glass door, confirm the door physically opened. Seeing shelves through
   glass alone is not proof; say “the freezer door is open” after checking by touch.
5. Record twenty utterances, including pauses within “find the eggs … in the
   freezer … on the top shelf,” short “yes”/“no,” and a second utterance while the
   first answer is pending. Wait for Listening before speaking. Compare the entire
   transcript with the words spoken, then retry with the proxy unavailable.
6. Deny permission once and retry after granting it. Exercise release during
   startup, repeated press/release, and navigation away during recording. The mic
   must close and playback resume; no old failure may cancel the next recording.

Save `voice_capture`, `guide`, `mission_checkpoint` traces and distance labels beside
the recordings. Do not report this phone pass as complete until it has been run.

## Verified and deferred

Local verification: app lint/typecheck and all 1,241 Jest tests; proxy typecheck and
all 212 Vitest tests; iOS engine typecheck and all 113 Swift harness checks.
The final targeted rerun passed 106 tests, including one additional dimension
regression (1,242 app tests now present), with lint/typecheck still passing.
These validate code paths and recorded inputs, not live microphone or physical
reach performance.

Authenticated GitHub checks show #13 and #14 open/mergeable, with both app and proxy
checks successful at heads `0091ce7` and `5a3c029`. This repair began on #14's head.
No PR was merged or branch pushed. #14 also contains the existing Sonnet routing
decision; its cost remains a team decision. Paid macOS CI was not enabled. Glass
door opening remains a perception limitation with explicit user confirmation.
