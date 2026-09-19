# Outdoor navigation validation — September 19, 2026

Pulled main through `3e892b1` before reviewing routing, signal processing, speech, compass fusion, and turn haptics.

## Live connectivity and routing

The key configured in `server/.env` successfully called Google Routes `computeRoutes` with WALK mode (HTTP 200). No key was printed or committed.

A Pittsburgh test route from 40.4428803,-79.9546937 to 40.4419,-79.9574 returned 296 metres and a right turn. The complete server builder, then an actual local HTTP `/api/route` request through the app's `parseRouteResponse`, both succeeded:

- Google: live; Overpass: live; cache: none.
- Two walking legs and two mapped signalized crossings.
- Route script compiled without fallback.
- HTTP route request completed in approximately five seconds.

This verifies the configured server credentials and route pipeline from this workstation. It does not verify phone-to-server connectivity on cellular or Wi-Fi.

## Repairs

- A failed walking-route request stops navigation rather than synthesizing a straight-line path toward the destination.
- Production no longer substitutes bundled demonstration routes. Explicitly injected replay fixtures remain supported.
- Disk routes must be live Google results within the thirty-minute cache lifetime; loading one does not renew its age.
- Stale/invalid/poor GPS cannot drive leg advancement or crossing proximity; unreliable fixes reset progress streaks. Curb decisions require accuracy within twenty metres.
- Turn confirmation uses the fused body heading, requires stable alignment across recent samples, and resets on jitter or gaps. A timeout asks the user to pause instead of asserting completion. Existing TURN/COURSE/STOP haptic priorities and hysteresis remain covered by tests.
- Expired compass readings no longer sustain course haptics.
- Vehicle scans require detector heartbeats; silence is unknown. Side-heading timeouts produce unclear results instead of labeling a forward-facing image as a side scan.
- Signal voice and ticker reject low-confidence events. Known signal states expire after missing heartbeats; ticker audio stops too.
- Cloud pedestrian-signal reads require alignment with the crossing before and after the request. Prompts explicitly exclude vehicle lights and printed signs as WALK evidence.

## Verification and limits

App lint, TypeScript, and automated app/server tests pass. Regression tests cover unavailable routes, GPS quality, heading jitter and gaps, compass expiry, signal expiry, wrong-facing cloud requests, and silent detectors. Tests simulate haptic commands; they do not measure physical vibration or outdoor recognition accuracy.

This checkout contains model manifests but no CoreML model weight packages. The dedicated `ped-signal-v1` model is absent; its evaluation report still has TBD accuracy results. The generic traffic-light detector class does not identify pedestrian WALK/DONT_WALK states. Native compilation is unavailable on this workstation because the iPhoneOS SDK is missing.

Before relying on the feature, a device build with the required detector, depth, and validated pedestrian-signal models needs supervised outdoor validation: parallel signal heads, already-lit WALK, fresh onset, countdown, glare/night, camera occlusion, curb approaches, GPS drift, and haptic turn alignment. The cloud fallback reports delayed observations and cannot establish fresh WALK onset.

Google explicitly notes that walking routes can omit sidewalks or pedestrian paths: https://developers.google.com/maps/documentation/routes/reference/rest/v2/RouteTravelMode . The app retains that warning. Mapped routes and crossings do not establish current sidewalk availability or permission to cross. These repairs improve failure handling; they do not establish field safety.
