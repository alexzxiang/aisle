/**
 * The composition root's body (02 Task 1 "App.tsx constructs every service
 * once"; 06 "Integration rules"). App.tsx supplies the platform edges (expo
 * backends, or D's mocks when `EXPO_PUBLIC_MOCK=1`) and renders; everything
 * that can be built and wired without React or a native module happens here,
 * so the whole graph is exercised under Jest with fakes.
 *
 * Order of construction follows the data flow: sensors → haptics → speech →
 * audio channels → perception (+ C's binding and reflexes) → Tier 1 / Tier 2
 * clients → route client → C's store resolver → D's transition detector →
 * C's indoor controller → A's voice input → persisted prefs → the trip
 * orchestrator (`trip.ts`, which builds B's outdoor session per trip).
 *
 * Mock mode is decided by the caller: `mocks` present means D's sensors,
 * perception, vision transport and planner replace the real ones and the route
 * comes from the track fixture. Speech and haptics stay real (05 Part 1).
 *
 * Two deliberate single-reactor decisions live here rather than in the tracks:
 * - C's `bindPerceptionToApp` owns the vehicle / obstacle reflex (STOP + the
 *   CRITICAL phrase, before the bus event). B's `VehicleAlert` reacts to the same
 *   bus event with a second STOP, so it is not constructed (flagged to B).
 * - Tier-1 streamed audio: the proxy relays it only over the WebSocket as binary
 *   frames and has no `GET /api/tts/stream/<id>`, which is what A's `playStream`
 *   plays. Wiring `speech_start → noteStream` today would silence Claude's
 *   `speech` field, so the socket stays closed and Tier 1 runs over HTTP until
 *   the relay exists (`STREAMED_SPEECH_RELAY_AVAILABLE`).
 */
import type { CrossingController, Detection, Direction, DistanceClass, PerceptionService, PlannerJob, SensorService, SignalState } from './contracts';
import type { AppEventBus } from './bus';
import type { AppConfig } from './config';
import type { AppStore } from './store';
import { services } from './services';
import { createHapticService, type AisleHapticService, type HapticBackend } from './haptics';
import { createSpeechService, type AisleSpeechService, type SpeechBackend } from './speech';
import { createAudioChannels, type AudioChannelBackend, type AudioChannels } from './audio';
import { createSensorService, type AisleSensorService, type SensorSources } from './sensors';
import { createVoiceInput, type Recognizer, type VoiceInput, type VoiceInputOptions } from './voice';
import { bindPrefs, createMemoryPrefsStorage, type PrefsBinding, type PrefsStorage } from './prefs';
import { createConversationLog, type ConversationLog } from './conversation';
import { createSceneDescriber, type SceneDescriber } from './describer';
import { createGuidedTask, type GuidedTask } from './guidedTask';
import { createSituate, whereaboutsFrom, type Situate } from './situate';
import { classForWords, createSceneMemory, type SceneMemory } from './sceneMemory';
import { createGuide } from './guide';
import { describeObstacle, obstacleDetection } from './obstacleWords';
import { createExplorationMap } from './explorationMap';
import { createTracer } from './trace';
import { createHandGuide } from './handGuide';
import { wirePrompts, type PromptsBinding } from './prompts';
import { LatencyRing, liveMetrics, observePlanner, timedTransport, type LiveMetrics } from './metrics';
import { createFixtureRouteClient, type FixtureTrack } from './fixtureRoute';
import { withSpokenForms } from './speechFacade';
import { wireTrip, type Trip, type TripSession } from './trip';
import type { PerceptionNativeModule } from '../../modules/perception';
import type { MockHarness, MockServices } from '../../mocks';
import type { MockPerceptionService } from '../../mocks/perception';
import { bindPerceptionToApp, createPerceptionService, type PerceptionBinding } from '../perception/PerceptionService';
import {
  createHttpVisionTransport,
  createSemanticVision,
  createWsVisionTransport,
  type SemanticVision,
  type VisionTransport,
  type WsTransportOptions,
  type WsVisionTransport,
} from '../perception/semanticVision';
import { createCrossingController } from '../crossing/CrossingController';
import { createIndoorController, type IndoorController } from '../indoor/indoorController';
import { createStoreResolver, type StoreResolver } from '../indoor/storeResolver';
import { createLegRunner } from '../outdoor/LegRunner';
import { createPlannerClient, type PlannerClient } from '../outdoor/planner';
import { isPlannerJob } from '../outdoor/plannerJobs';
import { createRouteClient, type RouteClient } from '../outdoor/routeClient';
import { outdoorStore as sharedOutdoorStore, type OutdoorStore } from '../outdoor/store';
import { WALKING_BETA_WARNING } from '../outdoor/types';
import { createTransitionDetector, type TransitionDetectorDebug } from '../transition/TransitionDetector';

