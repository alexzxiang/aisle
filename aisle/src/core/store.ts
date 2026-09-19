/**
 * App state machine (02 Task 2), a zustand store.
 *
 * - `mode` is written only here, through `setMode`, which validates the legal
 *   transition table from 01 §1. An illegal transition is a loud
 *   `console.warn` plus `ERROR { scope: 'store' }` on the bus, and no change.
 * - B, C and D never set mode; they emit events. `bindStoreToBus` subscribes the
 *   store to the bus and drives every transition in 02's table.
 * - Nobody passes mode around by hand: services subscribe to the store.
 *
 * Non-first-run note: 01 (post-review) has `IDLE → OUTDOOR_NAV` on ROUTE_READY when
 * firstRun is false; only the first run passes through ONBOARDING.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { AppEvent, AppMode, GeoFix, HeadingSample, Side, SpeechService } from './contracts';
import { createEventBus, type AppEventBus } from './bus';
import { TRANSITION_CAP_MS } from './config';

// ---------------------------------------------------------------------------
// Legal transition table (01 §1). `* → IDLE` is handled in isLegalTransition.
// ---------------------------------------------------------------------------

export const APP_MODES: readonly AppMode[] = [
  'IDLE', 'ONBOARDING', 'OUTDOOR_NAV', 'APPROACH_CROSSING', 'AT_CURB', 'CROSSING',
  'TRANSITION', 'INDOOR_NAV', 'AT_ITEM', 'ITEM_PICKUP', 'CHECKOUT_NAV', 'DONE',
];

export const LEGAL_TRANSITIONS: Readonly<Record<AppMode, readonly AppMode[]>> = {
  IDLE: ['ONBOARDING', 'OUTDOOR_NAV'],
  ONBOARDING: ['OUTDOOR_NAV'],
  OUTDOOR_NAV: ['APPROACH_CROSSING', 'TRANSITION'],
  APPROACH_CROSSING: ['AT_CURB', 'OUTDOOR_NAV'],
  AT_CURB: ['CROSSING', 'OUTDOOR_NAV'],
  CROSSING: ['OUTDOOR_NAV'],
  TRANSITION: ['INDOOR_NAV'],
  INDOOR_NAV: ['AT_ITEM'],
  AT_ITEM: ['ITEM_PICKUP', 'CHECKOUT_NAV'],
  ITEM_PICKUP: ['CHECKOUT_NAV'],
  CHECKOUT_NAV: ['DONE'],
  DONE: [],
};

export function isLegalTransition(from: AppMode, to: AppMode): boolean {
  if (to === 'IDLE') return true; // abort from anywhere
  return LEGAL_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type StampedEvent = AppEvent & { ts: number };

export const LAST_EVENTS_SIZE = 10;
export const SPEECH_RATE_MIN = 0.8;
export const SPEECH_RATE_MAX = 1.6;

export interface AppState {
  mode: AppMode;
  firstRun: boolean;            // gates ONBOARDING and the disclaimer
  trainingMode: boolean;        // default true: haptics are spoken too
  speechRate: number;           // 0.8–1.6
  targetItem: string | null;
  storeId: string | null;
  targetAisleId: string | null;
  targetSide: Side | null;
  currentAisleOrder: number | null;
  activeCrossingId: string | null;
  lastFix: GeoFix | null;
  heading: HeadingSample | null;
  bodyOffsetDeg: number;
  lastEvents: StampedEvent[];   // ring of 10 for the DebugPanel
  // join state for "onboarding finished + ROUTE_READY → OUTDOOR_NAV"
  onboardingComplete: boolean;
  routeReady: boolean;
  illegalTransitions: number;   // DebugPanel counter
}

export interface AppActions {
  /** Validates against 01 §1. Returns true when the mode changed (or was already `m`). */
  setMode(m: AppMode): boolean;
  /** `* → IDLE`; clears the task fields, keeps preferences and sensor snapshots. */
  abort(): void;
  /** Onboarding screen done (or skipped). Advances when the route is already ready. */
  finishOnboarding(): void;
  /** Handoff finished early (before the 3 s cap). */
  transitionEnded(): void;
  /** User tap "next" at the item: AT_ITEM / ITEM_PICKUP → CHECKOUT_NAV. */
  nextFromItem(): void;
  setFirstRun(v: boolean): void;
  setTrainingMode(v: boolean): void;
  setSpeechRate(rate: number): void;
  setBodyOffsetDeg(deg: number): void;
  setTargetItem(item: string | null): void;
  setStoreId(id: string | null): void;
  setTargetAisle(aisleId: string | null, side: Side | null): void;
  setCurrentAisleOrder(order: number | null): void;
  setLastFix(fix: GeoFix | null): void;
  setHeading(h: HeadingSample | null): void;
  pushEvent(e: AppEvent, ts?: number): void;
  /** Back to the initial state (tests, DebugPanel "reset"). */
  reset(): void;
}

