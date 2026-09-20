import type { AppEvent, ModeProfile, SpeechRequest } from '../core/contracts';
import { createEventBus } from '../core/bus';
import { createAppStore } from '../core/store';
import type { PerceptionNativeModule } from '../../modules/perception';
import { bindPerceptionToApp, createNativePerceptionService, createPerceptionService, vehicleText } from './PerceptionService';
import { missingRequiredModels, pedSignalModelPresent, reportMissingModels } from './PerceptionService';
import { PROFILE_FOR_MODE, obstacleReflexFor, profileForMode, vehicleCacheKey } from './profile';

type AnyListener = (e: unknown) => void;

/** A fake of the Swift module's JS surface: records calls, lets tests fire events. */
function fakeNative() {
  const calls: Array<[string, unknown[]]> = [];
  const listeners = new Map<string, Set<AnyListener>>();
  const rec = (name: string, ...args: unknown[]) => { calls.push([name, args]); };
  const native = {
    calls,
    fire(event: string, payload: unknown) {
      for (const cb of Array.from(listeners.get(event) ?? [])) cb(payload);
    },
    addListener(event: string, cb: AnyListener) {
      let set = listeners.get(event);
      if (!set) { set = new Set(); listeners.set(event, set); }
      set.add(cb);
      return { remove: () => { set!.delete(cb); } };
    },
    listenerCount: (event: string) => listeners.get(event)?.size ?? 0,
    async start(p: ModeProfile) { rec('start', p); },
    setProfile(p: ModeProfile) { rec('setProfile', p); },
    stop() { rec('stop'); },
    setCrossingBearing(b: number | null) { rec('setCrossingBearing', b); },
    setCourseReference(b: number | null) { rec('setCourseReference', b); },
    setBodyOffsetDeg(d: number) { rec('setBodyOffsetDeg', d); },
    setKnownSigns(w: string[]) { rec('setKnownSigns', w); },
    async snapshotJPEG(w: number) { rec('snapshotJPEG', w); return { base64: 'AAAA', width: w, height: (w * 3) / 4, seq: 1, timestamp: 0 }; },
    getTrackingState() { return 'NORMAL' as const; },
    getStats() { return { detectorFps: 15, depthFps: 10, ocrFps: 3, frameToEventMs: 80, thermalState: 'nominal' }; },
    async startDebugExport() {},
    async stopDebugExport() { return null; },
    nativeLog() { return []; },
  };
  return native as typeof native & PerceptionNativeModule;
}

describe('profile (pure)', () => {
  it('maps every AppMode per 01 §7 (AT_CURB → APPROACH_CROSSING, TRANSITION → OUTDOOR_NAV, AT_ITEM / CHECKOUT_NAV → INDOOR_NAV)', () => {
    expect(profileForMode('AT_CURB')).toBe('APPROACH_CROSSING');
    expect(profileForMode('TRANSITION')).toBe('OUTDOOR_NAV');
    expect(profileForMode('AT_ITEM')).toBe('INDOOR_NAV');
    expect(profileForMode('CHECKOUT_NAV')).toBe('INDOOR_NAV');
    expect(profileForMode('ITEM_PICKUP')).toBe('ITEM_PICKUP');
    expect(profileForMode('ONBOARDING')).toBe('IDLE');
    expect(profileForMode('DONE')).toBe('IDLE');
    expect(profileForMode('GUIDED_TASK')).toBe('INDOOR_NAV');
    expect(Object.keys(PROFILE_FOR_MODE)).toHaveLength(13);
  });
  it('vehicle cache keys and text', () => {
    expect(vehicleCacheKey('LEFT')).toBe('vehicle_left');
    expect(vehicleCacheKey('CENTER')).toBe('vehicle_ahead');
    expect(vehicleCacheKey('RIGHT')).toBe('vehicle_right');
    expect(vehicleText('RIGHT')).toBe('Vehicle right.');
  });
  it('obstacle reflex: NEAR + closing only; phrase only in the indoor profiles', () => {
    const closing = { closingRate: 0.2 };
    const still = { closingRate: 0 };
    expect(obstacleReflexFor('INDOOR_NAV', { distanceClass: 'NEAR' }, closing)).toBe('STOP_AND_SPEAK');
    expect(obstacleReflexFor('ITEM_PICKUP', { distanceClass: 'NEAR' }, closing)).toBe('STOP_AND_SPEAK');
    expect(obstacleReflexFor('OUTDOOR_NAV', { distanceClass: 'NEAR' }, closing)).toBe('STOP_ONLY');
    expect(obstacleReflexFor('APPROACH_CROSSING', { distanceClass: 'NEAR' }, closing)).toBe('STOP_ONLY');
    expect(obstacleReflexFor('CROSSING', { distanceClass: 'NEAR' }, closing)).toBe('STOP_ONLY');
    expect(obstacleReflexFor('INDOOR_NAV', { distanceClass: 'NEAR' }, still)).toBe('NONE');
    expect(obstacleReflexFor('INDOOR_NAV', { distanceClass: 'NEAR' }, null)).toBe('NONE');
    expect(obstacleReflexFor('INDOOR_NAV', { distanceClass: 'MID' }, closing)).toBe('NONE');
    expect(obstacleReflexFor('IDLE', { distanceClass: 'NEAR' }, closing)).toBe('NONE');
    // The indoor schedule runs in IDLE for the awareness loop; the reflex stays quiet there.
    expect(obstacleReflexFor('INDOOR_NAV', { distanceClass: 'NEAR' }, closing, 'IDLE')).toBe('NONE');
    expect(obstacleReflexFor('INDOOR_NAV', { distanceClass: 'NEAR' }, closing, 'DONE')).toBe('NONE');
    expect(obstacleReflexFor('INDOOR_NAV', { distanceClass: 'NEAR' }, closing, 'GUIDED_TASK')).toBe('STOP_AND_SPEAK');
    expect(profileForMode('IDLE')).toBe('AWARE');
    expect(obstacleReflexFor('AWARE', { distanceClass: 'NEAR' }, closing, 'GUIDED_TASK')).toBe('STOP_AND_SPEAK');
  });
});

