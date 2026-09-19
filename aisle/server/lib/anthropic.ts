/**
 * Claude Tier 1 (01 §8, 07 §3, 05 Part 2 "/api/vision").
 *
 * One streamed Messages call per VisionRequest with the byte-stable superset schema
 * as `output_config.format`. Routing: `curb_crop` → claude-sonnet-5 with
 * `thinking: { type: 'disabled' }` and a `cache_control` breakpoint on the system
 * prompt; everything else → claude-haiku-4-5 (no thinking field, no cache chase).
 * `max_tokens: 300`, `maxRetries: 0`, 4 s timeout. On timeout, a stop_reason other
 * than `end_turn`, or unparsable JSON the caller gets `response: null` and answers
 * `{ confidence: 0, seq }`.
 *
 * Speech is extracted while streaming (lib/speechExtract.ts). The proxy holds it
 * until the string closes, runs the language rule, and only then hands it to TTS:
 * forwarding token by token would speak a forbidden word before it could be
 * blanked, and a ≤ 12-word string closes within ~150 ms of its first token.
 *
 * The transport is injectable (`deps.stream`) so tests run with synthetic events.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { VisionRequest, VisionResponse } from '../../src/core/contracts';
import { MODELS } from '../config';
import { type LanguageVerdict, sanitizeSpeech } from './language';
import { createSpeechScanner, parseFinalJson } from './speechExtract';
import { VISION_RESPONSE_SCHEMA, coerceVisionResponse } from '../schemas/vision';
import { renderFacts, systemPromptFor } from '../prompts/vision';

export const VISION_MAX_TOKENS = 300;
export const VISION_TIMEOUT_MS = 4000;
export const MAX_IMAGE_LONG_EDGE = 1024;

export type VisionModel = typeof MODELS.haiku | typeof MODELS.sonnet;

export function modelFor(question: VisionRequest['question']): VisionModel {
  return question === 'curb_crop' ? MODELS.sonnet : MODELS.haiku;
}

/** Build the Messages params. Exported for the tests and the warm-up. */
export function buildVisionParams(req: VisionRequest): Anthropic.MessageStreamParams {
  const model = modelFor(req.question);
  const system = systemPromptFor(req);
  const content: Anthropic.ContentBlockParam[] = [];
  if (req.image) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: req.image.base64 },
    });
  }
  content.push({ type: 'text', text: `${renderFacts(req)}\nseq: ${req.seq}` });

  const params: Anthropic.MessageStreamParams = {
    model,
    max_tokens: VISION_MAX_TOKENS,
    system: [
      model === MODELS.sonnet
        ? { type: 'text', text: system, cache_control: { type: 'ephemeral' } }
        : { type: 'text', text: system },
    ],
    messages: [{ role: 'user', content }],
    output_config: { format: { type: 'json_schema', schema: { ...VISION_RESPONSE_SCHEMA } } },
  };
  if (model === MODELS.sonnet) params.thinking = { type: 'disabled' };
  return params;
}

export interface VisionCallResult {
  response: VisionResponse | null;
  /** Sanitized speech ('' when blanked or empty). */
  speech: string;
  verdict: LanguageVerdict;
  model: string;
  stopReason: string | null;
  firstTokenMs: number | null;
  speechClosedMs: number | null;
  totalMs: number;
  error?: string;
}

export interface VisionHooks {
  /** Fires once, after the language check, with the speech the phone may hear ('' skips TTS). */
  onSpeechReady?: (speech: string, verdict: LanguageVerdict) => void;
}

export type StreamFactory = (
  params: Anthropic.MessageStreamParams,
  signal: AbortSignal,
) => AsyncIterable<Anthropic.RawMessageStreamEvent>;

export interface AnthropicDeps {
  apiKey?: string | null;
  stream?: StreamFactory;
  now?: () => number;
  timeoutMs?: number;
}

export function sdkStreamFactory(apiKey: string): StreamFactory {
  const clientTimeoutMs = deps.timeoutMs ?? VISION_TIMEOUT_MS;
  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: clientTimeoutMs });
  return (params, signal) => client.messages.stream(params, { signal });
}

export class AnthropicConfigError extends Error {
  constructor() {
    super('ANTHROPIC_API_KEY is not set');
    this.name = 'AnthropicConfigError';
  }
}

export async function runVision(req: VisionRequest, hooks: VisionHooks, deps: AnthropicDeps): Promise<VisionCallResult> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  const params = buildVisionParams(req);
  const model = params.model;
  const timeoutMs = deps.timeoutMs ?? VISION_TIMEOUT_MS;

  let stream: StreamFactory | undefined = deps.stream;
  if (!stream) {
    if (!deps.apiKey) throw new AnthropicConfigError();
    stream = sdkStreamFactory(deps.apiKey);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const scanner = createSpeechScanner();
  let firstTokenMs: number | null = null;
  let speechClosedMs: number | null = null;
  let speech = '';
  let verdict: LanguageVerdict = 'pass';
  let speechReadyFired = false;
  let stopReason: string | null = null;
  let error: string | undefined;

  const fireSpeech = (): void => {
    if (speechReadyFired) return;
    speechReadyFired = true;
    const s = sanitizeSpeech(scanner.speech());
    speech = s.speech;
    verdict = s.verdict;
    hooks.onSpeechReady?.(speech, verdict);
  };

  try {
    for await (const ev of stream(params, controller.signal)) {
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
        if (firstTokenMs === null) firstTokenMs = now() - t0;
        const step = scanner.feed(ev.delta.text);
        if (step.closed && speechClosedMs === null) {
          speechClosedMs = now() - t0;
          fireSpeech();
        }
      } else if (ev.type === 'message_delta') {
        stopReason = ev.delta.stop_reason ?? stopReason;
      }
    }
  } catch (e) {
    error = controller.signal.aborted ? 'timeout' : e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timer);
  }

  const totalMs = now() - t0;
  // Speech never closed (empty output, timeout mid-string): nothing is spoken.
  if (!speechReadyFired) {
    speechReadyFired = true;
    speech = '';
    hooks.onSpeechReady?.('', 'pass');
  }

  if (error || stopReason !== 'end_turn') {
    return { response: null, speech: '', verdict, model, stopReason, firstTokenMs, speechClosedMs, totalMs, error: error ?? `stop_reason:${stopReason ?? 'none'}` };
  }
  const parsed = parseFinalJson(scanner.raw());
  const coerced = coerceVisionResponse(parsed, req.seq);
  if (!coerced) {
    return { response: null, speech: '', verdict, model, stopReason, firstTokenMs, speechClosedMs, totalMs, error: 'invalid_json' };
  }
  coerced.speech = speech;
  return { response: coerced, speech, verdict, model, stopReason, firstTokenMs, speechClosedMs, totalMs };
}

/** Cheap liveness for /api/health: the model list. */
export async function listAnthropicModels(apiKey: string, signal?: AbortSignal): Promise<string[]> {
  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: 10_000 });
  const page = await client.models.list({ limit: 50 }, { signal });
  return page.data.map((m) => m.id);
}
