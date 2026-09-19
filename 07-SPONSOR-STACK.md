# 07 — Sponsor Stack: NVIDIA Nemotron, ElevenLabs, Claude, and the proxy

Two sponsor tracks (NVIDIA Nemotron, ElevenLabs) plus Claude, which is not a sponsor but is
part of the stack. Owners: §1 Agent B (`server/routes/plan.ts`) with D; §2 Agent A
(`assets/audio/`, `src/core/`) with D (`/api/tts`, `/api/stt`); §3 Agent C (schema) with D
(`/api/vision`); §4 Agent D; §5 everyone, own lines. Schemas and cache keys are in
`01-SHARED-CONTRACTS.md` §3, §8, §9; rationale in `08-ROADMAP-AND-CONCERNS.md`.

One rule for all three providers: **nothing time-critical waits on the network.** Signal
state, vehicle STOP, haptics, the beacon and leg advancement are on-device
(`09-PERCEPTION-MODULE.md`). If the cloud is slow or down, the app runs on templates and
cached audio.

---

## §1 — NVIDIA Nemotron: the decision layer (Agent B + D)

### The track, quoted

"Beyond the Chatbot — Best Use of NVIDIA Nemotron": *"We have enough chatbots. Use NVIDIA
Nemotron for something else... routes requests, classifies something, judges another model's
output, makes a decision, or sits somewhere in a bigger pipeline."* Judges want *"some
evidence that it works: an eval, comparison, benchmark, or even a failure you found."* Three
winning teams; the track stacks with the others.

The pitch sentence: **Nemotron routes, classifies, judges and decides; it never chats; it is
never in the real-time path.** Load-bearing because every leg instruction, crossing
announcement and parsed request goes through it before the user walks; honest because nothing
safety-relevant depends on it and the eval shows exactly what it adds over the templates.

### Model and request shape

- Primary: `nvidia/nemotron-3.5-lightning-30b-a3b`. Fallback: `nvidia/nemotron-nano-3-30b-a3b`.
  **The spelling of both ids differs by surface** (build.nvidia.com sample, docs slug,
  `/v1/models`); the only authority is the authenticated `GET /v1/models` on day 0. Copy the
  exact strings from that response into the proxy config; never type them from memory.
- Endpoint: `https://integrate.api.nvidia.com/v1/chat/completions`, OpenAI-compatible. Send
  `max_completion_tokens` (the catalog sample uses it; the OpenAI SDK maps `max_tokens`).
- Thinking off: `chat_template_kwargs: { enable_thinking: false }`. Verify it is actually off
  (no reasoning field, no `<think>` prefix, first token is `{`). With thinking on, a small
  token cap is spent thinking and returns no JSON.
- Schema-bound output: `nvext: { guided_json: <strict schema> }`. Whether the hosted endpoint
  honours `nvext` for this model is not documented [verify on day 0]; probe it, and probe
  `response_format: { type: 'json_schema' }` as the alternative. Keep prompt-level "JSON only"
  plus a last-`{...}` extractor as the third line of defence.
- `stream: true`, always. **1.5 s first-token deadline** from request send; on miss the proxy
  returns the templated fallback with `fallback: true` and abandons the upstream request.
  Temperature 0 for repeatable wording.
- Failover: on 429 / 503 / connect error retry the **same model on OpenRouter** once, then the
  template. Confirm OpenRouter lists the model on day 0 [verify]; do not assume it.

### Jobs (schemas in `01-SHARED-CONTRACTS.md` §9)

| Job | What Nemotron does | Track verb | When | Owner |
|---|---|---|---|---|
| `routeCompile` | Turns Routes API steps + joined crossings into ≤12-word `soon / now / confirm` phrases and crossing announcements, numbers as words | routes / decides | once at route fetch, 8 s budget | B |
| `crossingAnnounce` | Picks which OSM node is on the path, signalized or not, push-button likely from WPRDC operation type | judges | route fetch | B |
| `parseIntent` | STT transcript → `{intent, item, reply}` | classifies | after push-to-talk | B (route), A (caller) |
| `disambiguate` | "dairy" vs "eggs" → aisle from the store map, or an ask-back | decides | item not in `itemIndex` | B (route), C (caller) |
| `answer` | "repeat / how far / where am I", re-plan after a missed turn | routes | on request | B |

What never waits on Nemotron: signal state, vehicle STOP, all haptics, the beacon, leg
advancement, the transition announcement, any crossing phrase already cached.

