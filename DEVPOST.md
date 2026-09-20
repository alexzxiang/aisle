# Aisle Be There: Devpost submission

Copy each section into the matching Devpost field. The prose avoids hyphens on purpose.

## 1. Elevator pitch (200 characters)

Aisle Be There turns one ordinary iPhone into a blind shopper's guide: it reads the aisle signs, reasons like a friend about where the bananas are, walks you there and puts them in your hand.

## 5. Project description (150 characters)

An iPhone app that guides blind shoppers through unmapped grocery stores and their own kitchens to the item they asked for, and into their hand.

## 2. About the project

## Inspiration

Ask a blind person about grocery shopping and you hear the same story. The store offers a helper, if you can find one and are willing to wait. Delivery apps work until you need one thing tonight. Navigation apps get you to the door and then go quiet, because nobody has mapped the inside of a Giant Eagle and the layout changed last Tuesday anyway. The aisle sign is three metres over your head. The bananas are somewhere in a room the size of a football field, and the eggs at home are behind the milk.

We kept asking one question. How far can one ordinary iPhone get, with no glasses, no LiDAR and no wearable, if we treat the camera the way a sighted friend treats their eyes: look, say what you see in a few plain words, reason about where the thing probably is, walk, and never claim to be sure when you are not?

Grocery stores were the test we set ourselves because they are the hardest case. Nobody has mapped them, the shelves change weekly, and the thing you want is one of ten thousand nearly identical boxes. If the approach works there, it works in a kitchen too, so Aisle Be There does both.

## What it does

You hold the talk button and say what you need. "Find the bananas." "I am in a grocery store, help me find the pasta." "Get the eggs from my fridge."

If the item is already in view, geometry takes over immediately: "Bananas at eleven o'clock, two steps." Aisle Be There locks on with the phone's own detectors and walks you in.

If it is not in view, the app reasons the way a person would. In a store it thinks by section: bananas belong in produce, pasta near the sauces, milk in dairy. It reads the overhead signs with the phone's own OCR, notices what is actually on the shelves in front of you ("milk and yogurt here, this seems to be dairy") and tells you where it is heading and why. At home it goes to where such things usually live, the counter, the table, the fruit bowl, the fridge, and rules each one out as it checks it. The two settings never mix: Aisle Be There will not look for a kitchen counter in a supermarket.

When the camera has nothing, it explores. It remembers every spot it has already looked from, every heading that turned out blocked and every shelf it has ruled out, picks the direction it has not covered yet, tells you it is about to move, walks you a short leg with the depth model vetoing every step, and looks again. You can steer it in plain words: "explore", "next aisle", "there is an opening in front of me, can I go that way". The whole time a language model narrates what it sees and where it thinks the item is, in fifteen words or fewer.

At the end it guides your hand. "Reach out left, at chest height." "Higher." "Touching." Then it asks you to confirm, because only you can. Aisle Be There never says it found something the camera has not seen, and never counts a shelf as empty until it has actually looked at it.

Everything is voice, sound and touch. A blind person never has to look at the screen.

## How we built it

Aisle Be There is an Expo development build in TypeScript with a Swift perception module we wrote ourselves, and a small Node proxy that holds every API key so nothing secret ever ships in the bundle.

Perception runs in three layers. On the phone, ARKit gives us position and heading ten times a second, two YOLO nano detectors (COCO and Open Images) alternate frames to cover about two hundred object classes, Depth Anything gives a three by three nearness grid, Apple's Vision framework reads signs at full resolution, and a hand pose model follows the user's hand during a reach. In the cloud, Claude answers a strict JSON question about each frame: where the item is, what is blocking it, which openings lead somewhere, what the sign in front of you says and what section this is. We run two lanes: Claude Haiku 4.5 on a 768 pixel frame for the fast look around, and Claude Sonnet 5 on a 1280 pixel frame when a candidate needs verifying or a shelf band needs a careful read. NVIDIA Nemotron turns what you said into a structured task and a plan of steps.

The decisions live in plain TypeScript with tests, not in a prompt. A model may propose and explain; the app validates. Geometry owns the walk once the item is in view. The bearing to a box comes straight from its position in the frame,

$$\beta = \left(c_x - \tfrac{1}{2}\right)\,\theta_{\text{hfov}},$$

and distance from its apparent height against a known real height, with the focal length in normalized units,

$$d \approx \frac{H\,f}{h}, \qquad f = \frac{1}{2\tan(\theta_{\text{hfov}}/2)},$$

which becomes "eleven o'clock, two steps" because clock faces and steps are what a blind person can act on.

