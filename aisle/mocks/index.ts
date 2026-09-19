/**
 * Mock composition (01 §12, 05 Part 1 "Wiring").
 *
 * A's App.tsx calls `createMockServices()` when `process.env.EXPO_PUBLIC_MOCK === '1'`
 * and registers the returned services; nothing else reads the flag. Speech and
 * haptics stay real: the point of mock mode is to hear and feel the app with no
 * store, no walking, no camera and no keys.
 *
 * The harness owns one ticker (~20 Hz) that advances both replayers from a shared
 * clock, and exposes the DebugPanel controls (`mocks/debug/MockControls.tsx`).
 */
import type { EventBus, SignalState } from '../src/core/contracts';
import { createReplayClock, type ReplayClock } from './clock';
import * as fx from './fixtures';
import { createNetworkGate, type NetworkGate } from './network';
import { createMockPerceptionService, type MockPerceptionService } from './perception';
import { type JumpContext, type MockStoreBridge, emitJumpEvents } from './phases';
import { createMockPlanner, type MockPlanner } from './planner';
import { createMockSemanticVision, type MockSemanticVision } from './semanticVision';
import { createMockSensorService, type MockSensorService } from './sensors';
import type { PhaseSpec, ReplayPhase } from './track';

export type { MockStoreBridge } from './phases';
export type { ReplayPhase } from './track';
export { bridgeAppStore } from './storeBridge';
export { REPLAY_PHASES, isReplayPhase } from './track';

export interface MockHarness {
  clock: ReplayClock;
  network: NetworkGate;
  /** Start / stop the ticker. Idempotent. */
  start(): void;
  stop(): void;
  isRunning(): boolean;
  play(): void;
  pause(): void;
  isPlaying(): boolean;
  scrub(seconds: number): void;
  setSpeed(x: 1 | 4): void;
  getSpeed(): number;
  getTimeS(): number;
  getDurationS(): number;
  /**
   * Seek the track, emit the legal event chain (needs `bus`), then arm the phase's
   * perception pack at its offset. The pack goes on last and pinned, so the mode edges
   * the chain produces (each re-arming a default pack) cannot override it.
   */
  jumpToPhase(phase: ReplayPhase): PhaseSpec | null;
  /** Inject a manual signal state through the perception mock (null releases). */
  forceSignalState(state: SignalState | null, fresh?: boolean): void;
  /** Perception pack override for the DebugPanel; holds until the perception profile changes (01 §7). */
  selectPack(name: string, offsetMs?: number): void;
  packNames(): string[];
  /** Run one tick by hand (tests). */
  tick(): void;
  /** stop() plus the store-mode subscription. */
  dispose(): void;
}

export interface MockServices {
  sensors: MockSensorService;
  perception: MockPerceptionService;
  semanticVision: MockSemanticVision;
  planner: MockPlanner;
  network: NetworkGate;
  harness: MockHarness;
}

export interface CreateMockServicesOptions {
  /** The app bus; phase jumps emit their chain here. */
  bus?: Pick<EventBus, 'emit'>;
  /** A's store, adapted with `bridgeAppStore(store)`; lets a jump reset to IDLE first. */
  store?: MockStoreBridge;
  jumpContext?: JumpContext;
  /** Ticker interval in ms. Default 50. */
  tickMs?: number;
  /** Start the clock playing immediately. Default true. */
  autoplay?: boolean;
  wall?: () => number;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  /** 0 makes the vision/planner mocks answer immediately (tests). Default 1. */
  latencyScale?: number;
}

export function createMockServices(opts: CreateMockServicesOptions = {}): MockServices {
  const wall = opts.wall ?? Date.now;
  const clock = createReplayClock({ wall, playing: false });
  const network = createNetworkGate(true);

  const sensors = createMockSensorService({ track: fx.track, clock, wall });
  const perception = createMockPerceptionService({ packs: fx.perceptionPacks, clock, frames: fx.frames, wall });
  sensors.attachPoseSource((cb) => perception.onPose(cb));
  const semanticVision = createMockSemanticVision({ fixtures: fx.visionFixtures, network, latencyScale: opts.latencyScale });
  const planner = createMockPlanner({ fixtures: fx.planFixtures, network, latencyScale: opts.latencyScale });

  const setIntervalFn = opts.setIntervalFn ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clearIntervalFn = opts.clearIntervalFn ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
  let handle: unknown = null;

  const tick = (): void => {
    sensors.controls.tick();
    perception.tick();
  };

  // Mode-driven packs when A's store is bridged (01 §7: AT_CURB shares a profile with the
  // approach, so only the mode edge can arm the curb pack at the curb).
  let unsubMode: (() => void) | null = null;
  if (opts.store?.subscribeMode) {
    perception.setAppMode(opts.store.getMode());
    unsubMode = opts.store.subscribeMode((mode) => perception.setAppMode(mode));
  }

  const harness: MockHarness = {
    clock,
    network,
    start() {
      if (handle !== null) return;
      handle = setIntervalFn(tick, opts.tickMs ?? 50);
      if (opts.autoplay ?? true) clock.play();
    },
    stop() {
      if (handle === null) return;
      clearIntervalFn(handle);
      handle = null;
      clock.pause();
    },
    isRunning: () => handle !== null,
    play: () => clock.play(),
    pause: () => clock.pause(),
    isPlaying: () => clock.isPlaying(),
    scrub: (s) => sensors.controls.scrub(s),
    setSpeed: (x) => clock.setSpeed(x),
    getSpeed: () => clock.speed(),
    getTimeS: () => clock.nowMs() / 1000,
    getDurationS: () => sensors.controls.getDurationS(),
    jumpToPhase(phase) {
      const spec = sensors.controls.jumpToPhase(phase);
      if (!spec) return null;
      // Chain first: every mode edge arms its default pack; the phase's pack then wins.
      if (opts.bus) emitJumpEvents(phase, { bus: opts.bus, store: opts.store, ctx: opts.jumpContext });
      if (perception.packNames().includes(spec.pack)) perception.selectPack(spec.pack, spec.packOffsetMs);
      return spec;
    },
    forceSignalState: (state, fresh) => perception.forceSignalState(state, fresh),
    selectPack: (name, offsetMs) => perception.selectPack(name, offsetMs, { holdUntil: 'profile' }),
    packNames: () => perception.packNames(),
    tick,
    dispose() {
      harness.stop();
      if (unsubMode) unsubMode();
      unsubMode = null;
    },
  };

  return { sensors, perception, semanticVision, planner, network, harness };
}
