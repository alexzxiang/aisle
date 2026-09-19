# 04 — Agent C: Indoor Vision & Guidance

**You own the hardest and most valuable part of the project.** Indoor
goal-directed guidance from a monocular phone camera is what makes this more
than a GPT wrapper. Budget your time accordingly — this is where the demo is won.

**Owns:** `src/indoor/`, `server/`
**Never touches:** `src/core/`, `src/outdoor/`, `src/transition/`

---

## Core insight: we are not doing SLAM

We have no floor plan, no GPS indoors, and no depth sensor. We are **not**
solving indoor localization in the general case. Instead:

> The store is pre-mapped as an **ordered list of aisles**. The camera's only
> job is to answer "which aisle sign am I looking at right now?" Navigation is
> then just comparing the current aisle's `order` to the target's `order`.

Relative, not absolute. No coordinates, no drift, no dead reckoning. This is why
the approach is buildable in days, and it's the design decision to defend if a
judge asks how you localize indoors.

---

## Task 1 — Vision proxy (`server/`)

Small Express server. Two jobs: keep the API keys off the device, and normalize
the vision response. **Vision backend is NVIDIA Nemotron Nano 2 VL** via the NIM
endpoint — read `07-SPONSOR-STACK.md` §1 before writing any of this.

```
POST /api/vision   { jpegBase64, storeId, targetAisleId, knownSigns[] }
→ VisionResult (see contracts §7)

GET  /api/route    (Agent B adds this here — coordinate, one server only)
```

Never ship the key in the app bundle. Also add a `/api/health` endpoint — on
demo day you want a one-second way to check the backend is alive.

---

## Task 2 — The vision prompt (get this right before anything else)

Send one downscaled frame with a prompt that returns **strict JSON only**.

**Nemotron-specific notes:**
- Nemotron Nano 2 VL tiles images to 512×512 internally, so send **≤1024 px
  wide, JPEG quality ~60**. Larger buys nothing and costs latency.
- Set `temperature: 0` — you want deterministic sign reading, not creativity.
- Set `max_tokens: 200`. The JSON is small; a high cap only invites rambling.
- Nemotron Nano 2 VL is a reasoning model. If it emits visible reasoning before
  the JSON, add `"Respond with the JSON object and nothing before or after it."`
  and extract the last `{...}` block as a fallback.
- It leads OCRBench v2, so sign reading is its strength — lean on `signText`
  accuracy and keep `alignmentOffset` as a lower-confidence secondary signal.

```
You are reading a single frame from a phone camera held by a blind shopper
walking down a grocery store aisle.

Known aisle signs in this store: {knownSigns}
They are trying to reach: {targetAisleId}

Return ONLY a JSON object, no prose, no markdown fences:
{
  "signText": string|null,        // any aisle number or category sign clearly visible
  "matchedAisleId": string|null,  // best match from the known list, else null
  "matchedLandmarkId": string|null, // e.g. "checkout" if a checkout sign is visible
  "hazard": "NONE"|"OBSTACLE_AHEAD"|"PERSON_AHEAD"|"CART_AHEAD",
  "hazardDirection": "LEFT"|"CENTER"|"RIGHT"|null,
  "alignmentOffset": number|null, // -1 drifting left of aisle centre .. +1 right
  "confidence": number            // 0..1, your certainty in signText
}

If you cannot read a sign clearly, return null rather than guessing.
Do not describe the scene. Do not add commentary.
```

Then in code:

- Strip markdown fences defensively before `JSON.parse` — models add them even
  when told not to.
- Wrap parsing in try/catch; on failure return a `confidence: 0` result rather
  than throwing. A single malformed response must never crash the nav loop.
- **Discard any result with `confidence < 0.5`.** Acting on a hallucinated aisle
  number is worse than staying silent.

---

## Task 3 — Capture loop (`src/indoor/camera.ts`)

- `expo-camera`, capture one frame every **2 seconds**. Never faster — you'll
  burn quota and add jitter with no usability gain.
- Hard 4-second timeout per call. On timeout, **drop the frame and move on**;
  do not queue. Stale guidance is worse than no guidance.
