import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { fakeClaude, fakeDeps, fakeTts, sampleRequest, startTestServer, type TestServer } from '../test/fakes';
import { decodeAudioFrame, encodeAudioFrame, parseClientMessage } from './frames';
import { attachVisionSocket } from './visionSocket';

let srv: TestServer | null = null;
afterEach(async () => {
  await srv?.close();
  srv = null;
});

interface Frame { kind: 'json'; msg: Record<string, unknown> }
interface Bin { kind: 'bin'; streamId: number; audio: string }

async function connect(url: string): Promise<{ ws: WebSocket; frames: Array<Frame | Bin>; waitFor(pred: (f: Frame | Bin) => boolean, ms?: number): Promise<void> }> {
  const ws = new WebSocket(url);
  const frames: Array<Frame | Bin> = [];
  const waiters: Array<{ pred: (f: Frame | Bin) => boolean; resolve: () => void }> = [];
  ws.on('message', (data, isBinary) => {
    let f: Frame | Bin;
    if (isBinary) {
      const d = decodeAudioFrame(data as Buffer)!;
      f = { kind: 'bin', streamId: d.streamId, audio: Buffer.from(d.audio).toString() };
    } else {
      f = { kind: 'json', msg: JSON.parse(data.toString()) as Record<string, unknown> };
    }
    frames.push(f);
    for (const w of waiters.splice(0)) {
      if (frames.some(w.pred)) w.resolve();
      else waiters.push(w);
    }
  });
  await new Promise<void>((r) => ws.on('open', () => r()));
  return {
    ws,
    frames,
    waitFor(pred, ms = 2000) {
      if (frames.some(pred)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout waiting for frame')), ms);
        waiters.push({ pred, resolve: () => { clearTimeout(t); resolve(); } });
      });
    },
  };
}

const isResult = (seq: number) => (f: Frame | Bin) => f.kind === 'json' && f.msg.type === 'result' && (f.msg.res as { seq: number }).seq === seq;
const types = (frames: Array<Frame | Bin>) => frames.map((f) => (f.kind === 'json' ? String(f.msg.type) : `bin:${f.streamId}`));

describe('frames', () => {
  it('round-trips the uint32 streamId prefix', () => {
    const enc = encodeAudioFrame(4242, Buffer.from('abc'));
    const dec = decodeAudioFrame(enc)!;
    expect(dec.streamId).toBe(4242);
    expect(Buffer.from(dec.audio).toString()).toBe('abc');
    expect(decodeAudioFrame(Buffer.alloc(2))).toBeNull();
  });
  it('parses client messages and rejects garbage', () => {
    expect(parseClientMessage('nope')).toEqual({ ok: false, code: 'bad_json', seq: null });
    expect(parseClientMessage('{"type":"dance"}')).toEqual({ ok: false, code: 'unknown_type', seq: null });
    expect(parseClientMessage('{"type":"warm","mode":"AT_CURB"}')).toEqual({ ok: true, msg: { type: 'warm', mode: 'AT_CURB' } });
    const v = parseClientMessage(JSON.stringify({ type: 'vision', req: { seq: 3 }, priority: 'INFO' }));
    expect(v.ok && v.msg.type === 'vision' && v.msg.priority).toBe('INFO');
  });
});

