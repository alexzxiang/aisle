/**
 * Indoor controller — the side-effect edge of `src/indoor/` (04 Tasks 3–10).
 *
 * Wires, per mode from A's store (nobody passes mode by hand):
 *   INDOOR_NAV / AT_ITEM / CHECKOUT_NAV → OCR reads → aisleMatcher → navigator →
 *   actions (speech, haptics, bus, course anchor); obstacles INFO; Claude
 *   `aisle_disambiguate` on no-match / two-match; checkout landmark; the item
 *   pick-up loop on request.
 *
 * Everything decision-shaped lives in the pure modules; this file only performs
 * their actions and subscribes/unsubscribes at the right mode edges.
 */
import type { AppMode, HapticService, OcrRead, PerceptionService, SensorService, SpeechService } from '../core/contracts';
import type { AppEventBus } from '../core/bus';
import type { AppStore } from '../core/store';
import { AISLE_MATCH_MIN_CONFIDENCE, type SemanticVision } from '../perception/semanticVision';
import { createAisleCentering, type AisleCentering } from './centering';
import { createItemPickup, type ItemPickup, type PickupAction } from './itemPickup';
import { createNavigator, type NavAction, type Navigator } from './navigator';
import { createObstacleReporter, type ObstacleReporter } from './obstacles';
import { createAisleMatcher, type AisleMatcher } from './ocrMatcher';
import { type ResolvedTarget, type StoreResolver } from './storeResolver';
import { type AisleStoreMap, aisleById, landmarkById, orderOf, signVocabulary } from './storeMap';

export const INDOOR_MODES: ReadonlySet<AppMode> = new Set<AppMode>(['INDOOR_NAV', 'AT_ITEM', 'ITEM_PICKUP', 'CHECKOUT_NAV']);
export const NAV_TICK_MS = 1000;

export interface IndoorControllerOptions {
  bus: AppEventBus;
  store: AppStore;
  speech: SpeechService;
  haptics: HapticService & { isCourseBuzzing?: () => boolean };
  sensors: SensorService;
  perception: PerceptionService;
  vision: SemanticVision;
  resolver: StoreResolver;
  now?: () => number;
  aislePitchM?: number;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (h: unknown) => void;
}

export interface IndoorController {
  /** Stretch beat: run the pick-up loop (only meaningful in AT_ITEM). */
  startPickup(): Promise<void>;
  stopPickup(): void;
  getNavigator(): Navigator;
  isActive(): boolean;
  dispose(): void;
}

