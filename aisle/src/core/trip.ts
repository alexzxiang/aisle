/**
 * Trip orchestration — the composition root's glue between the bus, the store
 * and the other tracks' controllers (02 Task 2 "on IDLE every service stops",
 * 03 Task 8, 05 Part 3). App.tsx constructs the services; this module decides
 * *when* they run:
 *
 *   ITEM_REQUESTED ─▶ C's StoreResolver resolves the item ─▶ `onTarget`
 *     ─▶ one outdoor session (B's CrossingController + LegRunner, built per trip
 *        because `LegRunner.stop()` disposes its controller) ─▶ `runner.start()`
 *        with the store-JSON entrance ─▶ ROUTE_READY … STORE_ENTERED (the runner
 *        stops itself there; C's indoor controller takes over on the store's mode edge)
 *   STORE_ENTERED (accepted by the store) ─▶ D's two-beat handoff announcement
 *   * → IDLE ─▶ session torn down, pick-up stopped, pending announcement cancelled
 *   voice outcomes ─▶ "repeat" at the curb re-runs the scan (B), "repeat / how far /
 *        where am I" while walking come from the runner, "reach" at the item starts C's pick-up
 *
 * Everything here is mode-driven through the store; nothing sets mode except the
 * one safety net (a trip cannot exist without a requested item). Side effects are
 * confined to the injected deps so the whole flow is unit-tested with fakes.
 */
import type { AppMode, GeoFix, HapticService, SensorService, SignalState, SpeechService } from './contracts';
import type { AppEventBus } from './bus';
import type { AppStore } from './store';
import { PHRASES } from './phrases';
import type { VoiceOutcome } from './voice';
import type { AisleCrossingController, CrossingDebugState } from '../crossing/CrossingController';
import type { IndoorController } from '../indoor/indoorController';
import type { StoreResolver } from '../indoor/storeResolver';
import type { LegRunner, LegRunnerDebugState } from '../outdoor/LegRunner';
import { RouteClientError } from '../outdoor/routeClient';
import type { OutdoorStore } from '../outdoor/store';
import { announceStoreEntry, type AnnounceHandle } from '../transition/announce';

export const FIX_TIMEOUT_MS = 8000;

/** Modes in which the runner answers "repeat / how far / where am I". */
export const WALKING_MODES: ReadonlySet<AppMode> = new Set<AppMode>(['OUTDOOR_NAV', 'APPROACH_CROSSING']);
/** Past the outdoor leg: a target resolved here (a DebugPanel jump) needs no route. */
const PAST_OUTDOOR: ReadonlySet<AppMode> = new Set<AppMode>(['TRANSITION', 'INDOOR_NAV', 'AT_ITEM', 'ITEM_PICKUP', 'CHECKOUT_NAV', 'DONE']);
/** The stretch beat has no planner intent; a plain request at the item starts it. */
export const REACH_RE = /\b(?:reach(?: out)?|pick (?:it |this )?up|grab (?:it|this)|hand guidance)\b/i;

export interface TripSession {
  runner: Pick<LegRunner, 'start' | 'stop' | 'answer' | 'getDebugState'>;
  controller: Pick<AisleCrossingController, 'setManualSignal' | 'curbReached' | 'getDebugState'>;
  dispose(): void;
}

