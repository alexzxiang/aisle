import { afterEach, describe, expect, it } from 'vitest';
import { WALKING_BETA_WARNING } from '../../src/outdoor/types';
import { fakeClaude, fakeDeps, sampleRequest, startTestServer, type TestServer } from '../test/fakes';
import { parseKeyterms, tooShort, wavDurationMs } from './stt';

let srv: TestServer | null = null;
afterEach(async () => {
  await srv?.close();
  srv = null;
});

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('POST /api/vision', () => {
  it('returns the coerced VisionResponse and logs one line', async () => {
    const deps = fakeDeps({ claude: fakeClaude({ speech: 'Doors ahead.' }) });
    srv = await startTestServer(deps);
    const res = await post(`${srv.url}/api/vision`, sampleRequest({ seq: 4 }));
    expect(res.status).toBe(200);
    const j = (await res.json()) as { speech: string; seq: number; confidence: number };
    expect(j.speech).toBe('Doors ahead.');
    expect(j.seq).toBe(4);
    const lines = deps.log.recent({ route: 'vision' });
    expect(lines.length).toBe(1);
    expect(lines[0]?.verdict).toBe('pass');
    expect(lines[0]?.key).toBe('storefront');
    expect(deps.latency.stats('vision.storefront').n).toBe(1);
  });

  it('rejects a bad question, a 1280-wide image and a missing seq with 400', async () => {
    srv = await startTestServer(fakeDeps());
    expect((await post(`${srv.url}/api/vision`, sampleRequest({ question: 'describe' as never }))).status).toBe(400);
    expect((await post(`${srv.url}/api/vision`, sampleRequest({ image: { base64: 'x'.repeat(64), width: 1280, height: 960 } }))).status).toBe(400);
    const r = await post(`${srv.url}/api/vision`, { question: 'storefront', mode: 'OUTDOOR_NAV', facts: { detections: [], ocr: [] } });
    expect(r.status).toBe(400);
  });

  it('answers { confidence: 0, seq } for a stale seq on the same client and logs stale_seq', async () => {
    const deps = fakeDeps();
    srv = await startTestServer(deps);
    await post(`${srv.url}/api/vision`, sampleRequest({ seq: 10 }), { 'x-aisle-client': 'phone-1' });
    const res = await post(`${srv.url}/api/vision`, sampleRequest({ seq: 9 }), { 'x-aisle-client': 'phone-1' });
    expect(await res.json()).toEqual({ confidence: 0, seq: 9 });
    expect(deps.log.recent({ route: 'vision' }).at(-1)?.error).toBe('stale_seq');
    // a different client has its own counter
    const other = await post(`${srv.url}/api/vision`, sampleRequest({ seq: 1 }), { 'x-aisle-client': 'phone-2' });
    expect(((await other.json()) as { confidence: number }).confidence).toBe(0.9);
  });

  it('answers a fourth in-flight request { confidence: 0 } immediately', async () => {
    const deps = fakeDeps({ claude: fakeClaude({ speech: 'Hi.', deltas: 4, delayMs: 40 }) });
    srv = await startTestServer(deps);
    const h = { 'x-aisle-client': 'p' };
    const t0 = Date.now();
    const p = [1, 2, 3].map((seq) => post(`${srv!.url}/api/vision`, sampleRequest({ seq }), h));
    await new Promise((r) => setTimeout(r, 20));
    const fourth = await post(`${srv.url}/api/vision`, sampleRequest({ seq: 4 }), h);
    expect(Date.now() - t0).toBeLessThan(150);
    expect(await fourth.json()).toEqual({ confidence: 0, seq: 4 });
    const done = await Promise.all(p);
    for (const r of done) expect(((await r.json()) as { confidence: number }).confidence).toBe(0.9);
  });

  it('answers { confidence: 0, seq } when Claude stops for max_tokens or the transport throws', async () => {
    srv = await startTestServer(fakeDeps({ claude: fakeClaude({ speech: 'Hi.', stopReason: 'max_tokens' }) }));
    expect(await (await post(`${srv.url}/api/vision`, sampleRequest({ seq: 1 }))).json()).toEqual({ confidence: 0, seq: 1 });
    await srv.close();
    srv = await startTestServer(fakeDeps({ vision: async () => { throw new Error('socket hang up'); } }));
    expect(await (await post(`${srv.url}/api/vision`, sampleRequest({ seq: 1 }))).json()).toEqual({ confidence: 0, seq: 1 });
  });
});

