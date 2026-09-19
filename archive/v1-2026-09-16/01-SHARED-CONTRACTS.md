# 01 — Shared Contracts (FROZEN)

Every interface in this file is a contract between agents. Agent A implements
the shared services; B, C, and D consume them. **Do not change a signature here
without flagging it — a silent change breaks three other agents.**

Write all of these as TypeScript types in `src/core/contracts.ts` (Agent A
creates the file on day 0, before anyone else starts).

---

## 1. App state machine

```ts
export type AppMode =
  | 'IDLE'            // pre-task, awaiting item request
  | 'ONBOARDING'      // haptic tutorial
  | 'OUTDOOR_NAV'     // walking to the store
  | 'TRANSITION'      // handoff in progress
  | 'INDOOR_NAV'      // navigating to target aisle
  | 'AT_ITEM'         // arrived at target aisle
  | 'CHECKOUT_NAV'    // navigating to checkout
  | 'DONE';
```

Legal transitions only:

```
IDLE → ONBOARDING → OUTDOOR_NAV → TRANSITION → INDOOR_NAV → AT_ITEM → CHECKOUT_NAV → DONE
```

Plus `* → IDLE` (abort). Any agent may **read** mode; only Agent A's store may
**write** it, via `setMode()`. Agents B/C/D request transitions by emitting
events (§5), they do not set mode directly.

---

## 2. HapticService (Agent A implements)

The entire vocabulary. Four patterns. Do not add a fifth.

```ts
export type HapticPattern =
  | 'ALIGNED'   // short double-tap — "you are facing/heading correctly"
  | 'TURN'      // rising triple pulse — "rotate now"
  | 'STOP'      // one long sharp buzz — "stop / obstacle"
  | 'CONFIRM';  // soft single tap — "acknowledged / arrived"

export interface HapticService {
  play(pattern: HapticPattern): void;

  /**
   * Continuous alignment feedback. Pulse rate scales inversely with |errorDeg|:
   * error > 45°  → slow, sparse pulses
   * error < 10°  → rapid pulses, then emits ALIGNED once and auto-stops
   * Used by BOTH Agent B (compass bearing) and Agent C (aisle centerline).
   */
  startAlignment(getErrorDeg: () => number): void;
  stopAlignment(): void;
}
```

**Latency requirement:** `play()` must fire in under 100 ms from call, fully
on-device. Never gate a haptic on a network response.

---

## 3. SpeechService (Agent A implements)

```ts
export type SpeechPriority = 'CRITICAL' | 'NAV' | 'INFO';

export interface SpeechRequest {
  text: string;            // MUST be under ~2 seconds spoken (~12 words)
  priority: SpeechPriority;
  dedupeKey?: string;      // suppresses repeat within cooldownMs
  cooldownMs?: number;     // default 8000
  interrupt?: boolean;     // CRITICAL only
}

export interface SpeechService {
  say(req: SpeechRequest): void;
  clearQueue(priority?: SpeechPriority): void;
  isSpeaking(): boolean;
}
```

**Backed by ElevenLabs Flash v2.5, two-tier:**

```ts
export interface SpeechRequest {
  // ...fields above, plus:
  cacheKey?: string;   // if set, plays pre-generated local audio — 0 ms network
}
```

- **Tier 1 (cached, default):** every fixed phrase in the app is pre-generated
  by ElevenLabs at build time into `assets/audio/<cacheKey>.mp3` and played
  locally. Instant, works offline.
- **Tier 2 (live):** only phrases containing runtime-variable text (street
  names, aisle labels) hit the Flash v2.5 streaming endpoint.

Any `say()` without a `cacheKey` and without network available must fall back to
`expo-speech` rather than failing silently. See `07-SPONSOR-STACK.md` §2.

Queue rules Agent A must enforce:

- `CRITICAL` interrupts and flushes everything below it.
- `NAV` queues; max one pending at a time (newest wins, older dropped).
- `INFO` is dropped entirely if anything else is queued or speaking.
- Any request whose `dedupeKey` fired within `cooldownMs` is silently dropped.
- Hard cap: **never speak more than once every 4 seconds** outside `CRITICAL`.

This queue is the main defence against the app becoming chatty noise.

---

## 4. SensorService (Agent A implements)

```ts
export interface GeoFix {
  lat: number;
  lng: number;
  accuracyM: number;    // Agent D keys transition detection off this
  timestamp: number;
}

export interface SensorService {
  subscribeHeading(cb: (headingDeg: number) => void): () => void;  // 0–359, true north
  subscribeLocation(cb: (fix: GeoFix) => void): () => void;
  getHeading(): number;
  getLastFix(): GeoFix | null;
}
```

Heading must be smoothed (rolling median over ~5 samples) — raw magnetometer
output jitters badly enough to make alignment haptics unusable.

---

## 5. Event bus (Agent A implements, everyone emits/subscribes)

