/**
 * ConversationLog — the transcript blurb's data ("what the user said, what
 * Aisle said"). A tiny append-only log with a React hook, registered in
 * `services.ts` under `conversation`.
 *
 * Who writes:
 *   - `speech.ts` pushes every utterance that actually starts playing (role
 *     'aisle', source 'speech') — policy-, dedupe- and queue-dropped requests
 *     never appear, so the blurb shows what was heard, not what was asked for;
 *   - `voice.ts` pushes the recognized transcript ('you', source 'voice' |
 *     'keyboard') and the reply it chose;
 *   - `describer.ts` pushes scene descriptions (source 'describe');
 *   - `prompts.ts` / `trip.ts` push proactive prompts (source 'prompt').
 *
 * Because a prompt is often pushed by its producer *and* by the speech queue
 * when it plays, an identical text for the same role inside `collapseMs`
 * (default 4 s) is recorded once. Entries are immutable snapshots so
 * `useSyncExternalStore` can compare them by reference.
 */
import { useSyncExternalStore } from 'react';

export type ConversationRole = 'you' | 'aisle';
export type ConversationSource = 'voice' | 'keyboard' | 'speech' | 'describe' | 'prompt';

export interface ConversationEntry {
  id: string;
  role: ConversationRole;
  text: string;
  t: number;
  source?: ConversationSource;
}

export interface ConversationLog {
  entries(): readonly ConversationEntry[];
  subscribe(cb: (entries: readonly ConversationEntry[]) => void): () => void;
  pushUser(text: string, source?: ConversationEntry['source']): void;
  pushAisle(text: string, source?: ConversationEntry['source']): void;
  clear(): void;
}

export interface ConversationLogOptions {
  /** Entries kept (oldest dropped). Default 50. */
  max?: number;
  now?: () => number;
  /** Same role + same text inside this window is one entry. Default 4000; 0 disables. */
  collapseMs?: number;
}

export const DEFAULT_CONVERSATION_MAX = 50;
export const DEFAULT_COLLAPSE_MS = 4000;

const EMPTY: readonly ConversationEntry[] = Object.freeze([]);

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function createConversationLog(opts: ConversationLogOptions = {}): ConversationLog {
  const max = Math.max(1, opts.max ?? DEFAULT_CONVERSATION_MAX);
  const now = opts.now ?? Date.now;
  const collapseMs = opts.collapseMs ?? DEFAULT_COLLAPSE_MS;
  let entries: readonly ConversationEntry[] = EMPTY;
  let nextId = 1;
  const listeners = new Set<(entries: readonly ConversationEntry[]) => void>();

  const notify = (): void => {
    for (const cb of Array.from(listeners)) {
      try {
        cb(entries);
      } catch {
        // a listener that throws must not take the log (or the speaker) down
      }
    }
  };

  const push = (role: ConversationRole, rawText: string, source?: ConversationSource): void => {
    const text = normalize(rawText);
    if (text.length === 0) return;
    const t = now();
    if (collapseMs > 0) {
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const e = entries[i];
        if (t - e.t > collapseMs) break;
        if (e.role === role && e.text === text) return;
      }
    }
    const entry: ConversationEntry = source ? { id: `c${nextId++}`, role, text, t, source } : { id: `c${nextId++}`, role, text, t };
    const next = entries.length >= max ? entries.slice(entries.length - max + 1) : entries.slice();
    next.push(entry);
    entries = Object.freeze(next);
    notify();
  };

  return {
    entries: () => entries,
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    pushUser: (text, source) => push('you', text, source),
    pushAisle: (text, source) => push('aisle', text, source),
    clear() {
      if (entries.length === 0) return;
      entries = EMPTY;
      notify();
    },
  };
}

/** The log as React state: re-renders on every push / clear. */
export function useConversation(log: ConversationLog): readonly ConversationEntry[] {
  return useSyncExternalStore(log.subscribe, log.entries, log.entries);
}
