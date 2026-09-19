/**
 * NIM client for Nemotron (07 §1, 05 Part 2) — the Tier 2 decision layer.
 *
 * `nimChat()` returns a StreamHandle (lib/deadline.ts) over an OpenAI-compatible
 * streaming chat completion against integrate.api.nvidia.com:
 *   - `stream: true`, `temperature: 0`, `max_completion_tokens`
 *   - `chat_template_kwargs: { enable_thinking: false }`   (thinking off)
 *   - `nvext: { guided_json: <schema> }`                    (schema-bound output)
 * plus prompt-level "JSON only". On 429 / 503 / connect error before the first
 * token it retries once with the spare NIM key (429 only) and then the same model on
 * OpenRouter (where `response_format: json_schema` replaces `nvext`); after that the
 * handle rejects and the deadline helper returns B's templated fallback.
 *
 * Thinking leakage is detected (a `reasoning`/`reasoning_content` delta or a
 * `<think>` prefix), stripped from `text`, and reported in `thinkingLeaked` so the
 * warm-up can log it — with thinking on, the token cap is spent thinking and no
 * JSON comes back (07 §1).
 *
 * The transport (`createStream`) is injectable so tests run without network.
 */
import OpenAI from 'openai';
import type { ProxyConfig } from '../config';
import type { StreamHandle } from './deadline';

export type NimProvider = 'nim' | 'openrouter';

export interface NimTarget {
  provider: NimProvider;
  baseURL: string;
  apiKey: string;
  model: string;
  keyLabel: 'primary' | 'fallback' | 'openrouter';
}

export interface NimMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface NimChatParams {
  system?: string;
  user?: string;
  messages?: NimMessage[];
  /** JSON schema for nvext.guided_json (B's job schema). */
  schema: Record<string, unknown>;
  schemaName?: string;
  maxTokens?: number;
  temperature?: number;
  /** Override the configured model id (exact string from /v1/models). */
  model?: string;
}

export interface NimChunk {
  text?: string;
  reasoning?: string;
}

export interface NimChatResult {
  text: string;
  provider: NimProvider;
  model: string;
  keyLabel: NimTarget['keyLabel'];
  firstTokenMs: number | null;
  totalMs: number;
  thinkingLeaked: boolean;
  failovers: string[];
}

export interface NimHandle extends StreamHandle<NimChatResult> {
  provider: NimProvider;
  model: string;
}

export type CreateStream = (
  target: NimTarget,
  body: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<AsyncIterable<NimChunk>>;

export interface NimDeps {
  config: ProxyConfig;
  createStream?: CreateStream;
  now?: () => number;
  onFailover?: (from: NimTarget, to: NimTarget, reason: string) => void;
}

export class NimConfigError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'NimConfigError';
  }
}

/** HTTP statuses (or connection failures) that justify moving to the next target. */
export function isFailoverError(e: unknown): { failover: boolean; status: number | null; reason: string } {
  const status = typeof (e as { status?: unknown })?.status === 'number' ? ((e as { status: number }).status) : null;
  if (status === 429 || status === 503 || status === 502 || status === 504) return { failover: true, status, reason: `http_${status}` };
  if (status === null) {
    const name = (e as { name?: string })?.name ?? '';
    const msg = (e as { message?: string })?.message ?? String(e);
    if (name === 'AbortError') return { failover: false, status: null, reason: 'aborted' };
    if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|fetch failed|Connection error|network/i.test(`${name} ${msg}`)) {
      return { failover: true, status: null, reason: 'connect_error' };
    }
    return { failover: false, status: null, reason: 'upstream_error' };
  }
  return { failover: false, status, reason: `http_${status}` };
}

/** Ordered targets: NIM primary → NIM spare key (429 only, checked by caller) → OpenRouter. */
export function buildTargets(cfg: ProxyConfig, model?: string): NimTarget[] {
  const out: NimTarget[] = [];
  const m = model ?? cfg.nvidiaModel;
  if (cfg.nvidiaApiKey) out.push({ provider: 'nim', baseURL: cfg.nimBaseUrl, apiKey: cfg.nvidiaApiKey, model: m, keyLabel: 'primary' });
  if (cfg.nvidiaApiKeyFallback) out.push({ provider: 'nim', baseURL: cfg.nimBaseUrl, apiKey: cfg.nvidiaApiKeyFallback, model: m, keyLabel: 'fallback' });
  if (cfg.openRouterApiKey) out.push({ provider: 'openrouter', baseURL: cfg.openRouterBaseUrl, apiKey: cfg.openRouterApiKey, model: model ?? cfg.openRouterModel, keyLabel: 'openrouter' });
  return out;
}

/** The request body, per provider. Exported for the tests and the day-0 probe. */
export function buildBody(target: NimTarget, p: NimChatParams): Record<string, unknown> {
  const messages: NimMessage[] = p.messages ?? [
    ...(p.system ? [{ role: 'system' as const, content: p.system }] : []),
    { role: 'user' as const, content: p.user ?? '' },
  ];
  const base: Record<string, unknown> = {
    model: target.model,
    messages,
    stream: true,
    temperature: p.temperature ?? 0,
    max_completion_tokens: p.maxTokens ?? 300,
    chat_template_kwargs: { enable_thinking: false },
  };
  if (target.provider === 'nim') {
    base.nvext = { guided_json: p.schema };
  } else {
    base.response_format = { type: 'json_schema', json_schema: { name: p.schemaName ?? 'output', schema: p.schema, strict: true } };
  }
  return base;
}

