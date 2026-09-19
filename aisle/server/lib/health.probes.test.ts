import { describe, expect, it } from 'vitest';
import { defaultHealthChecks, OVERPASS_STATUS_URLS, OVERPASS_USER_AGENT } from './health';
import type { ProxyConfig } from '../config';

const cfg = {
  elevenLabsApiKey: 'k',
  elevenLabsVoiceId: 'v123',
  elevenLabsBaseUrl: 'https://api.elevenlabs.io',
} as unknown as ProxyConfig;

type Call = { url: string; init?: RequestInit };

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { fn, calls };
}

const signal = new AbortController().signal;

describe('elevenlabs_tts probe tolerates scoped keys', () => {
  it('uses the subscription when the key has user:read', async () => {
    const { fn, calls } = fakeFetch((url) =>
      url.endsWith('/v1/user/subscription')
        ? new Response(JSON.stringify({ character_count: 100, character_limit: 1000 }), { status: 200 })
        : new Response('unexpected', { status: 500 }),
    );
    const r = await defaultHealthChecks(cfg, fn).elevenlabs_tts(signal);
    expect(r).toEqual({ creditsLeft: 900 });
    expect(calls).toHaveLength(1);
  });

  it('falls back to voices:read when subscription is 401', async () => {
    const { fn, calls } = fakeFetch((url) =>
      url.endsWith('/v1/user/subscription') ? new Response('', { status: 401 })
      : url.endsWith('/v1/voices/v123') ? new Response('{}', { status: 200 })
      : new Response('unexpected', { status: 500 }),
    );
    const r = await defaultHealthChecks(cfg, fn).elevenlabs_tts(signal);
    expect(r).toEqual({});
    expect(calls.map((c) => c.url.split('/v1/')[1])).toEqual(['user/subscription', 'voices/v123']);
  });

  it('proves the TTS scope itself with a one-character synthesis when both reads are denied', async () => {
    const { fn, calls } = fakeFetch((url, init) =>
      url.endsWith('/v1/user/subscription') || url.endsWith('/v1/voices/v123') ? new Response('', { status: 401 })
      : url.includes('/v1/text-to-speech/v123') && init?.method === 'POST' ? new Response(new Uint8Array([1, 2, 3]), { status: 200 })
      : new Response('unexpected', { status: 500 }),
    );
    const r = await defaultHealthChecks(cfg, fn).elevenlabs_tts(signal);
    expect(r).toEqual({});
    const tts = calls.find((c) => c.url.includes('/v1/text-to-speech/'));
    expect(tts).toBeTruthy();
    expect(JSON.parse(String(tts!.init!.body)).text).toBe('.');
  });

  it('still reports a real outage (500) as an error, not a scope problem', async () => {
    const { fn } = fakeFetch(() => new Response('down', { status: 500 }));
    await expect(defaultHealthChecks(cfg, fn).elevenlabs_tts(signal)).rejects.toThrow(/500/);
  });
});

describe('overpass status probe', () => {
  it('identifies itself and accepts text, and passes on the primary', async () => {
    const { fn, calls } = fakeFetch(() => new Response('OK', { status: 200 }));
    await defaultHealthChecks(cfg, fn).overpass(signal);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(OVERPASS_STATUS_URLS[0]);
    const h = calls[0].init?.headers as Record<string, string>;
    expect(h['User-Agent']).toBe(OVERPASS_USER_AGENT);
    expect(h.Accept).toMatch(/text\/plain/);
  });

  it('falls back to the mirror on 406 and fails with the last status if both fail', async () => {
    const { fn, calls } = fakeFetch((url) => new Response('', { status: url.includes('kumi') ? 200 : 406 }));
    await defaultHealthChecks(cfg, fn).overpass(signal);
    expect(calls.map((c) => c.url)).toEqual([...OVERPASS_STATUS_URLS]);
    const { fn: allBad } = fakeFetch(() => new Response('', { status: 406 }));
    await expect(defaultHealthChecks(cfg, allBad).overpass(signal)).rejects.toThrow(/overpass 406/);
  });
});
