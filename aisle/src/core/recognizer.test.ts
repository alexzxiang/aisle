import { createExpoRecognizer, type RecognizerHandlers } from './voice';
import { ExpoSpeechRecognitionModule as native } from 'expo-speech-recognition';

jest.mock('expo-speech-recognition', () => ({ ExpoSpeechRecognitionModule: {
  getPermissionsAsync: jest.fn(), requestPermissionsAsync: jest.fn(),
  isRecognitionAvailable: () => true, supportsOnDeviceRecognition: () => true,
  start: jest.fn(), stop: jest.fn(), abort: jest.fn(), addListener: jest.fn(),
} }));

describe('native recognizer startup', () => {
  const listeners = new Map<string, (e: any) => void>();
  const handlers: RecognizerHandlers = { onResult: jest.fn(), onEnd: jest.fn(), onError: jest.fn(), onAudioEnd: jest.fn() };
  const options = { lang: 'en-US', onDevice: false, contextualStrings: ['eggs'], persistAudio: true };
  beforeEach(() => {
    jest.useFakeTimers(); jest.clearAllMocks(); listeners.clear();
    (native.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
    (native.requestPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
    (native.addListener as jest.Mock).mockImplementation((name, callback) => {
      listeners.set(name, callback);
      return { remove: () => listeners.delete(name) };
    });
  });
  afterEach(() => jest.useRealTimers());

  it('loads existing grants before press, avoids repeated permission requests, and reports readiness only on audio capture', async () => {
    const recognizer = createExpoRecognizer();
    expect(native.getPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(native.start).not.toHaveBeenCalled();
    expect(await recognizer.requestPermissions()).toBe(true);
    expect(await recognizer.requestPermissions()).toBe(true);
    expect(native.requestPermissionsAsync).not.toHaveBeenCalled();
    const session = recognizer.listen(options, handlers);
    let ready = false;
    void session.ready!.then(() => { ready = true; });
    await Promise.resolve();
    expect(ready).toBe(false);
    expect(native.start).toHaveBeenCalledWith(expect.objectContaining({ continuous: true, iosCategory: expect.objectContaining({ category: 'playAndRecord' }) }));
    listeners.get('audiostart')!({});
    await session.ready;
    expect(ready).toBe(true);
    session.stop();
    listeners.get('audioend')!({ uri: 'file:///clip.wav' });
    listeners.get('end')!({});
    await session.ended;
    expect(handlers.onAudioEnd).toHaveBeenCalledWith('file:///clip.wav');
    expect(listeners.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('requests missing permission only on press, and rechecks after a native permission error', async () => {
    (native.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false });
    const recognizer = createExpoRecognizer();
    expect(native.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(await recognizer.requestPermissions()).toBe(true);
    const session = recognizer.listen(options, handlers);
    const rejected = expect(session.ready).rejects.toThrow('not-allowed');
    listeners.get('error')!({ error: 'not-allowed' });
    await rejected;
    listeners.get('end')!({});
    (native.requestPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false });
    expect(await recognizer.requestPermissions()).toBe(false);
    expect(native.requestPermissionsAsync).toHaveBeenCalledTimes(2);
  });
});
