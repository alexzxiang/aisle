/** DebugPanel "network on/off" for mock mode. The mock clients consult it; feature code never does. */
export interface NetworkGate {
  isOnline(): boolean;
  setOnline(online: boolean): void;
  toggle(): boolean;
  onChange(cb: (online: boolean) => void): () => void;
}

export function createNetworkGate(initial = true): NetworkGate {
  let online = initial;
  const listeners = new Set<(online: boolean) => void>();
  const set = (v: boolean): void => {
    if (v === online) return;
    online = v;
    for (const cb of Array.from(listeners)) cb(online);
  };
  return {
    isOnline: () => online,
    setOnline: set,
    toggle() {
      set(!online);
      return online;
    },
    onChange(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}
