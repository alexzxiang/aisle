/**
 * What the composition root (App.tsx) imports from the UI: the screen switch,
 * the adapters for A's own services, and the port types other props are typed
 * against. Individual screens remain importable by path for tests.
 */
export { Root, type RootProps } from './Root';
export { voicePortFrom, audioPortsFrom, type VoiceInputLike } from './adapters';
export type { AudioPorts, BeaconPort, DebugMetrics, MutablePort, OnboardingPorts, TickerPort, VoicePort } from './ports';
