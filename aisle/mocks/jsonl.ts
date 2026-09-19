/**
 * Parser for the perception fixture format (01 §12, 05 Part 1):
 *   {"t": 1234, "event": "onSignalState", "payload": {...}}
 * one line per native event, `t` in ms from fixture start. Malformed lines are
 * skipped and counted, never fatal — a bad line in a 40-minute recording must not
 * take the demo down.
 */
export interface PerceptionLine {
  t: number;
  event: string;
  payload: unknown;
}

export interface SkippedLine {
  lineNo: number;
  reason: 'invalid_json' | 'not_object' | 'bad_t' | 'bad_event';
  text: string;
}

export interface ParsedPack {
  lines: PerceptionLine[];
  skipped: SkippedLine[];
}

export function parseJsonl(text: string): ParsedPack {
  const lines: PerceptionLine[] = [];
  const skipped: SkippedLine[] = [];
  const raw = text.split(/\r?\n/);
  for (let i = 0; i < raw.length; i += 1) {
    const line = raw[i]!.trim();
    if (!line) continue;
    const lineNo = i + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped.push({ lineNo, reason: 'invalid_json', text: line.slice(0, 80) });
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      skipped.push({ lineNo, reason: 'not_object', text: line.slice(0, 80) });
      continue;
    }
    const obj = parsed as Record<string, unknown>;
    const t = obj.t;
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) {
      skipped.push({ lineNo, reason: 'bad_t', text: line.slice(0, 80) });
      continue;
    }
    const event = obj.event;
    if (typeof event !== 'string' || !/^on[A-Z]/.test(event)) {
      skipped.push({ lineNo, reason: 'bad_event', text: line.slice(0, 80) });
      continue;
    }
    lines.push({ t, event, payload: obj.payload });
  }
  // Stable sort by t so a hand-edited pack still replays in order.
  lines.sort((a, b) => a.t - b.t);
  return { lines, skipped };
}
