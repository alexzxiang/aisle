import { createStubServices, setStubLogging } from './stubs';

describe('stubs', () => {
  beforeAll(() => setStubLogging(false));

  it('are inert but record every call', async () => {
    const s = createStubServices();
    s.haptics.play('TURN');
    s.haptics.startCourse(() => ({ headingErrorDeg: 0, crossTrackM: 0, roadSide: 'NONE', compassAccuracy: 3 }));
    s.haptics.stopCourse();
    s.speech.say({ text: 'Turn right now', priority: 'NAV', cacheKey: 'turn_right_now' });
    expect(s.speech.isSpeaking()).toBe(false);
    const off = s.sensors.subscribeHeading(() => {});
    off();
    expect(s.sensors.getHeading()).toBeNull();
    expect(s.sensors.getFusedHeadingDeg()).toBeNull();
    const err = s.sensors.courseErrorFor({ bearingDeg: 90, roadSide: 'RIGHT' })();
    expect(err).toEqual({ headingErrorDeg: 0, crossTrackM: 0, roadSide: 'RIGHT', compassAccuracy: 0 });
    await expect(s.sensors.calibrateBodyOffset()).resolves.toEqual({ offsetDeg: 0, ok: false });

    await s.perception.start('OUTDOOR_NAV');
    const snap = await s.perception.snapshotJPEG(512);
    expect(snap.seq).toBe(1);
    expect(snap.base64.length).toBeGreaterThan(0);
    expect(s.perception.getTrackingState()).toBe('NOT_AVAILABLE');
    expect(s.perception.getStats().detectorFps).toBe(0);
    s.perception.stop();

    const methods = s.log.calls.map((c) => `${c.service}.${c.method}`);
    expect(methods).toEqual(expect.arrayContaining([
      'haptics.play', 'haptics.startCourse', 'haptics.stopCourse', 'speech.say',
      'sensors.subscribeHeading', 'sensors.courseErrorFor', 'sensors.calibrateBodyOffset',
      'perception.start', 'perception.snapshotJPEG', 'perception.stop',
    ]));
  });

  it('ships a real bus', () => {
    const s = createStubServices();
    const cb = jest.fn();
    s.bus.on('ERROR', cb);
    s.bus.emit({ type: 'ERROR', scope: 't', message: 'm' });
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