### Latency and the free tier

- Hosted latency is unpublished. Budget 0.7–1.5 s to first token, 1.5–4 s per ~100-token
  answer, a fat tail under load, occasional 429/503. Route-time jobs tolerate this; walk-time
  jobs are covered by the deadline.
- The free build.nvidia.com tier has **no credits**; limits are unpublished, per-model and
  load-dependent (commonly cited ~40 RPM). Read the limit in the account menu; count 429s in
  `/api/health`.
- New accounts can hit "Please contact support to verify your account" on key generation;
  resolution is by email and can take days. Make keys on two or three team emails now; keep a
  spare as `NVIDIA_API_KEY_FALLBACK` and rotate on 429.
- `routeCompile` and `crossingAnnounce` run once per route; their outputs are cached and
  pre-synthesized (§2) before the user walks.

### The eval artifact (Agent B, phase 3; cut last)

One page in the repo, linked from the README, one slide:

1. Intent accuracy on ~60 utterances (clean + noisy-ASR variants), per-intent confusion.
   Utterances live under `fixtures/plan/` (D's directory; B supplies the list).
2. Wording A/B: Nemotron leg phrases vs raw Google step text, rated blind by two teammates,
   plus the word-count distribution.
3. p50/p95 first-token and total latency per job schema, `nvext` acceptance rate, fallback
   rate. Report the failures: the track asks for them.

---

## §2 — ElevenLabs: speech out, speech in (Agent A + D)

### The track, quoted

"Out Loud — Best Project Built with ElevenLabs": *"ElevenLabs does text to speech, speech to
text, voice agents, dubbing, and sound effects. Use any of it."* Judges want *"voice or audio
as a real part of how your project works, not a feature bolted on"*, *"a demo we can hear.
Bring headphones in case the room is loud"*, and *"a sentence on why speech beats a screen
for your use case."* Perk: one month of Creator tier per participant; redeem it on the account
that holds the API key on day 0 (Flash concurrency 4 → 10, no non-commercial / attribution
constraint, more than 10× the credits).

The sentence: **"Our user cannot see the screen; speech and haptics are the interface, and
the app says at most twelve words at a time because the ears are busy with traffic."** Bring
wired open-ear headphones to the judging table.

### Model

`eleven_flash_v2_5` only. Turbo is deprecated; v3 Conversational is slower (~280 ms). Flash
does **no text normalization**: write numbers as words ("twenty feet"), expand abbreviations
("N Craig St" → "North Craig Street") in code before sending, and test with real Pittsburgh
street strings. Same `voice_id` and same model on both tiers or the seam is audible.

### Cache tier (build this first; `assets/audio/<cacheKey>.mp3`)

`scripts/generate-audio.ts` posts each phrase to `POST /v1/text-to-speech/{voice_id}` with
`model_id: 'eleven_flash_v2_5'`, default `voice_settings` (stability 0.5, similarity 0.75,
style 0), `output_format: 'mp3_44100_64'`, speed 1.0 (rate is applied on-device, below).
Batch four at a time on Free, ten on Creator. Run once, commit the files, re-run only when the
phrase table changes. Preload every file with `expo-audio` at app start.

Canonical text per cache key (keys from `01-SHARED-CONTRACTS.md` §3; every line ≤ 12 words
except the disclaimer, which is ≤ 12 s spoken):

```
disclaimer: Aisle is a prototype, not a safety device. Keep using your cane or guide dog.
  Aisle reads walk signals and warns about vehicles it can see; it cannot see everything
  and never decides when to cross.
compass_uncertain: Compass uncertain.   crossing_ahead_signalized: Crossing ahead. Signalized.
push_button_likely: Push button likely.   walk_signal_on: Walk signal on.
walk_already_on_wait: Walk already on. Wait for next.   dont_walk: Don't walk.
countdown: Countdown.   cant_see_signal: Can't see the signal.   far_curb: Far curb.
vehicle_left | vehicle_right | vehicle_ahead: Vehicle left. | Vehicle right. | Vehicle ahead.
no_signal_point_left: No signal here. Point the camera left.   now_right: Now right.
no_vehicles_left | no_vehicles_right: No vehicles seen to the left. | ... to the right.
listen_then_cross: Listen, then cross.
vehicle_approaching_left | _right: Vehicle approaching from the left. | ... from the right.
cant_see_well_left | _right: Can't see well to the left. | ... to the right.
turn_left_soon | turn_right_soon: Turn left in twenty feet. | Turn right in twenty feet.
turn_left_now | turn_right_now: Turn left now. | Turn right now.
entering_store: Entering the store. Looking for aisle signs.
keep_going: Keep going, looking for a sign.   passed_it_turn_around: You've passed it. Turn around.
checkout_ahead: Checkout ahead.   obstacle_ahead: Obstacle ahead.   tilt_camera_up: Tilt the camera up.
turn_left_a_little | turn_right_a_little: Turn left a little. | Turn right a little.
reach_out: Face the shelf. Reach out.   higher | lower | left | right | touching: one word each.
ask_staff: Ask staff for help finding it.   offline_notice: Offline. Signal reading and directions still work.
```

`crossing_ahead_signalized` is the street-less fallback; the street variant ("Crossing ahead:
Forbes. Signalized.") is live-tier, pre-synthesized at route load.

Onboarding needs its own cached lines ("This is turn", "This is stop", "This is confirm",
"Turn until the pulse is centered"); those keys are not in 01 §3 yet — Agent A flags the
addition there before generating them. Forbidden words (safe, clear, go, cross now, no cars,
you can cross) must not appear in any file; the generator script rejects them.

### Live tier (pre-synthesized at route load and store load)

Only text with runtime-variable words: leg phrases with street names (B, from
`routeCompile`), crossing announcements with a street, aisle labels (C). All are known when
the route or store map loads, so `POST /api/tts` synthesizes them then and caches the files
on the phone; **nothing is synthesized live during the walk.** For the rare true-live case
budget < 400 ms first audio measured on-device (~100–200 ms TTFB from a US client plus player
buffering; pin `api.us.elevenlabs.io`). React Native `fetch` cannot consume a chunked body:
a streamed utterance is played by pointing an `expo-audio` player at a proxy URL that pipes
the stream (progressive playback). That is also how the Claude → ElevenLabs relay (§3)
reaches the phone. On the TTS WebSocket send `flush: true` once the text is complete (the
default `chunk_length_schedule` will not emit a < 120-char utterance otherwise); the socket
closes after 20 s idle — keep-alive with a single space.

### Voice selection

1. Intelligibility over character: it competes with traffic and store noise.
2. A default or synthetic voice, not a Professional Voice Clone (slower to first audio).
3. Audition two or three candidates on one sentence, walking pace, noisy room, open-ear
   headphones. Regenerating ~40 phrases costs ~1k credits per voice; do not audition that way.

### Speaking rate

Generate at speed 1.0. `SpeechService.setRate(0.8–1.6)` applies `expo-audio`
`setPlaybackRate(rate, { pitchCorrectionQuality: 'high' })` at play time, so one file set
serves every setting; do not bake `voice_settings.speed` into the files. Screen-reader users
run fast: default 1.15, adjustable in settings.

### Speech in: Scribe as the STT fallback

Push-to-talk records 16 kHz mono with `expo-audio`, recording mode on only during the
utterance. Primary STT is on-device (`expo-speech-recognition`, dev build). Fallback in store
noise: `POST /api/stt` → ElevenLabs `POST /v1/speech-to-text`, `model_id: 'scribe_v2'`,
`keyterms` = the store's item and aisle vocabulary (keep it under 100 terms: 100+ triggers a
20 s minimum billable duration). A 3 s command costs ~17 credits. There is no React Native
SDK for TTS/STT; every call goes through the proxy. Keyboard dictation on a `TextInput` is
the zero-risk fallback under both.

### Fallback

Any `say()` without a cache entry and without network falls back to `expo-speech`; log it,
do not surface it. `expo-speech` is silent when the iPhone mute switch is on (`expo-audio`
is not) — check the switch before every run.

---

## §3 — Claude: Tier 1 semantics (Agent C + D)

Slack-tolerant questions only: storefront check, aisle disambiguation on OCR no-match /
two-match, the two unsignalized scan stills, active perception (`cameraRequest`,
`userAction`), item pick-up hints (stretch), and the curb-crop signal fallback rung. Claude
never decides signal state on the primary path and never gates a haptic. Shapes:
`01-SHARED-CONTRACTS.md` §8.

### Models

- `claude-haiku-4-5` (alias of the pinned snapshot) for the loop; no `thinking` field.
- `claude-sonnet-5` only for `curb_crop`, with `thinking: { type: 'disabled' }` and **no
  temperature / top_p / top_k** (Sonnet 5 returns 400 for non-default sampling and for
  assistant prefill). Check `stop_reason` before trusting output: `refusal` and `max_tokens`
  leave the parsed object null; the client then gets `{ confidence: 0 }`.
- Latency to plan on: Haiku TTFT ~0.66 s, ~2–2.5 s end-to-end for one frame + ~100 JSON
  tokens including upload and the proxy hop; Sonnet 5 thinking-off ~2.5–3.5 s. Streaming does
  not shorten the total; it lets `speech` be spoken ~1 s earlier.

### Image sizing and token cost

Images bill as 28-px patches, `ceil(w/28) × ceil(h/28)`: `snapshotJPEG(512)` → 512×384 =
**266 tokens** (default); `(640)` → 640×480 = **414** (when text must be read); `(1024)` →
1024×768 = **1036** (curb crop only). Nothing under 1568 tokens is downscaled. At Haiku's
$1 / $5 per MTok a 640×480 call is ~$0.0016 all-in (~700 prompt + ~100 output tokens); a
three-minute demo costs cents; an hour at 1 fps ~$6–8. JPEG quality 0.8 — heavy compression
hurts text. Image block before text. Send the on-device facts (detections, OCR, depth, signal
state) as text alongside; many turns then need no image.

### Structured outputs

`output_config.format` with `type: 'json_schema'`, `additionalProperties: false` on every
object, no numeric ranges or string lengths (unsupported). GA on both models; no fence
stripping. **One byte-stable superset schema** for every question: first use compiles a
grammar (extra latency), cached 24 h from last use, invalidated by any structural change. The
proxy warms each (model, schema) at start and on every mode change. Prompt caching is not
worth it on Haiku (4,096-token minimum prefix); on the Sonnet curb path a `cache_control`
breakpoint on the system prompt (1,024-token minimum) survives per-frame images.

### Streaming into ElevenLabs

`speech` is the first field in the schema. The proxy streams Claude, extracts `speech` as soon
as the string closes, opens the ElevenLabs WebSocket with `flush: true`, and relays audio to
the phone as `streamId = seq` (§2); the full JSON follows and is applied only if `seq` ≥ last
applied. Target first spoken word ~1.3–1.5 s: capture 30 ms + upload 150 ms + TTFT 650 ms +
first sentence 300 ms + TTS 200 ms. `max_tokens` ≤ 300, `maxRetries: 0`, proxy timeout 4 s,
≤ 3 in flight, freshness 3 s at crossings / 6 s indoors; stale results are dropped.

### Scene-change gating

Call only on scene change (frame difference or detector-state change) or user speech, never
on a timer in a time-critical mode. Caps: storefront ≤ 1 per 5 s; aisle disambiguation ≤ 1
per 4 s; `curb_crop` ≤ 1 per s; `hand_guidance` ~1 per 2 s, give up after 8; `cameraRequest`
/ `userAction` prompts ≤ 1 per 3 s, never while the COURSE buzz is active. Rate limits are not
the ceiling (Start tier: 1,000 RPM, 2M input tokens/min per model), but a new Console org
sits in an unpublished Evaluation tier — add a payment method and read the live limits on
day 0. Images are ephemeral on Anthropic's side (not stored past the request, not used for
training); with Tier 0 keeping video on-device, that is the privacy sentence for the pitch.

