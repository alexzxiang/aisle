# 03 — Agent B: Outdoor Navigation

**Your leg is deliberately thin.** Outdoor walking directions are a solved
problem — Google Maps, BlindSquare, Lazarillo all do it well. You are
integrating, not inventing. Spend your effort on the **turn-confirmation
haptics**, which is the one part that's ours.

**Owns:** `src/outdoor/`
**Never touches:** `src/core/`, `src/indoor/`, `src/transition/`

---

## Scope boundary (read twice)

You build: route fetching, spoken turn-by-turn, compass-based turn confirmation.

You do **not** build, and must refuse if a task drifts toward:
- street-crossing timing or guidance
- curb / traffic / pedestrian detection
- any use of the camera outdoors

Outdoors is **voice-led, haptic-confirmed**. No CV. The user's cane handles
ground-level obstacles better than our prototype could, and the consequences of
being wrong out there are severe.

---

## Task 1 — Routing API

Use the **Google Maps Directions API in `walking` mode** (or the newer Routes
API). $200/month free credit is far beyond what a demo consumes, it's
well-documented, and it returns JSON turn steps you can pipe straight into TTS.
Mapbox Directions is the fallback if you hit setup friction.

Key it from `.env` via the Node proxy in `server/` (Agent C owns that server —
coordinate, add your route endpoint there, don't stand up a second server).

```
GET /api/route?originLat=&originLng=&destLat=&destLng=
→ { destName, legs: RouteLeg[] }
```

```ts
export interface RouteLeg {
  index: number;
  instruction: string;     // "Turn right onto Forbes Ave"
  distanceM: number;
  startBearing: number;    // heading to hold along this leg (0–359)
  endLat: number;
  endLng: number;
  maneuver: 'STRAIGHT' | 'TURN_LEFT' | 'TURN_RIGHT' | 'ARRIVE';
}
```

Google returns HTML-laden instruction strings — **strip tags and shorten them**.
"Head southeast on Fifth Avenue toward South Craig Street" must become
"Head southeast on Fifth Avenue." Twelve words maximum, per the speech contract.

---

## Task 2 — Leg advancement

Subscribe to `SensorService.subscribeLocation`. Advance to the next leg when the
user comes within ~15 m of `endLat/endLng`. Emit `OUTDOOR_LEG_ADVANCED`.

Guard against GPS noise: require two consecutive fixes inside the radius before
advancing. A single bad fix bouncing the user forward a leg will desynchronise
the entire rest of the route.

---

## Task 3 — Spoken guidance

Speak, via `SpeechService` with priority `NAV`:

- On leg start: the shortened instruction.
- At ~20 m from the maneuver: `"Turn right in 20 feet"` — dedupeKey
  `leg-${index}-approach`.
- On arrival at the maneuver point: `"Turn right now"` then start alignment
  haptics (Task 4).

Use `dedupeKey` on every utterance. Without it, a jittery GPS fix will make the
app repeat "turn right in 20 feet" five times in ten seconds, which is precisely
the chatty-noise failure we're designing against.

**Cached vs live speech (ElevenLabs).** Your maneuver phrases are a closed set —
`"Turn right now"`, `"Turn left now"`, `"Turn right in 20 feet"` etc. Register
all of them in `src/core/phrases.ts` with `cacheKey`s so they play instantly
from bundled audio. Only the leg-start instruction contains a variable street
name and needs a live Flash v2.5 call — and it's non-urgent, so a ~300 ms
time-to-first-audio is fine there. Never let a turn command wait on the network.

---

## Task 4 — Turn-confirmation haptics (**your differentiator — polish this**)

When a maneuver fires:

```ts
haptics.play('TURN');
haptics.startAlignment(() => angularError(sensors.getHeading(), leg.startBearing));
```

`angularError` must handle wraparound correctly — the difference between 350°
and 10° is 20°, not 340°. Get this wrong and the haptics will tell users to spin
the long way around.

```ts
export function angularError(current: number, target: number): number {
  return ((target - current + 540) % 360) - 180;  // signed, -180..180
}
```

Agent A's `startAlignment` handles the hot/cold pulse ramp and auto-fires
`ALIGNED` under 10° error. You just supply the error function and stop alignment
once the user starts moving again.

Why this matters: a sighted-designed app says "turn right" once and hopes. A
blind user turning without feedback has no confirmation they landed on the right
heading. The buzz-ramp turns a guess into a felt confirmation. **This is the
part of the outdoor leg that is actually ours — make it feel good.**

---

## Task 5 — Handoff to Agent D

When the final leg's `maneuver === 'ARRIVE'`, stop your own guidance and let
Agent D's `TransitionDetector` take over. Emit nothing further; do not attempt
to detect store entry yourself. Call:

```ts
transitionDetector.start({ lat: dest.lat, lng: dest.lng, radiusM: 35 });
```

Then unsubscribe your location listener. Two modules both reacting to location
after arrival is a guaranteed source of double-speech.

---

## Task 6 — Mock support

Everything above must run against Agent D's `fixtures/track.json` replay with
`EXPO_PUBLIC_MOCK=1`. **Do all your development this way.** You should never
need to walk outside to test a code change, and on demo day you'll want the
replay path proven anyway.

---

## Definition of done

- [ ] Route fetches and parses; instructions shortened to ≤12 words
- [ ] Leg advancement requires two consecutive in-radius fixes
- [ ] No utterance repeats within its cooldown (verify via DebugPanel counter)
- [ ] `angularError` unit-tested across the 0°/360° boundary
- [ ] Turn alignment feels smooth and confirms crisply under 10° error
- [ ] Clean handoff to Agent D with your listeners torn down
- [ ] Zero camera usage anywhere in `src/outdoor/`
