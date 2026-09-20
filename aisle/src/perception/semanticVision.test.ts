import type { AppEvent, Detection, SpeechRequest, VisionRequest, VisionResponse } from '../core/contracts';
import { createAppStore } from '../core/store';
import { createEventBus } from '../core/bus';
import { fakeClock } from '../indoor/testing';
import {
  DEAD_LINE, DEAD_REPEAT_MS, DEAD_STREAK,
  FRESHNESS_CROSSING_MS,
  MAX_IN_FLIGHT,
  cameraPrompt,
  coerceVisionResponse,
  createHttpVisionTransport,
  createSemanticVision,
  createWsVisionTransport,
  decodeAudioFrame,
  emptyVisionResponse,
  gateVerdict,
  sanitizeSpeech,
  sceneKey,
  type FetchLike,
  type VisionTransport,
  type WsLike,
} from './semanticVision';

type Listener<T> = (v: T) => void;

/** A perception stub whose streams tests can drive by hand. */
function fakePerception() {
  const dets = new Set<Listener<Detection[]>>();
  const ocr = new Set<Listener<Array<{ text: string; box: [number, number, number, number]; confidence: number; timestamp: number }>>>();
  let snapshots = 0;
  const widths: number[] = [];
  return {
    snapshotsTaken: () => snapshots,
    widths,
    emitDetections: (d: Detection[]) => dets.forEach((cb) => cb(d)),
    emitOcr: (texts: string[]) => ocr.forEach((cb) => cb(texts.map((t) => ({ text: t, box: [0.4, 0.1, 0.2, 0.05] as [number, number, number, number], confidence: 0.9, timestamp: 0 })))),
    async snapshotJPEG(w: 512 | 640 | 768 | 1024 | 1280) {
      snapshots += 1;
      widths.push(w);
      return { base64: 'AAAA', width: w, height: Math.round((w * 3) / 4), seq: snapshots, timestamp: 0 };
    },
    onDetections: (cb: Listener<Detection[]>) => { dets.add(cb); return () => { dets.delete(cb); }; },
    onOcrText: (cb: Listener<Array<{ text: string; box: [number, number, number, number]; confidence: number; timestamp: number }>>) => { ocr.add(cb); return () => { ocr.delete(cb); }; },
    onDepth: () => () => {},
    onSignalState: () => () => {},
  };
}

function fakeSpeech() {
  const said: SpeechRequest[] = [];
  const streams: Array<{ streamId: string; priority: string }> = [];
  return {
    said,
    streams,
    say: (r: SpeechRequest) => { said.push(r); },
    playStream: (streamId: string, priority: string) => { streams.push({ streamId, priority }); },
  };
}

function okResponse(seq: number, partial: Partial<VisionResponse> = {}): VisionResponse {
  return { ...emptyVisionResponse(seq), confidence: 0.9, ...partial, seq: partial.seq ?? seq };
}

function scripted(handler: (req: VisionRequest) => Promise<VisionResponse> | VisionResponse): VisionTransport & { requests: VisionRequest[] } {
  const requests: VisionRequest[] = [];
  return {
    requests,
    async ask(req) {
      requests.push(req);
      return handler(req);
    },
  };
}

function harness(transport: VisionTransport, clock = fakeClock(), extra: { buzzing?: () => boolean } = {}) {
  const bus = createEventBus();
  const events: AppEvent[] = [];
  bus.onAny((r) => events.push(r.event));
  const store = createAppStore({ warn: () => {} });
  const perception = fakePerception();
  const speech = fakeSpeech();
  const sv = createSemanticVision({
    transport,
    perception,
    speech,
    bus,
    store,
    now: clock.now,
    getHeadingDeg: () => 91,
    isCourseBuzzing: extra.buzzing,
  });
  return { sv, bus, events, store, perception, speech, clock };
}

