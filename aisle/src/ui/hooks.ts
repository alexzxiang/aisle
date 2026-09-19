/**
 * The screens' only way in: the zustand store and the event bus, both taken
 * from the registry in `src/core/services.ts`, plus two small environment
 * hooks. No screen imports a singleton or constructs a service.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { AccessibilityInfo } from 'react-native';
import { useStore } from 'zustand';
import type { AppMode } from '../core/contracts';
import type { AppEventBus } from '../core/bus';
import type { AppStore, AppStoreState } from '../core/store';
import { services, type ServiceMap, type ServiceName } from '../core/services';
import { EMPTY_FACTS, reduceUi, type UiFacts } from './derive';

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

/** Respected by the one animation in the app (the band cross-fade). */
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
