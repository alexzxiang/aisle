# 07 — Sponsor Stack: NVIDIA Nemotron & ElevenLabs

Required for hackathon prize categories. Agent C owns §1, Agent A owns §2.

Read this alongside your agent doc — it supersedes any earlier mention of a
generic "GPT vision endpoint" or `expo-speech` as the primary TTS.

---

## §1 — NVIDIA Nemotron (Agent C)

### Model choice

Use **Nemotron Nano 2 VL** (`nvidia/nemotron-nano-12b-v2-vl`), a 12B multimodal
vision-language model that leads the OCRBench v2 benchmark and was trained
heavily on OCR and document-extraction data.

This is a real fit, not a sponsor tax. Our indoor navigation reduces entirely to
*"read the sign in this frame."* That is an OCR-under-motion problem, and we're
running it on the model family that's strongest at OCR. Say that out loud to
judges.

**Alternatives if you hit trouble:**
- **Nemotron OCR v2** — a dedicated multilingual OCR model. If Nano 2 VL's
  reasoning preamble proves hard to suppress, this returns raw text more
  directly; you'd then do sign-matching in your own code instead of in-prompt.
  Simpler, less flexible, still a Nemotron model for category purposes.
- **Nemotron 3 Nano Omni** — omni-modal (image, video, speech, text). Overkill
  here and a larger surface to debug. Note it for the "future work" slide, don't
  build on it in a hackathon.

Don't spend more than 30 minutes deciding. Start with Nano 2 VL.

### Access

Free NIM endpoints at `build.nvidia.com` — create an account, generate an API
key, note your credit allowance. The API is **OpenAI-compatible chat
completions**, so standard SDK request shapes work with the base URL swapped:

