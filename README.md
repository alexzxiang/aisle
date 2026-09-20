# Aisle Be There

A navigation aid for blind and low vision people that runs on one ordinary iPhone. It walks
a person along the street, across a signalized or unsignalized crossing, into a grocery store
nobody surveyed, and to the item they asked for, and it finds things at home too ("find the
bananas", "get the eggs from my fridge"). Haptics carry the signals that need to be fast,
speech carries meaning in twelve words or fewer, and the app informs; it never decides a
crossing for you.

Built at SteelHacks XIII (September 19 to 20, 2026). The short spoken name inside the app is
still "Aisle".

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
(what the item is, what is blocking it, which openings lead on, what the sign says) on a
fast lane and a careful lane, and NVIDIA Nemotron turns spoken requests into plans. The
policy that decides what to say and when lives in plain TypeScript with tests, so a model
can propose and explain but geometry owns the walk, the depth grid can veto any step, and
the words that would tell someone to cross a street are never allowed out of any model.

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