describe('createNativePerceptionService', () => {
  it('forwards every method and unwraps the array / tracking envelopes', async () => {
    const native = fakeNative();
    const svc = createNativePerceptionService(native);
    await svc.start('OUTDOOR_NAV');
    svc.setProfile('CROSSING');
    svc.setCrossingBearing(91.5);
    svc.setCrossingBearing(null);
    svc.setCourseReference({ bearingDeg: 12 });
    svc.setCourseReference(null);
    svc.setBodyOffsetDeg(-4);
    svc.setKnownSigns(['3', 'DAIRY', '3', '']);
    expect(native.calls).toEqual([
      ['start', ['OUTDOOR_NAV']], ['setProfile', ['CROSSING']], ['setCrossingBearing', [91.5]], ['setCrossingBearing', [null]],
      ['setCourseReference', [12]], ['setCourseReference', [null]], ['setBodyOffsetDeg', [-4]], ['setKnownSigns', [['3', 'DAIRY']]],
    ]);
    const ocr: unknown[] = [];
    const det: unknown[] = [];
    const trk: unknown[] = [];
    svc.onOcrText((r) => ocr.push(r));
    svc.onDetections((d) => det.push(d));
    svc.onTrackingState((s) => trk.push(s));
    native.fire('onOcrText', { items: [{ text: '3 DAIRY', box: [0, 0, 0.1, 0.1], confidence: 0.9, timestamp: 1 }] });
    native.fire('onDetections', { items: [] });
    native.fire('onTrackingState', { state: 'LIMITED' });
    expect(ocr).toEqual([[{ text: '3 DAIRY', box: [0, 0, 0.1, 0.1], confidence: 0.9, timestamp: 1 }]]);
    expect(det).toEqual([[]]);
    expect(trk).toEqual(['LIMITED']);
    expect(svc.getStats().detectorFps).toBe(15);
    expect((await svc.snapshotJPEG(640)).width).toBe(640);
    await expect(svc.snapshotJPEG(700 as unknown as 640)).rejects.toThrow(/512 \| 640 \| 768 \| 1024/);
  });
  it('the factory prefers the mock and otherwise needs a native module', () => {
    const mock = createNativePerceptionService(fakeNative());
    expect(createPerceptionService({ mock })).toBe(mock);
    expect(() => createPerceptionService({ native: null })).toThrow(/EXPO_PUBLIC_MOCK/);
    expect(createPerceptionService({ native: fakeNative() })).toBeDefined();
  });
});

