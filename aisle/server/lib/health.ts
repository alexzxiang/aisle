/**
 * /api/health (05 Part 2, 07 §4): each upstream individually, one key each, cached,
 * 10 s timeout per check. Five are required (`anthropic`, `nvidia`, `elevenlabs_tts`,
 * `elevenlabs_stt`, `google_routes`); `openrouter` is informational (the Nemotron
 * failover; grey, never red); `overpass` sits outside `upstreams` because it is
 * unkeyed and only needed at route fetch.
 *
 * Checks: Anthropic model list; NIM authenticated GET /v1/models (asserts the
 * Nemotron id is present); ElevenLabs subscription for credits; a Scribe call on the
 * bundled 300 ms clip (cached 5 min — it costs credits); one two-point computeRoutes
 * (cached 5 min); Overpass status. All checks are injectable so tests run offline.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProxyConfig } from '../config';
import { listAnthropicModels } from './anthropic';
import { sttScribe, subscription } from './elevenlabs';
import { listNimModels } from './nim';

export type UpstreamName = 'anthropic' | 'nvidia' | 'openrouter' | 'elevenlabs_tts' | 'elevenlabs_stt' | 'google_routes';
export const REQUIRED_UPSTREAMS: readonly UpstreamName[] = ['anthropic', 'nvidia', 'elevenlabs_tts', 'elevenlabs_stt', 'google_routes'];

export interface UpstreamStatus {
  ok: boolean;
  ms: number | null;
  err: string | null;
  http429: number;
  required?: boolean;
  modelSeen?: boolean;
  creditsLeft?: number;
  checkedAt: string | null;
  fromCache: boolean;
}

export interface HealthReport {
  ok: boolean;
  region: string;
  upstreams: Record<UpstreamName, UpstreamStatus>;
  overpass: { ok: boolean; ms: number | null; err: string | null };
  schemasWarm: Record<string, string | null>;
  latency: Record<string, { p50: number | null; p95: number | null; n: number }>;
  missingKeys: string[];
  generatedAt: string;
}

export const HEALTH_TIMEOUT_MS = 10_000;
export const HEALTH_CACHE_MS = 30_000;
export const HEALTH_SLOW_CACHE_MS = 5 * 60_000;

export type CheckFn = (signal: AbortSignal) => Promise<Partial<Pick<UpstreamStatus, 'modelSeen' | 'creditsLeft'>> | void>;

export interface HealthChecks {
  anthropic: CheckFn;
  nvidia: CheckFn;
  openrouter: CheckFn;
  elevenlabs_tts: CheckFn;
  elevenlabs_stt: CheckFn;
  google_routes: CheckFn;
  overpass: CheckFn;
}

/** 429 counters, incremented by the routes; read by the report. */
export interface RateLimitCounters {
  bump(name: UpstreamName): void;
  get(name: UpstreamName): number;
  reset(): void;
}

export function createRateLimitCounters(): RateLimitCounters {
  const m = new Map<UpstreamName, number>();
  return {
    bump: (n) => m.set(n, (m.get(n) ?? 0) + 1),
    get: (n) => m.get(n) ?? 0,
    reset: () => m.clear(),
  };
}

export const http429: RateLimitCounters = createRateLimitCounters();

export interface HealthDeps {
  config: ProxyConfig;
  checks: HealthChecks;
  counters?: RateLimitCounters;
  schemasWarm: () => Record<string, string | null>;
  latency: () => HealthReport['latency'];
  missingKeys: () => string[];
  now?: () => number;
  cacheMs?: Partial<Record<UpstreamName | 'overpass', number>>;
  timeoutMs?: number;
}

export interface HealthService {
  report(opts?: { force?: boolean }): Promise<HealthReport>;
}

interface CacheEntry {
  at: number;
  status: UpstreamStatus;
}

