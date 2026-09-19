/**
 * Tiny typed service locator.
 *
 * Services are constructed once in App.tsx (the composition root, where
 * EXPO_PUBLIC_MOCK swaps in D's mocks) and registered here. Feature code gets
 * them through `services.get('speech')` etc. instead of importing singletons,
 * so tests can swap in the stubs from `stubs.ts`.
 *
 * `get` throws when a service is missing — a missing service is a wiring bug
 * that should be loud in dev, not a silent no-op. `tryGet` is for optional
 * consumers (e.g. the store speaking `entering_store` only if speech exists).
 */
import type { HapticService, PerceptionService, SensorService, SpeechService } from './contracts';
import type { AppEventBus } from './bus';
import type { ConversationLog } from './conversation';
import type { AppStore } from './store';

export interface ServiceMap {
  haptics: HapticService;
  speech: SpeechService;
  sensors: SensorService;
  perception: PerceptionService;
  bus: AppEventBus;
  store: AppStore;
  /** The transcript blurb's data: what the user said and what Aisle said. */
  conversation: ConversationLog;
}

export type ServiceName = keyof ServiceMap;

export interface ServiceRegistry {
  set<K extends ServiceName>(name: K, value: ServiceMap[K]): void;
  get<K extends ServiceName>(name: K): ServiceMap[K];
  tryGet<K extends ServiceName>(name: K): ServiceMap[K] | undefined;
  has(name: ServiceName): boolean;
  /** Register many at once (composition root). */
  setAll(partial: Partial<ServiceMap>): void;
  /** Drop everything (tests). */
  reset(): void;
  names(): ServiceName[];
}

export function createServiceRegistry(): ServiceRegistry {
  const map = new Map<ServiceName, ServiceMap[ServiceName]>();
  return {
    set(name, value) {
      map.set(name, value);
    },
    get(name) {
      const v = map.get(name);
      if (v === undefined) {
        throw new Error(`[services] '${name}' is not registered. Register it in App.tsx before use.`);
      }
      return v as ServiceMap[typeof name];
    },
    tryGet(name) {
      return map.get(name) as ServiceMap[typeof name] | undefined;
    },
    has(name) {
      return map.has(name);
    },
    setAll(partial) {
      for (const key of Object.keys(partial) as ServiceName[]) {
        const v = partial[key];
        if (v !== undefined) map.set(key, v);
      }
    },
    reset() {
      map.clear();
    },
    names() {
      return Array.from(map.keys());
    },
  };
}

/** The app-wide registry. */
export const services: ServiceRegistry = createServiceRegistry();