export interface TripDeps {
  bus: AppEventBus;
  store: AppStore;
  speech: Pick<SpeechService, 'say'>;
  haptics: Pick<HapticService, 'play'>;
  sensors: Pick<SensorService, 'getLastFix' | 'subscribeLocation'>;
  resolver: Pick<StoreResolver, 'onTarget' | 'getMap' | 'ensureMap'>;
  outdoor: Pick<OutdoorStore, 'getState'>;
  /** One outdoor session per trip (B's controller is single-use after `LegRunner.stop()`). */
  createSession(): TripSession;
  indoor?: Pick<IndoorController, 'startPickup' | 'stopPickup'>;
  /** Mode edges other services care about (the WS transport opens on TRANSITION, closes at the end). */
  onTransition?(): void;
  onTripEnd?(): void;
  /** DebugPanel rung 4: the ticker follows the manual state while one is set. */
  onManualSignal?(state: SignalState | null): void;
  now?: () => number;
  fixTimeoutMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export interface TripDebugState {
  active: boolean;
  starts: number;
  lastError: string | null;
  manualSignal: SignalState | null;
  runner: LegRunnerDebugState | null;
  crossing: CrossingDebugState | null;
}

export interface Trip {
  /** Route the parsed intent after A's voice flow spoke its reply. */
  onVoiceOutcome(o: Pick<VoiceOutcome, 'output' | 'transcript'>): Promise<void>;
  /** Stable facade over the current session's controller (MockControls, always wired). */
  setManualSignal(state: SignalState | null): void;
  getManualSignal(): SignalState | null;
  /** B's "at curb" DebugPanel button. No-op unless a crossing is armed. */
  curbReached(): void;
  startPickup(): Promise<void>;
  nextFromItem(): void;
  isActive(): boolean;
  getDebugState(): TripDebugState;
  dispose(): void;
}

export function wireTrip(deps: TripDeps): Trip {
  const { bus, store } = deps;
  const setT = deps.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearT = deps.clearTimeoutFn ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const fixTimeoutMs = deps.fixTimeoutMs ?? FIX_TIMEOUT_MS;

  let session: TripSession | null = null;
  let generation = 0;
  let starts = 0;
  let lastError: string | null = null;
  let manualSignal: SignalState | null = null;
  let announcement: AnnounceHandle | null = null;
  let disposed = false;
  const unsubs: Array<() => void> = [];

  const mode = (): AppMode => store.getState().mode;

  const report = (scope: string, err: unknown): void => {
    const message = err instanceof Error ? err.message : String(err);
    lastError = `${scope}: ${message}`;
    bus.emit({ type: 'ERROR', scope, message });
  };

  const endSession = (): void => {
    const s = session;
    session = null;
    if (!s) return;
    try {
      s.dispose();
    } catch (e) {
      report('route', e);
    }
  };

  const awaitFix = (): Promise<GeoFix | null> => {
    const have = deps.sensors.getLastFix();
    if (have) return Promise.resolve(have);
    return new Promise((resolve) => {
      let done = false;
      let off: (() => void) | null = null;
      let timer: unknown = null;
      const finish = (fix: GeoFix | null): void => {
        if (done) return;
        done = true;
        if (timer !== null) clearT(timer);
        off?.();
        resolve(fix);
      };
      off = deps.sensors.subscribeLocation((fix) => finish(fix));
      if (done) {
        off();
        return;
      }
      timer = setT(() => finish(null), fixTimeoutMs);
    });
  };

  const beginTrip = async (): Promise<void> => {
    if (disposed || session) return;
    if (PAST_OUTDOOR.has(mode()) || store.getState().targetItem === null) return;
    const map = deps.resolver.getMap() ?? (await deps.resolver.ensureMap());
    if (!map || disposed || session) return;
    if (PAST_OUTDOOR.has(mode()) || store.getState().targetItem === null) return;

    const gen = ++generation;
    starts += 1;
    const s = deps.createSession();
    session = s;
    if (manualSignal !== null) s.controller.setManualSignal(manualSignal);

    const fix = await awaitFix();
    if (gen !== generation) return; // torn down while waiting
    if (!fix) {
      report('location', 'No GPS fix yet. Step outside and try again.');
      endSession();
      return;
    }
    try {
      await s.runner.start({
        storeId: map.storeId,
        entrance: { lat: map.entrance.lat, lng: map.entrance.lng, radiusM: map.entrance.radiusM },
        destName: map.displayName,
        origin: { lat: fix.lat, lng: fix.lng },
      });
      // B's installRoute has no `running` re-check after its prefetch await: a route
      // that finished installing after an abort must be stopped again.
      if (gen !== generation) s.runner.stop();
    } catch (e) {
      if (gen !== generation) {
        s.runner.stop();
        return;
      }
      report('route', e);
      if (e instanceof RouteClientError && (e.kind === 'network' || e.kind === 'timeout')) {
        deps.speech.say({ text: PHRASES.offline_notice, cacheKey: 'offline_notice', priority: 'NAV', dedupeKey: 'offline', cooldownMs: 60_000 });
      } else if (e instanceof RouteClientError) {
        // The proxy answered but had no route (Google disabled / 5xx / bad shape): never silence.
        deps.speech.say({ text: PHRASES.route_unavailable, cacheKey: 'route_unavailable', priority: 'NAV', dedupeKey: 'route_unavailable', cooldownMs: 15_000 });
      }
      endSession();
    }
  };

  const teardown = (): void => {
    generation += 1;
    announcement?.cancel();
    announcement = null;
    deps.indoor?.stopPickup();
    endSession();
    deps.onTripEnd?.();
  };

  const startPickup = async (): Promise<void> => {
    if (!deps.indoor) return;
    try {
      await deps.indoor.startPickup();
    } catch (e) {
      report('perception', e);
    }
  };

  const sayAnswer = (text: string): void => {
    try {
      deps.speech.say({ text, priority: 'NAV', dedupeKey: 'voice-answer', cooldownMs: 1000 });
    } catch (e) {
      report('voice', e);
    }
  };

  // --- subscriptions ----------------------------------------------------------

  unsubs.push(deps.resolver.onTarget((_target, outcome) => {
    if (outcome.kind === 'resolved' || outcome.kind === 'unresolved') void beginTrip();
  }));

  unsubs.push(store.subscribe((s, prev) => {
    // `abort()` clears the task fields even from IDLE (HomeScreen "Cancel" while the
    // route is still loading), so the cleared item is the abort signal, not the mode edge.
    const enteredIdle = s.mode === 'IDLE' && prev.mode !== 'IDLE';
    const taskCleared = prev.targetItem !== null && s.targetItem === null;
    if (enteredIdle || taskCleared) {
      teardown();
      return;
    }
    if (s.mode === prev.mode) return;
    if (s.mode === 'TRANSITION') deps.onTransition?.();
    if (s.mode === 'DONE') {
      endSession();
      deps.onTripEnd?.();
    }
    // Safety net: a stale ROUTE_READY after an abort would walk a trip nobody asked for.
    if (prev.mode === 'IDLE' && s.mode === 'OUTDOOR_NAV' && s.targetItem === null && session === null) s.abort();
  }));

  // D's handoff script, once per accepted STORE_ENTERED (the store's listener runs
  // first, so an illegal edge — e.g. mid-crossing — leaves the mode unchanged).
  unsubs.push(bus.on('STORE_ENTERED', () => {
    if (mode() !== 'TRANSITION') return;
    announcement?.cancel();
    announcement = announceStoreEntry({ haptics: deps.haptics, speech: deps.speech, setTimeoutFn: setT, clearTimeoutFn: clearT });
  }));

  unsubs.push(bus.on('USER_ACTION', (e) => {
    if (e.action === 'reach' && mode() === 'AT_ITEM') void startPickup();
  }));

  return {
    async onVoiceOutcome(o) {
      const intent = o.output.intent;
      const m = mode();
      if (intent === 'repeat') {
        if (m === 'AT_CURB') {
          deps.outdoor.getState().requestRescan();
          return;
        }
        if (session && WALKING_MODES.has(m)) sayAnswer(await session.runner.answer('repeat'));
        return;
      }
      if (intent === 'how_far' || intent === 'where_am_i') {
        if (session && WALKING_MODES.has(m)) sayAnswer(await session.runner.answer(intent));
        return;
      }
      if (m === 'AT_ITEM' && (intent === 'unknown' || intent === 'help') && REACH_RE.test(o.transcript)) await startPickup();
    },
    setManualSignal(state) {
      manualSignal = state;
      session?.controller.setManualSignal(state);
      deps.onManualSignal?.(state);
    },
    getManualSignal: () => manualSignal,
    curbReached() {
      session?.controller.curbReached();
    },
    startPickup,
    nextFromItem() {
      store.getState().nextFromItem();
    },
    isActive: () => session !== null,
    getDebugState: () => ({
      active: session !== null,
      starts,
      lastError,
      manualSignal,
      runner: session?.runner.getDebugState() ?? null,
      crossing: session?.controller.getDebugState() ?? null,
    }),
    dispose() {
      if (disposed) return;
      disposed = true;
      teardown();
      for (const u of unsubs.splice(0)) u();
    },
  };
}