describe('pure pieces', () => {
  it('sceneKey changes with detections or OCR tokens and ignores order', () => {
    const d1: Detection = { cls: 'person', box: [0.1, 0.2, 0.3, 0.4], score: 0.9, trackId: 1 };
    const d2: Detection = { cls: 'cart', box: [0.5, 0.5, 0.2, 0.2], score: 0.8, trackId: 2 };
    expect(sceneKey([d1, d2], ['3', 'DAIRY'])).toBe(sceneKey([d2, d1], ['DAIRY', '3']));
    expect(sceneKey([d1], ['3'])).not.toBe(sceneKey([d1], ['4']));
    expect(sceneKey([d1], [])).not.toBe(sceneKey([], []));
  });
  it('gateVerdict: in-flight cap, per-question interval, scene-unchanged inside freshness', () => {
    const base = { question: 'aisle_disambiguate' as const, now: 10_000, inFlight: 0, lastCallAt: null, lastResult: null, currentSceneKey: 'k' };
    expect(gateVerdict(base)).toBe('ok');
    expect(gateVerdict({ ...base, inFlight: MAX_IN_FLIGHT })).toBe('in_flight');
    expect(gateVerdict({ ...base, lastCallAt: 7000 })).toBe('interval');
    expect(gateVerdict({ ...base, lastCallAt: 5000, lastResult: { at: 6000, sceneKey: 'k' } })).toBe('scene_unchanged');
    expect(gateVerdict({ ...base, lastCallAt: 5000, lastResult: { at: 6000, sceneKey: 'other' } })).toBe('ok');
    expect(gateVerdict({ ...base, lastCallAt: 5000, lastResult: { at: 1000, sceneKey: 'k' } })).toBe('ok');
    // hand_guidance and free are loop / user driven: never scene-gated, force skips the interval.
    expect(gateVerdict({ ...base, question: 'hand_guidance', lastCallAt: 9000, lastResult: { at: 9500, sceneKey: 'k' }, force: true })).toBe('ok');
    expect(gateVerdict({ ...base, question: 'free', lastResult: { at: 9500, sceneKey: 'k' } })).toBe('ok');
  });
  it('sanitizeSpeech drops empties, forbidden words and > 12 words', () => {
    expect(sanitizeSpeech('  ')).toBeNull();
    expect(sanitizeSpeech('Aisle three, dairy.')).toBe('Aisle three, dairy.');
    expect(sanitizeSpeech('The road is clear now.')).toBeNull();     // lint-phrases: allow
    expect(sanitizeSpeech('It is safe to cross.')).toBeNull();        // lint-phrases: allow
    expect(sanitizeSpeech('one two three four five six seven eight nine ten eleven twelve thirteen')).toBeNull();
  });
  it('sanitizeSpeech blanks any digit so speech.say() never sees one', () => {
    expect(sanitizeSpeech('Aisle 3, dairy.')).toBeNull();
    expect(sanitizeSpeech('Milk is 2 shelves up.')).toBeNull();
    expect(sanitizeSpeech('Exit in 10 meters.')).toBeNull();
    expect(sanitizeSpeech('Aisle three, dairy.')).toBe('Aisle three, dairy.');
  });
  it('coerceVisionResponse tolerates garbage', () => {
    expect(coerceVisionResponse(null, 4).confidence).toBe(0);
    expect(coerceVisionResponse({ confidence: 'high' }, 4).confidence).toBe(0);
    const r = coerceVisionResponse({ speech: 'Aisle three.', confidence: 0.8, aisle: { matchedAisleId: 'a3', confidence: 0.8 } }, 4);
    expect(r.seq).toBe(4);
    expect(r.aisle).toEqual({ matchedAisleId: 'a3', matchedLandmarkId: null, confidence: 0.8 });
  });
  it('cameraPrompt maps to cached ≤ 6-word prompts', () => {
    expect(cameraPrompt('up')?.cacheKey).toBe('tilt_camera_up');
    expect(cameraPrompt('left')?.cacheKey).toBe('turn_left_a_little');
    expect(cameraPrompt('none')).toBeNull();
  });
});

