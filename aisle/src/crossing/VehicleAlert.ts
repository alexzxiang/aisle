/**
 * VehicleAlert (03 Task 6): the one reactor to `VEHICLE_APPROACHING` in the
 * outdoor modes. STOP, then two words, CRITICAL — both inside the handler, no
 * `await` before `play`. Forward field of view only; nothing about speed or
 * distance is ever said. `OBSTACLE_AHEAD { NEAR }` outdoors is STOP only (the
 * outdoor speech policy has no obstacle phrase).
 *
 * Ownership flag: one reactor per mode is the intent; confirm with Agent A
 * that the core does not also react.
 */
import type { AppMode, Direction, EventBus, HapticService, SpeechService } from '../core/contracts';
import { vehicleAlertRequest } from '../outdoor/guidance';

export const OUTDOOR_MODES: ReadonlySet<AppMode> = new Set<AppMode>(['OUTDOOR_NAV', 'APPROACH_CROSSING', 'AT_CURB', 'CROSSING']);

export interface VehicleAlertDeps {
  bus: EventBus;
  haptics: HapticService;
  speech: SpeechService;
  getMode: () => AppMode;
  now?: () => number;
}

export interface VehicleAlertStats {
  alerts: number;
  stops: number;
  lastDirection: Direction | null;
  /** Handler latency: event received → STOP fired (ms). Add C's frameToEventMs for the end-to-end figure. */
  lastHandlerMs: number | null;
  /** Cut line: vehicle warnings off (STOP for obstacles stays). */
  enabled: boolean;
}

export interface VehicleAlert {
  setEnabled(v: boolean): void;
  getStats(): VehicleAlertStats;
  dispose(): void;
}

export function createVehicleAlert(deps: VehicleAlertDeps): VehicleAlert {
  const now = deps.now ?? Date.now;
  const stats: VehicleAlertStats = { alerts: 0, stops: 0, lastDirection: null, lastHandlerMs: null, enabled: true };

  const offVehicle = deps.bus.on('VEHICLE_APPROACHING', (e) => {
    if (!stats.enabled || !OUTDOOR_MODES.has(deps.getMode())) return;
    const t0 = now();
    deps.haptics.play('STOP');
    stats.stops += 1;
    stats.alerts += 1;
    stats.lastDirection = e.direction;
    stats.lastHandlerMs = now() - t0;
    deps.speech.say(vehicleAlertRequest(e.direction));
  });

  const offObstacle = deps.bus.on('OBSTACLE_AHEAD', (e) => {
    if (!OUTDOOR_MODES.has(deps.getMode())) return;
    if (e.distanceClass !== 'NEAR') return;
    deps.haptics.play('STOP');
    stats.stops += 1;
  });

  return {
    setEnabled(v) {
      stats.enabled = v;
    },
    getStats: () => ({ ...stats }),
    dispose() {
      offVehicle();
      offObstacle();
    },
  };
}
