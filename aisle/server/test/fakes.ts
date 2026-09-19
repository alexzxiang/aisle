/**
 * Test doubles for the proxy: no network anywhere. A fake Claude stream factory that
 * emits the JSON of a VisionResponse in deltas, a fake ElevenLabs input stream, and an
 * AppDeps built from them.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { VisionRequest, VisionResponse } from '../../src/core/contracts';
import { createApp, type CreateAppOptions } from '../app';
import { type ProxyConfig, loadConfig } from '../config';
import type { AppDeps } from '../deps';
import { runVision, type StreamFactory, type VisionCallResult, type VisionHooks } from '../lib/anthropic';
import type { TtsInputStream } from '../lib/elevenlabs';
import { createHealthService, createRateLimitCounters, type HealthChecks } from '../lib/health';
import { createLatencyTracker } from '../lib/latency';
import { createRequestLog } from '../lib/log';
import { createSemaphore } from '../lib/semaphore';
import { createWarmupRegistry, type WarmRunners } from '../lib/warmup';
import { emptyVisionResponse } from '../schemas/vision';

export function testConfig(over: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    ...loadConfig({}),
    anthropicApiKey: 'test-anthropic',
    nvidiaApiKey: 'test-nvidia',
    elevenLabsApiKey: 'test-eleven',
    elevenLabsVoiceId: 'voice-1',
    googleMapsApiKey: 'test-google',
    warmupOnStart: false,
    ...over,
  };
}

/** Split a string into n roughly equal deltas. */
export function chunk(text: string, n: number): string[] {
  const size = Math.max(1, Math.ceil(text.length / n));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

export interface FakeClaudeOptions {
  /** Body to stream; defaults to a full VisionResponse with the given speech. */
  body?: string;
  speech?: string;
  stopReason?: string | null;
  deltas?: number;
  /** Delay per delta (ms), to exercise the 4 s timeout. */
  delayMs?: number;
  /** Throw before yielding anything. */
  throwError?: Error;
}

export function visionBody(speech: string, over: Partial<VisionResponse> = {}): string {
  const r = { ...emptyVisionResponse(0), speech, confidence: 0.9, ...over };
  return JSON.stringify(r);
}

export function fakeClaude(opts: FakeClaudeOptions = {}): StreamFactory & { calls: Anthropic.MessageStreamParams[] } {
  const calls: Anthropic.MessageStreamParams[] = [];
  const factory = ((params: Anthropic.MessageStreamParams, signal: AbortSignal) => {
    calls.push(params);
    const body = opts.body ?? visionBody(opts.speech ?? '');
    const deltas = chunk(body, opts.deltas ?? 6);
    const stop = opts.stopReason === undefined ? 'end_turn' : opts.stopReason;
    return (async function* (): AsyncGenerator<Anthropic.RawMessageStreamEvent> {
      if (opts.throwError) throw opts.throwError;
      for (const d of deltas) {
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: d } } as Anthropic.RawMessageStreamEvent;
      }
      if (stop !== null) {
        yield { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 10 } } as unknown as Anthropic.RawMessageStreamEvent;
      }
    })();
  }) as unknown as StreamFactory & { calls: Anthropic.MessageStreamParams[] };
  factory.calls = calls;
  return factory;
}

export interface FakeTts extends TtsInputStream {
  sent: Array<{ text: string; flush: boolean }>;
  ended: boolean;
  closed: boolean;
  /** Push audio then finish (what the fake ElevenLabs does after a flush). */
  emit(chunks: Buffer[]): void;
}

export function fakeTts(opts: { auto?: boolean; chunks?: Buffer[]; failOpen?: boolean } = {}): FakeTts {
  let audioCb: ((c: Buffer) => void) | null = null;
  let endCb: (() => void) | null = null;
  let errCb: ((e: Error) => void) | null = null;
  let first: number | null = null;
  const t = {
    sent: [] as Array<{ text: string; flush: boolean }>,
    ended: false,
    closed: false,
    ready: opts.failOpen ? Promise.reject(new Error('open failed')) : Promise.resolve(),
    send(text: string, flush = false) {
      t.sent.push({ text, flush });
    },
    end() {
      t.ended = true;
      if (opts.auto !== false) setTimeout(() => t.emit(opts.chunks ?? [Buffer.from('mp3-a'), Buffer.from('mp3-b')]), 5);
    },
    close() {
      t.closed = true;
    },
    onAudio(cb: (c: Buffer) => void) {
      audioCb = cb;
    },
    onEnd(cb: () => void) {
      endCb = cb;
    },
    onError(cb: (e: Error) => void) {
      errCb = cb;
    },
    firstAudioMs: () => first,
    emit(chunks: Buffer[]) {
      for (const c of chunks) {
        if (first === null) first = 42;
        audioCb?.(c);
      }
      endCb?.();
    },
    fail(e: Error) {
      errCb?.(e);
    },
  };
  t.ready.catch(() => undefined);
  return t;
}

