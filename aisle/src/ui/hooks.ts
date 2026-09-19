/**
 * The screens' only way in: the zustand store and the event bus, both taken
 * from the registry in `src/core/services.ts`, plus two small environment
 * hooks. No screen imports a singleton or constructs a service.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { AccessibilityInfo, Animated } from 'react-native';
import { useStore } from 'zustand';
import type { AppMode, Detection } from '../core/contracts';
import type { AppEventBus } from '../core/bus';
import type { AppStore, AppStoreState } from '../core/store';
import { services, type ServiceMap, type ServiceName } from '../core/services';
import { EMPTY_FACTS, reduceUi, type UiFacts } from './derive';
import type { ConversationEntryLike, ConversationLogPort } from './ports';
import { motion } from './theme';

export function useAppServiceStore(): AppStore {
  return services.get('store');
}

/** Subscribe to one slice of the app store. */
export function useStoreSlice<T>(selector: (s: AppStoreState) => T): T {
  return useStore(useAppServiceStore(), selector);
}

export function useMode(): AppMode {
  return useStoreSlice((s) => s.mode);
}

export function useBus(): AppEventBus {
  return services.get('bus');
}

/** Present-or-not services (speech may be missing in a stub shell). */
export function useOptionalService<K extends ServiceName>(name: K): ServiceMap[K] | undefined {
  return services.tryGet(name);
}

/** The detector's current tracks (≤ 5 Hz), or [] without a perception service. Throttled to `minIntervalMs`. */
export function useDetections(minIntervalMs = 500): Detection[] {
  const perception = services.tryGet('perception');
  const [dets, setDets] = useState<Detection[]>([]);
  useEffect(() => {
    if (!perception) return undefined;
    let last = 0;
    let stale: ReturnType<typeof setTimeout> | null = null;
    const unsub = perception.onDetections((d) => {
      const t = Date.now();
      if (stale !== null) clearTimeout(stale);
      // A quiet detector (nothing in frame) sends nothing: clear after a beat.
      stale = setTimeout(() => setDets([]), 2000);
      if (t - last < minIntervalMs) return;
      last = t;
      setDets(d);
    });
    return () => {
      unsub();
      if (stale !== null) clearTimeout(stale);
    };
  }, [perception, minIntervalMs]);
  return dets;
}

interface FactsAction {
  event: Parameters<typeof reduceUi>[1];
  ts: number;
  mode: AppMode | null;
}

/**
 * The reduced view of every event on the bus. Seeded from the bus history so a
 * screen mounted mid-trip (or after a DebugPanel jump) is not blank.
 *
 * Each live event is tagged with the store's mode *after* the event: the bus
 * runs typed listeners (the store's transitions) before `onAny` (this hook),
 * so an instruction knows the mode it belongs to and cannot outlive it. The
 * history seed has no such record and is tagged unknown.
 */
export function useUiFacts(): UiFacts {
  const bus = useBus();
  const store = useAppServiceStore();
  const seed = useMemo<UiFacts>(
    () => bus.history().reduce((f, r) => reduceUi(f, r.event, r.ts, null), EMPTY_FACTS),
    [bus],
  );
  const [facts, dispatch] = useReducer(
    (f: UiFacts, a: FactsAction) => reduceUi(f, a.event, a.ts, a.mode),
    seed,
  );
  useEffect(
    () => bus.onAny((r) => dispatch({ event: r.event, ts: r.ts, mode: store.getState().mode })),
    [bus, store],
  );
  return facts;
}

/**
 * A clock that ticks only while something on screen depends on it (the "seen
 * 1 s ago" ages). `nowOverride` makes a render deterministic in tests.
 */
export function useNow(intervalMs = 1000, nowOverride?: number): number {
  const [now, setNow] = useState(() => nowOverride ?? Date.now());
  const frozen = nowOverride !== undefined;
  useEffect(() => {
    if (frozen) return undefined;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [frozen, intervalMs]);
  return frozen ? (nowOverride as number) : now;
}

/** Respected by every animation in the app (DESIGN.md, Motion). */
export function useReduceMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => {
        if (alive) setReduced(v);
      })
      .catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (v: boolean) => setReduced(v));
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return reduced;
}

/**
 * VoiceOver / TalkBack on. The talk button switches to toggle mode and the
 * state band announces hero changes app speech did not carry.
 */
export function useScreenReader(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isScreenReaderEnabled()
      .then((v) => {
        if (alive) setOn(v);
      })
      .catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener('screenReaderChanged', (v: boolean) => setOn(v));
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return on;
}