describe('HTTP transport (mock fetch)', () => {
  it('uses a stable session header per runtime and a new one after restart', async () => {
    const clients: string[] = [];
    const fetchFn: FetchLike = async (_url, init) => {
      clients.push((init?.headers as Record<string, string>)['x-aisle-client']);
      return { ok: true, status: 200, json: async () => okResponse(1) };
    };
    const req: VisionRequest = { seq: 1, question: 'free', mode: 'IDLE', facts: { detections: [], ocr: [] } };
    const first = createHttpVisionTransport({ proxyUrl: 'http://proxy', fetchFn });
    await first.ask(req); await first.ask({ ...req, seq: 2 });
    await createHttpVisionTransport({ proxyUrl: 'http://proxy', fetchFn }).ask(req);
    expect(clients[0]).toBeTruthy();
    expect(clients[0]).toBe(clients[1]);
    expect(clients[2]).not.toBe(clients[0]);
  });
  it('POSTs the VisionRequest to /api/vision and returns the parsed body', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push({ url, body: init.body });
      return { ok: true, status: 200, json: async () => okResponse(1, { speech: 'Aisle three, dairy.' }) };
    };
    const t = createHttpVisionTransport({ proxyUrl: 'http://proxy:8787/', fetchFn });
    const res = await t.ask({ seq: 1, question: 'aisle_disambiguate', mode: 'INDOOR_NAV', facts: { detections: [], ocr: ['3'] } });
    expect(calls[0]!.url).toBe('http://proxy:8787/api/vision');
    expect(JSON.parse(calls[0]!.body).question).toBe('aisle_disambiguate');
    expect(res.speech).toBe('Aisle three, dairy.');
  });
  it('non-2xx, throw and bad JSON collapse to confidence 0 with the request seq', async () => {
    const bad = createHttpVisionTransport({ proxyUrl: 'http://p', fetchFn: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
    expect((await bad.ask({ seq: 7, question: 'free', mode: 'IDLE', facts: { detections: [], ocr: [] } })).confidence).toBe(0);
    const boom = createHttpVisionTransport({ proxyUrl: 'http://p', fetchFn: async () => { throw new Error('offline'); } });
    expect((await boom.ask({ seq: 8, question: 'free', mode: 'IDLE', facts: { detections: [], ocr: [] } })).seq).toBe(8);
    const junk = createHttpVisionTransport({ proxyUrl: 'http://p', fetchFn: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('x'); } }) });
    expect((await junk.ask({ seq: 9, question: 'free', mode: 'IDLE', facts: { detections: [], ocr: [] } })).confidence).toBe(0);
  });
});