export function createIndoorController(opts: IndoorControllerOptions): IndoorController {
  const { bus, store, speech, haptics, sensors, perception, vision, resolver } = opts;
  const now = opts.now ?? Date.now;
  const setIntervalFn = opts.setIntervalFn ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clearIntervalFn = opts.clearIntervalFn ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));

  let steps = 0;
  const unsubSteps = sensors.subscribeSteps((n) => {
    steps = n;
  });

  const navigator = createNavigator({ now, getSteps: () => steps, aislePitchM: opts.aislePitchM });
  const centering: AisleCentering = createAisleCentering({ perception, haptics, sensors });

  let map: AisleStoreMap | null = resolver.getMap();
  let matcher: AisleMatcher | null = null;
  let obstacles: ObstacleReporter | null = null;
  let pickup: ItemPickup | null = null;
  let active = false;
  let tickHandle: unknown = null;
  const sessionUnsubs: Array<() => void> = [];

  const applyTarget = (t: ResolvedTarget | null): void => {
    navigator.setTarget(t ? { aisleId: t.aisleId, order: t.order, spokenLabel: t.spokenLabel, item: t.item, sideWhenAscending: t.sideWhenAscending } : null);
  };
  applyTarget(resolver.getTarget());
  const unsubTarget = resolver.onTarget((t) => {
    map = resolver.getMap();
    applyTarget(t);
  });

  // ---- performing actions -------------------------------------------------

  const perform = (a: NavAction | PickupAction): void => {
    switch (a.kind) {
      case 'say':
        speech.say({
          text: a.text ?? '',
          priority: a.priority,
          ...(a.cacheKey ? { cacheKey: a.cacheKey } : {}),
          ...(a.dedupeKey ? { dedupeKey: a.dedupeKey } : {}),
          ...(a.cooldownMs !== undefined ? { cooldownMs: a.cooldownMs } : {}),
        });
        return;
      case 'emit':
        bus.emit(a.event);
        return;
      case 'haptic':
        haptics.play(a.pattern);
        return;
      case 'anchorCourse':
        centering.reanchor();
        return;
      default:
        return;
    }
  };

  const performAll = (actions: readonly (NavAction | PickupAction)[]): void => {
    for (const a of actions) perform(a);
    // Arrival stops the ramp (04 Task 6); the store moves to AT_ITEM on the event.
    if (actions.some((a) => a.kind === 'emit' && (a.event.type === 'TARGET_AISLE_REACHED' || a.event.type === 'CHECKOUT_REACHED'))) {
      centering.stop();
    }
  };

  // ---- reads → matcher → navigator ----------------------------------------

  const feedSign = (id: string, kind: 'aisle' | 'landmark', confidence: number, source: 'ocr' | 'claude'): void => {
    if (!map) return;
    const order = orderOf(map, id);
    if (order === null) return;
    const spokenLabel = kind === 'aisle' ? aisleById(map, id)?.spokenLabel : landmarkById(map, id)?.spokenLabel;
    const label = kind === 'aisle' ? aisleById(map, id)?.label : landmarkById(map, id)?.label;
    if (!spokenLabel || !label) return;
    const firstAnchor = navigator.getState().currentOrder === null && kind === 'aisle';
    const actions = navigator.onSignIdentified({ id, kind, order, spokenLabel, label, confidence, source });
    if (actions.length === 0) return;
    // First confident sign: anchor the centring line at the current heading and start COURSE.
    if (firstAnchor && !centering.isRunning() && !navigator.getState().arrived) centering.anchor();
    performAll(actions);
  };

  const onReads = (reads: OcrRead[]): void => {
    if (!matcher || !map) return;
    const out = matcher.process(reads);
    if (out.identified) {
      feedSign(out.identified.id, out.identified.kind, out.identified.confidence, 'ocr');
      return;
    }
    if (out.handoff) {
      void vision.ask('aisle_disambiguate', { knownSigns: signVocabulary(map) }).then((o) => {
        if (o.status !== 'applied' || !o.response || !map) return;
        const r = o.response.aisle;
        if (r.confidence < AISLE_MATCH_MIN_CONFIDENCE) return;
        const id = r.matchedAisleId ?? r.matchedLandmarkId;
        if (!id) return;
        const kind: 'aisle' | 'landmark' = r.matchedAisleId ? 'aisle' : 'landmark';
        const order = orderOf(map, id);
        if (order === null || !navigator.isPlausible(order)) return;
        feedSign(id, kind, r.confidence, 'claude');
      });
    }
  };

  // ---- mode edges ---------------------------------------------------------

  const startSession = (): void => {
    if (active) return;
    active = true;
    map = resolver.getMap();
    if (map) {
      const m = map;
      matcher = createAisleMatcher({ map: m, isPlausible: (o) => navigator.isPlausible(o), now });
      try {
        perception.setKnownSigns(signVocabulary(m));
      } catch {
        // module not started; bindPerceptionToApp starts it on the mode edge
      }
    } else {
      void resolver.ensureMap().then((m) => {
        if (!m || !active) return;
        map = m;
        matcher = createAisleMatcher({ map: m, isPlausible: (o) => navigator.isPlausible(o), now });
      });
    }
    sessionUnsubs.push(perception.onOcrText(onReads));
    obstacles = createObstacleReporter({
      perception,
      speech,
      now,
      isActive: () => active,
      onWallAhead: () => navigator.onWallAhead(),
    });
    tickHandle = setIntervalFn(() => {
      if (!active) return;
      performAll(navigator.tick());
    }, NAV_TICK_MS);
    void vision.warm();
  };

  const stopSession = (): void => {
    if (!active) return;
    active = false;
    for (const u of sessionUnsubs.splice(0)) u();
    obstacles?.dispose();
    obstacles = null;
    if (tickHandle !== null) {
      clearIntervalFn(tickHandle);
      tickHandle = null;
    }
    pickup?.stop();
    centering.stop();
    matcher = null;
    navigator.reset();
  };

  const onMode = (mode: AppMode, prev: AppMode | null): void => {
    const indoor = INDOOR_MODES.has(mode);
    const wasIndoor = prev !== null && INDOOR_MODES.has(prev);
    if (indoor && !wasIndoor) startSession();
    if (!indoor && wasIndoor) stopSession();
    if (!indoor) return;
    if (mode === 'CHECKOUT_NAV') {
      navigator.setPhase('CHECKOUT');
      pickup?.stop();
      if (!centering.isRunning()) centering.anchor();
    } else if (mode === 'INDOOR_NAV') {
      navigator.setPhase('AISLE');
    }
    if (mode === 'AT_ITEM' || mode === 'ITEM_PICKUP') centering.stop();
  };

  onMode(store.getState().mode, null);
  const unsubMode = store.subscribe((s, p) => {
    if (s.mode !== p.mode) onMode(s.mode, p.mode);
  });

  return {
    async startPickup() {
      const t = resolver.getTarget();
      const mode = store.getState().mode;
      if (!t || (mode !== 'AT_ITEM' && mode !== 'ITEM_PICKUP')) return;
      if (pickup?.isRunning()) return;
      centering.stop();
      const side = store.getState().targetSide ?? t.sideWhenAscending;
      pickup = createItemPickup({ vision, perform, now });
      await pickup.start({ item: t.item ?? t.requestedItem, side, packageHint: t.packageHint, shelf: t.shelf });
    },
    stopPickup() {
      pickup?.stop();
    },
    getNavigator: () => navigator,
    isActive: () => active,
    dispose() {
      stopSession();
      unsubMode();
      unsubTarget();
      unsubSteps();
    },
  };
}