---

## §4 — Key management and proxy routes (Agent D)

All keys live in `server/.env`, never in the app bundle. `EXPO_PUBLIC_*` variables are
compiled into the JS bundle: the app may know `EXPO_PUBLIC_PROXY_URL` and `EXPO_PUBLIC_MOCK`,
nothing else. Commit `server/.env.example` with empty values; `.gitignore` the real file.

```
ANTHROPIC_API_KEY=            # §3
NVIDIA_API_KEY=               # §1 (exact model ids read from /v1/models, stored in proxy config)
ELEVENLABS_API_KEY=           # §2
ELEVENLABS_VOICE_ID=          # §2, one voice for both tiers
GOOGLE_MAPS_API_KEY=          # Routes API + Places, server-side only; restrict the key to those APIs
# optional
NVIDIA_API_KEY_FALLBACK=      # second account, rotated on 429
OPENROUTER_API_KEY=           # same-model Nemotron failover
```

Routes (Node; **hosted in us-east, not on a laptop** — hackathon Wi-Fi is R17, and Anthropic /
ElevenLabs US clusters are closest):

```
POST /api/vision   → Claude Haiku 4.5 / Sonnet 5 (structured outputs)     (C schema, D route)
                     WebSocket variant: same body, streams speech audio + JSON
POST /api/plan     → Nemotron 3.5 Lightning on NIM, OpenRouter failover      (B)
POST /api/tts      → ElevenLabs Flash v2.5 (pre-synthesis + rare live)      (A caller, D route)
POST /api/stt      → ElevenLabs Scribe v2 (fallback STT)                    (A caller, D route)
GET  /api/route    → Google Routes API computeRoutes WALK, field mask,
                     OSM/WPRDC crossing join, walking-beta warning passed through (B)
GET  /api/health   → all five upstreams individually: Anthropic, NIM, OpenRouter,
                     ElevenLabs, Google Routes — status, last latency, last error,
                     429 count since start; Overpass reachability as an unkeyed extra
```