export interface FakeDepsOptions {
  claude?: StreamFactory;
  vision?: (req: VisionRequest, hooks: VisionHooks) => Promise<VisionCallResult>;
  ttsFactory?: () => TtsInputStream | null;
  flash?: (text: string) => Promise<Buffer>;
  stt?: AppDeps['stt'];
  checks?: Partial<HealthChecks>;
  warmRunners?: Partial<WarmRunners>;
  config?: Partial<ProxyConfig>;
}

export function fakeDeps(opts: FakeDepsOptions = {}): AppDeps & { ttsOpened: TtsInputStream[]; warmCalls: string[] } {
  const config = testConfig(opts.config);
  const log = createRequestLog({ sink: () => undefined });
  const claude = opts.claude ?? fakeClaude({ speech: 'Doors ahead.' });
  const ttsOpened: TtsInputStream[] = [];
  const warmCalls: string[] = [];
  const ok = async (): Promise<void> => undefined;
  const checks: HealthChecks = {
    anthropic: ok,
    nvidia: async () => ({ modelSeen: true }),
    openrouter: async () => ({ modelSeen: false }),
    elevenlabs_tts: async () => ({ creditsLeft: 8120 }),
    elevenlabs_stt: ok,
    google_routes: ok,
    overpass: ok,
    ...(opts.checks ?? {}),
  };
  const warmup = createWarmupRegistry({
    jobSchemas: { routeCompile: { type: 'object' } },
    runners: {
      vision: async (m) => {
        warmCalls.push(`${m}:vision`);
        return 'ok';
      },
      nim: async (j) => {
        warmCalls.push(`nim:${j}`);
        return '{"ok":true}';
      },
      ...(opts.warmRunners ?? {}),
    },
  });
  const latency = createLatencyTracker();
  const counters = createRateLimitCounters();
  const health = createHealthService({
    config,
    checks,
    counters,
    schemasWarm: () => warmup.schemasWarm(),
    latency: () => latency.all(),
    missingKeys: () => [],
  });
  return {
    config,
    log,
    latency,
    slots: createSemaphore(4),
    counters,
    vision: opts.vision ?? ((req, hooks) => runVision(req, hooks, { stream: claude })),
    tts: {
      flash: opts.flash ?? (async (text) => Buffer.from(`MP3:${text}`)),
      stream: async (text) => new Blob([Buffer.from(`MP3S:${text}`)]).stream() as ReadableStream<Uint8Array>,
      openInput: () => {
        const t = opts.ttsFactory ? opts.ttsFactory() : fakeTts();
        if (t) ttsOpened.push(t);
        return t;
      },
    },
    stt: opts.stt ?? (async () => ({ text: 'eggs please', languageCode: 'en', raw: {} })),
    warmup,
    health,
    nim: { config },
    ttsOpened,
    warmCalls,
  };
}

export interface TestServer {
  server: Server;
  url: string;
  wsUrl: string;
  close(): Promise<void>;
}

export async function startTestServer(deps: AppDeps, extra: Partial<CreateAppOptions> = {}, attach?: (s: Server) => void): Promise<TestServer> {
  const { app } = await createApp({ deps, externalRoutes: [], ...extra });
  const server = createServer(app);
  attach?.(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export function sampleRequest(over: Partial<VisionRequest> = {}): VisionRequest {
  return {
    seq: 1,
    question: 'storefront',
    mode: 'OUTDOOR_NAV',
    image: { base64: 'x'.repeat(64), width: 512, height: 384 },
    facts: { detections: [], ocr: [] },
    ...over,
  };
}