describe('createSemanticVision policy', () => {
  it('builds the request with facts, the right thumbnail width, knownSigns, and applies speech', async () => {
    const transport = scripted((req) => okResponse(req.seq, { speech: 'Aisle three, dairy.', aisle: { matchedAisleId: 'a3', matchedLandmarkId: null, confidence: 0.84 } }));
    const h = harness(transport);
    h.store.setState({ mode: 'INDOOR_NAV' });
    h.perception.emitDetections([{ cls: 'person', box: [0.1, 0.1, 0.2, 0.5], score: 0.9, trackId: 3 }]);
    h.perception.emitOcr(['3 da1ry', '$4.99']);
    const out = await h.sv.ask('aisle_disambiguate', { knownSigns: ['3', 'DAIRY'] });
    expect(out.status).toBe('applied');
    expect(out.capturedAt).toBe(0); // snapshot time, independent of request/response time
    const req = transport.requests[0]!;
    expect(req.seq).toBe(1);
    expect(req.mode).toBe('INDOOR_NAV');
    expect(req.image?.width).toBe(640);
    expect(req.facts.ocr).toEqual(['3', 'DA1RY']);
    expect(req.facts.detections[0]?.cls).toBe('person');
    expect(req.facts.knownSigns).toEqual(['3', 'DAIRY']);
    expect(req.facts.headingDeg).toBe(91);
    expect(h.speech.said.map((s) => s.text)).toEqual(['Aisle three, dairy.']);
    expect(h.speech.said[0]!.priority).toBe('NAV');
  });
  it('scene-change gate: an unchanged scene inside the freshness window is not re-asked; a change is', async () => {
    const transport = scripted((req) => okResponse(req.seq));
    const h = harness(transport);
    expect((await h.sv.ask('aisle_disambiguate')).status).toBe('applied');
    h.clock.advance(4500);
    const again = await h.sv.ask('aisle_disambiguate');
    expect(again.status).toBe('skipped');
    expect(again.gate).toBe('scene_unchanged');
    h.perception.emitOcr(['BEVERAGES']);
    expect((await h.sv.ask('aisle_disambiguate')).status).toBe('applied');
    expect(transport.requests).toHaveLength(2);
  });
  it('per-question interval: aisle_disambiguate ≤ 1 per 4 s, storefront ≤ 1 per 5 s', async () => {
    const transport = scripted((req) => okResponse(req.seq));
    const h = harness(transport);
    await h.sv.ask('aisle_disambiguate');
    h.perception.emitOcr(['DAIRY']);
    h.clock.advance(3000);
    expect((await h.sv.ask('aisle_disambiguate')).gate).toBe('interval');
    h.clock.advance(1000);
    h.perception.emitOcr(['DAIRY']); // A live OCR stream refreshes the sign after its TTL.
    expect((await h.sv.ask('aisle_disambiguate')).status).toBe('applied');
    await h.sv.ask('storefront');
    h.clock.advance(4900);
    expect((await h.sv.ask('storefront')).gate).toBe('interval');
  });
  it('confidence < 0.5 is ignored and silent', async () => {
    const transport = scripted((req) => okResponse(req.seq, { speech: 'Tilt the camera up.', cameraRequest: 'up', confidence: 0.3 }));
    const h = harness(transport);
    const out = await h.sv.ask('storefront');
    expect(out.status).toBe('low_confidence');
    expect(h.speech.said).toEqual([]);
    expect(h.events).toEqual([]);
  });
  it('four dead answers in a row ({ confidence: 0 }, the proxy collapse) → one ERROR and one line, then quiet for a minute', async () => {
    const transport = scripted((req) => emptyVisionResponse(req.seq));
    const h = harness(transport);
    for (let i = 0; i < DEAD_STREAK - 1; i += 1) {
      expect((await h.sv.ask('storefront', { force: true })).status).toBe('low_confidence');
    }
    expect(h.events).toEqual([]);
    await h.sv.ask('storefront', { force: true });
    expect(h.events).toEqual([{ type: 'ERROR', scope: 'vision', message: `${DEAD_STREAK} dead answers in a row (last: storefront)` }]);
    expect(h.speech.said.map((s) => s.text)).toEqual([DEAD_LINE]);
    await h.sv.ask('storefront', { force: true });
    await h.sv.ask('storefront', { force: true });
    expect(h.events).toHaveLength(1);
    h.clock.advance(DEAD_REPEAT_MS + 1);
    await h.sv.ask('storefront', { force: true });
    expect(h.events).toHaveLength(2);
  });
  it('a response with a lower seq than requested is stale and never spoken', async () => {
    const transport = scripted((req) => okResponse(req.seq, { speech: 'Old answer.', seq: req.seq - 1 }));
    const h = harness(transport);
    const out = await h.sv.ask('storefront', { force: true });
    expect(out.status).toBe('stale');
    expect(h.speech.said).toEqual([]);
  });
  it('a result older than its freshness window is dropped (3 s at crossings)', async () => {
    const clock = fakeClock();
    const transport = scripted((req) => {
      clock.advance(FRESHNESS_CROSSING_MS + 100);
      return okResponse(req.seq, { speech: 'No vehicles seen to the left.', scan: { vehiclesSeen: 'none', confidence: 0.9 } });
    });
    const h = harness(transport, clock);
    const out = await h.sv.ask('scan_left');
    expect(out.status).toBe('stale');
    expect(h.speech.said).toEqual([]);
  });
  it('forbidden words in speech are filtered; the rest of the response still applies', async () => {
    const transport = scripted((req) => okResponse(req.seq, { speech: 'It is safe to cross now.', scan: { vehiclesSeen: 'none', confidence: 0.9 } })); // lint-phrases: allow
    const h = harness(transport);
    const out = await h.sv.ask('scan_right');
    expect(out.status).toBe('applied');
    expect(out.response?.scan.vehiclesSeen).toBe('none');
    expect(h.speech.said).toEqual([]);
  });
  it('≤ 3 in flight; the fourth is skipped', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const transport = scripted(async (req) => { await gate; return okResponse(req.seq); });
    const h = harness(transport);
    const p1 = h.sv.ask('scan_left');
    const p2 = h.sv.ask('scan_right');
    const p3 = h.sv.ask('storefront');
    const p4 = await h.sv.ask('curb_crop');
    expect(p4.status).toBe('skipped');
    expect(p4.gate).toBe('in_flight');
    release!();
    const done = await Promise.all([p1, p2, p3]);
    expect(done.map((d) => d.status)).toEqual(['applied', 'applied', 'applied']);
    expect(h.sv.getStats().inFlight).toBe(0);
  });
  it('cameraRequest / userAction become bus events and ≤ 6-word prompts, ≤ 1 per 3 s, never while COURSE buzzes', async () => {
    let buzzing = false;
    const transport = scripted((req) => okResponse(req.seq, { cameraRequest: 'up', userAction: 'turn_left' }));
    const h = harness(transport, fakeClock(), { buzzing: () => buzzing });
    await h.sv.ask('free', { userText: 'where is the sign', force: true });
    expect(h.events.map((e) => e.type)).toEqual(['CAMERA_REQUEST', 'USER_ACTION']);
    // Two prompts were eligible; only one may be said inside 3 s.
    expect(h.speech.said.map((s) => s.cacheKey)).toEqual(['tilt_camera_up']);
    h.clock.advance(3000);
    buzzing = true;
    await h.sv.ask('free', { userText: 'again', force: true });
    expect(h.speech.said).toHaveLength(1); // buzzing: event yes, prompt no
    expect(h.events.filter((e) => e.type === 'CAMERA_REQUEST')).toHaveLength(2);
  });

  it('silent task evidence cannot inject competing speech or movement prompts', async () => {
    const h = harness(scripted((req) => okResponse(req.seq, { speech: 'Bear left.', cameraRequest: 'up', userAction: 'turn_left' })));
    h.store.setState({ mode: 'GUIDED_TASK' });
    const out = await h.sv.ask('task_step', { userText: 'Goal: eggs in my fridge. Stage: approach.', silent: true, force: true });
    expect(out.status).toBe('applied');
    expect(h.speech.said).toEqual([]);
    expect(h.events).toEqual([]);
    h.sv.dispose();
  });
  it('free with no userText image omits the thumbnail; hand_guidance asks for 640', async () => {
    const transport = scripted((req) => okResponse(req.seq));
    const h = harness(transport);
    await h.sv.ask('free', { userText: 'how far' });
    expect(transport.requests[0]!.image).toBeUndefined();
    await h.sv.ask('hand_guidance', { targetItem: 'eggs (yellow carton)', force: true });
    expect(transport.requests[1]!.image?.width).toBe(640);
    expect(transport.requests[1]!.facts.targetItem).toBe('eggs (yellow carton)');
  });
  it('transport rejection is an error outcome, silent, and frees the in-flight slot', async () => {
    const transport = scripted(() => { throw new Error('socket closed'); });
    const h = harness(transport);
    const out = await h.sv.ask('storefront');
    expect(out.status).toBe('error');
    expect(h.sv.getStats().inFlight).toBe(0);
    expect(h.speech.said).toEqual([]);
  });
  it('warm over HTTP sends a free request with userText "warm" and no image; over a transport with warm() it uses that', async () => {
    const transport = scripted((req) => okResponse(req.seq));
    const h = harness(transport);
    await h.sv.warm('INDOOR_NAV');
    expect(transport.requests[0]).toMatchObject({ question: 'free', userText: 'warm', mode: 'INDOOR_NAV' });
    expect(transport.requests[0]!.image).toBeUndefined();

    const warmed: string[] = [];
    const withWarm: VisionTransport = { ask: transport.ask, warm: (m) => { warmed.push(m); } };
    const h2 = harness(withWarm);
    await h2.sv.warm('AT_CURB');
    expect(warmed).toEqual(['AT_CURB']);
    expect(transport.requests).toHaveLength(1);   // no model call spent on the warm-up
  });

  it('asVisionAsk shares the seq counter, transport and in-flight cap with ask(), and never speaks', async () => {
    const transport = scripted((req) => okResponse(req.seq, { speech: 'Doors ahead.', storefront: { visible: true, confidence: 0.9 } }));
    const h = harness(transport);
    await h.sv.ask('aisle_disambiguate');                         // seq 1
    const raw = h.sv.asVisionAsk();
    const mine = h.sv.nextSeq();                                  // seq 2
    const res = await raw.ask({ seq: mine, question: 'storefront', mode: 'OUTDOOR_NAV', facts: { detections: [], ocr: [] } });
    expect(res.seq).toBe(2);
    expect(res.storefront.visible).toBe(true);
    // a stale caller-chosen seq is re-stamped forward, never sent backwards
    const res2 = await raw.ask({ seq: 1, question: 'storefront', mode: 'OUTDOOR_NAV', facts: { detections: [], ocr: [] } });
    expect(res2.seq).toBe(3);
    expect(transport.requests.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(h.sv.nextSeq()).toBe(4);
    expect(h.speech.said.map((r) => r.text)).toEqual(['Doors ahead.']);   // only ask() speaks; the raw path is silent
    expect(h.sv.getStats().calls).toBe(3);
  });

  it('passes the speech priority to the transport (NAV by default, INFO for free)', async () => {
    const priorities: Array<string | undefined> = [];
    const transport: VisionTransport = { ask: async (req, o) => { priorities.push(o?.priority); return okResponse(req.seq); } };
    const h = harness(transport);
    await h.sv.ask('aisle_disambiguate');
    await h.sv.ask('free', { userText: 'what is ahead' });
    expect(priorities).toEqual(['NAV', 'INFO']);
  });
});

