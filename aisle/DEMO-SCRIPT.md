# Aisle — the three-minute run

Written for whoever is holding the phone and whoever is talking, at the table and on
stage. Stream D owns this file. Every line in **bold** is said *to the phone*; every
line in quotes is what the phone says back, verbatim from the cached phrase table
(`src/core/phrases.ts`), so you can tell a wrong answer from a slow one.

Rehearse it twice before judging opens. If a beat misses, the fallback under it keeps
the run moving — never restart the app in front of a judge.

---

## Before the clock

| Check | How | If it fails |
|---|---|---|
| Proxy up | `curl http://<mac-ip>:8787/api/health` — Anthropic, NVIDIA, ElevenLabs green | Templates still answer; say so once, do not debug on stage |
| Phone on the proxy | Home banner does **not** read "Offline…" | Same Wi-Fi as the Mac running Metro, or set `EXPO_PUBLIC_PROXY_URL` |
| Headphones in | Open-ear or bone-conduction, both ears free | The room will not hear the beat; use the speaker and stand close |
| Body offset set | Settings → walk straight five seconds | The COURSE buzz will be biased; skip the walking beat |
| Battery, thermals | > 50 %, phone not already warm | The camera schedule downshifts and the demo slows |
| Backup phone | Second device, `EXPO_PUBLIC_MOCK=1`, parked on Home | Hand it over mid-run rather than explaining |

Stand where the camera sees something with a name: a kitchen, a doorway, a corridor.
A blank wall gives the awareness loop nothing to be right about.

---

## 0:00 — Open the app. Say nothing.

This beat sells itself; do not talk over it.

The camera comes up from launch. Within about ten seconds:

> "You are looking at a person opening a refrigerator in a kitchen."

and within thirty:

> "You seem to be in a kitchen by a refrigerator. Correct?"

**"Yes."**

> "Got it."

**What to say while it runs:** every frame stayed on the phone. Only a 512-pixel
still reached Claude, and only because the app had a question.

**If nothing is known after twenty seconds** the phone asks "Turn slowly. Show me
your surroundings." — turn slowly, and let the judges watch it settle. That is the
honest failure mode, and it is worth showing.

**Fallback:** say **"I'm in the kitchen"** unprompted. The scene becomes the user's
own words and the rest of the run is unaffected.

---

## 0:25 — The guided task

**"Find the eggs in my fridge."**

> "Eggs in my fridge. Got it."
> "Let me see your surroundings."

One description, then the first step inside about ten seconds:

> "Walk to the kitchen door frame."

Walk it. At each step the camera checks the step rather than the room, and a
micro-hint lands when it helps:

> "Fridge door, pull handle down."

Open the door. Two confident readings close the step: one CONFIRM tap, then

> "Step done."

Say **"next"** to move on by hand if a step hangs; **"repeat"** re-speaks it;
**"stop"** ends the task and returns to Home. Last step:

> "Done. Task complete."

**What to say while it runs:** Nemotron planned the steps from what the camera had
already seen, not from a generic recipe; Claude confirms each one. The phone gives
one instruction at a time because a blind user cannot skim a list.

**Fallback:** every step advances on **"next"**. A task that plans but never
confirms still demos end to end — drive it by voice and say that the camera check is
the part that is new.

---

## 1:25 — Take me somewhere

**"Take me to the CVS on Forbes."**

> "CVS. Got it."
> "Let me see your surroundings."
> "Planning your route."

The proxy searches OpenStreetMap near the current fix, ranks the Forbes Avenue
address ahead of the nearer Centre Avenue one, and the trip starts. Walk a few
steps holding the phone upright:

- Facing the leg: **silence**. Turn thirty degrees off it and the COURSE buzz grows.
  Turn back and it stops. Silence is the reward — hand the phone to a judge and let
  them feel it.
- At a turn: "Turn right now" and the TURN pattern, three rising pulses.
- Arriving: "You have arrived."

**What to say while it runs:** four haptic patterns, total — COURSE, TURN, STOP,
CONFIRM. Anything with under five seconds to act is decided on the phone and lands
as a buzz in under 150 milliseconds. Speech never stands between the user and a
hazard.

**Fallback (expect this one):** Google Routes is not enabled on the project yet, so
the phone says

> "No route data. Heading straight to the store."

and walks a straight-line leg to the pin. Everything else — perception, haptics,
the store handoff — still runs. Say the sentence out loud before the phone does:
"routing is one console switch away; here is the degraded leg, and it still walks."

---

## 2:35 — Close

Three sentences, then stop talking.

1. **What it is.** A phone-only navigation aid that covers the two moments other
   apps skip: the crossing and the walk through the door into a store nobody
   surveyed.
2. **What it refuses to do.** It reads the walk signal, reports the vehicles it can
   see, and states its own field of view — and it never tells anyone when to cross.
   The only peer-reviewed test of a general vision model judging crossing risk for
   blind travellers scored 25 %. That is why the decision stays with the user.
