import type { ParseIntentOutput, SpeechRequest } from './contracts';
import { createEventBus, type AppEventBus } from './bus';
import { createAppStore, type AppStore } from './store';
import { PHRASES, checkPhrase } from './phrases';
import {
  FALLBACK_REPLY,
  MAX_KEYTERMS,
  bestTranscript,
  coerceParseIntentOutput,
  createVoiceInput,
  keytermsFrom,
  parseIntentFallback,
  sanitizeReply,
  type Recognizer,
  type RecognizerHandlers,
  type VoiceInput,
} from './voice';

const KNOWN = ['eggs', 'milk', 'bread', 'egg noodles', 'butter'];

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

describe('parseIntentFallback (templated fallback when Nemotron misses its deadline)', () => {
  it.each<[string, ParseIntentOutput['intent'], string | null]>([
    ['I need eggs', 'find_item', 'eggs'],
    ['um, I need some egg noodles please', 'find_item', 'egg noodles'],   // longest known match wins
    ['where is the milk', 'find_item', 'milk'],
    ['find butter', 'find_item', 'butter'],
    ['I need tofu', 'find_item', 'tofu'],                                  // free-form, filler stripped
    ['take me to the bread', 'find_item', 'bread'],
    ['repeat that', 'repeat', null],
    ['say that again', 'repeat', null],
    ['how far is it', 'how_far', null],
    ['where am I', 'where_am_i', null],
    ['stop', 'abort', null],
    ['never mind', 'abort', null],
    ['help', 'help', null],
    ['what can you do', 'help', null],
    ['', 'unknown', null],
    ['blorp fnarg', 'unknown', null],
  ])('%p → %s / %p', (transcript, intent, item) => {
    const r = parseIntentFallback(transcript, KNOWN);
    expect(r.intent).toBe(intent);
    expect(r.item).toBe(item);
    expect(checkPhrase(r.reply)).toEqual([]);         // every reply obeys the language rules
  });

  it('unknown replies with the canonical say_item_again phrase', () => {
    expect(parseIntentFallback('zzz', KNOWN).reply).toBe(PHRASES.say_item_again);
    expect(FALLBACK_REPLY).toBe(PHRASES.say_item_again);
  });

  it('does not treat a long free-form tail as an item', () => {
    expect(parseIntentFallback('I need something for a birthday party tomorrow night', KNOWN).intent).toBe('unknown');
  });
});

describe('bestTranscript / sanitizeReply / coerceParseIntentOutput / keytermsFrom', () => {
  it('bestTranscript takes the highest-confidence non-empty result', () => {
    expect(bestTranscript([{ transcript: '', confidence: 0.9 }, { transcript: 'eggs', confidence: 0.4 }, { transcript: 'legs', confidence: 0.6 }])).toBe('legs');
    expect(bestTranscript([])).toBe('');
  });

  it('sanitizeReply falls back on forbidden, long or digit-bearing replies', () => {
    expect(sanitizeReply('Eggs. Finding it.')).toBe('Eggs. Finding it.');
    expect(sanitizeReply('It is safe to cross')).toBe(FALLBACK_REPLY);
    expect(sanitizeReply('Aisle 3')).toBe(FALLBACK_REPLY);
    expect(sanitizeReply('one two three four five six seven eight nine ten eleven twelve thirteen')).toBe(FALLBACK_REPLY);
    expect(sanitizeReply(42)).toBe(FALLBACK_REPLY);
    expect(sanitizeReply('  ', 'x')).toBe('x');
  });

  it('coerceParseIntentOutput repairs a malformed planner payload', () => {
    const fb = parseIntentFallback('I need eggs', KNOWN);
    expect(coerceParseIntentOutput(null, fb)).toBe(fb);
    expect(coerceParseIntentOutput({ intent: 'nope', item: 7, reply: 'x' }, fb)).toEqual({ intent: 'find_item', item: 'eggs', reply: 'x' });
    expect(coerceParseIntentOutput({ intent: 'find_item', item: ' Milk ', reply: 'Milk. Finding it.' }, fb)).toEqual({ intent: 'find_item', item: 'milk', reply: 'Milk. Finding it.' });
    expect(coerceParseIntentOutput({ intent: 'repeat', item: 'eggs', reply: 'The way is clear' }, fb)).toEqual({ intent: 'repeat', item: 'eggs', reply: fb.reply });
    expect(coerceParseIntentOutput({ intent: 'abort' }, fb).item).toBeNull();
  });

  it('keytermsFrom dedupes case-insensitively and caps at 100 (billing cliff)', () => {
    expect(keytermsFrom(['Eggs', 'eggs', ' milk ', '', 'Milk'])).toEqual(['Eggs', 'milk']);
    const many = Array.from({ length: 150 }, (_, i) => `item${i}`);
    expect(keytermsFrom(many)).toHaveLength(MAX_KEYTERMS);
  });
});

// ---------------------------------------------------------------------------
// Flow with a fake recognizer, fake fetch, fake audio/haptics
// ---------------------------------------------------------------------------

