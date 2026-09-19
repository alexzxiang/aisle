/**
 * The expo-audio / expo-speech / expo-file-system backend for SpeechService.
 *
 * Kept apart from `speech.ts` so the queue is testable without native modules.
 * Three players share one audio session (configured by `audio.ts`):
 *   - cached: one AudioPlayer per bundled phrase, created up front at app start
 *     so replay is `seekTo(0); play()` and cached phrase → audio out stays
 *     under 50 ms (01 §11);
 *   - file: prefetched or live-synthesized clips under the cache directory;
 *   - url: the proxy's Tier-1 stream relay (`GET /api/tts/stream/<streamId>`);
 *   - expo-speech: the offline fallback; iOS mutes it when the ring switch is
 *     silent, which onboarding says out loud.
 *
 * `synthesize` POSTs `/api/tts` and writes the mp3 to `<cache>/tts/<hash>.mp3`.
 * React Native's fetch cannot consume a chunked body, so this path is
 * whole-file by design (07 §2); streaming goes through `playUrl`.
 */
import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import * as Speech from 'expo-speech';
import { Directory, File, Paths } from 'expo-file-system';
import { AUDIO_MANIFEST } from '../../assets/audio/manifest';
import { fnv1a32, type PlaybackHandle, type SpeechBackend } from './speech';

export interface ExpoSpeechBackendOptions {
  proxyUrl: string;
  /** Override the bundled manifest (tests / partial generation). */
  manifest?: Readonly<Record<string, number>>;
  fetchImpl?: typeof fetch;
}

const noop = (): void => {};

function attachDone(player: AudioPlayer, onDone: () => void): () => void {
  let done = false;
  const sub = player.addListener('playbackStatusUpdate', (status) => {
    if (done) return;
    if (status.didJustFinish || (status.error !== null && status.error !== undefined)) {
      done = true;
      sub.remove();
      onDone();
    }
  });
  return () => {
    if (done) return;
    done = true;
    sub.remove();
  };
}

function applyRate(player: AudioPlayer, rate: number): void {
  try {
    player.setPlaybackRate(rate, 'high');
  } catch {
    // older runtimes without pitch correction still play at 1.0
  }
}

export function createExpoSpeechBackend(opts: ExpoSpeechBackendOptions): SpeechBackend {
  const manifest = opts.manifest ?? AUDIO_MANIFEST;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const cached = new Map<string, AudioPlayer>();
  const files = new Map<string, AudioPlayer>();

  // Preload every bundled phrase at construction (02 Task 4: "Preload every file at module scope").
  for (const key of Object.keys(manifest)) {
    try {
      cached.set(key, createAudioPlayer(manifest[key], { keepAudioSessionActive: true, updateInterval: 100 }));
    } catch {
      // A bad asset must not take the whole service down; the key falls back to expo-speech.
    }
  }

  const playPlayer = (player: AudioPlayer, backend: PlaybackHandle['backend'], rate: number, onDone: () => void, onFinal?: () => void): PlaybackHandle => {
    applyRate(player, rate);
    const detach = attachDone(player, () => {
      onFinal?.();
      onDone();
    });
    // pause → seek → play: a finished player will not restart from its end position.
    try {
      player.pause();
    } catch {
      // not yet loaded: play() below still works
    }
    player.seekTo(0).then(() => player.play(), () => player.play());
    return {
      backend,
      stop() {
        detach();
        try {
          player.pause();
        } catch {
          // already released
        }
        onFinal?.();
      },
    };
  };

  const ttsDir = (): Directory => {
    const dir = new Directory(Paths.cache, 'tts');
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    return dir;
  };

  return {
    hasCached: (key) => cached.has(key),

    playCached(key, rate, onDone) {
      const player = cached.get(key);
      if (!player) return null;
      try {
        return playPlayer(player, 'cached', rate, onDone);
      } catch {
        return null;
      }
    },

    playFile(uri, rate, onDone) {
      try {
        let player = files.get(uri);
        if (!player) {
          player = createAudioPlayer({ uri }, { keepAudioSessionActive: true, updateInterval: 100 });
          files.set(uri, player);
        }
        return playPlayer(player, 'file', rate, onDone);
      } catch {
        return null;
      }
    },

    playUrl(url, rate, onDone) {
      try {
        const player = createAudioPlayer({ uri: url }, { keepAudioSessionActive: true, updateInterval: 100 });
        const release = (): void => {
          try {
            player.remove();
          } catch {
            // already released
          }
        };
        return playPlayer(player, 'stream', rate, onDone, release);
      } catch {
        return null;
      }
    },

    speak(text, rate, onDone) {
      let finished = false;
      const done = (): void => {
        if (finished) return;
        finished = true;
        onDone();
      };
      try {
        Speech.speak(text, {
          language: 'en-US',
          rate,
          onDone: done,
          onStopped: done,
          onError: done,
        });
      } catch {
        // Even a throwing TTS engine must release the queue slot.
        setTimeout(done, 0);
      }
      return {
        backend: 'expo-speech',
        stop() {
          Speech.stop().catch(noop);
          done();
        },
      };
    },

    async synthesize(text, timeoutMs) {
      const name = `${fnv1a32(text)}.mp3`;
      try {
        const dir = ttsDir();
        const file = new File(dir, name);
        if (file.exists && file.size > 0) return file.uri;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetchImpl(`${opts.proxyUrl}/api/tts`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'audio/mpeg' },
            body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5', output_format: 'mp3_44100_64' }),
            signal: controller.signal,
          });
          if (!res.ok) return null;
          const buf = await res.arrayBuffer();
          if (buf.byteLength === 0) return null;
          file.write(new Uint8Array(buf));
          return file.uri;
        } finally {
          clearTimeout(timer);
        }
      } catch {
        return null;
      }
    },

    streamUrl: (streamId) => `${opts.proxyUrl}/api/tts/stream/${encodeURIComponent(streamId)}`,
  };
}
