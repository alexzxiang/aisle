/**
 * One line per request (05 Part 2 "Logs"): seq, question/job, model, ms to first
 * token, ms total, fallback, and the language-rule verdict. Kept in memory for 24 h
 * (the Nemotron eval artifact is built from these lines) and written to stdout as
 * JSON so the host's log drain keeps them too.
 *
 * Nothing here is on a hot path in the app; the proxy's hot path is the WS relay,
 * which logs once per request after the audio has been sent.
 */

export type LanguageVerdict = 'pass' | 'repaired' | 'blanked' | 'rejected_422' | 'allowlisted' | 'n/a';

export interface RequestLogLine {
  ts: string;                       // ISO
  route: string;                    // 'vision' | 'plan' | 'tts' | 'stt' | 'route' | 'health' | 'warm'
  seq?: number;
  key?: string;                     // question or job
  model?: string;
  provider?: string;                // 'anthropic' | 'nim' | 'openrouter' | 'elevenlabs'
  firstTokenMs?: number | null;
  totalMs: number;
  fallback?: boolean;
  status?: number;
  verdict?: LanguageVerdict;
  error?: string;
  extra?: Record<string, unknown>;
}

export const LOG_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface RequestLog {
  write(line: Omit<RequestLogLine, 'ts'> & { ts?: string }): RequestLogLine;
  /** Lines newer than the retention window, oldest first. */
  recent(filter?: Partial<Pick<RequestLogLine, 'route' | 'key' | 'provider'>>): RequestLogLine[];
  size(): number;
  clear(): void;
}

export interface RequestLogOptions {
  now?: () => number;
  sink?: (line: string) => void;
  retentionMs?: number;
  /** Hard cap on retained lines regardless of age. Default 50 000. */
  maxLines?: number;
}

export function createRequestLog(opts: RequestLogOptions = {}): RequestLog {
  const now = opts.now ?? Date.now;
  const sink = opts.sink ?? ((s: string) => process.stdout.write(`${s}\n`));
  const retention = opts.retentionMs ?? LOG_RETENTION_MS;
  const maxLines = opts.maxLines ?? 50_000;
  const lines: Array<{ at: number; line: RequestLogLine }> = [];

  const prune = (): void => {
    const cutoff = now() - retention;
    while (lines.length && (lines[0]!.at < cutoff || lines.length > maxLines)) lines.shift();
  };

  return {
    write(partial) {
      const at = now();
      const line: RequestLogLine = { ...partial, ts: partial.ts ?? new Date(at).toISOString() };
      lines.push({ at, line });
      prune();
      try {
        sink(JSON.stringify(line));
      } catch {
        // a broken sink must never break a request
      }
      return line;
    },
    recent(filter) {
      prune();
      return lines
        .map((l) => l.line)
        .filter((l) => !filter || Object.entries(filter).every(([k, v]) => v === undefined || (l as unknown as Record<string, unknown>)[k] === v));
    },
    size: () => lines.length,
    clear() {
      lines.splice(0);
    },
  };
}

/** Process-wide log. Routes import this; tests build their own with createRequestLog. */
export const requestLog: RequestLog = createRequestLog();

/** Operational lines are silent under vitest unless AISLE_LOG_VERBOSE=1. */
const quiet = (): boolean => Boolean(process.env.VITEST) && !process.env.AISLE_LOG_VERBOSE;

/** Terse operational message (startup, warm-up, failover), not a request line. */
export function info(msg: string, extra?: Record<string, unknown>): void {
  if (quiet()) return;
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg, ...(extra ?? {}) })}\n`);
}

export function warn(msg: string, extra?: Record<string, unknown>): void {
  if (quiet()) return;
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level: 'warn', msg, ...(extra ?? {}) })}\n`);
}
