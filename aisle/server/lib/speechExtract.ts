/**
 * Incremental extraction of the `speech` string from a streaming JSON prefix.
 *
 * The VisionResponse schema puts `speech` first, so the string closes long before
 * the JSON does. This scanner is fed each text delta from Claude and yields the
 * decoded speech characters as they arrive plus a `closed` flag the instant the
 * closing quote is seen — that is the moment the proxy sends `flush: true` to
 * ElevenLabs. Pure state machine; JSON string escapes are decoded (\" \\ \/ \b \f
 * \n \r \t \uXXXX), and an escape split across two deltas is held until complete.
 */

export type SpeechScanState = 'seek_key' | 'seek_colon' | 'seek_open' | 'in_string' | 'closed';

export interface SpeechScanStep {
  /** Newly decoded speech characters from this delta (may be ''). */
  text: string;
  /** True once the closing quote has been consumed (stays true afterwards). */
  closed: boolean;
}

const KEY = '"speech"';
const SIMPLE_ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

export interface SpeechScanner {
  feed(delta: string): SpeechScanStep;
  state(): SpeechScanState;
  /** Everything decoded so far. */
  speech(): string;
  /** Raw JSON text fed so far (the caller parses it at the end). */
  raw(): string;
}

export function createSpeechScanner(): SpeechScanner {
  let state: SpeechScanState = 'seek_key';
  let raw = '';
  let pre = '';          // unconsumed prefix while seeking the key
  let pending = '';      // partial escape sequence carried across deltas
  let speech = '';

  const feed = (delta: string): SpeechScanStep => {
    raw += delta;
    if (state === 'closed') return { text: '', closed: true };
    let out = '';
    let i = 0;

    if (state === 'seek_key') {
      pre += delta;
      const at = pre.indexOf(KEY);
      if (at < 0) {
        pre = pre.slice(Math.max(0, pre.length - KEY.length + 1));
        return { text: '', closed: false };
      }
      // Re-enter with the remainder after the key.
      delta = pre.slice(at + KEY.length);
      pre = '';
      state = 'seek_colon';
      i = 0;
    }

    while (i < delta.length) {
      const ch = delta[i]!;
      if (state === 'seek_colon') {
        if (ch === ':') state = 'seek_open';
        i += 1;
        continue;
      }
      if (state === 'seek_open') {
        if (ch === '"') state = 'in_string';
        i += 1;
        continue;
      }
      if (state === 'in_string') {
        if (pending) {
          pending += ch;
          i += 1;
          const done = tryDecodeEscape(pending);
          if (done.complete) {
            out += done.text;
            pending = '';
          }
          continue;
        }
        if (ch === '\\') {
          pending = '\\';
          i += 1;
          continue;
        }
        if (ch === '"') {
          state = 'closed';
          i += 1;
          break;
        }
        out += ch;
        i += 1;
        continue;
      }
      break;
    }
    speech += out;
    return { text: out, closed: state === 'closed' };
  };

  return {
    feed,
    state: () => state,
    speech: () => speech,
    raw: () => raw,
  };
}

function tryDecodeEscape(seq: string): { complete: boolean; text: string } {
  // seq starts with '\'
  if (seq.length < 2) return { complete: false, text: '' };
  const c = seq[1]!;
  if (c === 'u') {
    if (seq.length < 6) return { complete: false, text: '' };
    const code = Number.parseInt(seq.slice(2, 6), 16);
    return { complete: true, text: Number.isNaN(code) ? '' : String.fromCharCode(code) };
  }
  const simple = SIMPLE_ESCAPES[c];
  return { complete: true, text: simple ?? c };
}

/** Parse the complete JSON text at the end of the stream; null when it is not an object. */
export function parseFinalJson(raw: string): unknown | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const v: unknown = JSON.parse(trimmed);
    return isObj(v) ? v : null;
  } catch {
    // Third line of defence: last {...} in the text.
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        const v: unknown = JSON.parse(trimmed.slice(start, end + 1));
        return isObj(v) ? v : null;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