describe('streaming over the WebSocket transport (D\'s frames protocol)', () => {
  function fakeSocket() {
    const sent: string[] = [];
    const ws: WsLike & { sent: string[]; open(): void; receive(msg: unknown): void; receiveBinary(buf: ArrayBuffer): void } = {
      readyState: 0,
      sent,
      send: (d) => { sent.push(d); },
      close: () => { ws.readyState = 3; ws.onclose?.({}); },
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      open() { ws.readyState = 1; ws.onopen?.({}); ws.onmessage?.({ data: JSON.stringify({ type: 'hello', maxInFlight: 3, audio: true }) }); },
      receive(msg) { ws.onmessage?.({ data: JSON.stringify(msg) }); },
      receiveBinary(buf) { ws.onmessage?.({ data: buf }); },
    };
    return ws;
  }

  function audioFrame(streamId: number, bytes: number[]): ArrayBuffer {
    const buf = new ArrayBuffer(4 + bytes.length);
    new DataView(buf).setUint32(0, streamId, false);
    new Uint8Array(buf, 4).set(bytes);
    return buf;
  }

  it('decodeAudioFrame reads the uint32 big-endian streamId prefix', () => {
    const f = decodeAudioFrame(audioFrame(4242, [1, 2, 3]))!;
    expect(f.streamId).toBe(4242);
    expect(Array.from(f.audio)).toEqual([1, 2, 3]);
    expect(decodeAudioFrame(new Uint8Array(2))).toBeNull();
  });

  it('sends {type: vision, req, priority}; plays the stream on speech_start, routes audio frames, then applies the JSON without speaking twice', async () => {
    const sock = fakeSocket();
    let sv: ReturnType<typeof createSemanticVision> | null = null;
    const chunks: Array<{ streamId: string; n: number }> = [];
    const ends: Array<{ streamId: string; firstAudioMs: number | null }> = [];
    const transport = createWsVisionTransport({
      proxyWs: 'ws://p/ws',
      WebSocketCtor: function Ctor() { return sock; } as unknown as new (url: string) => WsLike,
      onSpeechStream: (seq, id) => sv?.noteStream(seq, id),
      onAudioChunk: (streamId, audio) => chunks.push({ streamId, n: audio.byteLength }),
      onSpeechEnd: (streamId, firstAudioMs) => ends.push({ streamId, firstAudioMs }),
    });
    transport.open();
    sock.open();
    expect(sock.binaryType).toBe('arraybuffer');
    expect(transport.serverInfo()).toEqual({ maxInFlight: 3, audio: true });
    const h = harness(transport);
    sv = h.sv;
    const p = h.sv.ask('aisle_disambiguate');
    await Promise.resolve();
    await Promise.resolve();
    expect(sock.sent).toHaveLength(1);
    const env = JSON.parse(sock.sent[0]!) as { type: string; req: VisionRequest; priority: string };
    expect(env.type).toBe('vision');
    expect(env.priority).toBe('NAV');
    const req = env.req;
    expect(req.question).toBe('aisle_disambiguate');
    sock.receive({ type: 'speech_start', streamId: req.seq });
    expect(h.speech.streams).toEqual([{ streamId: '1', priority: 'NAV' }]);
    sock.receiveBinary(audioFrame(req.seq, [9, 9]));
    sock.receiveBinary(audioFrame(req.seq, [9]));
    sock.receive({ type: 'speech_end', streamId: req.seq, firstAudioMs: 410 });
    expect(chunks).toEqual([{ streamId: '1', n: 2 }, { streamId: '1', n: 1 }]);
    expect(ends).toEqual([{ streamId: '1', firstAudioMs: 410 }]);
    sock.receive({ type: 'result', res: okResponse(req.seq, { speech: 'Aisle three, dairy.', aisle: { matchedAisleId: 'a3', matchedLandmarkId: null, confidence: 0.9 } }) });
    const out = await p;
    expect(out.status).toBe('applied');
    expect(out.streamed).toBe(true);
    expect(h.speech.said).toEqual([]); // already heard via the stream
    expect(out.response?.aisle.matchedAisleId).toBe('a3');
  });

  it('warm sends {type: warm, mode} and ping sends {type: ping}; both are no-ops while closed', () => {
    const sock = fakeSocket();
    const transport = createWsVisionTransport({ proxyWs: 'ws://p/ws', WebSocketCtor: function Ctor() { return sock; } as unknown as new (url: string) => WsLike });
    transport.warm('INDOOR_NAV');
    expect(sock.sent).toEqual([]);
    transport.open();
    sock.open();
    transport.warm('INDOOR_NAV');
    transport.ping();
    expect(sock.sent.map((m) => JSON.parse(m) as unknown)).toEqual([{ type: 'warm', mode: 'INDOOR_NAV' }, { type: 'ping' }]);
    sock.receive({ type: 'pong' });   // ignored
  });

  it('an error frame, a {confidence: 0} result or a closed socket resolves to confidence 0; unknown seqs are ignored', async () => {
    const sock = fakeSocket();
    const transport = createWsVisionTransport({ proxyWs: 'ws://p/ws', WebSocketCtor: function Ctor() { return sock; } as unknown as new (url: string) => WsLike });
    transport.open();
    sock.open();
    const p = transport.ask({ seq: 5, question: 'free', mode: 'IDLE', facts: { detections: [], ocr: [] } });
    sock.receive({ type: 'result', res: okResponse(99) });
    sock.receive({ type: 'error', seq: 5, code: 'upstream' });
    expect((await p).confidence).toBe(0);
    const p1 = transport.ask({ seq: 4, question: 'free', mode: 'IDLE', facts: { detections: [], ocr: [] } });
    sock.receive({ type: 'error', seq: 4, code: 'stale_seq' });
    sock.receive({ type: 'result', res: { confidence: 0, seq: 4 } });   // the follow-up result is idempotent
    expect(await p1).toMatchObject({ confidence: 0, seq: 4 });
    const p2 = transport.ask({ seq: 6, question: 'free', mode: 'IDLE', facts: { detections: [], ocr: [] } });
    sock.receive({ type: 'error', seq: null, code: 'bad_json' });   // socket-level: settles nothing
    sock.close();
    expect((await p2).seq).toBe(6);
    expect(transport.isOpen()).toBe(false);
    expect(transport.serverInfo()).toBeNull();
  });

  it('falls back to the HTTP transport while the socket is not open', async () => {
    const fallback = scripted((req) => okResponse(req.seq, { speech: 'Fallback.' }));
    const transport = createWsVisionTransport({ proxyWs: 'ws://p/ws', WebSocketCtor: undefined, fallback });
    const res = await transport.ask({ seq: 1, question: 'free', mode: 'IDLE', facts: { detections: [], ocr: [] } });
    expect(res.speech).toBe('Fallback.');
    expect(fallback.requests).toHaveLength(1);
  });

  it('noteStream ignores seqs that are unknown, stale, or silent', () => {
    const transport = scripted((req) => okResponse(req.seq));
    const h = harness(transport);
    h.sv.noteStream(42, '42');
    expect(h.speech.streams).toEqual([]);
  });
});

it('expires detector evidence before sending another frame to classification', async () => {
  const transport = scripted(req => okResponse(req.seq));
  const h = harness(transport);
  h.perception.emitDetections([{ cls: 'orange', box: [0.2, 0.2, 0.2, 0.2], score: 0.9, trackId: 1 }]);
  await h.sv.ask('task_step', { force: true });
  expect(transport.requests[0].facts.detections).toHaveLength(1);
  h.clock.advance(1501);
  expect(h.sv.getFacts().detections).toEqual([]);
  await h.sv.ask('task_step', { force: true });
  expect(transport.requests[1].facts.detections).toEqual([]);
  h.sv.dispose();
});

it.each([[0.2, 0.2, 0, 0.3], [0.9, 0.2, 0.4, 0.3], [0.2, 0.9, 0.3, 0.4]])('rejects unusable target geometry %j', (...box) => {
  expect(coerceVisionResponse({ target: { box, confidence: 0.9 } }, 1).target).toEqual({ box: null, confidence: 0 });
});
