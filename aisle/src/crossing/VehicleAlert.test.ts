import type { AppMode } from '../core/contracts';
import { createEventBus } from '../core/bus';
import { createFakeHaptics, createFakeSpeech } from '../outdoor/testing';
import { createVehicleAlert } from './VehicleAlert';

function harness(mode: AppMode) {
  const bus = createEventBus();
  const haptics = createFakeHaptics();
  const speech = createFakeSpeech();
  let current = mode;
  const alert = createVehicleAlert({ bus, haptics, speech, getMode: () => current });
  return { bus, haptics, speech, alert, setMode: (m: AppMode) => { current = m; } };
}

describe('VehicleAlert', () => {
  it('STOP fires synchronously inside the handler, then the two-word CRITICAL phrase', () => {
    const h = harness('AT_CURB');
    let stopsAtEmitReturn = -1;
    h.bus.emit({ type: 'VEHICLE_APPROACHING', direction: 'RIGHT', trackId: 3 });
    stopsAtEmitReturn = h.haptics.played.filter((p) => p === 'STOP').length;
    expect(stopsAtEmitReturn).toBe(1);
    expect(h.speech.said).toEqual([{ text: 'Vehicle right.', cacheKey: 'vehicle_right', priority: 'CRITICAL', interrupt: true, dedupeKey: 'vehicle-RIGHT', cooldownMs: 4000 }]);
    expect(h.alert.getStats().lastHandlerMs).toBeLessThan(150);
  });

  it('reacts in every outdoor mode and in no indoor mode', () => {
    for (const mode of ['OUTDOOR_NAV', 'APPROACH_CROSSING', 'AT_CURB', 'CROSSING'] as AppMode[]) {
      const h = harness(mode);
      h.bus.emit({ type: 'VEHICLE_APPROACHING', direction: 'LEFT', trackId: 1 });
      expect(h.haptics.played).toEqual(['STOP']);
    }
    for (const mode of ['IDLE', 'INDOOR_NAV', 'AT_ITEM', 'TRANSITION'] as AppMode[]) {
      const h = harness(mode);
      h.bus.emit({ type: 'VEHICLE_APPROACHING', direction: 'LEFT', trackId: 1 });
      expect(h.haptics.played).toEqual([]);
      expect(h.speech.said).toEqual([]);
    }
  });

  it('a NEAR obstacle outdoors is STOP only, no words', () => {
    const h = harness('OUTDOOR_NAV');
    h.bus.emit({ type: 'OBSTACLE_AHEAD', distanceClass: 'NEAR', direction: 'CENTER' });
    h.bus.emit({ type: 'OBSTACLE_AHEAD', distanceClass: 'MID', direction: 'CENTER' });
    expect(h.haptics.played).toEqual(['STOP']);
    expect(h.speech.said).toEqual([]);
  });

  it('the cut line turns vehicle words off but keeps obstacle STOP; dispose removes the listeners', () => {
    const h = harness('CROSSING');
    h.alert.setEnabled(false);
    h.bus.emit({ type: 'VEHICLE_APPROACHING', direction: 'CENTER', trackId: 1 });
    expect(h.haptics.played).toEqual([]);
    h.bus.emit({ type: 'OBSTACLE_AHEAD', distanceClass: 'NEAR', direction: 'CENTER' });
    expect(h.haptics.played).toEqual(['STOP']);
    h.alert.dispose();
    h.alert.setEnabled(true);
    h.bus.emit({ type: 'VEHICLE_APPROACHING', direction: 'CENTER', trackId: 2 });
    expect(h.haptics.played).toEqual(['STOP']);
  });
});