/** See the file header: flip once D serves `GET /api/tts/stream/<streamId>` (or A takes the WS chunks). */
export const STREAMED_SPEECH_RELAY_AVAILABLE = false;
/** Mock mode has no proxy to pre-synthesize against; do not hold ROUTE_READY for the 10 s default. */
export const MOCK_PREFETCH_CAP_MS = 2500;

export interface AppPlatform {
  isForeground?: () => boolean;
  hapticBackend: HapticBackend;
  speechBackend: SpeechBackend;
  audioBackend: AudioChannelBackend;
  /** Live build only; default expo-location + expo-sensors. Ignored when `mocks` is set. */
  sensorSources?: SensorSources;
  /** Live build only; default resolves the linked native module. `null` = none (throws). */
  nativePerception?: PerceptionNativeModule | null;
  recognizer?: Recognizer;
  sttUpload?: VoiceInputOptions['sttUpload'];
  prefsStorage?: PrefsStorage;
  fetchImpl?: typeof fetch;
  WebSocketCtor?: WsTransportOptions['WebSocketCtor'];
}

export interface ComposeAppOptions {
  config: AppConfig;
  bus: AppEventBus;
  store: AppStore;
  platform: AppPlatform;
  /** D's mocks when `config.mock`; the caller builds them so the real perception factory never runs in that branch. */
  mocks?: MockServices | null;
  /** Mock mode route source (`fixtures/track.json`). */
  fixtureTrack?: FixtureTrack | null;
  /** `fixtures/stores/<id>.json`, validated by C's resolver. */
  loadStoreMap: () => unknown;
  /** B's outdoor slice; default the shared singleton `useOutdoorStore` reads. Tests pass their own. */
  outdoor?: OutdoorStore;
  now?: () => number;
  prefetchCapMs?: number;
  fixTimeoutMs?: number;
  /** Store map name for the route destination when the map is not loaded yet. */
  fallbackDestName?: string;
}

export interface AppComposition {
  config: AppConfig;
  bus: AppEventBus;
  store: AppStore;
  outdoor: OutdoorStore;
  haptics: AisleHapticService;
  speech: AisleSpeechService;
  audio: AudioChannels;
  sensors: SensorService;
  perception: PerceptionService;
  perceptionBinding: PerceptionBinding;
  vision: SemanticVision;
  wsTransport: WsVisionTransport | null;
  planner: PlannerClient;
  routeClient: RouteClient;
  resolver: StoreResolver;
  detector: TransitionDetectorDebug;
  indoor: IndoorController;
  voice: VoiceInput;
  trip: Trip;
  /** Round 4: "take me to the eggs in my fridge" — camera-guided steps with no route. */
  guidedTask: GuidedTask;
  /** The awareness loop: "You seem to be in a kitchen. Is that right?" Runs from `start()`. */
  situate: Situate;
  /** Where things were seen, by bearing: "where's the fridge?" without a camera call. */
  sceneMemory: SceneMemory;
  prefs: PrefsBinding;
  /** The transcript blurb's data (also registered as the `conversation` service). */
  conversation: ConversationLog;
  /** "The voice sees more": Claude's free-form scene descriptions while walking. Runs from `start()`. */
  describer: SceneDescriber;
  prompts: PromptsBinding;
  metrics: LiveMetrics;
  harness: MockHarness | null;
  mockPerception: MockPerceptionService | null;
  /** MockControls' `crossing` prop: rung 4, wired on the live build too. */
  crossingPort: Pick<CrossingController, 'setManualSignal'>;
  /** MockControls' `transition` prop. */
  transitionPort: { forceEnter(): void; trace(): ReturnType<TransitionDetectorDebug['trace']> };
  /** Google's walking-routes sentence for HomeScreen (B's constant). */
  betaNotice: string;
  /** Audio session, sensors, harness, prefs hydration. Idempotent. The disclaimer belongs to onboarding. */
  start(): Promise<void>;
  dispose(): void;
}

