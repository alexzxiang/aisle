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
import type { CrossingController, PerceptionService, PlannerJob, SensorService, SignalState } from './contracts';
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
  prefs: PrefsBinding;
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
  const speech = createSpeechService({ backend: platform.speechBackend, store, bus, isCourseBuzzing: () => haptics.isCourseBuzzing(), now });
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
  const perceptionBinding = bindPerceptionToApp({ perception, bus, store, haptics, speech });
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
  const indoor = createIndoorController({ bus, store, speech, haptics, sensors, perception, vision, resolver, now });

  // --- A: push-to-talk ---------------------------------------------------------
  const knownItems = (): string[] => {
    const map = resolver.getMap();
    if (!map) return [];
    const words = new Set<string>(Object.keys(map.itemIndex));
    for (const a of map.aisles) for (const c of a.categories) words.add(c);
    return Array.from(words);
  };
  const voice = createVoiceInput({
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
  });

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
    now,
    fixTimeoutMs: opts.fixTimeoutMs,
  });

  // --- cross-service glue that belongs to no track -----------------------------------
  // B writes the beacon target into its slice; A's beacon plays it.
  unsubs.push(outdoor.subscribe((s, prev) => {
    if (s.beaconTarget !== prev.beaconTarget) audio.beacon.setTarget(s.beaconTarget);
  }));
  // The ticker follows SIGNAL_STATE (01 §3) unless a manual override is set.
  unsubs.push(bus.on('SIGNAL_STATE', (e) => {
    if (trip.getManualSignal() === null) audio.ticker.setState(e.state);
  }));

  services.setAll({ haptics, speech, sensors, perception, bus, store });

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
    prefs,
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
      // The first-launch disclaimer has one owner: OnboardingScreen step 0
      // (cacheKey 'disclaimer', firstRunOnly), reached by IDLE → ONBOARDING on the
      // first ITEM_REQUESTED (01 §1). Speaking it here too recited it twice.
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const u of unsubs.splice(0)) u();
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