At start the proxy warms every Claude (model, schema) pair and probes each Nemotron job
schema; `/api/health` reports the results and DebugPanel shows it in one glance, so on demo
day the team knows *which* dependency broke. Google route content informs where a crossing is
and never triggers a walk cue (Maps ToS High Risk Activities); the walking-beta warning is
displayed; "Google Maps" text attribution appears wherever route content is shown without a
map. Every upstream call has a timeout and `maxRetries: 0`; the phone, not the proxy, decides
whether a late answer is still fresh.

---

## §5 — Day-0 verification (before any feature code; named human per line)

**NVIDIA (B)**
- [ ] Account key generated without the "contact support to verify" block; spare key on a second email
- [ ] Authenticated `GET /v1/models` lists the primary and fallback ids; exact strings copied into proxy config
- [ ] One `parseIntent` call with `enable_thinking: false` + `nvext.guided_json` returns schema-valid JSON whose first token is `{`; `response_format json_schema` probed as the alternative; result recorded
- [ ] 20 streamed calls: p50/p95 first-token and total latency logged; 1.5 s deadline + templated fallback exercised by forcing a timeout
- [ ] OpenRouter lists the same model and one call succeeds [verify], or the failover is marked absent in `/api/health`

**Anthropic (C, D)**
- [ ] Console org has a payment method; rate-limit tier and live RPM/ITPM read from the Console
- [ ] `count_tokens` on real `snapshotJPEG(512)` and `(640)` frames returns 266 and 414
- [ ] Warm-up per (model, schema) succeeds; second call shows no grammar-compile penalty
- [ ] 20 aisle-sign and 20 signal-head frames from the venue: parse rate, accuracy, p50/p95 for Haiku and for Sonnet 5 thinking-off, all in DebugPanel
- [ ] Streamed `speech` reaches the phone as audio ~1.5 s after capture on hotspot

