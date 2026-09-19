/**
 * Persisted preferences (02 Task 2 / Task 10): the four store fields that must
 * survive a relaunch — `firstRun` (gates ONBOARDING and the spoken disclaimer),
 * `trainingMode`, `speechRate` and `bodyOffsetDeg`.
 *
 * Pure codec (`parsePrefs` / `serializePrefs`) plus a store binding that
 * hydrates once at start and writes back, debounced, on every change. The
 * storage is injected: `createExpoPrefsStorage()` is the expo-file-system one
 * (a small JSON file in the app's document directory); tests use memory.
 *
 * Nothing here ever throws into the app: a missing or corrupt file means "first
 * launch", and a failed write is reported through `onError` and retried on the
 * next change.
 */
import type { AppState, AppStore } from './store';
import { clampSpeechRate } from './store';

export const PREFS_VERSION = 1;
export const PREFS_FILE_NAME = 'aisle-prefs.json';
export const PREFS_WRITE_DEBOUNCE_MS = 300;

export interface Prefs {
  firstRun: boolean;
  trainingMode: boolean;
  speechRate: number;
  bodyOffsetDeg: number;
}

export interface PrefsStorage {
  /** The stored text, or null when nothing has been written yet. */
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
}

export const DEFAULT_PREFS: Readonly<Prefs> = Object.freeze({
  firstRun: true,
  trainingMode: true,
  speechRate: 1.0,
  bodyOffsetDeg: 0,
});

const PREF_KEYS: readonly (keyof Prefs)[] = ['firstRun', 'trainingMode', 'speechRate', 'bodyOffsetDeg'];

/** Tolerant: unknown keys ignored, wrong types dropped, rate clamped, offset must be finite. */
export function parsePrefs(text: string | null | undefined): Partial<Prefs> {
  if (!text) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<Prefs> = {};
  if (typeof r.firstRun === 'boolean') out.firstRun = r.firstRun;
  if (typeof r.trainingMode === 'boolean') out.trainingMode = r.trainingMode;
  if (typeof r.speechRate === 'number' && Number.isFinite(r.speechRate)) out.speechRate = clampSpeechRate(r.speechRate);
  if (typeof r.bodyOffsetDeg === 'number' && Number.isFinite(r.bodyOffsetDeg)) out.bodyOffsetDeg = r.bodyOffsetDeg;
  return out;
}

export function serializePrefs(p: Prefs): string {
  return JSON.stringify({ v: PREFS_VERSION, ...p });
}

export function prefsFrom(s: Pick<AppState, 'firstRun' | 'trainingMode' | 'speechRate' | 'bodyOffsetDeg'>): Prefs {
  return { firstRun: s.firstRun, trainingMode: s.trainingMode, speechRate: s.speechRate, bodyOffsetDeg: s.bodyOffsetDeg };
}

export function samePrefs(a: Prefs, b: Prefs): boolean {
  return PREF_KEYS.every((k) => a[k] === b[k]);
}

/** Apply the stored subset to the store through its own actions (never `setState`). */
export function applyPrefs(store: Pick<AppStore, 'getState'>, p: Partial<Prefs>): void {
  const s = store.getState();
  if (p.firstRun !== undefined) s.setFirstRun(p.firstRun);
  if (p.trainingMode !== undefined) s.setTrainingMode(p.trainingMode);
  if (p.speechRate !== undefined) s.setSpeechRate(p.speechRate);
  if (p.bodyOffsetDeg !== undefined) s.setBodyOffsetDeg(p.bodyOffsetDeg);
}

export interface BindPrefsOptions {
  debounceMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  onError?: (stage: 'read' | 'write', err: unknown) => void;
}

export interface PrefsBinding {
  /** Resolves with what was applied (empty when nothing was stored or the file was unreadable). */
  hydrated: Promise<Partial<Prefs>>;
  /** Write now if anything is pending (app background, tests). */
  flush(): Promise<void>;
  dispose(): void;
}

export function bindPrefs(store: AppStore, storage: PrefsStorage, opts: BindPrefsOptions = {}): PrefsBinding {
  const debounceMs = opts.debounceMs ?? PREFS_WRITE_DEBOUNCE_MS;
  const setT = opts.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearT = opts.clearTimeoutFn ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let lastWritten: Prefs | null = null;
  let timer: unknown = null;
  let disposed = false;
  let writing: Promise<void> = Promise.resolve();

  const write = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    const next = prefsFrom(store.getState());
    if (lastWritten && samePrefs(lastWritten, next)) return Promise.resolve();
    lastWritten = next;
    writing = storage.write(serializePrefs(next)).catch((err: unknown) => {
      lastWritten = null; // retry on the next change
      opts.onError?.('write', err);
    });
    return writing;
  };

  const schedule = (): void => {
    if (disposed) return;
    if (timer !== null) clearT(timer);
    timer = setT(() => {
      timer = null;
      void write();
    }, debounceMs);
  };

  let unsub: (() => void) | null = null;

  const hydrated = (async (): Promise<Partial<Prefs>> => {
    let stored: Partial<Prefs> = {};
    try {
      stored = parsePrefs(await storage.read());
    } catch (err) {
      opts.onError?.('read', err);
    }
    if (disposed) return stored;
    applyPrefs(store, stored);
    lastWritten = { ...prefsFrom(store.getState()) };
    // Anything the stored file lacked is now the store's default: only changes from here get written.
    unsub = store.subscribe((s, prev) => {
      if (
        s.firstRun !== prev.firstRun ||
        s.trainingMode !== prev.trainingMode ||
        s.speechRate !== prev.speechRate ||
        s.bodyOffsetDeg !== prev.bodyOffsetDeg
      ) {
        schedule();
      }
    });
    return stored;
  })();

  return {
    hydrated,
    async flush() {
      if (timer !== null) {
        clearT(timer);
        timer = null;
      }
      await hydrated;
      await write();
      await writing;
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearT(timer);
      timer = null;
      unsub?.();
      unsub = null;
    },
  };
}

/** In-memory storage (tests, and the fallback when the file system is unavailable). */
export function createMemoryPrefsStorage(initial: string | null = null): PrefsStorage & { current(): string | null } {
  let text = initial;
  return {
    read: async () => text,
    async write(next) {
      text = next;
    },
    current: () => text,
  };
}

/**
 * expo-file-system storage: `<document>/aisle-prefs.json`. Required lazily so
 * tests never load the native module.
 */
export function createExpoPrefsStorage(fileName: string = PREFS_FILE_NAME): PrefsStorage {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const FS = require('expo-file-system') as typeof import('expo-file-system');
  const file = (): InstanceType<typeof FS.File> => new FS.File(FS.Paths.document, fileName);
  return {
    async read() {
      const f = file();
      if (!f.exists) return null;
      return f.text();
    },
    async write(text) {
      const f = file();
      if (!f.exists) f.create({ intermediates: true, overwrite: true });
      f.write(text);
    },
  };
}
