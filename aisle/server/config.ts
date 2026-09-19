/**
 * Proxy configuration — every value comes from the environment (server/.env locally,
 * the host's secret store in us-east). Nothing here is ever sent to the phone.
 *
 * Model ids: the Nemotron spelling differs by surface (07 §1); the authenticated
 * `GET /v1/models` on day 0 is the only authority, and `NVIDIA_MODEL` overrides the
 * default below with the exact string read there.
 */

export interface ProxyConfig {
  port: number;
  host: string;
  region: string;
  anthropicApiKey: string | null;
  nvidiaApiKey: string | null;
  nvidiaApiKeyFallback: string | null;
  elevenLabsApiKey: string | null;
  elevenLabsVoiceId: string | null;
  googleMapsApiKey: string | null;
  openRouterApiKey: string | null;
  nvidiaModel: string;
  nvidiaModelFallback: string;
  openRouterModel: string;
  nimBaseUrl: string;
  openRouterBaseUrl: string;
  elevenLabsBaseUrl: string;
  elevenLabsWsBaseUrl: string;
  warmupOnStart: boolean;
  /** CAPTURE_FRAMES=1: keep every vision still + facts + answer for the eval. Off by default — see lib/frameCapture.ts. */
  captureFrames: boolean;
}

export const MODELS = Object.freeze({
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-5',
  nemotron: 'nvidia/nemotron-3.5-lightning-30b-a3b',
  nemotronFallback: 'nvidia/nemotron-nano-3-30b-a3b',
  flash: 'eleven_flash_v2_5',
  scribe: 'scribe_v2',
});

const str = (env: NodeJS.ProcessEnv, k: string): string | null => {
  const v = env[k];
  return v && v.trim() ? v.trim() : null;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ProxyConfig {
  return {
    port: Number(str(env, 'PORT') ?? 8787),
    host: str(env, 'HOST') ?? '0.0.0.0',
    region: str(env, 'REGION') ?? 'us-east',
    anthropicApiKey: str(env, 'ANTHROPIC_API_KEY'),
    nvidiaApiKey: str(env, 'NVIDIA_API_KEY'),
    nvidiaApiKeyFallback: str(env, 'NVIDIA_API_KEY_FALLBACK'),
    elevenLabsApiKey: str(env, 'ELEVENLABS_API_KEY'),
    elevenLabsVoiceId: str(env, 'ELEVENLABS_VOICE_ID'),
    googleMapsApiKey: str(env, 'GOOGLE_MAPS_API_KEY'),
    openRouterApiKey: str(env, 'OPENROUTER_API_KEY'),
    nvidiaModel: str(env, 'NVIDIA_MODEL') ?? MODELS.nemotron,
    nvidiaModelFallback: str(env, 'NVIDIA_MODEL_FALLBACK') ?? MODELS.nemotronFallback,
    openRouterModel: str(env, 'OPENROUTER_MODEL') ?? MODELS.nemotron,
    nimBaseUrl: str(env, 'NIM_BASE_URL') ?? 'https://integrate.api.nvidia.com/v1',
    openRouterBaseUrl: str(env, 'OPENROUTER_BASE_URL') ?? 'https://openrouter.ai/api/v1',
    elevenLabsBaseUrl: str(env, 'ELEVENLABS_BASE_URL') ?? 'https://api.us.elevenlabs.io',
    elevenLabsWsBaseUrl: str(env, 'ELEVENLABS_WS_BASE_URL') ?? 'wss://api.us.elevenlabs.io',
    warmupOnStart: (str(env, 'WARMUP_ON_START') ?? '1') !== '0',
    captureFrames: str(env, 'CAPTURE_FRAMES') === '1',
  };
}

/** The five keys 05 Part 2 names, in order — used by /api/health and the README. */
export const REQUIRED_KEYS = [
  'ANTHROPIC_API_KEY', 'NVIDIA_API_KEY', 'ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID', 'GOOGLE_MAPS_API_KEY',
] as const;

export function missingKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  return REQUIRED_KEYS.filter((k) => !str(env, k));
}