export type AppStoreState = AppState & AppActions;
export type AppStore = StoreApi<AppStoreState>;

export const INITIAL_STATE: AppState = {
  mode: 'IDLE',
  firstRun: true,
  trainingMode: true,
  speechRate: 1.0,
  targetItem: null,
  storeId: null,
  targetAisleId: null,
  targetSide: null,
  currentAisleOrder: null,
  activeCrossingId: null,
  lastFix: null,
  heading: null,
  bodyOffsetDeg: 0,
  lastEvents: [],
  onboardingComplete: false,
  routeReady: false,
  illegalTransitions: 0,
};

const TASK_FIELDS_CLEARED: Pick<
  AppState,
  'targetItem' | 'storeId' | 'targetAisleId' | 'targetSide' | 'currentAisleOrder' | 'activeCrossingId' | 'onboardingComplete' | 'routeReady'
> = {
  targetItem: null,
  storeId: null,
  targetAisleId: null,
  targetSide: null,
  currentAisleOrder: null,
  activeCrossingId: null,
  onboardingComplete: false,
  routeReady: false,
};

export function clampSpeechRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1.0;
  return Math.min(SPEECH_RATE_MAX, Math.max(SPEECH_RATE_MIN, rate));
}

export interface CreateAppStoreOptions {
  /** Where illegal transitions are reported as ERROR { scope: 'store' }. */
  bus?: AppEventBus;
  /** Override the loud warning (tests). Default console.warn. */
  warn?: (message: string) => void;
  /** Initial-state overrides (tests). */
  initial?: Partial<AppState>;
}

export function createAppStore(opts: CreateAppStoreOptions = {}): AppStore {
  const warn = opts.warn ?? ((m: string) => console.warn(m));

  return createStore<AppStoreState>()((set, get) => ({
    ...INITIAL_STATE,
    ...opts.initial,

    setMode(next) {
      const prev = get().mode;
      if (next === 'IDLE') {
        // Abort is always legal and always clears the task, even from IDLE.
        set({ mode: 'IDLE', ...TASK_FIELDS_CLEARED });
        return true;
      }
      if (prev === next) return true;
      if (!isLegalTransition(prev, next)) {
        const message = `ILLEGAL MODE TRANSITION ${prev} → ${next} (ignored; see 01 §1)`;
        warn(`[store] ${message}`);
        set((s) => ({ illegalTransitions: s.illegalTransitions + 1 }));
        opts.bus?.emit({ type: 'ERROR', scope: 'store', message });
        return false;
      }
      set({ mode: next });
      return true;
    },

    abort() {
      get().setMode('IDLE');
    },

    finishOnboarding() {
      set({ onboardingComplete: true, firstRun: false });
      const s = get();
      if (s.mode === 'ONBOARDING' && s.routeReady) s.setMode('OUTDOOR_NAV');
    },

    transitionEnded() {
      if (get().mode === 'TRANSITION') get().setMode('INDOOR_NAV');
    },

    nextFromItem() {
      const m = get().mode;
      if (m === 'AT_ITEM' || m === 'ITEM_PICKUP') get().setMode('CHECKOUT_NAV');
    },

    setFirstRun: (firstRun) => set({ firstRun }),
    setTrainingMode: (trainingMode) => set({ trainingMode }),
    setSpeechRate: (rate) => set({ speechRate: clampSpeechRate(rate) }),
    setBodyOffsetDeg: (bodyOffsetDeg) => set({ bodyOffsetDeg }),
    setTargetItem: (targetItem) => set({ targetItem }),
    setStoreId: (storeId) => set({ storeId }),
    setTargetAisle: (targetAisleId, targetSide) => set({ targetAisleId, targetSide }),
    setCurrentAisleOrder: (currentAisleOrder) => set({ currentAisleOrder }),
    setLastFix: (lastFix) => set({ lastFix }),
    setHeading: (heading) => set({ heading }),

    pushEvent(e, ts = Date.now()) {
      set((s) => {
        const next = s.lastEvents.length >= LAST_EVENTS_SIZE
          ? s.lastEvents.slice(s.lastEvents.length - LAST_EVENTS_SIZE + 1)
          : s.lastEvents.slice();
        next.push({ ...e, ts });
        return { lastEvents: next };
      });
    },

    reset() {
      set({ ...INITIAL_STATE, ...opts.initial, lastEvents: [] });
    },
  }));
}

