/**
 * Pure formatters for the DebugPanel. Monospace-friendly, fixed-width where a
 * value changes every second so the column does not jump.
 */
import type { AppEvent, GeoFix, HeadingSample } from '../core/contracts';
import type { StampedEvent } from '../core/store';

export const DASH = '—';

export function fmtNum(v: number | null | undefined, digits = 0, unit = ''): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return `${v.toFixed(digits)}${unit}`;
}

export function fmtDeg(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  const d = ((Math.round(v) % 360) + 360) % 360;
  return `${String(d).padStart(3, ' ')}°`;
}

export function fmtHeading(h: HeadingSample | null): string {
  if (!h) return `${DASH}  acc ${DASH}`;
  return `${fmtDeg(h.trueHeadingDeg)}  acc ${h.accuracy}`;
}

export function fmtFix(f: GeoFix | null): string[] {
  if (!f) return [`gps      ${DASH}`];
  return [
    `gps      ${f.lat.toFixed(5)}, ${f.lng.toFixed(5)}`,
    `accuracy ${fmtNum(f.accuracyM, 0, ' m')}   course ${fmtDeg(f.courseDeg)}   speed ${fmtNum(f.speedMps, 1, ' m/s')}`,
  ];
}

export function fmtClock(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

/** Everything but `type`, compact, longest fields truncated so a line stays a line. */
export function fmtPayload(e: AppEvent, max = 60): string {
  const { type: _type, ...rest } = e as AppEvent & Record<string, unknown>;
  void _type;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(rest)) {
    const s = typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : typeof v === 'string' ? v : JSON.stringify(v);
    parts.push(`${k}=${s}`);
  }
  const line = parts.join(' ');
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function formatEventLine(e: StampedEvent): string {
  const { ts, ...event } = e;
  return `${fmtClock(ts)}  ${event.type.padEnd(20)} ${fmtPayload(event)}`.trimEnd();
}

/** Newest first, so the top of the list is the freshest. */
export function eventLines(events: readonly StampedEvent[]): string[] {
  return events.slice().reverse().map(formatEventLine);
}

export function fmtMs(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? DASH : `${Math.round(v)} ms`;
}

export function fmtFps(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? DASH : `${v.toFixed(1)} fps`;
}
