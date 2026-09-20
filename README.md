# Aisle Be There

Aisle Be There turns one ordinary iPhone into a blind shopper's guide: it reads the aisle
signs, reasons like a friend about where the bananas are, walks you there and puts them in
your hand. It does the same at home ("get the eggs from my fridge"). No glasses, no LiDAR,
no wearable.

Built at SteelHacks XIII (September 19 to 20, 2026). The short spoken name inside the app is
still "Aisle". The repository also contains earlier outdoor routing and crossing work, which
is not the focus of the submission.

Aisle Be There is a prototype supplement to a cane or guide dog, not a safety device. The
first launch says so out loud before anything else.

## What it does

You hold the talk button and say what you need. "Find the bananas." "I am in a grocery
store, help me find the pasta." "Get the eggs from my fridge."

If the item is already in view, geometry takes over immediately: "Bananas at eleven o'clock,
two steps." Aisle Be There locks on with the phone's own detectors and walks you in.

If it is not in view, the app reasons the way a person would. In a store it thinks by
section: bananas belong in produce, pasta near the sauces, milk in dairy. It reads the
overhead signs with the phone's own OCR, notices what is actually on the shelves in front of
you ("milk and yogurt here, this seems to be dairy") and tells you where it is heading and
why. At home it goes to where such things usually live, the counter, the table, the fruit
bowl, the fridge, and rules each one out as it checks it. The two settings never mix: Aisle
Be There will not look for a kitchen counter in a supermarket.

When the camera has nothing, it explores. It remembers every spot it has already looked from,
every heading that turned out blocked and every shelf it has ruled out, picks the direction
it has not covered yet, tells you it is about to move, walks you a short leg with the depth
model vetoing every step, and looks again. You can steer it in plain words: "explore", "next
aisle", "there is an opening in front of me, can I go that way". The whole time a language
model narrates what it sees and where it thinks the item is, in fifteen words or fewer.

At the end it guides your hand. "Reach out left, at chest height." "Higher." "Touching."
Then it asks you to confirm, because only you can. Aisle Be There never says it found
something the camera has not seen, and never counts a shelf as empty until it has actually
looked at it.

Everything is voice, sound and touch. A blind person never has to look at the screen.

## How it is built

Aisle Be There is an Expo SDK 57 development build in TypeScript with a Swift perception
module of our own, and a small Node proxy that holds every API key so nothing secret ever
ships in the bundle.

Perception runs in three layers. On the phone, ARKit gives position and heading ten times a
second, two YOLO nano detectors (COCO and Open Images) alternate frames to cover about two
hundred object classes, Depth Anything gives a three by three nearness grid, Apple's Vision
framework reads signs at full resolution, and a hand pose model follows the user's hand
during a reach. In the cloud, Claude answers a strict JSON question about each frame: where
the item is, what is blocking it, which openings lead somewhere, what the sign in front of
you says and what section this is. Two lanes: Claude Haiku 4.5 on a 768 pixel frame for the
fast look around, Claude Sonnet 5 on a 1280 pixel frame when a candidate needs verifying or
a shelf band needs a careful read. NVIDIA Nemotron turns what you said into a structured
task and a plan of steps. ElevenLabs gives the app its voice in both directions.

The decisions live in plain TypeScript with tests, not in a prompt. A model may propose and
explain; the app validates. Geometry owns the walk once the item is in view: the bearing to
a box comes from its position in the frame and the distance from its apparent height against
a known real height, which becomes "eleven o'clock, two steps" because clock faces and steps
are what a blind person can act on.

Memory keeps the search from going in circles. A session map with 1.5 metre cells records
where the phone has stood, which headings turned out blocked, and "not on this table" marks
tied to a world position, so a pan away and back does not restart the search. A trip graph
records places, signs, sections and openings along walked edges and can route you back to a
remembered aisle. Absence is only claimed when the camera actually looked.

Speech is engineered like a control signal. Every line is twelve words or fewer, digits are
spoken as words, one voice speaks at a time, and a lint runs over every string the app can
say and fails the build on a forbidden word. Cached ElevenLabs clips play the common lines
instantly; the model's own sentences are spoken live.

We debugged from traces, not guesses. The phone posts every decision, every model answer and
every voice capture to the proxy, and each field failure became a replay test with the exact
utterance from the log.

## What is in this repository

| Path | What |
|---|---|
| [`aisle/`](aisle/) | The app: the Expo development build (React Native, TypeScript), the Swift `Perception` module (ARKit, Core ML, Vision OCR), and the Node proxy that holds every API key. Its own [README](aisle/README.md) has the full run instructions. |
| `00-PROJECT-BRIEF.md` … `11-PHASE-0-CHECKLIST.md` | The plan of record: brief, shared contracts, one document per track, integration and demo script, sponsor stack, roadmap and concerns, the perception module, the CV training track. `00` is the place to start. |
| [`archive/`](archive/) | Superseded v1 planning documents, kept for history and not built from. |

Engineering notes written as the work happened live in `aisle/`:
[`HANDOFF.md`](aisle/HANDOFF.md), [`IMPLEMENTATION-STATUS.md`](aisle/IMPLEMENTATION-STATUS.md),
[`GROCERY-SEARCH-DIAGNOSTICS.md`](aisle/GROCERY-SEARCH-DIAGNOSTICS.md) and the other
checkpoint files.

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

## Challenges we ran into

A schema keyword the vision API did not support turned every camera question into a silent
400 for hours; the app looked slow when it was actually blind. We added a boot check that
says "vision ready" or "VISION BROKEN" out loud.

The speech rules bit us. A thirteen word line was dropped by the validator, so the app said
nothing, and a blind user hears nothing as "stuck". Now long lines are trimmed instead of
thrown away.

Latency shapes everything. A frame answered five seconds later describes where the camera
was, not where it is, so each observation is tied to the pose at capture time and never
steers if the person has turned more than twenty five degrees since.

The doorway you are standing in is not a landmark. When a tester stood in a doorway with an
unexplored room ahead, the exit logic waited for a model to box a door and repeated "no exit
confirmed" for a minute. The fix was to let unvisited floor count as a way out.

Context is everything. The same "bananas" request in a store once ran the home logic and went
looking for a countertop. Now the setting is sticky when the user states it, unknown when
nobody knows, and home priors never drive a store search.

## What's next

Faster observation, so the camera is answered in under two seconds and the loop stops
fighting the clock. Real store walks with blind testers and orientation and mobility
instructors. Store maps that persist across visits and a shared layer where one shopper's
signs and sections help the next. Metric depth on LiDAR phones and the ultra wide lens,
while keeping the plain iPhone as the baseline. Checkout and the walk back to the door. And
Android.

## Team

Four students at SteelHacks XIII, working in parallel tracks: core shell and voice, outdoor
routing and crossings, perception and indoor search, harness and demo. The commit history
carries the names.
