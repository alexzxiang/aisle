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
  /** Seek track + perception pack and emit the legal event chain (needs `bus`). */
  jumpToPhase(phase: ReplayPhase): PhaseSpec | null;
  /** Inject a manual signal state through the perception mock (null releases). */
  forceSignalState(state: SignalState | null, fresh?: boolean): void;
  /** Perception pack override for the DebugPanel. */
  selectPack(name: string, offsetMs?: number): void;
  packNames(): string[];
  /** Run one tick by hand (tests). */
  tick(): void;
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

  // Phase jump: seek the track, arm the pack at its offset, then emit the legal chain.
  sensors.controls.onJump((_phase, spec) => {
    if (perception.packNames().includes(spec.pack)) perception.selectPack(spec.pack, spec.packOffsetMs);
  });

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
      if (spec && opts.bus) emitJumpEvents(phase, { bus: opts.bus, store: opts.store, ctx: opts.jumpContext });
      return spec;
    },
    forceSignalState: (state, fresh) => perception.forceSignalState(state, fresh),
    selectPack: (name, offsetMs) => perception.selectPack(name, offsetMs),
    packNames: () => perception.packNames(),
    tick,
  };

  return { sensors, perception, semanticVision, planner, network, harness };
}