describe('/ws vision → speech relay', () => {
  it('sends speech_start, audio frames tagged with seq, speech_end, then the result', async () => {
    const tts = fakeTts({ chunks: [Buffer.from('A'), Buffer.from('B')] });
    const deps = fakeDeps({ claude: fakeClaude({ speech: 'Aisle three. Eggs on your right.' }), ttsFactory: () => tts });
    srv = await startTestServer(deps, {}, (s) => attachVisionSocket(s, deps));
    const c = await connect(srv.wsUrl);
    c.ws.send(JSON.stringify({ type: 'vision', req: sampleRequest({ seq: 11 }), priority: 'NAV' }));
    await c.waitFor(isResult(11));
    expect(types(c.frames)).toEqual(['hello', 'speech_start', 'bin:11', 'bin:11', 'speech_end', 'result']);
    const bins = c.frames.filter((f): f is Bin => f.kind === 'bin');
    expect(bins.map((b) => b.audio)).toEqual(['A', 'B']);
    // flush:true on the complete utterance, then EOS
    expect(tts.sent).toEqual([{ text: 'Aisle three. Eggs on your right.', flush: true }]);
    expect(tts.ended).toBe(true);
    const result = c.frames.find(isResult(11)) as Frame;
    expect((result.msg.res as { speech: string }).speech).toBe('Aisle three. Eggs on your right.');
    c.ws.close();
  });

  it('empty speech: closes ElevenLabs without flushing, no speech_start, result still arrives', async () => {
    const tts = fakeTts();
    const deps = fakeDeps({ claude: fakeClaude({ speech: '' }), ttsFactory: () => tts });
    srv = await startTestServer(deps, {}, (s) => attachVisionSocket(s, deps));
    const c = await connect(srv.wsUrl);
    c.ws.send(JSON.stringify({ type: 'vision', req: sampleRequest({ seq: 1 }) }));
    await c.waitFor(isResult(1));
    expect(types(c.frames)).toEqual(['hello', 'result']);
    expect(tts.closed).toBe(true);
    expect(tts.sent).toEqual([]);
    c.ws.close();
  });

  it('blanked speech (forbidden word) is never spoken, and the JSON carries speech ""', async () => {
    const tts = fakeTts();
    const deps = fakeDeps({ claude: fakeClaude({ speech: 'You can cross now.' }), ttsFactory: () => tts });
    srv = await startTestServer(deps, {}, (s) => attachVisionSocket(s, deps));
    const c = await connect(srv.wsUrl);
    c.ws.send(JSON.stringify({ type: 'vision', req: sampleRequest({ seq: 2 }) }));
    await c.waitFor(isResult(2));
    expect(types(c.frames)).toEqual(['hello', 'result']);
    expect(tts.sent).toEqual([]);
    const res = (c.frames.find(isResult(2)) as Frame).msg.res as { speech: string; confidence: number };
    expect(res.speech).toBe('');
    expect(res.confidence).toBe(0.9);
    expect(deps.log.recent({ route: 'vision' })[0]?.verdict).toBe('blanked');
    c.ws.close();
  });

  it('a stale seq gets error + { confidence: 0 } and is never spoken', async () => {
    const deps = fakeDeps({ claude: fakeClaude({ speech: 'Doors ahead.' }) });
    srv = await startTestServer(deps, {}, (s) => attachVisionSocket(s, deps));
    const c = await connect(srv.wsUrl);
    c.ws.send(JSON.stringify({ type: 'vision', req: sampleRequest({ seq: 5 }) }));
    await c.waitFor(isResult(5));
    const opened = deps.ttsOpened.length;
    c.ws.send(JSON.stringify({ type: 'vision', req: sampleRequest({ seq: 4 }) }));
    await c.waitFor(isResult(4));
    const tail = types(c.frames).slice(-2);
    expect(tail).toEqual(['error', 'result']);
    expect((c.frames.find(isResult(4)) as Frame).msg.res).toEqual({ confidence: 0, seq: 4 });
    expect(deps.ttsOpened.length).toBe(opened); // no ElevenLabs socket for a stale request
    c.ws.close();
  });

  it('a fourth in-flight request is answered { confidence: 0 } immediately', async () => {
    const deps = fakeDeps({ claude: fakeClaude({ speech: 'Hi.', deltas: 4, delayMs: 40 }) });
    srv = await startTestServer(deps, {}, (s) => attachVisionSocket(s, deps));
    const c = await connect(srv.wsUrl);
    for (const seq of [1, 2, 3, 4]) c.ws.send(JSON.stringify({ type: 'vision', req: sampleRequest({ seq }) }));
    await c.waitFor(isResult(4), 200);
    expect((c.frames.find(isResult(4)) as Frame).msg.res).toEqual({ confidence: 0, seq: 4 });
    await c.waitFor(isResult(3));
    c.ws.close();
  });

  it('a stuck TTS socket never withholds the JSON past the grace period', async () => {
    const tts = fakeTts({ auto: false }); // never emits audio or end
    const deps = fakeDeps({ claude: fakeClaude({ speech: 'Doors ahead.' }), ttsFactory: () => tts });
    srv = await startTestServer(deps, {}, (s) => attachVisionSocket(s, deps, { speechEndGraceMs: 60 }));
    const c = await connect(srv.wsUrl);
    c.ws.send(JSON.stringify({ type: 'vision', req: sampleRequest({ seq: 1 }) }));
    await c.waitFor(isResult(1), 1000);
    expect(types(c.frames)).toEqual(['hello', 'speech_start', 'speech_end', 'result']);
    expect(tts.closed).toBe(true);
    c.ws.close();
  });

  it('a Claude timeout yields { confidence: 0 } and closes the TTS socket', async () => {
    const tts = fakeTts();
    const deps = fakeDeps({ vision: async (_req, hooks) => { hooks.onSpeechReady?.('', 'pass'); return { response: null, usage: null, speech: '', verdict: 'pass', model: 'm', stopReason: null, firstTokenMs: null, speechClosedMs: null, totalMs: 4000, error: 'timeout' }; }, ttsFactory: () => tts });
    srv = await startTestServer(deps, {}, (s) => attachVisionSocket(s, deps));
    const c = await connect(srv.wsUrl);
    c.ws.send(JSON.stringify({ type: 'vision', req: sampleRequest({ seq: 1 }) }));
    await c.waitFor(isResult(1));
    expect((c.frames.find(isResult(1)) as Frame).msg.res).toEqual({ confidence: 0, seq: 1 });
    expect(tts.closed).toBe(true);
    c.ws.close();
  });

  it('works with no ElevenLabs configured: JSON only', async () => {
    const deps = fakeDeps({ claude: fakeClaude({ speech: 'Doors ahead.' }), ttsFactory: () => null });
    srv = await startTestServer(deps, {}, (s) => attachVisionSocket(s, deps));
    const c = await connect(srv.wsUrl);
    c.ws.send(JSON.stringify({ type: 'vision', req: sampleRequest({ seq: 1 }) }));
    await c.waitFor(isResult(1));
    expect(types(c.frames)).toEqual(['hello', 'result']);
    c.ws.close();
  });

  it('warm messages re-fire the pairs for that mode; bad JSON and bad requests get error frames', async () => {
    const deps = fakeDeps();
    srv = await startTestServer(deps, {}, (s) => attachVisionSocket(s, deps));
    const c = await connect(srv.wsUrl);
    c.ws.send(JSON.stringify({ type: 'warm', mode: 'AT_CURB' }));
    c.ws.send('{not json');
    c.ws.send(JSON.stringify({ type: 'vision', req: { seq: 1, question: 'nope', mode: 'IDLE', facts: {} } }));
    c.ws.send(JSON.stringify({ type: 'ping' }));
    await c.waitFor((f) => f.kind === 'json' && f.msg.type === 'pong');
    const errors = c.frames.filter((f): f is Frame => f.kind === 'json' && f.msg.type === 'error').map((f) => f.msg.code);
    expect(errors).toEqual(['bad_json', 'bad_request']);
    await new Promise((r) => setTimeout(r, 10));
    expect(deps.warmCalls.sort()).toEqual(['haiku:vision', 'sonnet:vision']);
    c.ws.close();
  });
});
