# 02 — Agent A: Core Shell & Shared Services

**You are the spine.** Three other agents are blocked until your contracts file
and stub implementations exist. Ship stubs in hour one, refine after.

**Owns:** `src/core/`, `src/ui/`, `App.tsx`
**Never touches:** `src/outdoor/`, `src/indoor/`, `src/transition/`, `server/`

---

## Hour-one deliverable (blocking for everyone else)

Before building anything else, create and commit:

1. `src/core/contracts.ts` — every type from `01-SHARED-CONTRACTS.md`, verbatim.
2. `src/core/stubs.ts` — no-op implementations of `HapticService`,
   `SpeechService`, `SensorService`, `EventBus` that log to console.

Push this first. Agents B, C, D import from it immediately.

---

## Task 1 — Project scaffold

```bash
npx create-expo-app aisle --template blank-typescript
cd aisle
npx expo install expo-camera expo-haptics expo-location expo-sensors expo-speech expo-av
npm i zustand
```

Directory layout (create all, even empty — prevents merge conflicts):

```
src/
  core/      contracts.ts  store.ts  haptics.ts  speech.ts  sensors.ts  bus.ts  stubs.ts
  ui/        HomeScreen.tsx  NavScreen.tsx  OnboardingScreen.tsx  DebugPanel.tsx
  outdoor/   .gitkeep        (Agent B)
  indoor/    .gitkeep        (Agent C)
  transition/.gitkeep        (Agent D)
mocks/       .gitkeep        (Agent D)
fixtures/    .gitkeep        (Agent D)
server/      .gitkeep        (Agent C)
```

---

## Task 2 — State machine (`src/core/store.ts`)

Zustand store holding:

```ts
{
  mode: AppMode,
  targetItem: string | null,
  targetAisleId: string | null,
  targetSide: 'LEFT' | 'RIGHT' | null,
  storeId: string | null,
  currentAisleOrder: number | null,
  lastFix: GeoFix | null,
  heading: number,
  setMode(m: AppMode): void,      // validates legal transitions, logs illegal ones
  ...
}
```

`setMode` must **reject illegal transitions** (see §1 of contracts) and log a
loud warning. During a live demo, a wrong mode transition is the most likely
cause of a confusing failure — make it visible.

Subscribe to the event bus and drive transitions:

| Event | Effect |
|---|---|
| `ITEM_REQUESTED` | `IDLE → OUTDOOR_NAV` (after onboarding if first run) |
| `STORE_ENTERED` | `OUTDOOR_NAV → TRANSITION`, then auto `→ INDOOR_NAV` after announcement |
| `TARGET_AISLE_REACHED` | `INDOOR_NAV → AT_ITEM` |
| `CHECKOUT_REACHED` | `CHECKOUT_NAV → DONE` |

---

## Task 3 — HapticService (`src/core/haptics.ts`)

Implement the four patterns using `expo-haptics`:

```ts
ALIGNED : Haptics.impactAsync(Light) ×2, 90 ms apart
TURN    : Light → Medium → Heavy, 110 ms apart
STOP    : Haptics.notificationAsync(Warning), then Heavy impact
CONFIRM : Haptics.impactAsync(Light) ×1
```

These must be **distinguishable through a pocket or a loose grip**. Test that
before you consider them done — a pattern you can only tell apart while staring
at the phone is useless here.

### `startAlignment(getErrorDeg)`

Poll the supplied callback at ~10 Hz. Map absolute error to pulse interval:

| \|error\| | Pulse interval |
|---|---|
| > 60° | 900 ms |
| 30–60° | 600 ms |
| 10–30° | 300 ms |
| < 10° | fire `ALIGNED` once, stop polling, emit callback |

This "hot/cold" feel is the whole UX of turning correctly without sight. Both
Agent B (compass bearing) and Agent C (aisle centerline) call this same method —
one implementation, two contexts, which is exactly why the vocabulary stays small.

---

## Task 4 — SpeechService (`src/core/speech.ts`) — **ElevenLabs**

You own the ElevenLabs integration. Read `07-SPONSOR-STACK.md` §2 before starting.

### Two-tier playback (build the cache tier first)

Our design constraint — every utterance is terse and from a closed set — turns
out to be a gift here: there are only ~25 distinct fixed phrases in the whole
app. Pre-generate them all with ElevenLabs at build time, ship them as bundled
audio, and play locally. Result: **premium ElevenLabs voice with zero runtime
latency, working fully offline.** Live streaming is reserved for the handful of
phrases containing variable text.