```ts
const client = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY,
  baseURL: 'https://integrate.api.nvidia.com/v1',
});

const res = await client.chat.completions.create({
  model: 'nvidia/nemotron-nano-12b-v2-vl',
  temperature: 0,
  max_tokens: 200,
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: AISLE_PROMPT },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpegBase64}` } },
    ],
  }],
});
```

Verify the exact model string and base URL against `build.nvidia.com` on day 0 —
model identifiers on that catalog change more often than you'd like, and
discovering a stale string at hour 20 is a painful way to lose an evening.

### Practical notes

- **Image sizing:** the architecture tiles images to 512×512 and resizes, so
  ≤1024 px wide at JPEG quality ~60 is the sweet spot. Bigger frames cost
  latency and buy nothing.
- **Determinism:** `temperature: 0`. You want the same sign read the same way.
- **Reasoning preamble:** Nano 2 VL is a reasoning model. Instruct it to emit
  only the JSON object, and defensively extract the **last** `{...}` block from
  the response as a fallback. Do this before you test in the venue, not after.
- **Rate/credit limits:** at one frame per 2 seconds, a 3-minute demo is ~90
  calls. Cheap, but check your remaining credits before the pitch.
- **Fallback path:** if NIM is slow or down during the demo, Agent D's replay
  fixtures must carry the run. Confirm that path works end to end.

### Self-hosting (only if you have GPU access)

Nemotron Nano 2 VL weights are open (BF16/FP8/FP4). If the hackathon provides
GPUs, running it locally is a legitimately impressive differentiator — it
removes network latency entirely and makes a real claim about on-device
viability. **Only attempt this if someone on the team has done it before.** Model
serving setup can eat a full day, and it is not worth the demo.

---

## §2 — ElevenLabs (Agent A)

### The insight: our phrase set is closed

Because principle 2 forces every utterance to be terse and actionable, the whole
app speaks from roughly 25 fixed phrases. That means we don't need to call TTS in
real time for most speech — we can **pre-generate every fixed phrase at build
time and bundle the audio**.

This resolves what would otherwise be a real tension. A cloud TTS call in the
critical path contradicts the latency budget. Pre-generation removes the call
entirely: ElevenLabs voice quality, sub-50 ms playback, and it works with the
wifi dead. Strictly better than runtime synthesis for our use case.

### Tier 1 — Pre-generated cache (build this first)

`src/core/phrases.ts` — the single source of truth:

```ts
export const PHRASES = {
  'onboard.aligned':    "This is 'aligned'. You're facing the right way.",
  'onboard.turn':       "This is 'turn'. Rotate until the buzzing speeds up.",
  'onboard.stop':       "This is 'stop'.",
  'onboard.confirm':    "This is 'arrived'.",
  'disclaimer':         'Aisle is a prototype, not a safety device. Keep using your cane.',
  'turn.right.now':     'Turn right now.',
  'turn.left.now':      'Turn left now.',
  'turn.right.soon':    'Turn right in 20 feet.',
  'turn.left.soon':     'Turn left in 20 feet.',
  'transition.arrived': 'Arrived. Switching to store mode.',
  'transition.looking': 'Looking for aisle signs.',
  'indoor.forward':     'Keep going forward.',
  'indoor.passed':      "You've passed it. Turn around.",
  'hazard.cart':        'Cart ahead.',
  'hazard.person':      'Person ahead.',
  'hazard.obstacle':    'Obstacle ahead.',
  'checkout.ahead':     'Checkout ahead.',
  'done':               'You've reached checkout.',
  // ...train labels: 'stop', 'turn', 'aligned', 'arrived'
} as const;
```

`scripts/generate-audio.ts`:

```ts
// POST https://api.elevenlabs.io/v1/text-to-speech/{voiceId}
// headers: { 'xi-api-key': KEY }
// body: { text, model_id: 'eleven_flash_v2_5',
//         voice_settings: { stability: 0.5, similarity_boost: 0.75 } }
// → write assets/audio/<key>.mp3
```

Run once, commit the MP3s, re-run only when `PHRASES` changes. Pre-load all
sounds via `expo-av` at app start.

### Tier 2 — Live streaming

Only for phrases with runtime-variable text:
- Leg-start instructions containing street names (Agent B)
- Aisle arrival containing the aisle label and side (Agent C)

Use `eleven_flash_v2_5` with the **streaming** endpoint so playback starts before
generation completes. Flash v2.5 is the right model tier here — it's built for
real-time use and trades a little audio quality for speed, which is exactly the
trade we want. Independent benchmarks put real-world time-to-first-audio around
250–300 ms rather than the headline 75 ms inference figure, so budget ~400 ms
end to end and keep live TTS strictly off the urgent path.

Route these through the proxy, never from the device — the key stays server-side.

### Voice selection

Pick one voice and use it everywhere. Criteria, in order:

1. **Intelligibility over character.** This voice competes with store noise and
   is the user's main information channel. Warm-and-breathy loses to clear.
2. **Consistent across both tiers** — same `voiceId` for cached and live, or the
   seam between them is audible.
3. Test it at walking pace in an actual noisy space before committing.

Consider a **slightly elevated speaking rate** — experienced screen-reader users
often run TTS much faster than default, and a sluggish voice is a common
sighted-designer mistake in accessibility tools. Make rate adjustable in settings
and mention it to judges; it signals you understand the user population.

### Fallback

If ElevenLabs is unreachable and the phrase has no cache entry, fall back to
`expo-speech`. Log it, don't surface it. A degraded voice is acceptable; silence
mid-aisle is not.

---

## §3 — Combined key management

Both keys live in `server/.env`, never in the app bundle:

```
NVIDIA_API_KEY=
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
GOOGLE_MAPS_API_KEY=
```

Proxy endpoints (Agent C owns the server; Agent A and B add their routes there):

```
POST /api/vision   → Nemotron Nano 2 VL      (Agent C)
POST /api/tts      → ElevenLabs Flash v2.5   (Agent A)
GET  /api/route    → Google Directions       (Agent B)
GET  /api/health   → all three, status only  (Agent C)
```

Make `/api/health` check all three upstreams and report individually. On demo
day you want to know *which* dependency broke in one glance, not that something
did.

---

## §4 — Day-0 verification (do this before writing feature code)

- [ ] NVIDIA NIM account created, key working, model string confirmed live
- [ ] One test frame of a real aisle sign → parseable JSON from Nemotron
- [ ] ElevenLabs key working, voice chosen, one phrase generated and played
- [ ] Both keys in `server/.env`, nothing in the app bundle
- [ ] Credit/quota allowances noted and comfortably above demo needs

Thirty minutes here prevents the classic hackathon failure where a sponsor API
turns out to need a verification step nobody discovered until 3am.