export function createHealthService(deps: HealthDeps): HealthService {
  const now = deps.now ?? Date.now;
  const counters = deps.counters ?? http429;
  const cache = new Map<string, CacheEntry>();
  const ttl = (name: UpstreamName | 'overpass'): number =>
    deps.cacheMs?.[name] ?? (name === 'elevenlabs_stt' || name === 'google_routes' || name === 'overpass' ? HEALTH_SLOW_CACHE_MS : HEALTH_CACHE_MS);

  const runCheck = async (name: UpstreamName | 'overpass', fn: CheckFn, force: boolean): Promise<UpstreamStatus> => {
    const cached = cache.get(name);
    if (!force && cached && now() - cached.at < ttl(name)) return { ...cached.status, fromCache: true };
    const t0 = now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? HEALTH_TIMEOUT_MS);
    let status: UpstreamStatus;
    try {
      const extra = (await fn(controller.signal)) ?? {};
      status = { ok: true, ms: now() - t0, err: null, http429: 0, checkedAt: new Date(now()).toISOString(), fromCache: false, ...extra };
      if (extra.modelSeen === false) {
        status.ok = false;
        status.err = 'model not listed';
      }
    } catch (e) {
      const msg = controller.signal.aborted ? 'timeout' : e instanceof Error ? e.message : String(e);
      status = { ok: false, ms: now() - t0, err: msg.slice(0, 160), http429: 0, checkedAt: new Date(now()).toISOString(), fromCache: false };
    } finally {
      clearTimeout(timer);
    }
    cache.set(name, { at: now(), status });
    return status;
  };

  return {
    async report(opts = {}) {
      const force = opts.force === true;
      const names: UpstreamName[] = ['anthropic', 'nvidia', 'openrouter', 'elevenlabs_tts', 'elevenlabs_stt', 'google_routes'];
      const results = await Promise.all(names.map((n) => runCheck(n, deps.checks[n], force)));
      const overpass = await runCheck('overpass', deps.checks.overpass, force);
      const upstreams = {} as Record<UpstreamName, UpstreamStatus>;
      names.forEach((n, i) => {
        const r = results[i]!;
        upstreams[n] = { ...r, http429: counters.get(n), ...(n === 'openrouter' ? { required: false } : {}) };
      });
      const ok = REQUIRED_UPSTREAMS.every((n) => upstreams[n].ok);
      return {
        ok,
        region: deps.config.region,
        upstreams,
        overpass: { ok: overpass.ok, ms: overpass.ms, err: overpass.err },
        schemasWarm: deps.schemasWarm(),
        latency: deps.latency(),
        missingKeys: deps.missingKeys(),
        generatedAt: new Date(now()).toISOString(),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Default checks (real upstreams)
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
export const HEALTH_CLIP_PATH = join(here, '..', 'assets', 'health-clip.wav');

export function defaultHealthChecks(cfg: ProxyConfig, fetchFn: typeof fetch = fetch): HealthChecks {
  const need = (v: string | null, what: string): string => {
    if (!v) throw new Error(`${what} not set`);
    return v;
  };
  return {
    async anthropic(signal) {
      await listAnthropicModels(need(cfg.anthropicApiKey, 'ANTHROPIC_API_KEY'), signal);
    },
    async nvidia(signal) {
      const r = await listNimModels(cfg, fetchFn, signal);
      return { modelSeen: r.modelSeen };
    },
    async openrouter(signal) {
      const key = need(cfg.openRouterApiKey, 'OPENROUTER_API_KEY');
      const res = await fetchFn(`${cfg.openRouterBaseUrl}/models`, { headers: { Authorization: `Bearer ${key}` }, signal });
      if (!res.ok) throw Object.assign(new Error(`openrouter ${res.status}`), { status: res.status });
      const j = (await res.json()) as { data?: Array<{ id?: string }> };
      return { modelSeen: (j.data ?? []).some((m) => m.id === cfg.openRouterModel) };
    },
    async elevenlabs_tts(signal) {
      const s = await subscription({ config: cfg, fetchFn }, signal);
      return { creditsLeft: s.creditsLeft };
    },
    async elevenlabs_stt(signal) {
      const clip = await readFile(HEALTH_CLIP_PATH);
      await sttScribe(clip, { config: cfg, fetchFn }, { filename: 'health-clip.wav', mimeType: 'audio/wav', signal });
    },
    async google_routes(signal) {
      const key = need(cfg.googleMapsApiKey, 'GOOGLE_MAPS_API_KEY');
      const res = await fetchFn('https://routes.googleapis.com/directions/v2:computeRoutes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters' },
        body: JSON.stringify({
          origin: { location: { latLng: { latitude: 40.4443, longitude: -79.9436 } } },
          destination: { location: { latLng: { latitude: 40.4453, longitude: -79.9450 } } },
          travelMode: 'WALK',
        }),
        signal,
      });
      if (!res.ok) throw Object.assign(new Error(`google routes ${res.status}`), { status: res.status });
    },
    async overpass(signal) {
      const res = await fetchFn('https://overpass-api.de/api/status', { signal });
      if (!res.ok) throw new Error(`overpass ${res.status}`);
    },
  };
}