/** Latest value in a ref, for callbacks that must not re-subscribe. */
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/** A callback that is safe to pass to a native handler and never stale. */
export function useEvent<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  const ref = useLatest(fn);
  return useCallback((...args: A) => ref.current(...args), [ref]);
}

/** A prop override (tests, or a parent that already knows) wins over the system setting. */
export function useResolvedReduceMotion(override?: boolean): boolean {
  const system = useReduceMotion();
  return override ?? system;
}

const NO_ENTRIES: readonly ConversationEntryLike[] = Object.freeze([]);

function isConversationLog(v: unknown): v is ConversationLogPort {
  return typeof v === 'object' && v !== null
    && typeof (v as ConversationLogPort).entries === 'function'
    && typeof (v as ConversationLogPort).subscribe === 'function';
}

/**
 * The conversation log registered under 'conversation' by the composition
 * root, if any. Looked up by name so the screens compile before the core
 * module that owns the key exists; the duck check keeps a stray value out.
 */
export function useRegisteredConversation(): ConversationLogPort | undefined {
  const registry = services as unknown as { tryGet(name: string): unknown };
  const v = registry.tryGet('conversation');
  return isConversationLog(v) ? v : undefined;
}

/**
 * The log's entries, live. Kept on local state (not useSyncExternalStore) so
 * a log whose `entries()` builds a fresh array each call cannot loop a render.
 */
export function useConversationEntries(log: ConversationLogPort | undefined): readonly ConversationEntryLike[] {
  const [entries, setEntries] = useState<readonly ConversationEntryLike[]>(() => (log ? safeEntries(log) : NO_ENTRIES));
  useEffect(() => {
    if (!log) {
      setEntries(NO_ENTRIES);
      return undefined;
    }
    setEntries(safeEntries(log));
    try {
      return log.subscribe((e) => setEntries(e));
    } catch {
      return undefined;
    }
  }, [log]);
  return entries;
}

function safeEntries(log: ConversationLogPort): readonly ConversationEntryLike[] {
  try {
    return log.entries();
  } catch {
    return NO_ENTRIES;
  }
}

export interface MountInStyle {
  opacity: Animated.Value | number;
  transform: Array<{ translateY: Animated.Value | number }>;
}

/**
 * Fade in and slide up on mount (glass panels, transcript lines). Under
 * reduce-motion the element simply appears. The values never change after
 * the first frame, so the style object is stable.
 */
export function useMountIn(reduceMotion: boolean, opts: { durationMs?: number; slidePx?: number; delayMs?: number } = {}): MountInStyle {
  const { durationMs = motion.panelInMs, slidePx = motion.panelSlidePx, delayMs = 0 } = opts;
  const opacity = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;
  const translateY = useRef(new Animated.Value(reduceMotion ? 0 : slidePx)).current;
  useEffect(() => {
    if (reduceMotion) {
      opacity.setValue(1);
      translateY.setValue(0);
      return undefined;
    }
    const anim = Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: durationMs, delay: delayMs, useNativeDriver: true }),
      Animated.timing(translateY, { toValue: 0, duration: durationMs, delay: delayMs, useNativeDriver: true }),
    ]);
    anim.start();
    return () => anim.stop();
    // Mount-only by design: a later reduce-motion flip just leaves the element where it is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return useMemo(() => ({ opacity, transform: [{ translateY }] }), [opacity, translateY]);
}

export interface PressScale {
  scale: Animated.Value;
  onPressIn(): void;
  onPressOut(): void;
}

/** The 0.96 press scale on buttons; a no-op under reduce-motion. */
export function usePressScale(reduceMotion: boolean): PressScale {
  const scale = useRef(new Animated.Value(1)).current;
  const reducedRef = useLatest(reduceMotion);
  const onPressIn = useCallback(() => {
    if (reducedRef.current) return;
    Animated.timing(scale, { toValue: motion.pressScale, duration: motion.pressMs, useNativeDriver: true }).start();
  }, [scale, reducedRef]);
  const onPressOut = useCallback(() => {
    if (reducedRef.current) {
      scale.setValue(1);
      return;
    }
    Animated.spring(scale, { toValue: 1, speed: 30, bounciness: 6, useNativeDriver: true }).start();
  }, [scale, reducedRef]);
  return useMemo(() => ({ scale, onPressIn, onPressOut }), [scale, onPressIn, onPressOut]);
}