3. **Who it is for.** Accessible pedestrian signals exist at about 5 % of New York's
   signalized intersections. The average blind traveller drifts five metres over a
   22-metre crossing and ends outside the crosswalk 60 % of the time without a
   far-side cue, 26 % with one.

---

## The crossing beat (only if you have a real curb and time)

Not in the three-minute run. If a judge asks to see it, walk to a signalized crossing
and show the ladder honestly:

| Rung | What runs | State today |
|---|---|---|
| 1 | On-device pedestrian-signal model, 15 fps | **Not built** — no weights, no training data |
| 2 | Claude reads a curb crop | Works: DON'T WALK and COUNTDOWN at 0.85 on real photos, 2.8–3.5 s |
| 3 | Curb alignment + map awareness only | Always available |
| 4 | Manual signal state from the DebugPanel | Always wired |

The demo runs at rung 2 or 3. Say that plainly: the app announces "Signal read is
delayed" on the fallback rung because a stale reading that pretends to be fresh is
the one failure that could hurt somebody.

At the curb the app is near-silent on purpose — the user needs to hear traffic.

---

## The architecture slide

```
                       ONE STANDARD iPHONE  (Expo SDK 57, no LiDAR, no Pro)
  ┌──────────────────────────────────────────────────────────────────────────┐
  │  PerceptionModule — Swift, ARKit world tracking. Owns the camera alone.   │
  │  pose 10 Hz · YOLO11n COCO · Depth Anything V2 · Apple Vision OCR         │
  │                                                                          │
  │            TIER 0 — on device, always. frame ─▶ haptic < 150 ms           │
  └───────────────────────────────┬──────────────────────────────────────────┘
                                  │  events (never pixels)
  ┌───────────────────────────────▼──────────────────────────────────────────┐
  │  src/core — one event bus, one store, twelve modes                        │
  │  IDLE ▸ OUTDOOR_NAV ▸ APPROACH_CROSSING ▸ AT_CURB ▸ CROSSING ▸            │
  │  TRANSITION ▸ INDOOR_NAV ▸ AT_ITEM ▸ CHECKOUT_NAV ▸ DONE                  │
  │                                                                          │
  │  HAPTICS carry real-time signals   ·   SPEECH carries meaning             │
  │  COURSE · TURN · STOP · CONFIRM        ≤ 12 words, 4 s apart              │
  └───────────────┬──────────────────────────────────┬───────────────────────┘
                  │ a still, only when asked         │ text only
  ┌───────────────▼──────────────┐   ┌───────────────▼───────────────────────┐
  │ TIER 1 — Claude Haiku 4.5    │   │ TIER 2 — NVIDIA Nemotron              │
  │ slack-tolerant semantics     │   │ the decision layer, never the eyes    │
  │ where am I · which aisle ·   │   │ route compile · parse intent ·        │
  │ read this curb · task step   │   │ disambiguate · judge the crossing     │
  └───────────────┬──────────────┘   └───────────────┬───────────────────────┘
                  └──────────────┬───────────────────┘
                   ┌─────────────▼─────────────┐
                   │  PROXY — Node, us-east    │   Keys never ship in the app.
                   │  ElevenLabs Flash v2.5    │   81 phrases cached on device;
                   │  every word you hear      │   live synthesis only for names.
                   └───────────────────────────┘

  NOTHING TIME-CRITICAL EVER WAITS ON A NETWORK.  Offline: Tier 0, haptics and
  cached speech keep working; cloud calls fail closed to silence, never to a guess.
```

**The two sponsor sentences, if asked:**

- *NVIDIA* — Nemotron is the decision layer, not the eyes. It never touches an
  image: it compiles routes into twelve-word legs, parses what the user asked for,
  resolves "dairy" to an aisle, and judges which OpenStreetMap node is the crossing.
  Numbers are in [`server/routes/plan.eval.md`](server/routes/plan.eval.md).
- *ElevenLabs* — every word the user hears is Flash v2.5, cached on the phone for
  the closed phrase set and streamed for anything variable; Scribe covers speech
  recognition in store noise. Speech beats a screen here because the user cannot see
  one, and their hands hold a cane and a phone.

---

## If something breaks mid-run

| Symptom | Do this, out loud |
|---|---|
| Phone says nothing for ten seconds | "It stays quiet when it has nothing true to say." Then press **Describe surroundings**. |
| Wrong scene guess | Say **"no"**, then tell it: **"I'm in the hallway."** The correction *is* the feature. |
| A step will not confirm | Say **"next"**. |
| Route fails | Expected today; the straight-line leg still walks. |
| Anything worse | Hand over the backup phone in mock mode and keep talking. The same build replays the whole run from fixtures. |

Never say the app is certain. It is a prototype supplement to a cane or guide dog,
it says so out loud on first launch, and that sentence is the most important one in
the pitch.
