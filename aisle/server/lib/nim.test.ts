import { describe, expect, it } from 'vitest';
import { testConfig } from '../test/fakes';
import { withFirstTokenDeadline } from './deadline';
import { type CreateStream, type NimTarget, buildBody, chunksFromCompletion, buildTargets, isFailoverError, nimChat, stripThinking } from './nim';

const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };

function streamOf(parts: string[], delayMs = 0): CreateStream {
  return async () => (async function* () {
    for (const p of parts) {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      yield { text: p };
    }
  })();
}

describe('buildBody', () => {
  const target: NimTarget = { provider: 'nim', baseURL: 'https://integrate.api.nvidia.com/v1', apiKey: 'k', model: 'nvidia/nemotron-3.5-lightning-30b-a3b', keyLabel: 'primary' };

  it('sends a NON-streaming json_object request with thinking off and the schema in the system prompt to NIM (no nvext)', () => {
    const body = buildBody(target, { system: 'sys', user: 'u', schema });
    expect(body.stream).toBe(false);
    expect(body.temperature).toBe(0);
    expect(body.max_completion_tokens).toBe(300);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.nvext).toBeUndefined();
    expect(body.response_format).toEqual({ type: 'json_object' });
    const msgs = body.messages as Array<{ role: string; content: string }>;
    expect(msgs[0]?.role).toBe('system');
    expect(msgs[0]?.content.startsWith('sys')).toBe(true);
    expect(msgs[0]?.content).toContain(JSON.stringify(schema));
    expect(msgs[1]).toEqual({ role: 'user', content: 'u' });
  });

  it('adds a system message with the schema when the caller gave none (NIM)', () => {
    const body = buildBody(target, { user: 'u', schema });
    const msgs = body.messages as Array<{ role: string; content: string }>;
    expect(msgs[0]?.role).toBe('system');
    expect(msgs[0]?.content).toContain('JSON Schema');
  });

  it('chunksFromCompletion turns a non-streaming completion into one chunk', () => {
    expect(chunksFromCompletion({ choices: [{ message: { content: '{"a":1}' } }] })).toEqual([{ text: '{"a":1}', reasoning: undefined }]);
    expect(chunksFromCompletion({ choices: [] })).toEqual([]);
  });

  it('uses response_format json_schema (no nvext) on OpenRouter', () => {
    const body = buildBody({ ...target, provider: 'openrouter', keyLabel: 'openrouter' }, { user: 'u', schema, schemaName: 'parseIntent' });
    expect(body.nvext).toBeUndefined();
    expect(body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'parseIntent', schema, strict: true } });
  });
});

describe('buildTargets', () => {
  it('orders primary NIM, spare NIM key, then OpenRouter, skipping unset keys', () => {
    const cfg = testConfig({ nvidiaApiKeyFallback: 'spare', openRouterApiKey: 'or' });
    expect(buildTargets(cfg).map((t) => t.keyLabel)).toEqual(['primary', 'fallback', 'openrouter']);
    expect(buildTargets(testConfig()).map((t) => t.keyLabel)).toEqual(['primary']);
    expect(buildTargets(testConfig({ nvidiaApiKey: null, openRouterApiKey: 'or' })).map((t) => t.provider)).toEqual(['openrouter']);
  });
});

describe('isFailoverError', () => {
  it('fails over on 429/502/503/504 and connection errors, not on 400/401', () => {
    expect(isFailoverError({ status: 429 }).failover).toBe(true);
    expect(isFailoverError({ status: 503 }).failover).toBe(true);
    expect(isFailoverError(new Error('fetch failed')).failover).toBe(true);
    expect(isFailoverError({ status: 400 }).failover).toBe(false);
    expect(isFailoverError({ status: 401 }).failover).toBe(false);
    expect(isFailoverError(Object.assign(new Error('x'), { name: 'AbortError' })).failover).toBe(false);
  });
});

describe('stripThinking', () => {
  it('removes a leaked <think> block and flags it', () => {
    expect(stripThinking('<think>hmm</think>{"ok":true}')).toEqual({ text: '{"ok":true}', leaked: true });
    expect(stripThinking('{"ok":true}')).toEqual({ text: '{"ok":true}', leaked: false });
  });
});