// ---------------------------------------------------------------------------
// Bus → store transitions (02 Task 2 table)
// ---------------------------------------------------------------------------

export interface BindOptions {
  /** Speaks `entering_store` on STORE_ENTERED when present. Looked up lazily. */
  speech?: () => SpeechService | undefined;
  /** TRANSITION → INDOOR_NAV cap. Default 3000 ms. */
  transitionCapMs?: number;
}

export const HAND_GUIDANCE_MAX_STEPS = 8;

/**
 * Subscribes the store to the bus. Returns an unsubscribe that also cancels the
 * TRANSITION timer. Pure with respect to services: speech is optional.
 */
export function bindStoreToBus(store: AppStore, bus: AppEventBus, opts: BindOptions = {}): () => void {
  const capMs = opts.transitionCapMs ?? TRANSITION_CAP_MS;
  let transitionTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTransitionTimer = (): void => {
    if (transitionTimer !== null) {
      clearTimeout(transitionTimer);
      transitionTimer = null;
    }
  };

  const unsubs: Array<() => void> = [];

  // Every event lands in the DebugPanel ring.
  unsubs.push(bus.onAny((r) => store.getState().pushEvent(r.event, r.ts)));

  unsubs.push(bus.on('ITEM_REQUESTED', (e) => {
    const s = store.getState();
    s.setTargetItem(e.item);
    if (s.mode !== 'IDLE') return;
    if (s.firstRun) {
      s.setMode('ONBOARDING');
      return;
    }
    // Returning user (01 §1 post-review): stay in IDLE; ROUTE_READY takes IDLE → OUTDOOR_NAV.
    if (!store.getState().onboardingComplete) store.getState().finishOnboarding();
    if (store.getState().routeReady) store.getState().setMode('OUTDOOR_NAV');
  }));

  unsubs.push(bus.on('ROUTE_READY', () => {
    const s = store.getState();
    switch (s.mode) {
      case 'IDLE':
        store.setState({ routeReady: true });
        // 01 §1 (post-review): only the first run passes through ONBOARDING.
        if (!s.firstRun) s.setMode('OUTDOOR_NAV');
        return;
      case 'ONBOARDING':
        store.setState({ routeReady: true });
        if (store.getState().onboardingComplete) s.setMode('OUTDOOR_NAV');
        return;
      case 'APPROACH_CROSSING':
        // Re-plan: crossing dropped.
        if (s.setMode('OUTDOOR_NAV')) store.setState({ activeCrossingId: null });
        return;
      default:
        return;
    }
  }));

  unsubs.push(bus.on('CROSSING_AHEAD', (e) => {
    const s = store.getState();
    if (s.mode === 'OUTDOOR_NAV') {
      if (s.setMode('APPROACH_CROSSING')) store.setState({ activeCrossingId: e.crossingId });
    } else if (s.mode === 'APPROACH_CROSSING') {
      store.setState({ activeCrossingId: e.crossingId });
    }
  }));

  unsubs.push(bus.on('CURB_REACHED', (e) => {
    const s = store.getState();
    if (s.mode === 'APPROACH_CROSSING' && s.setMode('AT_CURB')) {
      store.setState({ activeCrossingId: e.crossingId });
    }
  }));

  unsubs.push(bus.on('CROSSING_STARTED', () => {
    const s = store.getState();
    if (s.mode === 'AT_CURB') s.setMode('CROSSING');
  }));

  unsubs.push(bus.on('FAR_CURB_REACHED', () => {
    const s = store.getState();
    if (s.mode === 'CROSSING' && s.setMode('OUTDOOR_NAV')) {
      store.setState({ activeCrossingId: null });
    }
  }));
  unsubs.push(bus.on('CROSSING_ABORTED', () => {
    // 01 §1 (post-review): user does not cross / walked past / re-plan → back to walking;
    // B re-arms the crossing with CROSSING_AHEAD → CURB_REACHED. CROSSING → AT_CURB is never legal.
    const s = store.getState();
    if ((s.mode === 'AT_CURB' || s.mode === 'CROSSING') && s.setMode('OUTDOOR_NAV')) {
      store.setState({ activeCrossingId: null });
    }
  }));

  unsubs.push(bus.on('STORE_ENTERED', () => {
    const s = store.getState();
    // Anywhere but OUTDOOR_NAV this is illegal by 01 §1 (the crossing wins);
    // setMode logs it loudly and drops it.
    if (!s.setMode('TRANSITION') || store.getState().mode !== 'TRANSITION') return;
    opts.speech?.()?.say({
      text: 'Entering the store.',
      priority: 'NAV',
      cacheKey: 'entering_store',
      dedupeKey: 'entering_store',
    });
    clearTransitionTimer();
    transitionTimer = setTimeout(() => {
      transitionTimer = null;
      store.getState().transitionEnded();
    }, capMs);
  }));

  unsubs.push(bus.on('TARGET_AISLE_REACHED', (e) => {
    const s = store.getState();
    if (s.mode === 'INDOOR_NAV' && s.setMode('AT_ITEM')) {
      store.setState({ targetAisleId: e.aisleId, targetSide: e.side });
    }
  }));

  unsubs.push(bus.on('ITEM_HAND_GUIDANCE', (e) => {
    const s = store.getState();
    const done = e.hint === 'touching' || e.step >= HAND_GUIDANCE_MAX_STEPS;
    if (s.mode === 'AT_ITEM') {
      if (done) {
        s.setMode('CHECKOUT_NAV');
      } else {
        s.setMode('ITEM_PICKUP');
      }
    } else if (s.mode === 'ITEM_PICKUP' && done) {
      s.setMode('CHECKOUT_NAV');
    }
  }));

  unsubs.push(bus.on('CHECKOUT_REACHED', () => {
    const s = store.getState();
    if (s.mode === 'CHECKOUT_NAV') s.setMode('DONE');
  }));

  // Leaving TRANSITION by any other path (abort) cancels the cap timer.
  unsubs.push(store.subscribe((s, prev) => {
    if (prev.mode === 'TRANSITION' && s.mode !== 'TRANSITION') clearTransitionTimer();
  }));

  return () => {
    clearTransitionTimer();
    for (const u of unsubs.splice(0)) u();
  };
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

const OUTDOOR_PHASE: ReadonlySet<AppMode> = new Set(['OUTDOOR_NAV', 'APPROACH_CROSSING', 'AT_CURB', 'CROSSING']);
const CROSSING_PHASE: ReadonlySet<AppMode> = new Set(['APPROACH_CROSSING', 'AT_CURB', 'CROSSING']);
const INDOOR_PHASE: ReadonlySet<AppMode> = new Set(['INDOOR_NAV', 'AT_ITEM', 'ITEM_PICKUP', 'CHECKOUT_NAV']);

export const selectMode = (s: AppState): AppMode => s.mode;
export const selectIsOutdoorPhase = (s: AppState): boolean => OUTDOOR_PHASE.has(s.mode);
export const selectIsCrossingPhase = (s: AppState): boolean => CROSSING_PHASE.has(s.mode);
export const selectIsIndoorPhase = (s: AppState): boolean => INDOOR_PHASE.has(s.mode);
/** A trip is in progress: anything but IDLE / ONBOARDING / DONE. */
export const selectIsTripActive = (s: AppState): boolean =>
  s.mode !== 'IDLE' && s.mode !== 'ONBOARDING' && s.mode !== 'DONE';
export const selectTarget = (s: AppState) => ({
  item: s.targetItem,
  aisleId: s.targetAisleId,
  side: s.targetSide,
  storeId: s.storeId,
});
export const selectActiveCrossingId = (s: AppState): string | null => s.activeCrossingId;
export const selectLastEvents = (s: AppState): StampedEvent[] => s.lastEvents;
export const selectPreferences = (s: AppState) => ({
  trainingMode: s.trainingMode,
  speechRate: s.speechRate,
  firstRun: s.firstRun,
});

// ---------------------------------------------------------------------------
// App-wide singletons. App.tsx registers these in `services`; tests build their
// own with createEventBus / createAppStore / bindStoreToBus.
// ---------------------------------------------------------------------------

export const appBus: AppEventBus = createEventBus();
export const appStore: AppStore = createAppStore({ bus: appBus });
bindStoreToBus(appStore, appBus);

/** React hook over the app-wide store. */
export function useAppStore<T>(selector: (s: AppStoreState) => T): T {
  return useStore(appStore, selector);
}