- Skip capture entirely while a previous call is in flight (single-flight).
- Track rolling success rate in `DebugPanel`. If it drops below ~70% in the
  venue, your lighting or framing assumptions are wrong and you need to know
  before the demo, not during.

---

## Task 4 — Navigation logic (`src/indoor/navigator.ts`)

State: `currentAisleOrder` (from last confident match), `targetOrder` (from store map).

```
if currentAisleOrder === null          → "Keep walking forward"  (INFO, cooldown 15s)
if currentOrder <  targetOrder         → "Keep going forward"    (NAV, cooldown 12s)
if currentOrder >  targetOrder         → "You've passed it, turn around" (NAV)
if currentOrder === targetOrder        → emit TARGET_AISLE_REACHED
```

On `TARGET_AISLE_REACHED`:

```ts
haptics.play('CONFIRM');
speech.say({ text: `Dairy aisle. Eggs on your ${side}.`, priority: 'NAV' });
```

Note the utterance is six words. Resist every temptation to make it a sentence.

**Win condition is aisle-level.** Do not attempt to locate the specific product
on the shelf — shelf-level detection in cluttered retail is where academic
systems still fail, and it will eat your entire remaining time. "Eggs on your
right" is the correct, honest, demoable endpoint.

---

## Task 5 — Aisle alignment haptics

Feed `alignmentOffset` into Agent A's shared alignment service so the user can
walk down the centre of an aisle without drifting into shelves:

```ts
haptics.startAlignment(() => (lastResult.alignmentOffset ?? 0) * 45);
```

(Scaling offset to a pseudo-degree error lets you reuse Agent A's identical
hot/cold ramp — same vocabulary the user already learned outdoors. That reuse is
deliberate: one learned pattern, two contexts.)

Because vision updates only every 2 s, **interpolate or hold** the last value
between frames rather than letting pulses stop and start. Choppy alignment feels
broken even when it's correct.

---

## Task 6 — Hazard alerts

On `hazard !== 'NONE'` with confidence ≥ 0.6:

```ts
haptics.play('STOP');
speech.say({ text: 'Cart ahead.', priority: 'CRITICAL', interrupt: true });
```

Keep these to two words. Be aware of the honest limitation: at a 2-second
capture interval this is **not** reliable real-time collision avoidance, and you
should not describe it as such. It's a supplementary cue on top of a cane, and
that's how the demo script should frame it.

---

## Task 7 — Checkout navigation

Reuse everything above with `targetLandmarkId = 'checkout'`. The checkout is
just another pre-mapped landmark with sign text — no new capability needed.
On detection, emit `CHECKOUT_REACHED` and speak: `"Checkout ahead."`

Do **not** build open-lane or queue-length detection. Dynamic scene analysis of
moving people is a different and much harder problem, and guiding someone to the
checkout *area* is the complete, honest deliverable.

---

## Task 8 — Store mapping (do this physically, early)

Walk the demo venue once with a teammate. Record:

- every aisle sign's exact text and order
- checkout sign text
- lighting conditions and sign height (affects how the phone must be held)

Write it into `fixtures/stores/<storeId>.json` per contracts §6. Then **record
video walking the full route** and hand it to Agent D for the replay fixtures.
That recording is your insurance policy: if live vision misbehaves on demo day,
the replay path still tells the whole story.

---

## Definition of done

- [ ] Proxy running, NVIDIA + ElevenLabs keys server-side only, `/api/health` responds
- [ ] Nemotron returns parseable JSON ≥90% of the time on real venue frames
- [ ] Reasoning-preamble fallback (last `{...}` block) tested
- [ ] NIM free-tier credit checked before demo day — do not run out mid-pitch
- [ ] Fence-stripping and try/catch verified against a deliberately malformed response
- [ ] Results under 0.5 confidence discarded, never spoken
- [ ] Capture holds at one frame per 2 s with single-flight enforcement
- [ ] Aisle progression works forward, backward, and on overshoot
- [ ] Alignment haptics feel continuous despite 2 s vision cadence
- [ ] Demo venue mapped to JSON and route video recorded for Agent D
