# Route guidance checkpoint

## Findings and implementation plan

- Off-route detection requires stalled progress, missing parallel movement.
- Course reference stays at the leg's starting bearing through curved geometry.
- Advancement publishes the previous leg's remaining distance until another fix.
- No sustained-heading spoken correction exists between maneuvers.

Implement accuracy-aware off-route evidence, local segment bearings, fresh
remaining distance after advancement, and conservative left/right orientation
cues. Suppress ordinary walking cues while off-route/replanning and during
crossing control. Verify with synthetic route regressions and outdoor suites.

Physical GPS/compass validation is required before claiming field accuracy.

## Implementation complete

- `legs.ts`: three fixes beyond both the active and next leg trigger off-route
  detection even with continued parallel progress. Separation must exceed
  max(25 metres, 1.5 × reported GPS accuracy).
- `courseCorrection.ts`: three consistent readings spanning at least two
  seconds prompt left/right orientation, or a pause/turn-around for reversal.
  Corrections have a twelve-second cooldown and reset on interrupted evidence.
- `LegRunner.ts`: corrections require fresh, reasonably accurate GPS/compass,
  proximity to the active route, and distance from the next maneuver. Crossing
  and dedicated turn-alignment flows retain control of their instructions.
  Local polyline segments update course haptics and perception references.
- After advancement, distance and beacon selection use the new leg immediately.
- Off-route guidance says to pause while recalculating; ordinary route cues and
  beacon/course targets are suppressed while separated from the route.
- Leg changes and route installation clear NAV speech, preserving critical
  alerts. Route-specific leg speech keys prevent reroute deduplication from
  hiding the new first instruction. Obsolete asynchronous reroutes/installations
  cannot publish after stop or a newer route installation.
- `guidance.ts`: maneuver-derived turn wording overrides contradictory compiled
  wording; crossing announcements and compiled continuation wording remain.

## Validation

`npm run lint` passed. Twenty targeted outdoor/crossing/composition/replay suites
passed (221 tests). New regressions cover parallel divergence, GPS uncertainty,
correction direction across north, stale compass, interrupted correction evidence,
curved route bearings, immediate new-leg distance, reroute speech keys, and a
compiled script naming the opposite turn. `git diff --check` passed.

## Field checkpoint

Walk a known route with bends and turns, intentionally face away while on the
path, then diverge on a walkable parallel path. Check correction timing, new
route speech, and GPS jitter near buildings. Existing leg-end radius/overshoot
rules remain unchanged; these are not curb-precision localization. Corrections
orient along the mapped path and never infer a traversable shortcut back to it.
