# Aisle Be There

A shopping and item finding aid for blind and low vision people that runs on one ordinary
iPhone. Say what you need ("find the bananas", "I am in a grocery store, help me find the
pasta", "get the eggs from my fridge") and Aisle Be There reasons about where it should be,
reads the signs, explores the store or the room while remembering what it has already checked,
locks on when the camera sees the item, and guides your hand to it. Speech carries meaning in
twelve words or fewer, haptics carry the signals that need to be fast, and the app never
announces an item the camera has not seen.

Built at SteelHacks XIII (September 19 to 20, 2026). The short spoken name inside the app is
still "Aisle". The repository also contains the earlier outdoor routing and crossing work,
which is not the focus of the submission.

Aisle Be There is a prototype supplement to a cane or guide dog, not a safety device. The
first launch says so out loud before anything else.

## What is in this repository

| Path | What |
|---|---|
| [`aisle/`](aisle/) | The app: an Expo SDK 57 development build (React Native, TypeScript), the Swift `Perception` module (ARKit, Core ML, Vision OCR), and the Node proxy that holds every API key. Its own [README](aisle/README.md) has the run instructions. |
| `00-PROJECT-BRIEF.md` … `11-PHASE-0-CHECKLIST.md` | The plan of record: brief, shared contracts, one document per track, integration and demo script, sponsor stack, roadmap and concerns, the perception module, the CV training track. `00` is the place to start. |
| [`archive/`](archive/) | Superseded v1 planning documents, kept for history and not built from. |

Engineering notes that were written as the work happened live in `aisle/`:
[`HANDOFF.md`](aisle/HANDOFF.md), [`IMPLEMENTATION-STATUS.md`](aisle/IMPLEMENTATION-STATUS.md),
[`GROCERY-SEARCH-DIAGNOSTICS.md`](aisle/GROCERY-SEARCH-DIAGNOSTICS.md) and the other
checkpoint files. [`DEVPOST.md`](DEVPOST.md) is the submission text.

## How it works, in one paragraph

Three layers of perception feed one set of rules. On the phone, ARKit gives position and
heading at ten hertz, two YOLO detectors (COCO and Open Images) find objects, a small depth
model reports what is close, Apple's OCR reads signs, and a hand tracker follows the user's
hand during a reach. In the cloud, Claude answers a strict JSON question about each frame
(what the item is, what is blocking it, which openings lead on, what the sign says, what
section this is) on a fast lane and a careful lane, and NVIDIA Nemotron turns spoken
requests into tasks. The policy that decides what to say and when lives in plain TypeScript
with tests, so a model can propose and explain but geometry owns the walk once the item is
in view, a session map and a trip graph remember where the app has already looked, and the
depth grid can veto any step.

## Quick start

```bash
cd aisle
npm install
npx expo prebuild --platform ios       # once, or after a native change
npx expo run:ios --device              # builds and installs the dev client (Expo Go cannot load the Swift module)
npm run start:mock                     # fixtures for sensors, camera and models; no keys needed
```

Live mode needs the proxy. Keys live only in `aisle/server/.env` (ignored by git) and are
never shipped in the app bundle:

```bash
cd aisle/server && cp .env.example .env   # ANTHROPIC_API_KEY, NVIDIA_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, GOOGLE_MAPS_API_KEY
npm install && npm run dev                # http://<host>:8787, /api/health shows every upstream
cd .. && EXPO_PUBLIC_PROXY_URL=http://<host>:8787 npx expo start --dev-client
```

Tests and lints: `npm run lint && npm test` in `aisle/`, `npm run typecheck && npm test` in
`aisle/server/`. The phrase lint enforces the speech rules (twelve words, digits as words, no
"safe", "clear" or "go") on every string the app can say.

## Team

Four students at SteelHacks XIII, working in parallel tracks: core shell and voice, outdoor
routing and crossings, perception and indoor search, harness and demo. The commit history
carries the names.
