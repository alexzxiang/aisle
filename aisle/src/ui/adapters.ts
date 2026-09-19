/**
 * Adapters from the A-side services in `src/core/` to the small ports the
 * screens take as props (`ports.ts`). The composition root calls these once:
 *
 *   <Root voice={voicePortFrom(voiceInput)} audio={audioPortsFrom(channels)} … />
 *
 * They are structural: `audio.ts` already satisfies `AudioPorts`, and
 * `voice.ts` differs only in verb (`begin`/`end` vs `start`/`stop`) and in
 * returning an outcome the screens do not need. Nothing here touches a
 * singleton, so the adapters are testable with plain objects.
 */
import type { AudioPorts, VoicePort } from './ports';

/** The subset of `src/core/voice.ts` VoiceInput the talk button drives. */
export interface VoiceInputLike {
  begin(): Promise<void>;
  end(): Promise<unknown>;
  cancel(): void;
}

export interface VoicePortOptions {
  /** Where a failed begin/end lands (never the UI). Default: swallowed. */
  onError?(stage: 'start' | 'stop', err: unknown): void;
}

/**
 * Press-in → `begin()`; press-out → `end()` (STT → parseIntent → reply, all
 * inside voice.ts). A `begin` that rejects is cancelled so the mic and the
 * recording-mode audio session are never left open, which would keep haptics
 * suppressed (02 Task 5).
 */
export function voicePortFrom(input: VoiceInputLike, opts: VoicePortOptions = {}): VoicePort {
  let starting: Promise<void> | null = null;
  return {
    start() {
      starting = input.begin().catch((err: unknown) => {
        opts.onError?.('start', err);
        input.cancel();
      });
      return starting;
    },
    async stop() {
      // Release cannot overtake press: wait for begin() to settle first.
      if (starting) {
        await starting;
        starting = null;
      }
      try {
        await input.end();
      } catch (err) {
        opts.onError?.('stop', err);
        input.cancel();
      }
    },
  };
}

/** `src/core/audio.ts` AudioChannels (or any beacon/ticker pair) → the screens' ports. */
export function audioPortsFrom(channels: { beacon?: AudioPorts['beacon']; ticker?: AudioPorts['ticker'] } | null | undefined): AudioPorts {
  if (!channels) return {};
  const out: AudioPorts = {};
  if (channels.beacon) out.beacon = channels.beacon;
  if (channels.ticker) out.ticker = channels.ticker;
  return out;
}