/**
 * A `fetch` for A's voice flow in mock mode: `POST …/api/plan` answers from D's
 * planner replayer; anything else fails fast the way React Native's fetch does
 * with no proxy reachable, so nothing waits on a timeout.
 */
export function plannerFetch(planner: PlannerClient, fallback?: typeof fetch): typeof fetch {
  const respond = (status: number, body: unknown): Response =>
    ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (/\/api\/plan(?:\?|$)/.test(url) && method === 'POST') {
      let parsed: { job?: unknown; input?: unknown } = {};
      try {
        parsed = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { job?: unknown; input?: unknown };
      } catch {
        return respond(400, { error: 'invalid JSON' });
      }
      if (!isPlannerJob(parsed.job)) return respond(400, { error: 'unknown job' });
      const job: PlannerJob = parsed.job;
      const result = await planner.run(job, parsed.input as never);
      return respond(200, result);
    }
    if (fallback) return fallback(input, init);
    throw new TypeError('Network request failed');
  };
  return impl as typeof fetch;
}

function isAisleSensorService(s: SensorService): s is AisleSensorService {
  return typeof (s as Partial<AisleSensorService>).attachPerception === 'function' && typeof (s as Partial<AisleSensorService>).start === 'function';
}

export function composeApp(opts: ComposeAppOptions): AppComposition {
  const { config, bus, store, platform } = opts;
  const mocks = opts.mocks ?? null;
  const outdoor = opts.outdoor ?? sharedOutdoorStore;
  const now = opts.now ?? Date.now;
  const getMode = () => store.getState().mode;
  const report = (scope: string, err: unknown): void => {
    bus.emit({ type: 'ERROR', scope, message: err instanceof Error ? err.message : String(err) });
  };
  const unsubs: Array<() => void> = [];

  // --- A: the transcript blurb's log (every speaker below writes to it) -------------
  const conversation = createConversationLog({ now });

  // --- A: sensors, haptics, speech, audio ------------------------------------
  const sensors: SensorService = mocks ? mocks.sensors : createSensorService({ sources: platform.sensorSources, store, now });
  const realSensors = isAisleSensorService(sensors) ? sensors : null;

  let audioRef: AudioChannels | null = null;
  let speechRef: AisleSpeechService | null = null;
  const haptics = createHapticService({
    backend: platform.hapticBackend,
    speech: () => speechRef ?? undefined,
    bus,
    store,
    beaconActive: () => audioRef?.beacon.isActive() ?? false,
    now,
  });
  const speech = createSpeechService({ backend: platform.speechBackend, store, bus, isCourseBuzzing: () => haptics.isCourseBuzzing(), now, conversation });
  speechRef = speech;
  const audio = createAudioChannels({
    backend: platform.audioBackend,
    store,
    heading: () => sensors.getFusedHeadingDeg(),
    position: () => sensors.getLastFix(),
    speaking: () => speech.isSpeaking(),
    now,
  });
  audioRef = audio;

  // --- C: perception + reflexes; A's fusion consumes pose / tracking / lateral --
  const perception: PerceptionService = mocks
    ? createPerceptionService({ mock: mocks.perception })
    : createPerceptionService({ native: platform.nativePerception });
  // Round 13: obstacle lines say what is in the way, where, how far and which side is open. The
  // detections and the depth grid are captured further down; the closure reads them when asked.
  let obstacleWords: ((e: { distanceClass: DistanceClass; direction: Direction }) => string | null) | null = null;
  let obstacleNoise: ((e: { distanceClass: DistanceClass; direction: Direction }) => boolean) | null = null;
  const perceptionBinding = bindPerceptionToApp({ perception, bus, store, haptics, speech,
    isForeground: platform.isForeground, healthIntervalMs: config.mock ? undefined : 5000,
    onHealth: (health) => trace('perception_health', health),
    describeObstacle: (e) => obstacleWords?.(e) ?? null,
    suppressObstacle: (e) => obstacleNoise?.(e) ?? false,
  });
  realSensors?.attachPerception(perception);

  // --- Tier 1 (C) and Tier 2 (B) clients, measured for the DebugPanel ----------
  const tier1 = new LatencyRing();
  let tier2: { latencyMs: number | null; fallback: boolean | null } = { latencyMs: null, fallback: null };

  let wsTransport: WsVisionTransport | null = null;
  let transport: VisionTransport;
  if (mocks) {
    transport = mocks.semanticVision;
  } else {
    const http = createHttpVisionTransport({ proxyUrl: config.proxyUrl, fetchFn: platform.fetchImpl ? (i, init) => platform.fetchImpl!(i, init) : undefined });
    wsTransport = createWsVisionTransport({ proxyWs: config.proxyWs, fallback: http, WebSocketCtor: platform.WebSocketCtor, now });
    transport = wsTransport;
  }
  const vision = createSemanticVision({
    transport: timedTransport(transport, (ms) => tier1.push(ms), now),
    perception,
    speech,
    bus,
    store,
    getHeadingDeg: () => sensors.getFusedHeadingDeg(),
    isCourseBuzzing: () => haptics.isCourseBuzzing(),
    now,
  });

  const rawPlanner: PlannerClient = mocks ? mocks.planner : createPlannerClient({ baseUrl: config.proxyUrl, fetchImpl: platform.fetchImpl, now });
  const planner = observePlanner(rawPlanner, (o) => {
    tier2 = { latencyMs: o.latencyMs, fallback: o.fallback };
  }, now);

  const routeClient: RouteClient = mocks
    ? createFixtureRouteClient(opts.fixtureTrack ?? {}, { destName: opts.fallbackDestName ?? 'Demo Grocery', now })
    : createRouteClient({ baseUrl: config.proxyUrl, fetchImpl: platform.fetchImpl, now });

  // --- C: store map + item → aisle; D: handoff detector; C: indoor leg -----------
  const resolver = createStoreResolver({
    bus,
    store,
    speech,
    perception,
    loadStoreMap: opts.loadStoreMap,
    disambiguate: (input) => planner.run('disambiguate', input),
    prefetch: (text) => speech.prefetch(text),
  });
  const detector = createTransitionDetector({
    sensors,
    perception,
    vision: vision.asVisionAsk(),
    bus,
    getMode,
    nextSeq: () => vision.nextSeq(),
    now,
  });
  const indoor = createIndoorController({ bus, store, speech, haptics, sensors, perception, vision, resolver, now, describeObstacle: (e) => obstacleWords?.(e) ?? null });

  // --- A: scene descriptions and proactive prompts ------------------------------------
  const describer = createSceneDescriber({
    vision,
    speech,
    store,
    bus,
    conversation,
    perception,
    enabled: () => store.getState().describeSurroundings,
    now,
  });
  const prompts = wirePrompts({ bus, store, conversation });

  // --- Awareness loop: where the user seems to be, checked with them --------------------
  let dialogueBusy = (): boolean => false;
  const situate = createSituate({ store, speech, vision, perception, conversation, now,
    narrate: () => store.getState().describeSurroundings,
    mayspeak: () => !dialogueBusy() && ['IDLE', 'DONE'].includes(store.getState().mode) && store.getState().targetItem === null,
  });
  // --- Scene memory: bearings of what the detector saw in the last minute ----------------
  const sceneMemory = createSceneMemory({
    perception, speech, conversation, headingDeg: () => sensors.getFusedHeadingDeg(), now,
    // Bearings need the lens: ~100° across a portrait ultra-wide still, ~56° on the wide lens.
    hfovDeg: () => ((perception.debugLog?.() ?? []).some((l) => l.includes('ultrawide')) ? 100 : 56),
  });
  // --- Round 7b: the phone's decisions, one line each, to the proxy (server/data/cache/trace.jsonl) ---
  const trace = createTracer({ proxyUrl: mocks ? '' : config.proxyUrl, fetchImpl: platform.fetchImpl, now });
  const TRACED_EVENTS = new Set(['TASK_REQUESTED', 'TASK_STEP', 'TASK_COMPLETED', 'ITEM_HAND_GUIDANCE', 'ERROR', 'DESTINATION_REQUESTED', 'CAMERA_REQUEST', 'USER_ACTION']);
  unsubs.push(bus.onAny((r) => {
    if (TRACED_EVENTS.has(r.event.type)) trace('event', { event: r.event });
  }));
  // Every line either side said (the conversation log already dedupes repeats).
  let tracedEntries = 0;
  unsubs.push(conversation.subscribe((entries) => {
    if (entries.length < tracedEntries) tracedEntries = 0;
    for (const e of entries.slice(tracedEntries)) trace('said', { role: e.role, text: e.text, source: e.source ?? null });
    tracedEntries = entries.length;
  }));
  // What the detector sees, once a second at most, so a trace line can be matched to the frame.
  let lastDetTraceAt = 0;
  unsubs.push(perception.onDetections((list) => {
    const t = now();
    if (t - lastDetTraceAt < 1000) return;
    lastDetTraceAt = t;
    trace('seen', { n: list.length, top: list.slice(0, 6).map((d) => ({ cls: d.cls, score: Math.round(d.score * 100) / 100, box: d.box.map((v) => Math.round(v * 100) / 100), near: d.near ?? null })) });
  }));

  // --- Round 7: instructions from geometry (guide.ts) and the phone's own hand ------------
  const lensHfov = (): number => ((perception.debugLog?.() ?? []).some((l) => l.includes('ultrawide')) ? 100 : 56);
  let latestDetections: readonly Detection[] = [];
  let latestDetectionAt = -Infinity;
  unsubs.push(perception.onDetections((d) => { latestDetections = d; latestDetectionAt = now(); }));
  let latestDepth: { at: number; center: number; left?: number; right?: number; closingRate: number; meters?: number } | null = null;
  unsubs.push(perception.onDepth((d) => {
    latestDepth = { at: now(), closingRate: d.closingRate, center: d.centerBottomRel, ...(typeof d.leftBottomRel === 'number' ? { left: d.leftBottomRel } : {}), ...(typeof d.rightBottomRel === 'number' ? { right: d.rightBottomRel } : {}) };
    if (d.source === 'lidar' && d.pathMeters?.every(m => Number.isFinite(m) && m > 0)) latestDepth.meters = d.pathMeters[1];
  }));
  obstacleWords = (e) => describeObstacle({
    detections: now() - latestDetectionAt <= 1500 ? latestDetections : [],
    depth: latestDepth && now() - latestDepth.at <= 1000 ? latestDepth : null,
    hfovDeg: lensHfov(),
    direction: e.direction,
  });
  // Round 14: an obstacle line is noise when standing still (panning a table), when deliberately
  // at a surface, or when walking up to the very thing the reflex sees (the fridge we are after).
  const AT_SURFACE = new Set<string>(['scan_place', 'open_place', 'reach', 'confirm', 'open', 'find_item', 'confirm_pickup']);
  const APPROACHING = new Set<string>(['approach_item', 'approach_place', 'approach', 'find_place', 'find_door']);
  obstacleNoise = (e) => {
    if (isStationary()) return true;
    const st = guidedTaskRef?.getDebugState();
    if (!st?.active) return false;
    if (st.stage && AT_SURFACE.has(st.stage)) return true;
    if (st.stage && APPROACHING.has(st.stage) && st.target) {
      const seen = obstacleDetection(now() - latestDetectionAt <= 1500 ? latestDetections : [], e.direction);
      const want = classForWords(st.target);
      if (seen && want && seen.cls === want) return true;
    }
    return false;
  };
  const guide = createGuide({
    detections: () => now() - latestDetectionAt <= 1500 ? latestDetections : [],
    detectionTimestamp: () => latestDetectionAt,
    memory: sceneMemory,
    hfovDeg: lensHfov,
    path: () => (latestDepth && now() - latestDepth.at <= 1000 ? latestDepth : null),
    now,
  });
  const handGuide = createHandGuide({ vision, speech, haptics, perception, bus, conversation, now });
  let guidedTaskRef: GuidedTask | null = null;

  // --- A: push-to-talk ---------------------------------------------------------
  const knownItems = (): string[] => {
    const map = resolver.getMap();
    if (!map) return [];
    const words = new Set<string>(Object.keys(map.itemIndex));
    for (const a of map.aisles) for (const c of a.categories) words.add(c);
    return Array.from(words);
  };
  const voice = createVoiceInput({
    onDiagnostic: (data) => trace('voice_capture', data),
    // Round 9: the two moments a blind user needs to feel — "speak now" and "heard".
    cues: {
      listening: () => { haptics.play('LISTEN'); audio.earcon('listen'); },
      sent: () => { haptics.play('SENT'); audio.earcon('sent'); },
    },
    speech,
    bus,
    store,
    proxyUrl: config.proxyUrl,
    knownItems,
    recognizer: platform.recognizer,
    audio,
    haptics,
    sttUpload: platform.sttUpload,
    fetchImpl: mocks ? plannerFetch(planner) : platform.fetchImpl,
    now,
    conversation,
    describe: () => describer.describeNow(),
    // B-3: an unrecognised utterance becomes a free question to the camera in the user's words.
    askScene: (question) => describer.describeNow(question),
    // Open questions answer first: the awareness loop's, then the guided task's step check,
    // then "where is the X" from memory — never a store trip for a fridge.
    intercept: (transcript) => (whereaboutsFrom(transcript) !== null && situate.intercept(transcript)
      && !/\b(?:find|search|look for|help me)\b/i.test(transcript))
      || (guidedTaskRef?.intercept(transcript) ?? false)
      || (store.getState().mode !== 'GUIDED_TASK' && situate.intercept(transcript)) || sceneMemory.intercept(transcript),
    sceneContext: () => {
      const scene = situate.getScene();
      if (scene?.confirmed || scene?.setting === 'store') return situate.getContext();
      // Shared furniture alone cannot distinguish an apartment from a store/classroom.
      return scene && scene.confidence >= 0.8 ? situate.getContext() : null;
    },
  });
  dialogueBusy = () => voice.isListening() || voice.isAwaitingConfirmation();

  // --- A: persisted prefs ----------------------------------------------------------
  const prefs = bindPrefs(store, platform.prefsStorage ?? createMemoryPrefsStorage(), { onError: (stage, err) => report(`prefs-${stage}`, err) });

  // --- B's outdoor session, built per trip -----------------------------------------
  const prefetchCapMs = opts.prefetchCapMs ?? (mocks ? MOCK_PREFETCH_CAP_MS : undefined);
  // B speaks Google's walking-beta warning verbatim at ROUTE_READY; A's 12-word rule
  // would throw in dev. The outdoor session speaks the short form (see speechFacade.ts).
  const outdoorSpeech = withSpokenForms(speech);
  const createSession = (): TripSession => {
    const controller = createCrossingController({ haptics, speech: outdoorSpeech, sensors, perception, bus, outdoor, vision: vision.asVisionAsk(), getMode, now });
    const runner = createLegRunner({
      haptics, speech: outdoorSpeech, sensors, perception, bus, outdoor, routeClient, controller, planner, transition: detector, getMode, now, prefetchCapMs,
    });
    return {
      runner,
      controller,
      dispose() {
        runner.stop();
        controller.dispose();
        detector.stop();
        outdoor.getState().clearRoute();
      },
    };
  };

  const trip = wireTrip({
    bus,
    store,
    speech,
    haptics,
    sensors,
    resolver,
    outdoor,
    createSession,
    indoor,
    onTransition: () => {
      if (STREAMED_SPEECH_RELAY_AVAILABLE) wsTransport?.open();
    },
    onTripEnd: () => wsTransport?.close(),
    onManualSignal: (state: SignalState | null) => audio.ticker.setState(state ?? 'UNKNOWN'),
    conversation,
    now,
    fixTimeoutMs: opts.fixTimeoutMs,
    // Round 4: "take me to <place>" — look, then resolve the name through the proxy's places search.
    proxyUrl: config.proxyUrl,
    fetchImpl: mocks ? plannerFetch(planner, platform.fetchImpl) : platform.fetchImpl,
    describe: () => describer.describeNow(),
  });

  // --- Round 4: guided tasks (no route; Tier 2 plans the steps, Tier 1 confirms each) ---
  let searchSteps = 0;
  unsubs.push(sensors.subscribeSteps((steps) => { searchSteps = steps; }));
  // Round 18: one map for the whole session — what the camera looked at, and where a thing was
  // found absent — so a pan away, a walk, or a new "find the bananas" does not forget.
  const explorationMap = createExplorationMap(now);
  let latestPose: import('./contracts').Pose | null = null;
  // Round 17: the phone's own OCR reads (full resolution) as sign landmarks for the store search.
  let latestOcr: Array<{ text: string; box: [number, number, number, number]; at: number }> = [];
  unsubs.push(perception.onOcrText((reads) => {
    const at = now();
    latestOcr = reads.filter((r) => r.text.trim().length >= 3 && r.confidence >= 0.5).slice(0, 8).map((r) => ({ text: r.text, box: r.box, at }));
  }));
  unsubs.push(perception.onTrackingState((state) => {
    if (state !== 'NORMAL') { latestPose = null; explorationMap.trip.loseTracking(); }
  }));
  const poseTrail: Array<{ x: number; z: number; at: number }> = [];
  unsubs.push(perception.onPose((p) => {
    latestPose = p;
    explorationMap.ingestPose(p);
    poseTrail.push({ x: p.x, z: p.z, at: now() });
    while (poseTrail.length > 0 && now() - poseTrail[0]!.at > 2000) poseTrail.shift();
  }));
  /** Walking speed under 0.15 m/s over the last two seconds: standing (or turning) still. */
  const isStationary = (): boolean => {
    if (poseTrail.length < 4) return false;
    const a = poseTrail[0]!;
    const b = poseTrail[poseTrail.length - 1]!;
    const dt = (b.at - a.at) / 1000;
    if (dt < 1) return false;
    return Math.hypot(b.x - a.x, b.z - a.z) / dt < 0.15;
  };
  const guidedTask = createGuidedTask({
    adaptiveSearch: !mocks,
    heading: () => sceneMemory.facing(),
    steps: () => searchSteps,
    pose: () => (latestPose && now() - latestPose.timestamp <= 2000 && latestPose.trackingState === 'NORMAL' ? latestPose : null),
    path: () => (latestDepth && now() - latestDepth.at <= 1000 ? latestDepth : null),
    hfovDeg: lensHfov,
    signs: () => latestOcr,
    map: explorationMap,
    bus,
    store,
    speech,
    haptics,
    vision,
    planner,
    describe: () => describer.describeNow(),
    scene: () => situate.getScene()?.label ?? null,
    seen: () => sceneMemory.describe(),
    guide,
    handGuide,
    conversation,
    now,
    trace,
  });
  guidedTaskRef = guidedTask;
  // Live trips enter the same adaptive store search as a request spoken inside a
  // store. Fixture mode retains the surveyed-map demonstration and checkout flow.
  if (!mocks) unsubs.push(store.subscribe((s, prev) => {
    if (s.mode === 'INDOOR_NAV' && prev.mode === 'TRANSITION' && s.targetItem && !s.destinationOnly) {
      bus.emit({ type: 'TASK_REQUESTED', goal: s.targetItem, context: 'store', source: 'voice' });
    }
  }));

  // --- cross-service glue that belongs to no track -----------------------------------
  // B writes the beacon target into its slice; A's beacon plays it.
  unsubs.push(outdoor.subscribe((s, prev) => {
    if (s.beaconTarget !== prev.beaconTarget) audio.beacon.setTarget(s.beaconTarget);
  }));
  // The ticker follows SIGNAL_STATE (01 §3) unless a manual override is set.
  let signalExpiry: ReturnType<typeof setTimeout> | null = null;
  unsubs.push(bus.on('SIGNAL_STATE', (e) => {
    if (trip.getManualSignal() !== null) return;
    if (signalExpiry) clearTimeout(signalExpiry);
    audio.ticker.setState(Number.isFinite(e.confidence) && e.confidence >= 0.5 ? e.state : 'UNKNOWN');
    signalExpiry = setTimeout(() => {
      signalExpiry = null;
      if (trip.getManualSignal() === null) audio.ticker.setState('UNKNOWN');
    }, 4500);
  }));
  unsubs.push(() => { if (signalExpiry) clearTimeout(signalExpiry); });

  services.setAll({ haptics, speech, sensors, perception, bus, store, conversation });

  const metrics = liveMetrics({
    tier0FrameToEventMs: () => perception.getStats().frameToEventMs,
    tier1,
    tier2: () => tier2,
    speech: () => speech.getStats(),
    illegalTransitions: () => store.getState().illegalTransitions,
  });

  let started = false;
  let disposed = false;

  return {
    config,
    bus,
    store,
    outdoor,
    haptics,
    speech,
    audio,
    sensors,
    perception,
    perceptionBinding,
    vision,
    wsTransport,
    planner,
    routeClient,
    resolver,
    detector,
    indoor,
    voice,
    trip,
    guidedTask,
    situate,
    sceneMemory,
    prefs,
    conversation,
    describer,
    prompts,
    metrics,
    harness: mocks?.harness ?? null,
    mockPerception: mocks?.perception ?? null,
    crossingPort: { setManualSignal: (state) => trip.setManualSignal(state) },
    transitionPort: { forceEnter: () => detector.forceEnter(), trace: () => detector.trace() },
    betaNotice: WALKING_BETA_WARNING,

    async start() {
      if (started || disposed) return;
      started = true;
      try {
        await audio.configureSession();
      } catch (e) {
        report('audio', e);
      }
      realSensors?.start().catch((e: unknown) => report('location', e));
      mocks?.harness.start();
      void resolver.ensureMap();
      await prefs.hydrated;
      describer.start();
      situate.start();
      // The first-launch disclaimer has one owner: OnboardingScreen step 0
      // (cacheKey 'disclaimer', firstRunOnly), reached by IDLE → ONBOARDING on the
      // first ITEM_REQUESTED (01 §1). Speaking it here too recited it twice.
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const u of unsubs.splice(0)) u();
      describer.stop();
      situate.dispose();
      sceneMemory.dispose();
      trace.dispose();
      prompts.dispose();
      guidedTask.dispose();
      trip.dispose();
      voice.cancel();
      indoor.dispose();
      detector.stop();
      resolver.dispose();
      vision.dispose();
      wsTransport?.close();
      perceptionBinding.dispose();
      realSensors?.stop();
      mocks?.harness.stop();
      prefs.dispose();
      audio.dispose();
      speech.dispose();
      haptics.dispose();
    },
  };
}