```ts
export type AppEvent =
  | { type: 'ITEM_REQUESTED'; item: string }
  | { type: 'ROUTE_READY'; legCount: number; destName: string }
  | { type: 'OUTDOOR_LEG_ADVANCED'; index: number; instruction: string }
  | { type: 'STORE_ENTERED'; reason: TransitionReason; confidence: number }
  | { type: 'AISLE_IDENTIFIED'; aisleId: string; label: string; confidence: number }
  | { type: 'TARGET_AISLE_REACHED'; aisleId: string; side: 'LEFT' | 'RIGHT' }
  | { type: 'CHECKOUT_REACHED' }
  | { type: 'HAZARD'; kind: HazardKind; direction: Direction }
  | { type: 'ERROR'; scope: string; message: string };

export type TransitionReason = 'GPS_DEGRADED' | 'STOREFRONT_SEEN' | 'MANUAL';
export type HazardKind = 'NONE' | 'OBSTACLE_AHEAD' | 'PERSON_AHEAD' | 'CART_AHEAD';
export type Direction = 'LEFT' | 'CENTER' | 'RIGHT';

export interface EventBus {
  emit(e: AppEvent): void;
  on<T extends AppEvent['type']>(
    type: T,
    cb: (e: Extract<AppEvent, { type: T }>) => void
  ): () => void;
}
```

---

## 6. Store map schema (Agent C owns the format, Agent D produces fixtures)

`fixtures/stores/<storeId>.json`:

```json
{
  "storeId": "demo-store-01",
  "displayName": "Demo Grocery",
  "entrance": { "lat": 40.4443, "lng": -79.9436, "radiusM": 35 },
  "aisles": [
    { "id": "a1", "label": "Aisle 1", "signText": ["1", "PRODUCE"], "order": 1,
      "categories": ["produce", "fruit", "vegetables"] },
    { "id": "a3", "label": "Aisle 3", "signText": ["3", "DAIRY"], "order": 3,
      "categories": ["dairy", "eggs", "milk", "cheese", "butter"] }
  ],
  "landmarks": [
    { "id": "checkout", "label": "Checkout", "signText": ["CHECKOUT", "REGISTERS", "LANES"],
      "afterAisleOrder": 99 }
  ],
  "itemIndex": {
    "eggs":  { "aisleId": "a3", "side": "RIGHT" },
    "milk":  { "aisleId": "a3", "side": "RIGHT" },
    "bread": { "aisleId": "a2", "side": "LEFT" }
  }
}
```

`order` is what makes navigation work without SLAM: if the user is at order 1
and the target is order 3, they keep walking forward past increasing aisle
numbers. Everything is relative, no coordinates needed indoors.

---

## 7. VisionService (Agent C implements)

```ts
export interface VisionResult {
  signText: string | null;        // raw text read off an aisle/landmark sign
  matchedAisleId: string | null;  // resolved against the store map
  matchedLandmarkId: string | null;
  hazard: HazardKind;
  hazardDirection: Direction | null;
  alignmentOffset: number | null; // -1 (drifting left) .. 0 (centered) .. +1 (right)
  confidence: number;             // 0..1 — below 0.5, callers must ignore
}

export interface VisionService {
  analyzeFrame(jpegBase64: string, ctx: { storeId: string; targetAisleId: string }):
    Promise<VisionResult>;
  start(): void;   // begins throttled capture loop
  stop(): void;
}
```

**Backed by NVIDIA Nemotron Nano 2 VL** via the NIM endpoint (OpenAI-compatible
chat completions schema, so standard SDK shapes work). The model must return
JSON only, no prose, no markdown fences. Agent C owns the prompt and must strip
fences defensively before parsing. See `07-SPONSOR-STACK.md` §1.

---

## 8. TransitionDetector (Agent D implements)

```ts
export interface TransitionSignal {
  reason: TransitionReason;
  confidence: number;
  detectedAt: number;
}

export interface TransitionDetector {
  start(dest: { lat: number; lng: number; radiusM: number }): void;
  stop(): void;
  onEnter(cb: (s: TransitionSignal) => void): () => void;
  forceEnter(): void;   // manual override — demo safety net, always wire this up
}
```

---

## 9. Latency budget (hard numbers)

| Path | Budget | Owner |
|---|---|---|
| Haptic pattern fire | < 100 ms, on-device | A |
| Heading update → alignment pulse change | < 200 ms | A |
| Camera frame → Nemotron result | < 2.5 s | C |
| Vision capture interval | one frame every 2 s (never faster) | C |
| Cached ElevenLabs phrase → audio out | < 50 ms (local file) | A |
| Live ElevenLabs Flash v2.5 → first audio | < 400 ms | A |
| Spoken utterance length | < 2 s (~12 words) | all |
| Minimum gap between utterances | 4 s (non-CRITICAL) | A |

If a vision call exceeds 4 s, drop it and skip to the next frame rather than
queueing — stale guidance is worse than none.

---

## 10. Mock mode (Agent D provides, everyone develops against it)

Environment flag `EXPO_PUBLIC_MOCK=1` must make the entire app runnable with
**no store, no walking, and no API keys**:

- `SensorService` replays a recorded GPS + heading track from `fixtures/track.json`
- `VisionService` replays `fixtures/frames/*.json` pre-scored vision results
- All haptics and speech still fire normally

Agents B and C **must** be able to develop and test entirely in mock mode.
Nobody should be blocked on physically walking to a grocery store.
