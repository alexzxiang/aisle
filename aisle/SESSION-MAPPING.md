# Continuous session mapping

The app now shares `ExplorationMap.trip` across item missions. `tripMemory.ts` owns the
spatial observations and walked route graph. Nothing is persisted to disk or reused across
application launches.

## Data and coordinate lifecycle

- Native ARKit poses carry a UUID that changes on run, tracking reset, and interruption
  recovery. They also carry pitch and at most 64 sparse world feature points per pose.
- Feature points retain x/y/z in 25 cm voxels, capped at 12,000. These are measured visual
  features, not a dense mesh, floor segmentation, or proof that space is walkable.
- A 15 second pose history associates semantic results with the actual JPEG timestamp.
  Moving or turning while a cloud request runs still saves the historical observation;
  its old image boxes cannot steer the current viewpoint.
- LIMITED/NOT_AVAILABLE tracking freezes guided movement. Three normally tracked samples
  are needed before resuming. Stale poses, origin changes, and implausible jumps disconnect
  route segments. The old geometric coverage grid is cleared on tracking invalidation.
- Semantic descriptions survive origin changes. Two consistent readable sign observations
  can link a newly observed place to a unique old semantic place. This does **not** align or
  resurrect the old route coordinates; a fresh local graph is built. Ambiguous repeated
  signs are not merged.

## Areas, portals, and routes

The graph has observation/waypoint nodes, aisle ends, and doorways/open passages. Edges
are created by continuous tracked movement, rather than drawing a straight line to a
remembered department through shelving. Sparse points and graph nodes preserve height;
walking directions use the horizontal plane.

Repeated semantic doorway/aisle-end observations create portal candidates with world
bearings and source viewpoints. A previously seen, unreached portal can attract exploration
back to its observation point. At that point the camera must find it again. A semantic
opening remains a candidate, not a geometric guarantee of traversability.

A new item mission prefers remembered item/section observations reachable on the walked
graph; otherwise it can revisit an unreached portal or scan toward unvisited ground.
The user must affirm a relocation proposal. An explicit `explore` command already expresses
that intent. After turning, current depth must be available and not blocked before walking.
Without position or a landmark, the app asks for another scan/help instead of inventing a
forward walking distance. Silence is never permission.

Reached aisle ends delimit observed traversal spans. The map records distance walked
between them. `lengthKnown: false` is deliberate: two aisle ends can border a cross aisle,
and a bent route is not a measured shelf length. Full aisle identity, parallel shelf
geometry and complete aisle length still need real footage and further perception work.

## Search evidence and stopping

Evidence is per item, local viewpoint node, shelf band, heading and time. States distinguish
seen, not seen, occluded, closed and unusable. Each vertical band needs two explicit target inspections at confidence at least 0.85,
from distinct capture times at least 750 ms apart, with open and usable views and compatible
headings. Upper/lower evidence also requires measured pitch change (eight degrees) or
camera displacement (25 cm); changing only the model view label cannot complete a sweep.
Local face coverage never clears the opposite face of an aisle waypoint.
A positive sighting overrides negative evidence. Evidence expires after 30 minutes.
An `explore` command and a timer expiring do not write negative trip evidence.

The old field-of-view cone is no longer painted during live search; it could see through
walls and refrigerators. Its legacy API remains for diagnostics/tests. Search stopping
messages no longer claim that an item is absent everywhere. The five minute search budget
pauses to offer continuing or asking for help; `keep looking` resets the budget.

Local shelf coverage does not establish that an entire aisle is empty. Object identity,
opaque packaging, door state and occlusion remain perception limitations. The existing
mission's short timeout can still deprioritize a hypothesis, but cannot turn that timeout
alone into a session-long negative location mark.

## Validation before persistence

Automated checks cover remembered dairy routing around a corner, delayed image attribution,
qualified negatives, positive overrides, portal memory, measured traversal spans, tracking
loss, origin resets and sparse point bounds. The iOS module must compile as part of validation.

Next run supervised phone walks and record pose/session IDs and `trip.snapshot()` alongside
vision timestamps. Required scenarios:

1. Pass dairy while finding bananas, then ask for milk and retrace the walked corridor.
2. Scan one shelf, pan away and return; occluded/closed shelves must remain unconfirmed.
3. Find an open passage without a door, confirm relocation, stop if depth becomes unavailable.
4. Interrupt ARKit, change the origin, and revisit a sign; old coordinate routes must stay disabled.
5. Walk between aisle ends and compare recorded travel with a measured route.

Only consider cross-launch map persistence after these real-store checks pass. No claim of
complete 3D reconstruction, calibrated aisle lengths, or validated autonomous store navigation
is made by the synthetic tests.

## Evidence and progress policy update

The vision schema now includes `inspection` (target, assessed, confidence) and landmark
`boundary` (open_passage, cross_aisle, closed_door, unknown). Older responses with missing
fields remain usable for description, but cannot clear shelves or authorize crossing.

The LLM is explicitly asked to identify continuing floor through a doorless gap, or shelving
terminating at a transverse corridor. A door detection alone is not an opening. Two aligned
semantic sightings at confidence at least 0.8 are needed before proposing a portal. Current
depth must still permit movement after turning. After approach, the crossing is a bounded
1.5 metre forward segment; measured displacement, not the timer, establishes the next area.

Coverage gets up to 60 seconds per viewpoint while new verified shelf bands are accumulating.
Twenty seconds without coverage progress allows relocation without claiming absence; unusable
views pause after 45 seconds. Home surface missions also allow up to 60 seconds before
abandoning an unverified hypothesis. Relocation still requires consent.

Inconclusive viewpoints are deferred for two minutes, separately from verified absence.
Remembered routes are pinned to the selected destination so new observations cannot switch
the destination while walking. Eighteen seconds without 35 cm movement aborts the approach;
the existing overall approach timeout remains a backstop. Failed coverage legs remember the
attempted direction, rather than choosing it immediately again. Explicit retry renews the
search budget.

These are conservative policy thresholds, not calibrated probabilities. Verify with recorded
store walks (especially glare, repeated shelf textures, slow walking, closed doors and camera
pans) before treating the system as reliable navigation. No camera system can guarantee that
an occluded item is absent; incomplete regions remain unknown.
