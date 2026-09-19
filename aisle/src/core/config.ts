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
export const DEFAULT_PROXY_PORT = 8787;
export const DEFAULT_WS_PATH = '/ws';

const HTTP_RE = /^https?:\/\/[^/\s]+/i;
const WS_RE = /^wss?:\/\/[^\s]+/i;

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

/**
 * The proxy runs on the Mac that runs Metro, so with no `EXPO_PUBLIC_PROXY_URL`
 * a dev client aims at Metro's host (`Constants.expoConfig.hostUri`, e.g.
 * "172.26.16.221:8081") on the proxy port. `localhost` only ever reaches the
 * phone itself, which is what "Offline" on the first launch was.
 */
export function proxyUrlFromDevHost(hostUri: string | null | undefined, port: number = DEFAULT_PROXY_PORT): string | null {
  const v = (hostUri ?? '').trim();
  if (!v) return null;
  const host = v.replace(/^[a-z]+:\/\//i, '').split('/')[0]?.split(':')[0] ?? '';
  if (!host || host === 'localhost' || host === '127.0.0.1') return null;
  return `http://${host}:${port}`;
}

export function normalizeProxyUrl(raw: string | undefined, devHostUri?: string | null): string {
  const v = (raw ?? '').trim();
  if (!v || !HTTP_RE.test(v)) return proxyUrlFromDevHost(devHostUri) ?? DEFAULT_PROXY_URL;
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

export function readConfig(env: ConfigEnv, devHostUri?: string | null): AppConfig {
  const proxyUrl = normalizeProxyUrl(env.EXPO_PUBLIC_PROXY_URL, devHostUri);
  return {
    proxyUrl,
    proxyWs: normalizeProxyWs(env.EXPO_PUBLIC_PROXY_WS, proxyUrl),
    mock: parseMockFlag(env.EXPO_PUBLIC_MOCK),
  };
}

function devHostUri(): string | null {
  try {
    // Lazy so the pure functions above stay importable under Node (tests, scripts).
    const Constants = (require('expo-constants') as { default?: { expoConfig?: { hostUri?: string | null } | null } }).default;
    return Constants?.expoConfig?.hostUri ?? null;
  } catch {
    return null;
  }
}

/** Literal references so Expo's bundler can inline them. */
export const config: Readonly<AppConfig> = Object.freeze(
  readConfig({
    EXPO_PUBLIC_PROXY_URL: process.env.EXPO_PUBLIC_PROXY_URL,
    EXPO_PUBLIC_PROXY_WS: process.env.EXPO_PUBLIC_PROXY_WS,
    EXPO_PUBLIC_MOCK: process.env.EXPO_PUBLIC_MOCK,
  }, devHostUri()),
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
