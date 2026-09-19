/**
 * Optional ports the screens use when the composition root hands them over.
 *
 * `src/core/services.ts` holds the six registry services (haptics, speech,
 * sensors, perception, bus, store). The audio siblings (beacon, ticker),
 * push-to-talk and the latency counters are owned by other A-side modules that
 * the integrator wires in `App.tsx`; the screens must render and stay useful
 * without them (stub mode, mock mode, a cut feature). So they arrive as props,
 * typed here, and every screen treats them as optional.
 */
import type { SignalState } from '../core/contracts';

/** src/core/audio.ts beacon (02 Task 5). Direction, never distance. */
export interface BeaconPort {
  setTarget(target: { bearingDeg: number } | null): void;
}

/** src/core/audio.ts signal-state ticker (02 Task 5). Tempo carries the state. */
export interface TickerPort {
  setState(state: SignalState): void;
}

/** The DebugPanel mute overrides (02 Task 9). Optional on either channel. */
export interface MutablePort {
  setMuted(muted: boolean): void;
  isMuted(): boolean;
}

/** Both audio siblings, as the screens see them. `src/core/audio.ts` satisfies this as is. */
export interface AudioPorts {
  beacon?: BeaconPort & Partial<MutablePort>;
  ticker?: TickerPort & Partial<MutablePort>;
}

/** src/core/voice.ts push-to-talk (02 Task 7). */
export interface VoicePort {
  /** Called on press-in. Resolves when recognition has started. */
  start(): Promise<void> | void;
  /** Called on press-out (and on unmount, so the mic never stays open). */
  stop(): Promise<void> | void;
  /** Live partial transcript, when the recognizer provides one. */
  onPartial?(cb: (text: string) => void): () => void;
}

/** What the DebugPanel shows that no registry service can answer yet. */
export interface DebugMetrics {
  /** Tier 0: frame -> event, per 01 section 11. */
  tier0FrameToEventMs?: number | null;
  /** Tier 1 Claude end-to-end. */
  tier1LastMs?: number | null;
  tier1P95Ms?: number | null;
  /** Tier 2 Nemotron first token, and whether the last answer was the fallback. */
  tier2FirstTokenMs?: number | null;
  tier2Fallback?: boolean | null;
  /** SpeechService counters (02 Task 4). */
  utterancesPerMinute?: number | null;
  lastSpeechBackend?: string | null;
  policyDroppedCount?: number | null;
  /** Store counter, when the caller would rather pass it than read the store. */
  illegalTransitions?: number | null;
  batteryPercent?: number | null;
}

/** What the onboarding demonstrations need: the same two channels. */
export type OnboardingPorts = AudioPorts;

/**
 * One line of the conversation (src/core/conversation.ts `ConversationEntry`,
 * restated structurally so the screens compile and test before that module
 * lands and never import it).
 */
export interface ConversationEntryLike {
  id: string;
  role: 'you' | 'aisle';
  text: string;
  t: number;
  source?: 'voice' | 'keyboard' | 'speech' | 'describe' | 'prompt';
}

/** src/core/conversation.ts `ConversationLog`, the two members the screens read. */
export interface ConversationLogPort {
  entries(): readonly ConversationEntryLike[];
  subscribe(cb: (entries: readonly ConversationEntryLike[]) => void): () => void;
}

/** src/core/describer.ts `describeNow`: speaks and logs a description, resolves to it (or null when nothing was said). */
export type DescribeNow = () => Promise<string | null> | void;