/** Default transport: the OpenAI SDK as a plain OpenAI-compatible client. */
export const openAiCreateStream: CreateStream = async (target, body, signal) => {
  const client = new OpenAI({ apiKey: target.apiKey, baseURL: target.baseURL, maxRetries: 0, timeout: 20_000 });
  const stream = await client.chat.completions.create(
    body as unknown as Parameters<typeof client.chat.completions.create>[0] & { stream: true },
    { signal },
  );
  return (async function* () {
    for await (const chunk of stream as AsyncIterable<{ choices?: Array<{ delta?: Record<string, unknown> }> }>) {
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      const text = typeof delta.content === 'string' ? delta.content : undefined;
      const reasoning = typeof delta.reasoning_content === 'string'
        ? delta.reasoning_content
        : typeof delta.reasoning === 'string' ? delta.reasoning : undefined;
      if (text !== undefined || reasoning !== undefined) yield { text, reasoning };
    }
  })();
};

const THINK_OPEN = /^\s*<think>/i;
const THINK_BLOCK = /<think>[\s\S]*?<\/think>\s*/gi;

/** Strip a leaked `<think>…</think>` block; returns the cleaned text and whether one was seen. */
export function stripThinking(text: string): { text: string; leaked: boolean } {
  if (!/<think>/i.test(text)) return { text, leaked: false };
  const cleaned = text.replace(THINK_BLOCK, '');
  // An unterminated <think> with no JSON after it: keep whatever follows the tag.
  const finalText = THINK_OPEN.test(cleaned) ? cleaned.replace(THINK_OPEN, '') : cleaned;
  return { text: finalText.trimStart(), leaked: true };
}

export function nimChat(params: NimChatParams, deps: NimDeps): NimHandle {
  const now = deps.now ?? Date.now;
  const createStream = deps.createStream ?? openAiCreateStream;
  const targets = buildTargets(deps.config, params.model);
  if (targets.length === 0) throw new NimConfigError('NVIDIA_API_KEY (or OPENROUTER_API_KEY) is not set');

  const controller = new AbortController();
  const t0 = now();
  let firstTokenAt: number | null = null;
  let resolveFirst!: (ms: number) => void;
  let rejectFirst!: (e: unknown) => void;
  const firstToken = new Promise<number>((res, rej) => {
    resolveFirst = res;
    rejectFirst = rej;
  });
  firstToken.catch(() => undefined);

  const handle: NimHandle = {
    provider: targets[0]!.provider,
    model: targets[0]!.model,
    firstToken,
    result: undefined as unknown as Promise<NimChatResult>,
    abort: () => controller.abort(),
  };

  handle.result = (async (): Promise<NimChatResult> => {
    const failovers: string[] = [];
    for (let i = 0; i < targets.length; i += 1) {
      const target = targets[i]!;
      handle.provider = target.provider;
      handle.model = target.model;
      let text = '';
      let reasoning = '';
      try {
        const body = buildBody(target, params);
        const stream = await createStream(target, body, controller.signal);
        for await (const chunk of stream) {
          if (controller.signal.aborted) break;
          if (chunk.reasoning) reasoning += chunk.reasoning;
          if (chunk.text) {
            if (firstTokenAt === null) {
              firstTokenAt = now();
              resolveFirst(firstTokenAt - t0);
            }
            text += chunk.text;
          }
        }
        if (controller.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        const stripped = stripThinking(text);
        if (firstTokenAt === null) {
          // Empty completion: count it as an (instant) first token so the deadline helper reaches `accept`.
          firstTokenAt = now();
          resolveFirst(firstTokenAt - t0);
        }
        return {
          text: stripped.text,
          provider: target.provider,
          model: target.model,
          keyLabel: target.keyLabel,
          firstTokenMs: firstTokenAt - t0,
          totalMs: now() - t0,
          thinkingLeaked: stripped.leaked || reasoning.length > 0,
          failovers,
        };
      } catch (e) {
        const verdict = isFailoverError(e);
        const next = targets[i + 1];
        const beforeFirstToken = firstTokenAt === null;
        // The spare NIM key is only worth trying on a rate limit.
        const skipSpare = next?.keyLabel === 'fallback' && verdict.status !== 429;
        if (verdict.failover && beforeFirstToken && next) {
          const to = skipSpare ? targets[i + 2] : next;
          if (to) {
            failovers.push(`${target.keyLabel}:${verdict.reason}`);
            deps.onFailover?.(target, to, verdict.reason);
            if (skipSpare) i += 1;
            continue;
          }
        }
        rejectFirst(e);
        throw e;
      }
    }
    const e = new Error('all Nemotron targets failed');
    rejectFirst(e);
    throw e;
  })();
  handle.result.catch(() => undefined);
  return handle;
}

/** Authenticated model listing for /api/health (asserts the Nemotron id is present). */
export async function listNimModels(
  cfg: ProxyConfig,
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<{ ids: string[]; modelSeen: boolean; fallbackSeen: boolean }> {
  if (!cfg.nvidiaApiKey) throw new NimConfigError('NVIDIA_API_KEY is not set');
  const res = await fetchFn(`${cfg.nimBaseUrl}/models`, { headers: { Authorization: `Bearer ${cfg.nvidiaApiKey}` }, signal });
  if (!res.ok) throw Object.assign(new Error(`nim /models ${res.status}`), { status: res.status });
  const json = (await res.json()) as { data?: Array<{ id?: string }> };
  const ids = (json.data ?? []).map((m) => m.id ?? '').filter(Boolean);
  return { ids, modelSeen: ids.includes(cfg.nvidiaModel), fallbackSeen: ids.includes(cfg.nvidiaModelFallback) };
}
