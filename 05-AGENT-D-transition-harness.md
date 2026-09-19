# 05 — Agent D: Transition Detection & Demo Harness

You own two things: the **15 seconds that differentiate this project**, and the
**infrastructure that keeps the other three agents unblocked**. Do the harness
first — it's what lets B and C develop without walking to a store.

**Owns:** `src/transition/`, `mocks/`, `fixtures/`, demo tooling
**Never touches:** `src/core/`, `src/outdoor/`, `src/indoor/`

---

## Part 1 — Mock harness (DO THIS FIRST — others are blocked)

### `mocks/sensors.ts`

Implements Agent A's `SensorService` interface, replaying `fixtures/track.json`:

```json
{
  "hz": 1,
  "samples": [
    { "lat": 40.4501, "lng": -79.9350, "accuracyM": 6,  "heading": 120 },
    { "lat": 40.4498, "lng": -79.9361, "accuracyM": 9,  "heading": 118 },
    { "lat": 40.4443, "lng": -79.9436, "accuracyM": 38, "heading": 95 },
    { "lat": 40.4443, "lng": -79.9436, "accuracyM": 65, "heading": 95 }
  ]
}
```

Note the deliberate accuracy degradation at the end — that's the store-entry
signal Part 2 keys off. Build the track so it exercises the real trigger.

Add playback controls: play, pause, scrub, and **jump-to-phase** (outdoor /
transition / indoor / checkout). The team will use jump-to-phase hundreds of
times while iterating — without it, everyone waits through a four-minute replay
to test the last ten seconds.

### `mocks/vision.ts`

Implements Agent C's `VisionService`, replaying pre-scored `VisionResult` objects
from `fixtures/frames/*.json`, timed to the track. Include deliberately hard
cases so the others' error handling gets exercised: a null sign read, a 0.3
confidence result, one malformed response, one timeout.

### Wiring

`EXPO_PUBLIC_MOCK=1` swaps real services for mocks at the composition root only.
No `if (mock)` branches scattered through feature code.

---

## Part 2 — Transition detection (your differentiator)

This is the moment no existing tool handles: outdoor map guidance ends, indoor
camera guidance begins, and today users fall into a gap between two apps.

### Signals (fuse all three)

```ts
type TransitionReason = 'GPS_DEGRADED' | 'STOREFRONT_SEEN' | 'MANUAL';
```

1. **Proximity + GPS degradation (primary).** Within `radiusM` of the store's
   entrance coordinates AND `accuracyM` climbing past ~30 m for two consecutive
   fixes. Losing sky view is exactly what walking through a door does — the
   degradation isn't noise here, it's the signal.
2. **Storefront/door seen (secondary).** One camera frame through Agent C's
   vision service asking whether a store entrance, automatic doors, or the
   store's name sign is visible. Fire at most one call per 5 s; this is a
   confirmation signal, not a loop.
3. **Manual override (always wired).** `forceEnter()` bound to a large button
   in `DebugPanel`. **Never demo without this.** If detection misfires in front
   of judges, a teammate taps once and the story continues.

### Fusion

```
confidence = 0.6·gpsDegraded + 0.4·storefrontSeen
fire ENTERED_STORE when confidence ≥ 0.6, with a 10 s debounce
```

Emit exactly once per session. Double-firing mid-announcement is the ugliest
possible failure here.

### The announcement (script this precisely)

```ts
haptics.play('CONFIRM');
speech.say({ text: 'Arrived. Switching to store mode.', priority: 'NAV' });
// then, after speech completes:
speech.say({ text: 'Looking for aisle signs.', priority: 'INFO' });
```

Five words, then four. The handoff should feel like the app *noticed* something,
not like a menu changed. That felt sense of continuity is the whole point —
judges will remember this beat more than either navigation leg on its own.

---

## Part 3 — Demo tooling

### `DebugPanel` additions (coordinate with Agent A)

- Big `FORCE ENTER STORE` button
- Big `SKIP TO AISLE` button
- Mock track scrubber + jump-to-phase
- Backend health indicator (green/red dot hitting Agent C's `/api/health`)

### `fixtures/` checklist

- [ ] `track.json` — full home→store GPS+heading replay with accuracy decay
- [ ] `frames/` — pre-scored vision results incl. the four hard cases
- [ ] `stores/demo-store-01.json` — from Agent C's venue walk
- [ ] `video/route.mp4` — Agent C's recorded walkthrough, for the backup demo

### Backup demo build

Produce a build that runs the **entire flow from fixtures with no network and no
venue**. Test it on a phone in airplane mode. Hackathon wifi fails constantly;
the team that still demos when the wifi dies looks dramatically more prepared
than the one that doesn't.

---

## Part 4 — Rehearsal support

Own the run-of-show (see `06-INTEGRATION-AND-DEMO.md`) and drive at least three
full rehearsals. Time each one. If the run exceeds 3 minutes, cut content —
almost always by shortening the outdoor leg, which is the least novel part.

---

## Definition of done

- [ ] Mocks shipped early enough that B and C never wait on real hardware
- [ ] Jump-to-phase works for all four phases
- [ ] Transition fires once, reliably, on the replay track
- [ ] Manual override wired and tested
- [ ] Announcement timing feels like noticing, not switching
- [ ] Airplane-mode backup build verified on a real phone
- [ ] Three timed rehearsals completed
