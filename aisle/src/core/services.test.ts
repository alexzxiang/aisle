import { createServiceRegistry, services } from './services';
import { createStubHaptics, createStubSpeech } from './stubs';
import { createEventBus } from './bus';

describe('service registry', () => {
  it('stores and returns typed services', () => {
    const reg = createServiceRegistry();
    const haptics = createStubHaptics();
    reg.set('haptics', haptics);
    expect(reg.get('haptics')).toBe(haptics);
    expect(reg.has('haptics')).toBe(true);
    expect(reg.has('speech')).toBe(false);
    expect(reg.tryGet('speech')).toBeUndefined();
    expect(reg.names()).toEqual(['haptics']);
  });

  it('throws loudly for a missing service', () => {
    const reg = createServiceRegistry();
    expect(() => reg.get('perception')).toThrow(/perception/);
  });

  it('setAll registers many and reset clears', () => {
    const reg = createServiceRegistry();
    reg.setAll({ speech: createStubSpeech(), bus: createEventBus() });
    expect(reg.has('speech')).toBe(true);
    expect(reg.has('bus')).toBe(true);
    reg.reset();
    expect(reg.names()).toEqual([]);
  });

  it('exposes one app-wide registry', () => {
    services.reset();
    expect(services.has('bus')).toBe(false);
  });
});