Memory is what keeps the search from going in circles. A session map with 1.5 metre cells records where the phone has stood, which headings turned out blocked, and "not on this table" marks tied to a world position, so a pan away and back, or a second visit to the same table from the other side, does not restart the search. A trip graph records places, signs, sections and openings along walked edges, and can route you back to a remembered aisle. Absence is only claimed when the camera actually looked: the detector staring at a surface for three seconds without firing is a reason to move on, and a shelf band is only cleared when the model says it inspected it.

Speech is engineered like a control signal. Every line is twelve words or fewer, digits are spoken as words, one voice speaks at a time, and a lint runs over every string the app can say and fails the build on a forbidden word. Cached ElevenLabs clips play the common lines instantly; the model's own sentences are spoken live.

We debugged from traces, not guesses. The phone posts every decision, every model answer and every voice capture to the proxy, and each field failure became a replay test with the exact utterance from the log.

## Challenges we ran into

A schema keyword the vision API did not support turned every camera question into a silent 400 for hours; the app looked slow when it was actually blind. We added a boot check that says "vision ready" or "VISION BROKEN" out loud.

The speech rules bit us. A thirteen word line was dropped by the validator, so the app said nothing, and a blind user hears nothing as "stuck". Now long lines are trimmed instead of thrown away.

Latency shapes everything. A frame answered five seconds later describes where the camera was, not where it is, so we had to attach each observation to the pose at capture time and refuse to steer by it if the person had turned more than twenty five degrees since. Then we found the loop starving itself: walking legs made every frame stale, so the app kept asking for "a current view" and paused.

The doorway you are standing in is not a landmark. When a tester stood in a doorway with an unexplored room ahead, the exit logic waited for a model to box a door and repeated "no exit confirmed" for a minute. The fix was to let unvisited floor count as a way out.

Context is everything. The same "bananas" request in a store once ran the home logic and went looking for a countertop. Now the setting is sticky when the user states it, unknown when nobody knows, and home priors never drive a store search.

And the human parts: a fridge door is a featureless white wall to ARKit, a blind tester cannot tell you which voice made a mistake, and five people pushing to one repository in twenty four hours meant merging each other's ideas about the same forty lines several times a night.

## Accomplishments that we're proud of

The whole thing runs on a phone anyone already owns. Position, detection, depth, OCR and hand tracking all run on the device at the same time without a Pro model.

The split we ended up with feels right: the language model owns the voice while exploring and may suggest where to go, computer vision owns the lock on once the item is in sight, and the depth grid can veto anyone. This is the first version that moves on its own when the camera has nothing to offer, and stops the moment the depth grid says so.

Honesty is enforced by tooling, not by hoping. No build can ship a sentence the speech rules forbid, and Aisle Be There cannot announce an item the camera has not seen.

Fourteen hundred automated tests, including replays of real field failures typed exactly as the tester said them, and a trace channel that let us fix bugs we never saw happen.

## What we learned

Vision language models are superb observers and poor controllers. Ask them what they see and let code decide what to do with it.

For a blind user, silence is the worst output. Every state needs a sentence, every sentence needs an action, and the pacing of speech is part of the interface.

Latency is not a number to report, it is a physical constraint on the control loop. Five seconds of inference means a walking person has moved two metres, and the software has to know that.

Memory of what you have already checked matters more than a smarter guess about where to look next.

And the last one: context first. The most confident search in the world is useless if it thinks a grocery store is a kitchen.

## What's next for Aisle Be There

Faster observation: a compact schema and a shorter prompt for the fast lane, so the camera is answered in under two seconds and the loop stops fighting the clock. Real store walks with blind testers and orientation and mobility instructors, with the trace channel recording every decision. Store maps that persist across visits, so the second trip starts with what the first one learned, and a shared layer where one shopper's signs and sections help the next. Metric depth on LiDAR phones and the ultra wide lens for the search, while keeping the plain iPhone as the baseline. Checkout and the walk back to the door. And Android, so the phone in a person's pocket is the phone that helps them.

## 3. Built With (25 tags)

TypeScript, Swift, React Native, Expo, Node.js, Express, ARKit, Core ML, Apple Vision, Apple Speech Recognition, Anthropic Claude, NVIDIA Nemotron, NVIDIA NIM, ElevenLabs, Ultralytics YOLO, Open Images, PyTorch, Python, Depth Anything, Zod, Jest, Vitest, Zustand, NVIDIA Brev, WebSockets

## 4. Generative AI

Yes, in three places, each behind a contract the app enforces.

