jest.mock('expo-audio', () => ({ createAudioPlayer: jest.fn() }));
jest.mock('expo-speech', () => ({ speak: jest.fn(), stop: jest.fn(async () => {}) }));
jest.mock('expo-file-system', () => ({ Directory: jest.fn(), File: jest.fn(), Paths: { cache: 'cache' } }));
jest.mock('../../assets/audio/manifest', () => ({ AUDIO_MANIFEST: {} }));

import { createAudioPlayer } from 'expo-audio';
import * as Speech from 'expo-speech';
import { createExpoSpeechBackend } from './speechBackend';

describe('native speech playback', () => {
  beforeEach(() => jest.clearAllMocks());

  it('loads task audio lazily, at full volume, and cannot play after cancellation during seek', async () => {
    let finishSeek!: () => void;
    const player = {
      volume: 0.2, pause: jest.fn(), play: jest.fn(), setPlaybackRate: jest.fn(),
      addListener: jest.fn(() => ({ remove: jest.fn() })),
      seekTo: jest.fn(() => new Promise<void>((resolve) => { finishSeek = resolve; })),
    };
    (createAudioPlayer as jest.Mock).mockReturnValue(player);
    const backend = createExpoSpeechBackend({ proxyUrl: 'http://localhost', manifest: { guide_fridge_arrived: 1 } });
    expect(backend.hasCached('guide_fridge_arrived')).toBe(true);
    expect(createAudioPlayer).not.toHaveBeenCalled();
    const handle = backend.playCached('guide_fridge_arrived', 1, jest.fn());
    expect(player.volume).toBe(1);
    handle!.stop();
    finishSeek();
    await Promise.resolve();
    expect(player.play).not.toHaveBeenCalled();
    backend.playCached('guide_fridge_arrived', 1, jest.fn());
    finishSeek();
    await Promise.resolve();
    expect(player.play).toHaveBeenCalledTimes(1);
    expect(createAudioPlayer).toHaveBeenCalledTimes(1);
  });

  it('uses the application audio session and full volume for the offline fallback', () => {
    createExpoSpeechBackend({ proxyUrl: 'http://localhost' }).speak('Stop.', 1, jest.fn());
    expect(Speech.speak).toHaveBeenCalledWith('Stop.', expect.objectContaining({ volume: 1, useApplicationAudioSession: true }));
  });

  it('releases the queue without an unhandled rejection when native play loses its session', async () => {
    const done = jest.fn();
    (createAudioPlayer as jest.Mock).mockReturnValue({
      volume: 1, pause: jest.fn(), setPlaybackRate: jest.fn(),
      addListener: () => ({ remove: jest.fn() }), seekTo: async () => {},
      play: () => { throw new Error('Session lookup failed'); },
    });
    const backend = createExpoSpeechBackend({ proxyUrl: 'http://localhost', manifest: { guide_fridge_arrived: 1 } });
    backend.playCached('guide_fridge_arrived', 1, done);
    await Promise.resolve();
    expect(done).toHaveBeenCalledTimes(1);
  });
});