describe('bindPerceptionToApp', () => {
  function rig(healthIntervalMs?: number, isForeground?: () => boolean) {
    const native = fakeNative();
    const perception = createNativePerceptionService(native);
    const bus = createEventBus();
    const events: AppEvent[] = [];
    bus.onAny((r) => events.push(r.event));
    const store = createAppStore({ bus, warn: () => {} });
    const played: string[] = [];
    const said: SpeechRequest[] = [];
    const order: string[] = [];
    const haptics = { play: (p: string) => { played.push(p); order.push(`haptic:${p}`); }, startCourse: () => {}, stopCourse: () => {} };
    const speech = {
      say: (r: SpeechRequest) => { said.push(r); order.push(`say:${r.cacheKey ?? r.text}`); },
      playStream: () => {}, clearQueue: () => {}, isSpeaking: () => false, setRate: () => {},
    };
    bus.onAny((r) => order.push(`bus:${r.event.type}`));
    const binding = bindPerceptionToApp({ perception, bus, store, haptics: haptics as never, speech, healthIntervalMs, isForeground });
    return { native, perception, bus, events, store, played, said, order, binding };
  }

  it('recovers a silent detector twice, then stops retrying; empty detections count as healthy', async () => {
    jest.useFakeTimers();
    const r = rig(5000, () => true);
    await jest.advanceTimersByTimeAsync(10_000);
    r.native.fire('onDetections', { items: [] });
    await jest.advanceTimersByTimeAsync(10_000);
    expect(r.native.calls.filter((c) => c[0] === 'start')).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(r.native.calls.filter((c) => c[0] === 'start')).toHaveLength(3);
    expect(r.events.some((e) => e.type === 'ERROR' && e.scope === 'perception.recovery')).toBe(true);
    r.binding.dispose();
    jest.useRealTimers();
  });

  it('does not restart the camera while the app is backgrounded', async () => {
    jest.useFakeTimers();
    const r = rig(5000, () => false);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(r.native.calls.filter((c) => c[0] === 'start')).toHaveLength(1);
    r.binding.dispose();
    jest.useRealTimers();
  });

  it('starts at once (IDLE runs the AWARE schedule for the awareness loop) and follows the mode → profile table without anyone passing mode', async () => {
    const r = rig();
    await Promise.resolve();
    expect(r.native.calls.filter((c) => c[0] === 'start')).toEqual([['start', ['AWARE']]]);
    r.store.setState({ mode: 'OUTDOOR_NAV' });
    r.store.setState({ mode: 'APPROACH_CROSSING' });
    r.store.setState({ mode: 'AT_CURB' });          // same profile: no extra call
    r.store.setState({ mode: 'CROSSING' });
    r.store.setState({ mode: 'OUTDOOR_NAV' });
    r.store.setState({ mode: 'TRANSITION' });       // OUTDOOR_NAV again: no call
    r.store.setState({ mode: 'INDOOR_NAV' });
    r.store.setState({ mode: 'AT_ITEM' });          // INDOOR_NAV: no call
    r.store.setState({ mode: 'ITEM_PICKUP' });
    r.store.setState({ mode: 'CHECKOUT_NAV' });
    r.store.setState({ mode: 'DONE' });             // pauses (IDLE), does not stop
    const profiles = r.native.calls.filter((c) => c[0] === 'setProfile').map((c) => c[1][0]);
    expect(profiles).toEqual(['OUTDOOR_NAV', 'APPROACH_CROSSING', 'CROSSING', 'OUTDOOR_NAV', 'INDOOR_NAV', 'ITEM_PICKUP', 'INDOOR_NAV', 'IDLE']);
    expect(r.native.calls.some((c) => c[0] === 'stop')).toBe(false);
    r.binding.dispose();
    expect(r.native.calls.some((c) => c[0] === 'stop')).toBe(true);
  });

  it('vehicle reflex: STOP, then one CRITICAL cached phrase with dedupeKey/cooldown, then the bus event — in that order', () => {
    const r = rig();
    r.store.setState({ mode: 'AT_CURB' });
    r.native.fire('onVehicleApproaching', { direction: 'RIGHT', trackId: 7, growth: 1.6 });
    expect(r.order).toEqual(['haptic:STOP', 'say:vehicle_right', 'bus:VEHICLE_APPROACHING']);
    expect(r.said[0]).toEqual({
      text: 'Vehicle right.', priority: 'CRITICAL', cacheKey: 'vehicle_right', interrupt: true, dedupeKey: 'vehicle-RIGHT', cooldownMs: 4000,
    });
    expect(r.events).toContainEqual({ type: 'VEHICLE_APPROACHING', direction: 'RIGHT', trackId: 7 });
  });

  it('obstacle reflex indoors: the described line when the app has one, suppressed when it would be noise, the event always (rounds 13–14)', () => {
    const native = fakeNative();
    const perception = createNativePerceptionService(native);
    const bus = createEventBus();
    const store = createAppStore({ bus, warn: () => {} });
    const played: string[] = [];
    const said: SpeechRequest[] = [];
    let noise = false;
    let words: string | null = 'Chair ahead, close. Open on your right.';
    bindPerceptionToApp({
      perception, bus, store,
      haptics: { play: (p: string) => { played.push(p); }, startCourse: () => {}, stopCourse: () => {} } as never,
      speech: { say: (r: SpeechRequest) => { said.push(r); }, playStream: () => {}, clearQueue: () => {}, isSpeaking: () => false, setRate: () => {} },
      describeObstacle: () => words,
      suppressObstacle: () => noise,
    });
    const events: AppEvent[] = [];
    bus.onAny((r) => events.push(r.event));
    store.setState({ mode: 'TRANSITION' });
    store.setState({ mode: 'INDOOR_NAV' });
    native.fire('onDepth', { centerBottomRel: 0.9, closingRate: 0.3, timestamp: 1 });
    native.fire('onObstacleAhead', { distanceClass: 'NEAR', direction: 'CENTER' });
    expect(played).toEqual(['STOP']);
    expect(said[0]).toMatchObject({ text: 'Chair ahead, close. Open on your right.', priority: 'CRITICAL', interrupt: true, dedupeKey: 'obstacle-near', cooldownMs: 4000 });
    expect(said[0]!.cacheKey).toBeUndefined();
    // The same words again: a longer cooldown rides on the request.
    native.fire('onObstacleAhead', { distanceClass: 'NEAR', direction: 'CENTER' });
    expect(said[1]!.cooldownMs).toBe(8000);
    // Standing still / at a surface / walking up to the thing: nothing felt or said, the event still goes out.
    noise = true;
    native.fire('onObstacleAhead', { distanceClass: 'NEAR', direction: 'CENTER' });
    expect(played).toEqual(['STOP', 'STOP']);
    expect(said).toHaveLength(2);
    expect(events.filter((e) => e.type === 'OBSTACLE_AHEAD')).toHaveLength(3);
    // No description available: the cached phrase.
    noise = false; words = null;
    native.fire('onObstacleAhead', { distanceClass: 'NEAR', direction: 'CENTER' });
    expect(said[2]).toMatchObject({ text: 'Obstacle ahead.', cacheKey: 'obstacle_ahead' });
  });

  it('obstacle reflex: NEAR + closing → STOP only outdoors, STOP + obstacle_ahead indoors; bus event always', () => {
    const r = rig();
    r.store.setState({ mode: 'OUTDOOR_NAV' });
    r.native.fire('onDepth', { centerBottomRel: 0.9, closingRate: 0.3, timestamp: 1 });
    r.native.fire('onObstacleAhead', { distanceClass: 'NEAR', direction: 'CENTER' });
    expect(r.played).toEqual(['STOP']);
    expect(r.said).toEqual([]);
    expect(r.events.filter((e) => e.type === 'OBSTACLE_AHEAD')).toHaveLength(1);

    r.store.setState({ mode: 'TRANSITION' });
    r.store.setState({ mode: 'INDOOR_NAV' });
    r.native.fire('onObstacleAhead', { distanceClass: 'NEAR', direction: 'LEFT' });
    expect(r.played).toEqual(['STOP', 'STOP']);
    expect(r.said.map((s) => s.cacheKey)).toEqual(['obstacle_ahead']);
    expect(r.said[0]!.priority).toBe('CRITICAL');

    // Not closing → no STOP, still the bookkeeping event (INFO handling is obstacles.ts's job).
    r.native.fire('onDepth', { centerBottomRel: 0.9, closingRate: -0.1, timestamp: 2 });
    r.native.fire('onObstacleAhead', { distanceClass: 'NEAR', direction: 'CENTER' });
    r.native.fire('onObstacleAhead', { distanceClass: 'MID', direction: 'CENTER' });
    expect(r.played).toEqual(['STOP', 'STOP']);
    expect(r.events.filter((e) => e.type === 'OBSTACLE_AHEAD')).toHaveLength(4);
  });

  it('re-broadcasts SIGNAL_STATE and HAZARD; pushes bodyOffsetDeg from the store', () => {
    const r = rig();
    r.native.fire('onSignalState', { state: 'WALK', fresh: true, confidence: 0.97, nOfM: 6 });
    r.native.fire('onHazard', { kind: 'PERSON_AHEAD', direction: 'CENTER' });
    expect(r.events).toContainEqual({ type: 'SIGNAL_STATE', state: 'WALK', fresh: true, confidence: 0.97 });
    expect(r.events).toContainEqual({ type: 'HAZARD', kind: 'PERSON_AHEAD', direction: 'CENTER' });
    expect(r.played).toEqual([]);
    r.store.getState().setBodyOffsetDeg(7);
    expect(r.native.calls.filter((c) => c[0] === 'setBodyOffsetDeg').map((c) => c[1][0])).toEqual([0, 7]);
  });

  it('a rejected start() is reported on the bus, not thrown', async () => {
    const native = fakeNative();
    native.start = async () => { throw new Error('ARKit unavailable'); };
    const perception = createNativePerceptionService(native);
    const bus = createEventBus();
    const errors: AppEvent[] = [];
    bus.on('ERROR', (e) => errors.push(e));
    const store = createAppStore({ bus, warn: () => {} });
    bindPerceptionToApp({ perception, bus, store, haptics: { play: () => {}, startCourse: () => {}, stopCourse: () => {} }, speech: { say: () => {}, playStream: () => {}, clearQueue: () => {}, isSpeaking: () => false, setRate: () => {} } });
    store.setState({ mode: 'OUTDOOR_NAV' });
    await new Promise((r) => setTimeout(r, 0));   // the start → log → report chain is a few microtasks long
    expect(errors).toEqual([{ type: 'ERROR', scope: 'perception.start', message: 'ARKit unavailable' }]);
  });
});

