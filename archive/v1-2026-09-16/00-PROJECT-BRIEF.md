# 00 — Project Brief (READ FIRST, ALL AGENTS)

## What we are building

A phone-only navigation aid for blind and low-vision users that takes a person
from **their home → to a grocery store → to a requested item → to checkout**,
using nothing but a standard smartphone. No LiDAR, no Vision Pro, no wearables.

Working name: **Aisle** (rename freely).

## The demo we are building toward

One continuous, rehearsed run:

1. User says (or types) "I need eggs."
2. App routes them on foot toward a nearby grocery store, speaking turn-by-turn
   directions and buzzing to confirm each turn is executed correctly.
3. As they approach the store, the app detects the transition and announces it:
   *"You've arrived at the store. Switching to store mode."*
4. Inside, the camera reads aisle signage. The app guides them aisle by aisle,
   using vibration to keep them aligned down the correct aisle.
5. Arrival: *"You're at the dairy aisle. Eggs should be on the shelf to your right."*
6. App then guides them to the checkout area and ends: *"You've reached checkout."*

The **outdoor→indoor handoff (step 3)** and the **camera-based indoor guidance
(step 4)** are our differentiators. Everything else is scaffolding around them.

## Why this framing (context, do not re-litigate)

Prior art exists for "phone camera + AI scene description for blind users" —
many hackathon projects, plus academic work (ShopTalk for grocery, Mobilio for
smartphone-only outdoor navigation). Our claim to novelty is **not** "we use a
phone camera." It is:

- The seamless **outdoor-to-indoor handoff**, which existing tools do not cover.
- **Goal-directed** indoor guidance (find *this item*) rather than ambient scene narration.
- **Haptic-first** real-time feedback so safety cues never wait on a network round trip.

## Non-negotiable design principles

1. **Haptics carry real-time signals. Speech carries meaning.**
   Vibration is on-device and instant. API-driven speech is slow and must never
   be the only thing standing between a user and an obstacle.
2. **Terse over descriptive.** Never narrate a scene. Speak the top one or two
   actionable facts, under ~2 seconds of audio. Blind users rely on ambient
   sound for spatial awareness — every second we talk, we mask it.
3. **Tiny haptic vocabulary.** Maximum four patterns, total. Large vocabularies
   are unlearnable in one sitting.
4. **Every haptic pattern is teachable.** Onboarding pairs each vibration with
   its spoken meaning so a first-time user (or judge) learns it in under a minute.
5. **Latency budget is a hard constraint.** See `01-SHARED-CONTRACTS.md`.

## Explicit non-goals (do NOT build these)

| Not building | Why |
|---|---|
| Street-crossing guidance, traffic/curb detection | Highest-consequence failure mode in the whole system. A prototype must not imply it handles this. Their cane handles ground-level outdoor obstacles. |
| Outdoor obstacle detection from video | Hard CV problem, high stakes, low added value over a cane. |
| Shelf-level product detection ("that exact egg carton") | Hardest CV problem in the project. Academic systems still struggle. Aisle-level is the win condition. |
| Open-lane / queue-length detection at checkout | Dynamic scene analysis. Out of scope. |
| Payment, scanning, cashier interaction | A different product. Cashiers and accessible self-checkout already handle this. |
| General-purpose indoor SLAM | Not achievable in days. We use pre-mapped stores + sign reading. |
| Continuous scene narration | Actively harmful to usability. See principle 2. |

If a task tempts you toward any row in that table, stop and note it in your
agent log instead of building it.

## Safety posture

This is a prototype. It must never be presented, in copy or in demo script, as
a safety-critical device. Routing APIs explicitly disclaim safety-critical use.
The app should include a short spoken disclaimer on first launch and keep the
user's primary mobility aid (cane/dog) assumed present at all times.

## Tech stack (fixed — do not substitute)

- **React Native + Expo (TypeScript)** — fastest cross-platform path with
  first-class access to camera, haptics, compass, GPS, and TTS.
- `expo-camera`, `expo-haptics`, `expo-location`, `expo-sensors` (magnetometer),
  `expo-speech`, `zustand` (state), `expo-av` (audio fallback).
- **Thin Node proxy** (Express) for all API keys. Never ship a key in-app.

### Sponsor stack (REQUIRED — these are hackathon prize categories)

- **NVIDIA Nemotron** — all vision and language work. Specifically
  **Nemotron Nano 2 VL** (12B multimodal, leads OCRBench v2) for aisle-sign
  reading, via the free NIM endpoint at `build.nvidia.com`. Returns **strict
  JSON**, never prose.
- **ElevenLabs** — all speech output. **Flash v2.5** (~75 ms inference,
  streaming) plus a **pre-generated audio cache** for our fixed phrase set.

Neither is a bolt-on. Nemotron Nano 2 VL is genuinely the right model for this
job — sign reading in a store is an OCR-under-motion problem, and that's the
benchmark it leads. See `07-SPONSOR-STACK.md` for full integration detail.

## Agent ownership map

| Agent | Owns | Directory |
|---|---|---|
| **A** | Core shell, state machine, haptics, speech queue, sensors, onboarding | `src/core/`, `src/ui/` |
| **B** | Outdoor routing, spoken turns, compass alignment haptics | `src/outdoor/` |
| **C** | Camera pipeline, vision proxy, store map, item lookup, indoor guidance | `src/indoor/`, `server/` |
| **D** | Transition detection, mock/replay harness, fixtures, demo tooling | `src/transition/`, `mocks/`, `fixtures/` |

**No agent edits another agent's directory.** All cross-agent communication
happens through the interfaces in `01-SHARED-CONTRACTS.md`, which is frozen —
if you need it changed, flag it rather than editing unilaterally.

## Build order priority

If time runs short, ship in this order:

1. Indoor guidance working in one rehearsed store (Agent C + A)
2. Transition announcement (Agent D)
3. Outdoor routing + turn haptics (Agent B)
4. Onboarding polish (Agent A)

A flawless 60-second indoor demo beats a shaky end-to-end one.