- Write `scripts/generate-audio.ts` — reads `src/core/phrases.ts`, calls the
  ElevenLabs API once per phrase, writes `assets/audio/<cacheKey>.mp3`. Commit
  the generated files; regenerate only when phrases change.
- Playback via `expo-av` `Audio.Sound`. Pre-load all cached sounds at app start
  so the first play isn't slow.
- For `cacheKey`-less requests, call Flash v2.5 (`eleven_flash_v2_5`) streaming
  through the proxy. On any network failure, fall back to `expo-speech` —
  degraded voice beats silence when a blind user is mid-aisle.

Pick one voice ID and keep it consistent across cached and live audio, or the
handoff between tiers will be audible and jarring.

### Queue rules

Implement the priority queue and all suppression rules from §3 of contracts.
This is the single most important file for perceived quality. Specifically:

- Maintain a `Map<dedupeKey, lastSpokenAt>`; drop repeats inside cooldown.
- Enforce the 4-second minimum gap for non-`CRITICAL` speech.
- On `CRITICAL`, call `Speech.stop()` then speak immediately.
- Truncate or reject any `text` over 15 words with a dev warning — catches other
  agents accidentally writing narration.

Add a dev-only counter of utterances per minute to `DebugPanel`. If it climbs
above ~8, the app is too chatty and someone's priorities are wrong.

---

## Task 5 — SensorService (`src/core/sensors.ts`)

- Heading from `expo-sensors` magnetometer, converted to 0–359° true north.
- **Smooth it**: rolling median over 5 samples. Raw values jitter ±15° and will
  make alignment haptics flutter uselessly.
- Location from `expo-location` with `Accuracy.High`, ~1 Hz.
- Respect `EXPO_PUBLIC_MOCK=1` by delegating to Agent D's mock in `mocks/`.
  Import it lazily so a missing mock file doesn't crash production builds.

---

## Task 6 — Onboarding (`src/ui/OnboardingScreen.tsx`)

**This exists because a haptic vocabulary nobody has learned is just confusing
buzzing.** 45 seconds, fully spoken, runs on first launch and from a "practice"
button.

Script:

```
"Aisle uses four vibrations. Let's learn them. This is 'aligned' — you're facing
the right way."           [play ALIGNED]
"This is 'turn' — rotate until the buzzing speeds up."
                          [play TURN, then a 5 s live alignment exercise]
"This is 'stop'."         [play STOP]
"This is 'arrived'."      [play CONFIRM]
"That's all four. Aisle will say each one out loud until you turn training off."
```

Then set a `trainingMode` flag (default **on**): while it is on, every haptic
fires alongside a one-word spoken label ("stop", "turn"). A "training off"
toggle in settings drops the words once the user has internalised the patterns.

This paired-training design is what makes the haptic-first choice survive
first-time use — build it, don't skip it.

---

## Task 7 — DebugPanel (`src/ui/DebugPanel.tsx`)

Hidden behind a three-finger tap. Shows live: mode, heading, target bearing,
GPS accuracy, last vision result, utterances/min, last 10 events. Every other
agent will use this to debug. Build it early; it pays for itself by hour three.

---

## Task 8 — Launch disclaimer

On first launch, before anything else:

> "Aisle is a prototype and is not a safety device. Keep using your cane or
> guide dog. Aisle does not help with street crossings."

Short, spoken, skippable after first run. This is both honest and good demo
framing — judges notice teams that know their own limits.

---

## Definition of done

- [ ] Contracts + stubs pushed within hour one
- [ ] All four haptic patterns distinguishable in-pocket
- [ ] Alignment hot/cold ramp feels smooth, no flutter at rest
- [ ] Speech queue provably drops repeats and enforces the 4 s gap
- [ ] All ~25 fixed phrases pre-generated by ElevenLabs and bundled
- [ ] Cached playback verified in airplane mode
- [ ] `expo-speech` fallback fires on network failure, never silence
- [ ] Same voice ID across cached and live tiers (no audible seam)
- [ ] Onboarding runs end to end in under 60 s
- [ ] Illegal mode transitions logged loudly, never silently applied
- [ ] App runs fully in `EXPO_PUBLIC_MOCK=1` with zero real sensors