describe('POST /api/tts', () => {
  it('synthesizes a clean phrase as audio/mpeg with the verdict header', async () => {
    const deps = fakeDeps();
    srv = await startTestServer(deps);
    const res = await post(`${srv.url}/api/tts`, { text: 'Walk signal on.', cacheKey: 'walk_signal_on' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('audio/mpeg');
    expect(res.headers.get('x-aisle-verdict')).toBe('pass');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('MP3:Walk signal on.');
    expect(deps.log.recent({ route: 'tts' })[0]?.verdict).toBe('pass');
  });

  it('returns 422 for a forbidden word and for more than twelve words', async () => {
    const deps = fakeDeps();
    srv = await startTestServer(deps);
    const bad = await post(`${srv.url}/api/tts`, { text: 'The road is clear.' });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { reason: string }).reason).toBe('forbidden');
    const long = await post(`${srv.url}/api/tts`, { text: 'one two three four five six seven eight nine ten eleven twelve thirteen' });
    expect(long.status).toBe(422);
    expect(((await long.json()) as { reason: string }).reason).toBe('too_long');
    expect(deps.log.recent({ route: 'tts' }).map((l) => l.verdict)).toEqual(['rejected_422', 'rejected_422']);
  });

  it('pre-synthesizes the hashed walking-beta sentence and logs allowlisted; a paraphrase still 422s', async () => {
    const deps = fakeDeps();
    srv = await startTestServer(deps);
    const ok = await post(`${srv.url}/api/tts`, { text: WALKING_BETA_WARNING, cacheKey: 'walking_beta' });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-aisle-verdict')).toBe('allowlisted');
    expect(deps.log.recent({ route: 'tts' })[0]?.verdict).toBe('allowlisted');
    const para = await post(`${srv.url}/api/tts`, { text: WALKING_BETA_WARNING.replace('may be', 'might be') });
    expect(para.status).toBe(422);
  });

  it('streams when asked and 400s on empty text', async () => {
    srv = await startTestServer(fakeDeps());
    const res = await post(`${srv.url}/api/tts?stream=1`, { text: 'Far curb.' });
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('MP3S:Far curb.');
    expect((await post(`${srv.url}/api/tts`, { text: '' })).status).toBe(400);
  });

  it('maps an upstream failure to 502', async () => {
    srv = await startTestServer(fakeDeps({ flash: async () => { throw Object.assign(new Error('quota'), { status: 429 }); } }));
    const res = await post(`${srv.url}/api/tts`, { text: 'Far curb.' });
    expect(res.status).toBe(502);
  });
});

describe('POST /api/stt', () => {
  const wav = (ms: number): Buffer => {
    const sr = 16000;
    const n = Math.round((sr * ms) / 1000);
    const data = Buffer.alloc(n * 2);
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
    h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sr, 24);
    h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
    return Buffer.concat([h, data]);
  };

  it('measures WAV duration and applies the 100 ms floor', () => {
    expect(Math.round(wavDurationMs(wav(300)) ?? 0)).toBe(300);
    expect(tooShort(wav(50))).toBe(true);
    expect(tooShort(wav(150))).toBe(false);
    expect(tooShort(Buffer.alloc(100))).toBe(true);
    expect(wavDurationMs(Buffer.alloc(10))).toBeNull();
  });

  it('caps and de-duplicates keyterms at 100', () => {
    expect(parseKeyterms('eggs, milk ,eggs,,')).toEqual(['eggs', 'milk']);
    expect(parseKeyterms(Array.from({ length: 150 }, (_, i) => `t${i}`)).length).toBe(100);
  });

  it('transcribes a raw audio body and passes keyterms through', async () => {
    let seen: string[] = [];
    const deps = fakeDeps({ stt: async (_a, o) => { seen = o.keyterms ?? []; return { text: 'eggs please', languageCode: 'en', raw: {} }; } });
    srv = await startTestServer(deps);
    const res = await fetch(`${srv.url}/api/stt?keyterms=eggs,aisle%20three`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: new Blob([new Uint8Array(wav(400))]) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { text: string }).text).toBe('eggs please');
    expect(seen).toEqual(['eggs', 'aisle three']);
  });

  it('accepts the JSON base64 shape and rejects clips under 100 ms', async () => {
    srv = await startTestServer(fakeDeps());
    const ok = await post(`${srv.url}/api/stt`, { audioBase64: wav(200).toString('base64'), mimeType: 'audio/wav', keyterms: ['eggs'] });
    expect(ok.status).toBe(200);
    const short = await post(`${srv.url}/api/stt`, { audioBase64: wav(40).toString('base64'), mimeType: 'audio/wav' });
    expect(short.status).toBe(422);
    expect((await post(`${srv.url}/api/stt`, {})).status).toBe(400);
  });
});

describe('GET /api/health', () => {
  it('reports every upstream, schemasWarm and latency', async () => {
    const deps = fakeDeps();
    deps.latency.record('vision.storefront', 1900);
    srv = await startTestServer(deps);
    const res = await fetch(`${srv.url}/api/health`);
    const j = (await res.json()) as { ok: boolean; region: string; upstreams: Record<string, { ok: boolean; required?: boolean }>; schemasWarm: Record<string, unknown>; latency: Record<string, { p50: number }> };
    expect(j.ok).toBe(true);
    expect(j.region).toBe('us-east');
    expect(Object.keys(j.upstreams).sort()).toEqual(['anthropic', 'elevenlabs_stt', 'elevenlabs_tts', 'google_routes', 'nvidia', 'openrouter']);
    expect(j.upstreams.openrouter?.required).toBe(false);
    expect(Object.keys(j.schemasWarm)).toContain('haiku:vision');
    expect(j.latency['vision.storefront']?.p50).toBe(1900);
  });

  it('passes ?budgetMs through to the probes, clamped, and leaves an unasked report unbounded', async () => {
    const deps = fakeDeps();
    const seen: Array<{ force?: boolean; timeoutMs?: number }> = [];
    const report = deps.health.report.bind(deps.health);
    deps.health = { report: (o = {}) => { seen.push(o); return report(o); } };
    srv = await startTestServer(deps);
    await fetch(`${srv.url}/api/health?budgetMs=800`);
    await fetch(`${srv.url}/api/health?budgetMs=99999`);
    await fetch(`${srv.url}/api/health?budgetMs=oops`);
    await fetch(`${srv.url}/api/health`);
    expect(seen.map((o) => o.timeoutMs)).toEqual([800, 10_000, undefined, undefined]);
  });

  it('/warm re-fires every pair', async () => {
    const deps = fakeDeps();
    srv = await startTestServer(deps);
    const res = await fetch(`${srv.url}/api/health/warm`);
    const j = (await res.json()) as { schemasWarm: Record<string, string | null> };
    expect(j.schemasWarm['haiku:vision']).not.toBeNull();
    expect(deps.warmCalls).toContain('nim:routeCompile');
  });
});
