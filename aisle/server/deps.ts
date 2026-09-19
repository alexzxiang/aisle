/**
 * The proxy's dependency container. Routes and the WebSocket handler take an
 * `AppDeps`; `createDefaultDeps()` wires the real upstreams from the environment
 * and tests pass fakes. Nothing opens a network connection at construction time.
 */
import type { VisionRequest } from '../src/core/contracts';
import { type ProxyConfig, loadConfig, missingKeys } from './config';
import { type AnthropicDeps, type VisionCallResult, type VisionHooks, buildVisionParams, runVision } from './lib/anthropic';
import { emptyVisionRequest } from './lib/visionRequest';
import {
  type SttOptions,
  type SttResult,
  type TtsInputStream,
  type TtsOptions,
  openTtsInputStream,
  sttScribe,
  ttsFlash,
  ttsFlashStream,
} from './lib/elevenlabs';
import { type HealthService, createHealthService, defaultHealthChecks, http429, type RateLimitCounters } from './lib/health';
import { type LatencyTracker, latency } from './lib/latency';
import { type RequestLog, requestLog } from './lib/log';
import { type NimDeps, nimChat } from './lib/nim';
import { type Semaphore, elevenLabsSlots } from './lib/semaphore';
import { type WarmupRegistry, createWarmupRegistry, loadJobSchemas } from './lib/warmup';
import { withFirstTokenDeadline } from './lib/deadline';

export interface TtsPort {
  flash(text: string, opts?: TtsOptions): Promise<Buffer>;
  stream(text: string, opts?: TtsOptions): Promise<ReadableStream<Uint8Array>>;
  /** Null when ElevenLabs is not configured: the vision path then returns JSON only. */
  openInput(): TtsInputStream | null;
}

export interface AppDeps {
  config: ProxyConfig;
  log: RequestLog;
  latency: LatencyTracker;
  slots: Semaphore;
  counters: RateLimitCounters;
  vision(req: VisionRequest, hooks: VisionHooks): Promise<VisionCallResult>;
  tts: TtsPort;
  stt(audio: Buffer, opts: SttOptions): Promise<SttResult>;
  warmup: WarmupRegistry;
  health: HealthService;
  nim: NimDeps;
}

export interface CreateDepsOptions {
  config?: ProxyConfig;
  anthropic?: Partial<AnthropicDeps>;
  jobSchemas?: Awaited<ReturnType<typeof loadJobSchemas>>;
  fetchFn?: typeof fetch;
}

export async function createDefaultDeps(opts: CreateDepsOptions = {}): Promise<AppDeps> {
  const config = opts.config ?? loadConfig();
  const anthropicDeps: AnthropicDeps = { apiKey: config.anthropicApiKey, ...(opts.anthropic ?? {}) };
  const eleven = { config, fetchFn: opts.fetchFn };
  const nim: NimDeps = { config };
  const jobSchemas = opts.jobSchemas ?? (await loadJobSchemas());

  const warmup = createWarmupRegistry({
    jobSchemas,
    runners: {
      async vision(model) {
        const req = emptyVisionRequest(model === 'sonnet' ? 'curb_crop' : 'storefront');
        const r = await runVision(req, {}, anthropicDeps);
        if (r.error && r.error !== 'invalid_json') throw new Error(r.error);
        return `${buildVisionParams(req).model} stop=${r.stopReason ?? '?'} ${r.totalMs}ms`;
      },
      async nim(job, schema) {
        const out = await withFirstTokenDeadline(
          () => nimChat({ system: 'Reply with JSON only.', user: `Return a minimal valid object for the ${job} schema.`, schema, maxTokens: 200, schemaName: job }, nim),
          { firstTokenMs: 8000, totalMs: 15000, fallback: () => null as null | { text: string; thinkingLeaked: boolean } },
        );
        if (out.fallback || !out.value) throw new Error(out.error ?? out.reason ?? 'warm failed');
        const first = out.value.text.trimStart()[0];
        if (first !== '{') throw new Error(`first token was ${JSON.stringify(first ?? '')} (thinking on?)`);
        return `${out.value.thinkingLeaked ? 'THINKING-LEAK ' : ''}${out.value.text}`;
      },
    },
  });

  const health = createHealthService({
    config,
    checks: defaultHealthChecks(config, opts.fetchFn ?? fetch),
    counters: http429,
    schemasWarm: () => warmup.schemasWarm(),
    latency: () => latency.all(),
    missingKeys: () => missingKeys(),
  });

  return {
    config,
    log: requestLog,
    latency,
    slots: elevenLabsSlots,
    counters: http429,
    vision: (req, hooks) => runVision(req, hooks, anthropicDeps),
    tts: {
      flash: (text, o) => ttsFlash(text, eleven, o),
      stream: (text, o) => ttsFlashStream(text, eleven, o),
      openInput: () => (config.elevenLabsApiKey && config.elevenLabsVoiceId ? openTtsInputStream(eleven) : null),
    },
    stt: (audio, o) => sttScribe(audio, eleven, o),
    warmup,
    health,
    nim,
  };
}

let memo: Promise<AppDeps> | null = null;
/** Process-wide deps (routes' default export). */
export function getDefaultDeps(): Promise<AppDeps> {
  if (!memo) memo = createDefaultDeps();
  return memo;
}