describe('nimChat', () => {
  it('streams text, reports first-token and provider', async () => {
    const h = nimChat({ user: 'u', schema }, { config: testConfig(), createStream: streamOf(['{"ok"', ':true}']) });
    const first = await h.firstToken;
    expect(first).toBeGreaterThanOrEqual(0);
    const r = await h.result;
    expect(r.text).toBe('{"ok":true}');
    expect(r.provider).toBe('nim');
    expect(r.keyLabel).toBe('primary');
    expect(r.thinkingLeaked).toBe(false);
    expect(r.failovers).toEqual([]);
  });

  it('fails over to OpenRouter on a 429 before the first token', async () => {
    const seen: string[] = [];
    const createStream: CreateStream = async (target) => {
      seen.push(target.keyLabel);
      if (target.provider === 'nim') throw Object.assign(new Error('rate limited'), { status: 429 });
      return (async function* () {
        yield { text: '{"ok":true}' };
      })();
    };
    const h = nimChat({ user: 'u', schema }, { config: testConfig({ openRouterApiKey: 'or' }), createStream });
    const r = await h.result;
    expect(seen).toEqual(['primary', 'openrouter']);
    expect(r.provider).toBe('openrouter');
    expect(r.failovers).toEqual(['primary:http_429']);
  });

  it('tries the spare NIM key only on 429, and skips straight to OpenRouter on 503', async () => {
    const seen: string[] = [];
    const createStream: CreateStream = async (target) => {
      seen.push(target.keyLabel);
      if (target.provider === 'nim') throw Object.assign(new Error('unavailable'), { status: 503 });
      return (async function* () {
        yield { text: '{"ok":true}' };
      })();
    };
    const cfg = testConfig({ nvidiaApiKeyFallback: 'spare', openRouterApiKey: 'or' });
    const r = await nimChat({ user: 'u', schema }, { config: cfg, createStream }).result;
    expect(seen).toEqual(['primary', 'openrouter']);
    expect(r.provider).toBe('openrouter');
  });

  it('does not fail over after the first token arrived', async () => {
    const seen: string[] = [];
    const createStream: CreateStream = async (target) => {
      seen.push(target.keyLabel);
      return (async function* () {
        yield { text: '{"ok"' };
        throw Object.assign(new Error('dropped'), { status: 503 });
      })();
    };
    const h = nimChat({ user: 'u', schema }, { config: testConfig({ openRouterApiKey: 'or' }), createStream });
    await expect(h.result).rejects.toThrow('dropped');
    expect(seen).toEqual(['primary']);
  });

  it('rejects (no failover) on a 400', async () => {
    const createStream: CreateStream = async () => {
      throw Object.assign(new Error('bad request'), { status: 400 });
    };
    const h = nimChat({ user: 'u', schema }, { config: testConfig({ openRouterApiKey: 'or' }), createStream });
    await expect(h.result).rejects.toThrow('bad request');
    await expect(h.firstToken).rejects.toThrow('bad request');
  });

  it('strips a leaked reasoning stream and flags thinkingLeaked', async () => {
    const createStream: CreateStream = async () => (async function* () {
      yield { reasoning: 'let me think' };
      yield { text: '<think>x</think>{"ok":true}' };
    })();
    const r = await nimChat({ user: 'u', schema }, { config: testConfig(), createStream }).result;
    expect(r.text).toBe('{"ok":true}');
    expect(r.thinkingLeaked).toBe(true);
  });

  it('throws NimConfigError when no key is configured', () => {
    expect(() => nimChat({ user: 'u', schema }, { config: testConfig({ nvidiaApiKey: null }) })).toThrow(/NVIDIA_API_KEY/);
  });

  it('composes with the deadline helper: slow first token → templated fallback', async () => {
    const out = await withFirstTokenDeadline(
      () => nimChat({ user: 'u', schema }, { config: testConfig(), createStream: streamOf(['{"ok":true}'], 200) }),
      { firstTokenMs: 30, fallback: () => ({ ok: false }), accept: (r) => JSON.parse(r.text) as { ok: boolean } },
    );
    expect(out.fallback).toBe(true);
    expect(out.reason).toBe('first_token_deadline');
    expect(out.value).toEqual({ ok: false });
  });
});
