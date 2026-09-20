/**
 * Spoken guidance (03 Task 4): legs and crossings → `SpeechRequest`s. Pure.
 *
 * Three sources of audio, in order: a cached phrase (`cacheKey`, bundled by
 * Agent A), a phrase pre-synthesized at route load (text whose runtime file
 * `SpeechService.prefetch` wrote before `ROUTE_READY`), and live Flash only
 * for unbounded `how_far` replies. Every outdoor utterance carries a
 * `dedupeKey`, otherwise a jittery fix repeats "turn right" five times.
 *
 * A phrase whose text equals a cached key's canonical text is sent by key, so
 * the walk plays the bundled file instead of a runtime one.
 */
import type { CacheKey, Direction, RouteCompileOutput, SpeechRequest } from '../core/contracts';
import { PHRASES, countWords, findForbiddenTerm, hasDigit, isPhraseKey, truncateWords } from '../core/phrases';
import { crossingAnnouncementText, templateLeg } from './plannerJobs';
import type { RouteCrossing, RouteLeg } from './types';

export const SOON_COOLDOWN_MS = 15_000;
export const NOW_COOLDOWN_MS = 15_000;
export const ONCE_COOLDOWN_MS = 60 * 60 * 1000;
export const VEHICLE_COOLDOWN_MS = 4000;
/** The `soon` cue fires at 20 m along-track from the maneuver point. */
export const SOON_TRIGGER_M = 20;
/** Crossing announcement when along-track distance to the near curb is ≤ 25 m. */
export const CROSSING_AHEAD_M = 25;

const TEXT_TO_KEY: ReadonlyMap<string, CacheKey> = (() => {
  const m = new Map<string, CacheKey>();
  for (const [key, text] of Object.entries(PHRASES)) {
    // Only 01 §3 keys are safe to send by key; A-side keys are flagged, not shared.
    if (isPhraseKey(key) && !key.startsWith('onboarding_') && !key.startsWith('label_') && !key.startsWith('course_hint_')) {
      m.set(normalize(text), key as CacheKey);
    }
  }
  return m;
})();

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** The 01 §3 key whose canonical text matches, if any. */
export function cacheKeyForText(text: string): CacheKey | null {
  return TEXT_TO_KEY.get(normalize(text)) ?? null;
}

/** ≤ 12 words, no digits, none of the forbidden words. */
export function isSpeakable(text: string): boolean {
  const t = text.trim();
  return t !== '' && countWords(t) <= 12 && !hasDigit(t) && findForbiddenTerm(t) === null;
}

/** Build one request: by key when the text is canonical, else by text (truncated to 12 words). */
export function requestFor(
  text: string,
  opts: { priority?: SpeechRequest['priority']; dedupeKey: string; cooldownMs: number; interrupt?: boolean },
): SpeechRequest | null {
  const t = text.trim();
  if (t === '' || findForbiddenTerm(t) !== null || hasDigit(t)) return null;
  const key = cacheKeyForText(t);
  const req: SpeechRequest = {
    text: key ? PHRASES[key] : truncateWords(t, 12),
    priority: opts.priority ?? 'NAV',
    dedupeKey: opts.dedupeKey,
    cooldownMs: opts.cooldownMs,
  };
  if (key) req.cacheKey = key;
  if (opts.interrupt) req.interrupt = true;
  return req;
}

/** The compiled phrases for a leg, falling back to the template when the script lacks it. */
export function scriptLegFor(leg: RouteLeg, script: RouteCompileOutput | null | undefined): RouteCompileOutput['legs'][number] {
  const found = script?.legs.find((l) => l.index === leg.index);
  const canonical = templateLeg({
    index: leg.index,
    instruction: leg.instruction,
    maneuver: leg.maneuver,
    distanceM: leg.distanceM,
    startBearingDeg: leg.startBearingDeg,
  });
  // Turn direction is route data, never a language-model wording decision.
  return found ? { ...found, soon: canonical.soon, now: canonical.now } : canonical;
}

export function legSoonRequest(leg: RouteLeg, script: RouteCompileOutput | null | undefined): SpeechRequest | null {
  const s = scriptLegFor(leg, script);
  if (leg.maneuver === 'STRAIGHT' || leg.maneuver === 'ARRIVE') return null;
  return requestFor(s.soon, { dedupeKey: `leg-${leg.index}-soon`, cooldownMs: SOON_COOLDOWN_MS });
}

export function legNowRequest(leg: RouteLeg, script: RouteCompileOutput | null | undefined): SpeechRequest | null {
  const s = scriptLegFor(leg, script);
  if (leg.maneuver === 'STRAIGHT' || leg.maneuver === 'ARRIVE') return null;
  return requestFor(s.now, { dedupeKey: `leg-${leg.index}-now`, cooldownMs: NOW_COOLDOWN_MS });
}

export function legConfirmRequest(leg: RouteLeg, script: RouteCompileOutput | null | undefined): SpeechRequest | null {
  const s = scriptLegFor(leg, script);
  return requestFor(s.confirm, { dedupeKey: `leg-${leg.index}-confirm`, cooldownMs: ONCE_COOLDOWN_MS });
}

/** Walking-beta sentence, spoken once at route ready (allow-listed byte string on the proxy). */
export function routeWarningRequest(warning: string): SpeechRequest {
  return { text: warning, priority: 'INFO', dedupeKey: 'route-warning', cooldownMs: ONCE_COOLDOWN_MS };
}

