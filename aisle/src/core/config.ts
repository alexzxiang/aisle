/**
 * App configuration from `EXPO_PUBLIC_*` variables, with safe defaults.
 *
 * Expo inlines `process.env.EXPO_PUBLIC_<NAME>` at bundle time only when the
 * variable is referenced literally, so the three reads below stay literal.
 * `readConfig(env)` is the pure core; `config` is the frozen app-wide value.
 *
 * The mock flag is read here and consumed by the composition root (App.tsx)
 * alone; feature code never branches on it (01 §12, 05 "Wiring").
 */

export interface AppConfig {
  /** http(s)://host:port — no trailing slash. */
  proxyUrl: string;
  /** ws(s)://host:port/ws */
  proxyWs: string;
  /** EXPO_PUBLIC_MOCK === '1' */
  mock: boolean;
}

export type ConfigEnv = Partial<Record<'EXPO_PUBLIC_PROXY_URL' | 'EXPO_PUBLIC_PROXY_WS' | 'EXPO_PUBLIC_MOCK', string | undefined>>;

/** Local proxy per 05 (`npm run proxy` binds 0.0.0.0:8787). */
export const DEFAULT_PROXY_URL = 'http://localhost:8787';
export const DEFAULT_WS_PATH = '/ws';

const HTTP_RE = /^https?:\/\/[^/\s]+/i;
const WS_RE = /^wss?:\/\/[^\s]+/i;

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

export function normalizeProxyUrl(raw: string | undefined): string {
  const v = (raw ?? '').trim();
  if (!v || !HTTP_RE.test(v)) return DEFAULT_PROXY_URL;
  return stripTrailingSlash(v);
}

/** Derive ws(s)://host:port/ws from an http(s) proxy URL. */
export function wsFromProxyUrl(proxyUrl: string): string {
  const base = stripTrailingSlash(proxyUrl).replace(/^http/i, 'ws');
  return `${base}${DEFAULT_WS_PATH}`;
}

export function normalizeProxyWs(raw: string | undefined, proxyUrl: string): string {
  const v = (raw ?? '').trim();
  if (!v || !WS_RE.test(v)) return wsFromProxyUrl(proxyUrl);
  return v;
}

export function parseMockFlag(raw: string | undefined): boolean {
  return (raw ?? '').trim() === '1';
}

export function readConfig(env: ConfigEnv): AppConfig {
  const proxyUrl = normalizeProxyUrl(env.EXPO_PUBLIC_PROXY_URL);
  return {
    proxyUrl,
    proxyWs: normalizeProxyWs(env.EXPO_PUBLIC_PROXY_WS, proxyUrl),
    mock: parseMockFlag(env.EXPO_PUBLIC_MOCK),
  };
}

/** Literal references so Expo's bundler can inline them. */
export const config: Readonly<AppConfig> = Object.freeze(
  readConfig({
    EXPO_PUBLIC_PROXY_URL: process.env.EXPO_PUBLIC_PROXY_URL,
    EXPO_PUBLIC_PROXY_WS: process.env.EXPO_PUBLIC_PROXY_WS,
    EXPO_PUBLIC_MOCK: process.env.EXPO_PUBLIC_MOCK,
  }),
);

/** Latency budget (01 §11) — one source of truth for DebugPanel and tests. */
export const LATENCY_BUDGET_MS = Object.freeze({
  tier0FrameToHaptic: 150,
  courseChangeToBuzz: 200,
  hapticPlayFire: 100,
  tier1EndToEndP95: 3000,
  tier1FirstSpokenWord: 1500,
  tier2FirstToken: 1500,
  cachedPhraseToAudio: 50,
  liveTtsFirstAudio: 400,
  utteranceMax: 2000,
  minGapNonCritical: 4000,
});

/** Store-entry handoff: TRANSITION auto-advances to INDOOR_NAV after this cap (02 Task 2). */
export const TRANSITION_CAP_MS = 3000;
