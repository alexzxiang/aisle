# Aisle proxy (`server/`)

One Node 20+ TypeScript process: HTTP and WebSocket on the same port. Every upstream call
(Anthropic, NVIDIA NIM / OpenRouter, ElevenLabs, Google Routes, Overpass) originates here;
the phone never holds a key. Spec: `05-AGENT-D-harness-transition-demo.md` Part 2,
`07-SPONSOR-STACK.md`, contracts in `01-SHARED-CONTRACTS.md` §8 / §9.

```
npm install
cp .env.example .env        # fill the five keys
npm run dev                 # tsx watch, 0.0.0.0:8787
npm test                    # vitest, no network (every upstream is faked)
npm run typecheck
```

## Routes

| Route | Upstream | Owner | File |
|---|---|---|---|
| `POST /api/vision` | Claude Haiku 4.5; Sonnet 5 (thinking disabled) for `curb_crop` | D | `routes/vision.ts` |
| `WS /ws` | same, streamed: Claude `speech` → ElevenLabs Flash → audio frames → JSON | D | `ws/visionSocket.ts` |
| `POST /api/plan` | Nemotron on NIM, OpenRouter failover | **B** | `routes/plan.ts` (B's file; mounted behind try/catch) |
| `POST /api/tts` | ElevenLabs `eleven_flash_v2_5`, `mp3_44100_64` | D | `routes/tts.ts` |
| `POST /api/stt` | ElevenLabs `scribe_v2`, keyterms ≤ 100 | D | `routes/stt.ts` |
| `GET /api/route` | Google Routes `computeRoutes` WALK + OSM/WPRDC | **B** | `routes/route.ts` (B's file) |
| `GET /api/health` | every upstream individually, `schemasWarm`, p50/p95 | D | `routes/health.ts` |
| `GET /api/health/warm` | re-fires every (model, schema) warm-up pair | D | |
| `GET /api/health/log` | last 500 request lines (`?route=vision`) | D | |

If B's two files are absent the server still boots and answers `503 { fallback: true }` on
those mounts (`app.ts`).

### Shared helpers B codes against

- `lib/deadline.ts` — `withFirstTokenDeadline(start, { firstTokenMs: 1500, totalMs, fallback, accept })`
  → `{ value, fallback, reason, firstTokenMs, latencyMs }`; `toPlannerResult(job, outcome)`.
- `lib/nim.ts` — `nimChat({ system, user, schema, maxTokens }, { config })` returns a
  `StreamHandle<NimChatResult>`: `stream: true`, `temperature: 0`, `max_completion_tokens`,
  `chat_template_kwargs: { enable_thinking: false }`, `nvext: { guided_json }`; on 429 / 503 /
  connect error **before the first token** it retries the spare NIM key (429 only) and then
  the same model on OpenRouter (`response_format: json_schema` there). Leaked `<think>` /
  `reasoning` is stripped and reported as `thinkingLeaked`.
- `lib/log.ts` — `requestLog.write({ route, seq, key, model, firstTokenMs, totalMs, fallback, verdict })`;
  one JSON line per request to stdout, 24 h in memory for the Nemotron eval artifact.

## Environment

`.env.example` lists the five required keys (`ANTHROPIC_API_KEY`, `NVIDIA_API_KEY`,
`ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `GOOGLE_MAPS_API_KEY`) and the optional ones
(`NVIDIA_API_KEY_FALLBACK`, `OPENROUTER_API_KEY`, `NVIDIA_MODEL` — copy the exact Nemotron id
from the authenticated `GET /v1/models` on day 0, never from memory). `WARMUP_ON_START=0`
skips the warm-up for offline development. `CAPTURE_FRAMES=1` records every vision still for
the eval below; it is off by default.

## Vision eval on real frames (`CAPTURE_FRAMES`)

The proxy keeps no images — except when you start it with `CAPTURE_FRAMES=1`, which saves
every vision call (the JPEG, the on-device facts, the question and Claude's answer) to
`server/data/cache/frames/`. That covers the HTTP route and the WebSocket alike. The folder
is git-ignored, and it should stay that way: a captured frame is a photo of someone's home.
The proxy logs a warning at startup whenever capture is on.

1. `CAPTURE_FRAMES=1 npm run dev`, then run the living-room test on the phone.
2. `npx tsx routes/vision.eval.ts --label` writes `labels.json` beside the frames. For each
   entry, open the JPEG and fill in the fields its `fill` lists: `target` as `[x, y, w, h]`
   fractions from the top-left (or `null` when it is not in view), `setting`, `done`. The
   skeleton leaves out Claude's answer on purpose, so the labels are not anchored to it.
   Re-running `--label` adds new frames and never touches an entry you filled in.
3. `npx tsx routes/vision.eval.ts` scores the answers the phone actually got (no API calls);
   add `--rerun` to re-ask Haiku and Sonnet on the same frames and compare accuracy against
   latency. `--dir <path>` points it at another frame set.

A target box is a hit when its centre is within 0.1 of the label's on both axes, and "not in
view" has to match too. Acceptance is ≥ 80 % target-box hits (TEAM-PLAN v2 C2). The report is
written to `routes/vision.eval.md`; commit it only when it scores real labelled frames.

## The language rule (a safety control)

Every Claude `speech` string and every `/api/tts` text is checked against the forbidden list
(`safe, clear, go, cross now, no cars, you can cross`, imported from `src/core/phrases.ts` —
there is no second copy) and the 12-word cap. Claude speech that fails is **blanked** (never
spoken, `speech: ""` in the JSON); `/api/tts` text that fails is **422**. One exemption, by
SHA-256 of the exact bytes: Google's walking-beta warning (`src/outdoor/types.ts`), which logs
`allowlisted` on `/api/tts` only. Verdicts (`pass | blanked | rejected_422 | allowlisted`) are
in every log line. Because the check needs the whole string, Claude's speech is held until the
string closes (≈150 ms after its first token) and then sent to ElevenLabs with `flush: true`.

## WebSocket protocol (`/ws`)

```
client → { type: 'vision', req: VisionRequest, priority: 'NAV' | 'INFO' }
client → { type: 'warm', mode: AppMode }        // re-fires the pairs that mode uses
client → { type: 'ping' }                        → { type: 'pong' }
server → { type: 'hello', maxInFlight: 3, audio: boolean }
server → { type: 'speech_start', streamId: seq }
server → <binary: uint32 big-endian streamId + mp3 bytes>
server → { type: 'speech_end', streamId: seq, firstAudioMs }
server → { type: 'result', res: VisionResponse | { confidence: 0, seq } }
server → { type: 'error', seq, code: 'bad_json' | 'bad_request' | 'stale_seq' | 'too_many_in_flight' | 'upstream' | 'unknown_type' }
```

Per request the ElevenLabs input socket is opened in parallel with Claude's TTFT (per request;
ElevenLabs closes idle sockets after 20 s), `seq` must increase per socket, ≤ 3 requests in
flight (a fourth gets `{ confidence: 0 }` at once), empty or blanked speech sends no
`speech_start`, and a stuck TTS socket never holds the JSON past 2.5 s. ElevenLabs work runs
through a semaphore of 4 (`lib/semaphore.ts`; raise to 10 once the Creator perk is confirmed)
with live speech ahead of pre-synthesis batches.

## Schema warm-up and health

At start and every 20 min: Haiku + `VisionResponse`, Sonnet + `VisionResponse`, and each of
B's five Planner schemas against NIM (asserts the first token is `{`, i.e. thinking is off;
logs the first 50 characters). `/api/health` reports:

```json
{ "ok": true, "region": "us-east",
  "upstreams": { "anthropic": {...}, "nvidia": { "modelSeen": true }, "openrouter": { "required": false },
                 "elevenlabs_tts": { "creditsLeft": 8120 }, "elevenlabs_stt": {...}, "google_routes": {...} },
  "overpass": { "ok": true, "ms": 900 },
  "schemasWarm": { "haiku:vision": "2026-09-19T15:02:11Z", "nim:routeCompile": null },
  "latency": { "vision.storefront": { "p50": 1900, "p95": 2800, "n": 12 } },
  "missingKeys": [] }
```

Five upstreams are red when down; `openrouter` is grey. Checks are cached 30 s (Scribe and
Routes 5 min — they cost credits); `?force=1` re-runs them. A red pair in `schemasWarm`
30 minutes before the slot is a stop-the-line item.

`npm run doctor [url]` prints that report one line per upstream, in colour, and exits
nonzero when anything required is red — a dead key (`MISSING KEY` / `AUTH / PERMISSION`)
reads differently from a dead network (`NETWORK`). It asks for `?budgetMs=` so every cold
probe is bounded (all of them run at once, Overpass included) and the answer lands in a
couple of seconds instead of waiting out the 10 s per-check timeout.

## Hosting (us-east) and the hotspot / LAN plan

1. **Hosted, us-east** on the team's Node host [verify: provider, plan, WebSocket support,
   cold-start]. Requirements: Node 20+, one open port, WebSockets allowed, the five keys in the
   host's secret store, no sleep-on-idle (a cold start eats the 1.5 s deadline). Start command
   `npm start` (tsx). The phone's `EXPO_PUBLIC_PROXY_URL` / `EXPO_PUBLIC_PROXY_WS` point here;
   the demo phone reaches it over cellular with no dependency on venue Wi-Fi.
2. **Hotspot fallback.** Laptop joined to the demo phone's hotspot, `npm run dev` bound to
   `0.0.0.0:8787`, DebugPanel proxy override pointed at the laptop's hotspot IP
   (`ipconfig getifaddr en0` / `ipconfig`). Hackathon Wi-Fi isolates clients; do not plan on it.
3. **Replay mode.** With no proxy at all, `EXPO_PUBLIC_MOCK=1` replays every Tier 1/2 answer
   from `fixtures/`; cached speech and haptics never touched the proxy in the first place.

Pre-demo, 30 minutes out: `GET /api/health?force=1` green for the five, `schemasWarm` fresh,
one real `storefront` round-trip with audio over `/ws`, ElevenLabs credits above the run's need.

## Tests

`vitest run` — 115 tests, all upstreams faked: the deadline helper (first-token, total,
upstream error, `accept` mapping), NIM body shape and failover order, the language rule both
ways (the hashed sentence pre-synthesizes and logs `allowlisted`; a paraphrase, truncation or
re-case and every other forbidden sentence still 422), the streaming speech extractor, Claude
routing (Sonnet + thinking disabled + `cache_control` only for `curb_crop`), the byte-stable
schema, the HTTP routes, the WS framing (speech_start → binary frames tagged with `seq` →
speech_end → result; empty and blanked speech; stale seq; a fourth in flight; a stuck TTS
socket), warm-up bookkeeping, and boot without B's routes.

Attribution: speech by ElevenLabs; route data by Google Maps (the walking-beta warning is
displayed unmodified); decisions by NVIDIA Nemotron; Tier 1 semantics by Claude.