**ElevenLabs (A)**
- [ ] Creator-month perk redeemed on the key's account; concurrency limit noted
- [ ] Voice chosen by audition in noise; `ELEVENLABS_VOICE_ID` set
- [ ] `scripts/generate-audio.ts` run: every cache key in 01 §3 has a file, none contains a forbidden word, all preload and play through `expo-audio` with `setRate(1.15)`
- [ ] One live Flash call through `/api/tts` measured on-device (< 400 ms first audio); one Scribe call through `/api/stt` from an `expo-audio` M4A recording returns the spoken item
- [ ] `expo-speech` fallback verified with the mute switch off

**Google (B)**
- [ ] Billing on, Routes API and Places enabled, key restricted server-side
- [ ] One `computeRoutes` WALK with the field mask returns steps with `maneuver` and plain-text instructions for the demo route; the beta warning text is captured
- [ ] Overpass query for the demo bbox returns crossing nodes and is cached; WPRDC signalized-intersection JSON bundled

**Proxy (D)**
- [ ] Deployed in us-east; `/api/health` green for all five upstreams from the demo phone on the phone hotspot
- [ ] Built JS bundle grepped for key material (prefixes such as `sk-ant-`, `nvapi-`, `AIza`): nothing found
- [ ] `EXPO_PUBLIC_MOCK=1` build runs the whole flow with the proxy unreachable

An account-verification queue or a stale model id is a day-0 problem, not an hour-20 problem.
Do this before writing feature code.