/** Announcement text for a crossing: the compiled one, else the template. */
export function crossingAnnouncementFor(c: RouteCrossing, script: RouteCompileOutput | null | undefined): string {
  const found = script?.crossingAnnouncements.find((a) => a.crossingId === c.crossingId);
  if (found && isSpeakable(found.text)) return found.text;
  return crossingAnnouncementText(c);
}

/** The approach announcement and, when flagged, `push_button_likely` — each once. */
export function crossingAheadRequests(c: RouteCrossing, script: RouteCompileOutput | null | undefined): SpeechRequest[] {
  const out: SpeechRequest[] = [];
  const text = crossingAnnouncementFor(c, script);
  const main = requestFor(text, { dedupeKey: `xing-${c.crossingId}-ahead`, cooldownMs: ONCE_COOLDOWN_MS });
  if (main) out.push(main);
  if (c.pushButtonLikely && !/push button likely/i.test(text)) {
    out.push({ text: PHRASES.push_button_likely, cacheKey: 'push_button_likely', priority: 'NAV', dedupeKey: `xing-${c.crossingId}-button`, cooldownMs: ONCE_COOLDOWN_MS });
  }
  return out;
}

const VEHICLE_KEY: Record<Direction, CacheKey> = { LEFT: 'vehicle_left', RIGHT: 'vehicle_right', CENTER: 'vehicle_ahead' };

/** "Vehicle left." — CRITICAL, interrupting, per-direction cooldown 4 s. */
export function vehicleAlertRequest(direction: Direction): SpeechRequest {
  const key = VEHICLE_KEY[direction];
  return { text: PHRASES[key], cacheKey: key, priority: 'CRITICAL', interrupt: true, dedupeKey: `vehicle-${direction}`, cooldownMs: VEHICLE_COOLDOWN_MS };
}

export function offlineNoticeRequest(): SpeechRequest {
  return { text: PHRASES.offline_notice, cacheKey: 'offline_notice', priority: 'INFO', dedupeKey: 'offline', cooldownMs: ONCE_COOLDOWN_MS };
}

export function replanRequest(reply: string): SpeechRequest {
  return requestFor(reply, { priority: 'INFO', dedupeKey: 'replan', cooldownMs: 10_000 }) ?? {
    text: 'Re-routing.', priority: 'INFO', dedupeKey: 'replan', cooldownMs: 10_000,
  };
}

/** "Signal read is delayed." — fallback rung 2 preface (A-side key `signal_read_delayed`). */
export const SIGNAL_READ_DELAYED_TEXT = 'Signal read is delayed.';

/**
 * Every phrase with a variable word that must exist as audio before
 * `ROUTE_READY`: leg phrases whose text is not a cached key's, every crossing
 * announcement and the walking-beta sentence (the rung-2 preface is dropped
 * here when A bundles it as `signal_read_delayed`). Deduplicated, in speaking order.
 */
export function variablePhrases(route: {
  legs: readonly RouteLeg[];
  crossings: readonly RouteCrossing[];
  warnings: readonly string[];
  script: RouteCompileOutput | null | undefined;
}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (text: string): void => {
    const t = text.trim();
    if (t === '' || seen.has(t)) return;
    if (cacheKeyForText(t) !== null) return;
    seen.add(t);
    out.push(t);
  };
  for (const w of route.warnings) add(w);
  for (const leg of route.legs) {
    const s = scriptLegFor(leg, route.script);
    if (leg.maneuver !== 'STRAIGHT' && leg.maneuver !== 'ARRIVE') {
      add(s.soon);
      add(s.now);
    }
    add(s.confirm);
  }
  for (const c of route.crossings) add(crossingAnnouncementFor(c, route.script));
  add(SIGNAL_READ_DELAYED_TEXT);
  return out;
}

export interface PrefetchPort {
  prefetch(text: string): Promise<string | null>;
}

export interface PrefetchReport {
  requested: number;
  ok: number;
  failed: string[];
  elapsedMs: number;
}

/**
 * Pre-synthesize in batches of four (ElevenLabs free-plan concurrency). Never
 * throws: a failed phrase falls back to expo-speech at say() time, and the
 * report tells the DebugPanel which ones.
 */
export async function prefetchPhrases(
  texts: readonly string[],
  port: PrefetchPort | null | undefined,
  opts: { concurrency?: number; now?: () => number } = {},
): Promise<PrefetchReport> {
  const now = opts.now ?? Date.now;
  const started = now();
  const failed: string[] = [];
  if (!port) return { requested: texts.length, ok: 0, failed: [...texts], elapsedMs: 0 };
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  let ok = 0;
  for (let i = 0; i < texts.length; i += concurrency) {
    const batch = texts.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(async (t) => {
      try {
        return await port.prefetch(t);
      } catch {
        return null;
      }
    }));
    results.forEach((r, j) => {
      if (r === null) failed.push(batch[j]);
      else ok += 1;
    });
  }
  return { requested: texts.length, ok, failed, elapsedMs: now() - started };
}

/** Duck-typed: A's `AisleSpeechService` has `prefetch`; the 01 interface does not. */
export function prefetchPortOf(speech: unknown): PrefetchPort | null {
  if (speech && typeof (speech as PrefetchPort).prefetch === 'function') return speech as PrefetchPort;
  return null;
}