function fakeRecognizer(opts: { available?: boolean; onDevice?: boolean; granted?: boolean } = {}) {
  let handlers: RecognizerHandlers | null = null;
  const calls: string[] = [];
  let listenOpts: { lang: string; onDevice: boolean; contextualStrings: string[] } | null = null;
  const rec: Recognizer = {
    isAvailable: () => opts.available ?? true,
    supportsOnDevice: () => opts.onDevice ?? true,
    requestPermissions: async () => opts.granted ?? true,
    listen(o, h) {
      handlers = h;
      listenOpts = o;
      calls.push('listen');
      return { stop: () => calls.push('stop'), abort: () => calls.push('abort') };
    },
  };
  return {
    rec, calls,
    listenOpts: () => listenOpts,
    final(text: string, confidence = 0.9) { handlers?.onResult({ isFinal: true, results: [{ transcript: text, confidence }] }); },
    partial(text: string) { handlers?.onResult({ isFinal: false, results: [{ transcript: text, confidence: 0.3 }] }); },
    audio(uri: string | null) { handlers?.onAudioEnd(uri); },
    end() { handlers?.onEnd(); },
    error(code: string) { handlers?.onError(code); },
  };
}

describe('createVoiceInput', () => {
  let bus: AppEventBus;
  let store: AppStore;
  let said: SpeechRequest[];
  let events: string[];
  let audioModes: boolean[];
  let suspended: boolean[];
  let fetchBody: unknown;
  let fetchStatus: number;
  let fetchCalls: Array<{ url: string; body: unknown }>;
  let fetchImpl: typeof fetch;

  const speech = {
    say: (r: SpeechRequest) => { said.push(r); },
    playStream: () => {}, clearQueue: () => {}, isSpeaking: () => false, setRate: () => {},
  };

  const make = (rec: Recognizer | undefined, extra: Partial<Parameters<typeof createVoiceInput>[0]> = {}): VoiceInput =>
    createVoiceInput({
      speech, bus, store, proxyUrl: 'http://proxy', knownItems: () => KNOWN, recognizer: rec,
      audio: { setRecordingMode: async (on) => { audioModes.push(on); } },
      haptics: { setSuspended: (s) => { suspended.push(s); } },
      fetchImpl,
      ...extra,
    });

  beforeEach(() => {
    bus = createEventBus();
    store = createAppStore({ bus, warn: () => {} });
    store.setState({ mode: 'OUTDOOR_NAV' });
    said = [];
    events = [];
    audioModes = [];
    suspended = [];
    fetchCalls = [];
    fetchStatus = 200;
    fetchBody = { job: 'parseIntent', output: { intent: 'find_item', item: 'eggs', reply: 'Eggs. Route ready: two legs.' }, fallback: false, latencyMs: 640 };
    fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      return { ok: fetchStatus >= 200 && fetchStatus < 300, status: fetchStatus, json: async () => fetchBody } as Response;
    }) as typeof fetch;
    bus.on('ITEM_REQUESTED', (e) => events.push(`${e.item}@${e.source}`));
  });

  it('push-to-talk: recording mode + COURSE pause → on-device STT → /api/plan → reply, and back', async () => {
    const r = fakeRecognizer();
    const v = make(r.rec);
    await v.begin();
    expect(audioModes).toEqual([true]);
    expect(suspended).toEqual([true]);
    expect(v.isListening()).toBe(true);
    expect(r.listenOpts()).toMatchObject({ lang: 'en-US', onDevice: true, contextualStrings: KNOWN });

    r.partial('I need');
    r.final('I need eggs');
    const out = await v.end();
    expect(r.calls).toEqual(['listen', 'stop']);
    expect(out).toMatchObject({ transcript: 'I need eggs', sttPath: 'on-device', planner: true, plannerLatencyMs: 640 });
    expect(out.output).toEqual({ intent: 'find_item', item: 'eggs', reply: 'Eggs. Route ready: two legs.' });
    expect(fetchCalls[0].url).toBe('http://proxy/api/plan');
    expect(fetchCalls[0].body).toEqual({ job: 'parseIntent', input: { transcript: 'I need eggs', mode: 'OUTDOOR_NAV', knownItems: KNOWN } });
    expect(events).toEqual(['eggs@voice']);
    expect(said).toEqual([expect.objectContaining({ text: 'Eggs. Route ready: two legs.', priority: 'NAV' })]);
    expect(audioModes).toEqual([true, false]);
    expect(suspended).toEqual([true, false]);
    expect(v.isListening()).toBe(false);
    expect(v.getLast()).toBe(out);
  });

  it('falls back to the local keyword parser when the planner fails, times out or returns fallback', async () => {
    const r = fakeRecognizer();
    fetchStatus = 503;
    let v = make(r.rec);
    await v.begin();
    r.final('I need milk');
    let out = await v.end();
    expect(out.planner).toBe(false);
    expect(out.output).toEqual({ intent: 'find_item', item: 'milk', reply: 'Milk. Finding it.' });
    expect(events).toEqual(['milk@voice']);

    fetchStatus = 200;
    fetchBody = { job: 'parseIntent', output: { intent: 'find_item', item: 'milk', reply: 'Milk. Finding it.' }, fallback: true, latencyMs: 1500 };
    v = make(r.rec);
    await v.begin();
    r.final('I need milk');
    out = await v.end();
    expect(out.planner).toBe(false);

    fetchImpl = (async () => { throw new Error('network'); }) as typeof fetch;
    v = make(r.rec);
    await v.begin();
    r.final('I need bread');
    out = await v.end();
    expect(out.planner).toBe(false);
    expect(out.output.item).toBe('bread');
  });

  it('sanitizes a planner reply that breaks the language rules', async () => {
    const r = fakeRecognizer();
    fetchBody = { job: 'parseIntent', output: { intent: 'find_item', item: 'eggs', reply: 'Eggs in aisle 3, all clear' }, fallback: false, latencyMs: 300 };
    const v = make(r.rec);
    await v.begin();
    r.final('eggs');
    const out = await v.end();
    expect(out.output.reply).toBe('Eggs. Finding it.');
    expect(said[0].text).toBe('Eggs. Finding it.');
  });

  it('uses the Scribe upload when on-device heard nothing and a clip was persisted', async () => {
    const r = fakeRecognizer();
    fetchBody = { job: 'parseIntent', output: { intent: 'find_item', item: 'butter', reply: 'Butter. Finding it.' }, fallback: false, latencyMs: 300 };
    const uploads: string[] = [];
    const v = make(r.rec, { sttUpload: async (uri, keyterms) => { uploads.push(`${uri}|${keyterms.length}`); return 'I need butter'; } });
    await v.begin();
    r.audio('file:///rec.wav');
    r.end();
    const out = await v.end();
    expect(uploads).toEqual([`file:///rec.wav|${KNOWN.length}`]);
    expect(out).toMatchObject({ transcript: 'I need butter', sttPath: 'scribe' });
    expect(events).toEqual(['butter@voice']);
  });

  it('nothing heard → "Say the item again", no event, session torn down', async () => {
    jest.useFakeTimers();
    try {
      const r = fakeRecognizer();
      const v = make(r.rec, { finalTimeoutMs: 100 });
      await v.begin();
      const p = v.end();
      jest.advanceTimersByTime(150);
      const out = await p;
      expect(out).toMatchObject({ transcript: '', sttPath: 'none', planner: false });
      expect(out.output.reply).toBe(PHRASES.say_item_again);
      expect(events).toEqual([]);
      expect(fetchCalls).toEqual([]);
      expect(audioModes).toEqual([true, false]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('recognizer unavailable or permission denied: still tears down and replies with the fallback', async () => {
    let v = make(undefined);
    await v.begin();
    let out = await v.end();
    expect(out.sttPath).toBe('none');
    expect(audioModes).toEqual([true, false]);
    expect(suspended).toEqual([true, false]);

    const denied = fakeRecognizer({ granted: false });
    v = make(denied.rec);
    await v.begin();
    expect(denied.calls).toEqual([]);
    out = await v.end();
    expect(out.sttPath).toBe('none');
  });

  it('cancel aborts the recognizer without parsing', async () => {
    const r = fakeRecognizer();
    const v = make(r.rec);
    await v.begin();
    v.cancel();
    await Promise.resolve();
    expect(r.calls).toEqual(['listen', 'abort']);
    expect(v.isListening()).toBe(false);
    expect(fetchCalls).toEqual([]);
    expect(suspended[suspended.length - 1]).toBe(false);
  });

  it('keyboard dictation takes the same parse path with source keyboard', async () => {
    const v = make(undefined);
    const out = await v.submitText('  I need eggs ');
    expect(out).toMatchObject({ transcript: 'I need eggs', sttPath: 'keyboard', planner: true });
    expect(events).toEqual(['eggs@voice'.replace('voice', 'keyboard')]);
    expect(audioModes).toEqual([]);                       // no recording session for typed input
  });

  it('an abort intent aborts the trip through the store', async () => {
    fetchBody = { job: 'parseIntent', output: { intent: 'abort', item: null, reply: 'Stopping.' }, fallback: false, latencyMs: 200 };
    const v = make(undefined);
    store.setState({ mode: 'INDOOR_NAV', targetItem: 'eggs' });
    await v.submitText('stop');
    expect(store.getState().mode).toBe('IDLE');
    expect(store.getState().targetItem).toBeNull();
    expect(events).toEqual([]);
  });

  it('a recognizer error ends the session gracefully', async () => {
    const r = fakeRecognizer();
    const v = make(r.rec);
    await v.begin();
    r.error('audio-capture');
    const out = await v.end();
    expect(out.sttPath).toBe('none');
    expect(audioModes).toEqual([true, false]);
  });
});