Claude (Haiku 4.5 and Sonnet 5 through the Anthropic API) is the camera's understanding. The phone's detectors know about two hundred object classes; a grocery store has ten thousand products, signs, gaps between shelves and doorways, and only a vision language model can say "that carton is eggs", "the sign here reads Dairy" or "there is an opening with floor beyond it on your left". Each frame is answered as strict JSON against a schema: item box, barrier, sign, section, up to four landmarks with boxes, a strategy (promising, unlikely, unknown) and one short sentence of speech. We run Haiku as the fast lane and Sonnet as the verifier. The app validates every answer, geometry takes over once the item is in view, and a model can never make Aisle Be There announce an item the camera has not confirmed.

NVIDIA Nemotron (through NVIDIA NIM) turns spoken requests into structured tasks and step plans, with a template fallback if it misses its deadline.

ElevenLabs gives the app its voice in both directions: low latency speech for the sentences the app composes live, cached clips for the common lines, and speech recognition with the item vocabulary as key terms.

We used generative models because the problem is open world. We constrained them because the user is blind and the model cannot see the consequences of being wrong.

## 6. Technology feedback

**Anthropic Claude (Haiku 4.5 and Sonnet 5).** The strongest piece of our stack, and the one we leaned on hardest. Structured output against a JSON schema is exactly what a safety minded app needs: we could ask for an item box, a barrier, the sign, the section and up to four openings, and get back something code can validate. Two things cost us. First, one unsupported schema keyword (minItems) turned every vision call into a 400 for hours, and the error surfaced only in the proxy log; a schema validation endpoint, or a warmup call that fails loudly, would have saved us an afternoon. Second, latency: Sonnet answered a 768 pixel frame in about five and a half seconds at the median, and Haiku on the same prompt was not much faster (about five seconds), so the time is in the prompt and the output, not the model. For a walking user five seconds is two metres. We would love a mode tuned for short structured answers on small images.

**NVIDIA Nemotron on NIM.** Fast and dependable for turning speech into structured tasks and plans, and free credits made it an easy choice. Rate limits on the free tier arrived without much warning, so we ended up with a second key, a deadline race and a template fallback. A clearer view of remaining quota in the response headers would have let us plan instead of react.

**NVIDIA Brev.** The credits were generous and the setup was simple enough that one of us could prepare an Open Images fine tuning job in an hour. The weekend's hours went to the search logic instead, so the phone still runs the stock export. That is on us; the platform did what it promised.

**ElevenLabs.** The voice is the reason the app feels like a companion rather than a screen reader, and cached clips (we generated about five hundred) play instantly. Scribe's key terms kept item names accurate. Two wishes: streaming recognition that returns a one word answer ("yes") without waiting for silence, and a lighter path for very short live sentences, because a twelve word instruction is still worth several hundred milliseconds of synthesis when the person is mid step.

**Expo SDK 57 with a development build and a local Swift module.** Writing our own perception module in Swift and bridging it through Expo's local modules worked better than we expected, and the development client was the right call. The friction was churn: the SDK has changed enough that every coding assistant on the team kept reaching for last year's APIs, and we had to pin them to the versioned documentation. Native changes need a clean rebuild, which is slow when you are iterating on Core ML models.

**Apple ARKit, Core ML and Vision.** On a plain iPhone 16 we ran pose tracking, two YOLO nano detectors, a depth model, full frame OCR and hand tracking at the same time, and the thermal state only reached serious after long sessions. Vision's OCR reads overhead store signs far better than any cloud call on a downscaled frame. The limits we hit were hardware truths rather than bugs: no metric depth without LiDAR, no ultra wide camera inside an ARKit session on this phone, and tracking that wobbles on featureless surfaces like a white fridge door.

**Ultralytics YOLO and Open Images.** Exporting to Core ML with built in NMS was one command, which is why we could run two detectors at all. The stock Open Images nano is spread thin across six hundred classes, so per class quality on the things a home is made of (doors, countertops, drawers) is modest; the narrowing job we prepared for Brev is the fix.

**GitHub and GitHub Actions.** Five people on one repository for twenty four hours with a small CI kept us honest. The one surprise was the 100 MB file limit rejecting our demo video at the last minute; a friendlier nudge toward LFS before the push would help hackathon teams.

**Claude Code and Codex as teammates.** Both wrote large parts of this codebase overnight. What worked: tracing real failures back to code, writing replay tests from the exact words a tester said, and keeping documentation current. What needed a human: two agents will happily rewrite the same forty lines in opposite directions, and an agent will write a test that blesses its own behaviour. Read the diff, keep the field traces, and make the agents argue with the trace rather than with each other.

