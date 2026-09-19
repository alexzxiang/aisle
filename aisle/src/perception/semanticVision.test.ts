import type { AppEvent, Detection, SpeechRequest, VisionRequest, VisionResponse } from '../core/contracts';
import { createAppStore } from '../core/store';
import { createEventBus } from '../core/bus';
import { fakeClock } from '../indoor/testing';
import {
  FRESHNESS_CROSSING_MS,
  MAX_IN_FLIGHT,
  cameraPrompt,
  coerceVisionResponse,
  createHttpVisionTransport,
  createSemanticVision,
  createWsVisionTransport,
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
    async snapshotJPEG(w: 512 | 640 | 1024) {
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
    const req = transport.requests[0]!;
    expect(req.seq).toBe(1);
    expect(req.mode).toBe('INDOOR_NAV');
    expect(req.image?.width).toBe(640);
    expect(req.facts.ocr).toEqual(['3', 'DA1RY', '4', '99']);
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
    h.perception.emitOcr(['X1']);
    h.clock.advance(3000);
    expect((await h.sv.ask('aisle_disambiguate')).gate).toBe('interval');
    h.clock.advance(1000);
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
  it('warm sends a free request with userText "warm" and no image', async () => {
    const transport = scripted((req) => okResponse(req.seq));
    const h = harness(transport);
    await h.sv.warm('INDOOR_NAV');
    expect(transport.requests[0]).toMatchObject({ question: 'free', userText: 'warm', mode: 'INDOOR_NAV' });
    expect(transport.requests[0]!.image).toBeUndefined();
  });
});

describe('streaming over the WebSocket transport', () => {
  function fakeSocket() {
    const sent: string[] = [];
    const ws: WsLike & { sent: string[]; open(): void; receive(msg: unknown): void } = {
      readyState: 0,
      sent,
      send: (d) => { sent.push(d); },
      close: () => { ws.readyState = 3; ws.onclose?.({}); },
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      open() { ws.readyState = 1; ws.onopen?.({}); },
      receive(msg) { ws.onmessage?.({ data: JSON.stringify(msg) }); },
    };
    return ws;
  }

  it('plays the stream as soon as speech closes, then applies the JSON without speaking twice', async () => {
    const sock = fakeSocket();
    let sv: ReturnType<typeof createSemanticVision> | null = null;
    const transport = createWsVisionTransport({
      proxyWs: 'ws://p/ws',
      WebSocketCtor: function Ctor() { return sock; } as unknown as new (url: string) => WsLike,
      onSpeechStream: (seq, id) => sv?.noteStream(seq, id),
    });
    transport.open();
    sock.open();
    const h = harness(transport);
    sv = h.sv;
    const p = h.sv.ask('aisle_disambiguate');
    await Promise.resolve();
    await Promise.resolve();
    expect(sock.sent).toHaveLength(1);
    const req = JSON.parse(sock.sent[0]!) as VisionRequest;
    sock.receive({ type: 'speech', seq: req.seq, streamId: String(req.seq) });
    expect(h.speech.streams).toEqual([{ streamId: '1', priority: 'NAV' }]);
    sock.receive({ type: 'result', seq: req.seq, response: okResponse(req.seq, { speech: 'Aisle three, dairy.', aisle: { matchedAisleId: 'a3', matchedLandmarkId: null, confidence: 0.9 } }) });
    const out = await p;
    expect(out.status).toBe('applied');
    expect(out.streamed).toBe(true);
    expect(h.speech.said).toEqual([]); // already heard via the stream
    expect(out.response?.aisle.matchedAisleId).toBe('a3');
  });
  it('an error frame or a closed socket resolves to confidence 0; unknown seqs are ignored', async () => {
    const sock = fakeSocket();
    const transport = createWsVisionTransport({ proxyWs: 'ws://p/ws', WebSocketCtor: function Ctor() { return sock; } as unknown as new (url: string) => WsLike });
    transport.open();
    sock.open();
    const p = transport.ask({ seq: 5, question: 'free', mode: 'IDLE', facts: { detections: [], ocr: [] } });
    sock.receive({ type: 'result', seq: 99, response: okResponse(99) });
    sock.receive({ type: 'error', seq: 5, message: 'upstream' });
    expect((await p).confidence).toBe(0);
    const p2 = transport.ask({ seq: 6, question: 'free', mode: 'IDLE', facts: { detections: [], ocr: [] } });
    sock.close();
    expect((await p2).seq).toBe(6);
    expect(transport.isOpen()).toBe(false);
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
