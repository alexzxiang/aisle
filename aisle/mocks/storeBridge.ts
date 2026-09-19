/** Adapts A's zustand store to the narrow MockStoreBridge the phase jump needs. */
import type { AppStore } from '../src/core/store';
import type { MockStoreBridge } from './phases';

export function bridgeAppStore(store: AppStore): MockStoreBridge {
  return {
    getMode: () => store.getState().mode,
    abort: () => store.getState().abort(),
    setFirstRun: (v) => store.getState().setFirstRun(v),
    transitionEnded: () => store.getState().transitionEnded(),
  };
}