describe('missing on-device models are announced, not suffered in silence', () => {
  const present = ['videoFormat=1920x1440@30 wide', 'models: detector=present signal=MISSING depth=present segmentation=MISSING'];
  const blind = ['videoFormat=1920x1440@30 wide', 'models: detector=MISSING signal=MISSING depth=MISSING segmentation=MISSING'];

  it('says nothing when the models that matter are there', () => {
    // signal and segmentation are expected to be absent: untrained, and optional.
    expect(missingRequiredModels(present)).toEqual([]);
  });

  it('names the stages that leave the app blind', () => {
    expect(missingRequiredModels(blind)).toEqual(['detector', 'depth']);
    expect(missingRequiredModels(['models: detector=MISSING depth=present'])).toEqual(['detector']);
  });

  it('stays quiet on a build whose engine never reported models', () => {
    // An older binary, or mock mode: absence of the line is not absence of the model.
    expect(missingRequiredModels(['videoFormat=1920x1440@30 wide'])).toBeNull();
    expect(missingRequiredModels([])).toBeNull();
  });

  it('reads the pedestrian-signal model presence for the crossing safety guard', () => {
    expect(pedSignalModelPresent(present)).toBe(false);   // signal=MISSING (untrained today)
    expect(pedSignalModelPresent(['models: detector=present depth=present signal=present'])).toBe(true);
    expect(pedSignalModelPresent(['videoFormat=1920x1440@30 wide'])).toBeNull();   // no models line → unknown → trusted
    expect(pedSignalModelPresent([])).toBeNull();
  });

  it('reports once, with the command that fixes it', () => {
    const calls: Array<{ scope: string; message: string }> = [];
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      reportMissingModels(blind, (scope, err) => calls.push({ scope, message: (err as Error).message }));
      expect(calls).toHaveLength(1);
      expect(calls[0].scope).toBe('perception.models');
      expect(calls[0].message).toContain('cannot recognise objects');
      expect(calls[0].message).toContain('npm run models:coco');
      expect(warn).toHaveBeenCalledTimes(1);

      calls.length = 0;
      reportMissingModels(present, (scope, err) => calls.push({ scope, message: (err as Error).message }));
      expect(calls).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});
