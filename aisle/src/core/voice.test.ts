import type { ParseIntentOutput, SpeechRequest, SpeechService } from './contracts';
import { createEventBus, type AppEventBus } from './bus';
import { bindStoreToBus, createAppStore, type AppStore } from './store';
import { PHRASES, checkPhrase } from './phrases';
import { createConversationLog, type ConversationLog } from './conversation';
import {
  FALLBACK_REPLY,
  MAX_KEYTERMS,
  UNCLEAR_TRIES_BEFORE_ONE_WORD,
  isDescribeRequest,
  bestTranscript,
  coerceParseIntentOutput,
  createVoiceInput,
  goalConfirmQuestion,
  keytermsFrom,
  VOICE_VOCABULARY,
  parseIntentFallback,
  sanitizeReply,
  type ListenOptions,
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
    expect(coerceParseIntentOutput({ intent: 'nope', item: 7, reply: 'x' }, fb)).toMatchObject({ intent: 'find_item', item: 'eggs', reply: 'x' });
    expect(coerceParseIntentOutput({ intent: 'find_item', item: ' Milk ', reply: 'Milk. Finding it.' }, fb)).toMatchObject({ intent: 'find_item', item: 'milk', reply: 'Milk. Finding it.' });
    expect(coerceParseIntentOutput({ intent: 'repeat', item: 'eggs', reply: 'The way is clear' }, fb)).toMatchObject({ intent: 'repeat', item: 'eggs', reply: fb.reply });
    expect(coerceParseIntentOutput({ intent: 'abort' }, fb).item).toBeNull();
  });

  it('keytermsFrom dedupes case-insensitively and caps at 100 (billing cliff)', () => {
    // The fixed vocabulary leads; the store's own items follow, deduped case-insensitively.
    // (Use items not in the fixed vocabulary so the append/dedup is visible.)
    expect(keytermsFrom(['Tofu', 'tofu', ' hummus ', '', 'Hummus']).slice(-2)).toEqual(['Tofu', 'hummus']);
    expect(keytermsFrom(['Eggs']).slice(0, VOICE_VOCABULARY.length)).toEqual([...VOICE_VOCABULARY]);
    expect(keytermsFrom(['yes', 'CVS'])).toHaveLength(VOICE_VOCABULARY.length);   // already in the vocabulary
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
  let listenOpts: ListenOptions | null = null;
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
  let cleared: number;
  let fetchBody: unknown;
  let fetchStatus: number;
  let fetchCalls: Array<{ url: string; body: unknown }>;
  let fetchImpl: typeof fetch;

  const speech = {
    say: (r: SpeechRequest) => { said.push(r); },
    playStream: () => {}, clearQueue: () => { cleared += 1; }, isSpeaking: () => false, setRate: () => {},
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
    cleared = 0;
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
    // Apple's server recogniser by default (more accurate); the store's items ride along with the fixed vocabulary.
    // The fixed vocabulary leads, then the store's items — deduped (some KNOWN items are now staples in the vocabulary).
    expect(r.listenOpts()).toMatchObject({ lang: 'en-US', onDevice: false, contextualStrings: keytermsFrom(KNOWN) });

    r.partial('I need');
    r.final('I need eggs');
    const out = await v.end();
    expect(r.calls).toEqual(['listen', 'stop']);
    expect(out).toMatchObject({ transcript: 'I need eggs', sttPath: 'on-device', planner: true, plannerLatencyMs: 640 });
    expect(out.output).toMatchObject({ intent: 'find_item', item: 'eggs', reply: 'Eggs. Route ready: two legs.' });
    expect(fetchCalls[0].url).toBe('http://proxy/api/plan');
    expect(fetchCalls[0].body).toEqual({ job: 'parseIntent', input: { transcript: 'I need eggs', mode: 'OUTDOOR_NAV', knownItems: KNOWN } });
    expect(events).toEqual(['eggs@voice']);
    expect(said).toEqual([expect.objectContaining({ text: 'Eggs. Route ready: two legs.', priority: 'NAV' })]);
    expect(audioModes).toEqual([true, false]);
    expect(suspended).toEqual([true, false]);
    expect(v.isListening()).toBe(false);
    expect(v.getLast()).toBe(out);
  });

  it('explicit fridge commands replace the mistaken outdoor route without consulting the planner', async () => {
    const unbind = bindStoreToBus(store, bus);
    const v = make(undefined);
    await v.submitText('get eggs from my fridge');
    expect(fetchCalls).toHaveLength(0);
    expect(store.getState()).toMatchObject({ mode: 'GUIDED_TASK', taskGoal: 'eggs from my fridge', targetItem: null });
    expect(bus.history().filter((r) => r.event.type === 'TASK_REQUESTED').at(-1)?.event).toMatchObject({ context: 'home' });
    unbind();
  });

  it('a place correction attaches to the existing item, and asking for the fridge keeps the egg mission', async () => {
    const unbind = bindStoreToBus(store, bus);
    store.setState({ targetItem: 'eggs' });
    const intercept = jest.fn(() => true);
    const v = make(undefined, { intercept });
    await v.submitText('in my fridge');
    expect(store.getState().taskGoal).toBe('eggs in my fridge');
    await v.submitText('how do I get to my fridge');
    expect(intercept).toHaveBeenCalledWith('repeat');
    expect(store.getState().taskGoal).toBe('eggs in my fridge');
    expect(bus.history().filter((r) => r.event.type === 'TASK_REQUESTED')).toHaveLength(1);
    unbind();
  });

  it('begin() stops the app talking into its own microphone (clears the speech queue)', async () => {
    const r = fakeRecognizer();
    const v = make(r.rec);
    expect(cleared).toBe(0);
    await v.begin();
    expect(cleared).toBeGreaterThanOrEqual(1);   // the queue was cut the moment the mic opened
    v.cancel();
  });

  it('an unrecognised question goes to the camera as a free question, not "say the item again" (B-3)', async () => {
    const r = fakeRecognizer();
    fetchStatus = 503;   // planner miss → local parser → unknown
    const asked: string[] = [];
    const v = make(r.rec, { askScene: async (q: string) => { asked.push(q); return 'The shelf has cereal boxes.'; } });
    await v.begin();
    r.final('what is on the shelf');
    const out = await v.end();
    expect(asked).toEqual(['what is on the shelf']);
    expect(out.localIntent).toBe('describe');
    expect(said.some((s) => s.text === PHRASES.say_item_again)).toBe(false);
  });

  it('when the camera cannot answer an unrecognised utterance, it says "I did not catch that" once (B-3)', async () => {
    const r = fakeRecognizer();
    fetchStatus = 503;
    const v = make(r.rec, { askScene: async () => null });
    await v.begin();
    r.final('what is on the shelf');
    await v.end();
    expect(said.filter((s) => s.text === PHRASES.not_caught)).toHaveLength(1);
  });

  it('falls back to the local keyword parser when the planner fails, times out or returns fallback', async () => {
    const r = fakeRecognizer();
    fetchStatus = 503;
    let v = make(r.rec);
    await v.begin();
    r.final('I need milk');
    let out = await v.end();
    expect(out.planner).toBe(false);
    expect(out.output).toMatchObject({ intent: 'find_item', item: 'milk', reply: 'Milk. Finding it.' });
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
    expect(uploads).toEqual([`file:///rec.wav|${keytermsFrom(KNOWN).length}`]);
    expect(out).toMatchObject({ transcript: 'I need butter', sttPath: 'scribe' });
    expect(events).toEqual(['butter@voice']);
  });

  it('records nothing to disk unless a Scribe upload is configured (privacy)', async () => {
    const r = fakeRecognizer();
    const v = make(r.rec);
    await v.begin();
    expect(r.listenOpts()?.persistAudio).toBe(false);
    r.final('eggs');
    await v.end();

    const r2 = fakeRecognizer();
    const v2 = make(r2.rec, { sttUpload: async () => null });
    await v2.begin();
    expect(r2.listenOpts()?.persistAudio).toBe(true);
    r2.final('eggs');
    await v2.end();
  });

  it('deletes the persisted clip once end() is through with it, whether or not it was uploaded', async () => {
    const deleted: string[] = [];
    const deleteFile = (uri: string) => { deleted.push(uri); };

    // Uploaded (on-device heard nothing) → deleted after the upload.
    let r = fakeRecognizer();
    let v = make(r.rec, { sttUpload: async () => 'I need butter', deleteFile });
    await v.begin();
    r.audio('file:///rec-1.wav');
    r.end();
    await v.end();
    expect(deleted).toEqual(['file:///rec-1.wav']);

    // Not uploaded (on-device heard the item) → still deleted, exactly once.
    r = fakeRecognizer();
    v = make(r.rec, { sttUpload: async () => null, deleteFile });
    await v.begin();
    r.audio('file:///rec-2.wav');
    r.final('eggs');
    await v.end();
    expect(deleted).toEqual(['file:///rec-1.wav', 'file:///rec-2.wav']);

    // A clip the recognizer hands over after end() finished is deleted on arrival.
    r = fakeRecognizer();
    v = make(r.rec, { sttUpload: async () => null, deleteFile });
    await v.begin();
    r.final('eggs');
    await v.end();
    r.audio('file:///rec-late.wav');
    expect(deleted).toEqual(['file:///rec-1.wav', 'file:///rec-2.wav', 'file:///rec-late.wav']);
  });

  it('cancel() deletes the persisted clip too, and a throwing delete never surfaces', async () => {
    const deleted: string[] = [];
    let r = fakeRecognizer();
    let v = make(r.rec, { sttUpload: async () => null, deleteFile: (uri) => { deleted.push(uri); } });
    await v.begin();
    r.audio('file:///rec-cancel.wav');
    v.cancel();
    await Promise.resolve();
    expect(deleted).toEqual(['file:///rec-cancel.wav']);

    r = fakeRecognizer();
    v = make(r.rec, { sttUpload: async () => null, deleteFile: () => { throw new Error('disk'); } });
    await v.begin();
    r.audio('file:///rec-throw.wav');
    r.final('eggs');
    const out = await v.end();
    expect(out.transcript).toBe('eggs');

    r = fakeRecognizer();
    v = make(r.rec, { sttUpload: async () => null, deleteFile: async () => { throw new Error('disk'); } });
    await v.begin();
    r.audio('file:///rec-reject.wav');
    r.final('eggs');
    await expect(v.end()).resolves.toMatchObject({ transcript: 'eggs' });
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

  // --- round 3: the conversation log, "describe", two unclear tries ------------------

  describe('conversation log and local intents (round 3)', () => {
    let conversation: ConversationLog;
    beforeEach(() => { conversation = createConversationLog({ collapseMs: 0 }); });
    const lines = () => conversation.entries().map((e) => `${e.role}/${e.source}:${e.text}`);

    it('pushes the transcript as "you" (voice or keyboard) and the reply as "aisle"; nothing heard pushes no user line', async () => {
      const r = fakeRecognizer();
      let v = make(r.rec, { conversation });
      await v.begin();
      r.final('I need eggs');
      await v.end();
      expect(lines()).toEqual(['you/voice:I need eggs', 'aisle/speech:Eggs. Route ready: two legs.']);

      v = make(undefined, { conversation });
      await v.submitText('I need eggs');
      expect(lines()[2]).toBe('you/keyboard:I need eggs');

      jest.useFakeTimers();
      try {
        const r2 = fakeRecognizer();
        v = make(r2.rec, { conversation, finalTimeoutMs: 50 });
        await v.begin();
        const p = v.end();
        jest.advanceTimersByTime(60);
        await p;
      } finally {
        jest.useRealTimers();
      }
      expect(lines().slice(4)).toEqual([`aisle/speech:${PHRASES.say_item_again}`]);
    });

    it('a canonical phrase reply carries its cache key so it plays from the bundle', async () => {
      fetchStatus = 500;
      const v = make(undefined, { conversation });
      await v.submitText('blorp');
      expect(said[0]).toMatchObject({ text: PHRASES.say_item_again, cacheKey: 'say_item_again', priority: 'NAV' });
      fetchStatus = 200;
      await v.submitText('I need eggs');
      expect(said[1].cacheKey).toBeUndefined();
    });

    it('two unclear tries in a row earn "Say the item again, one word."; any clear intent resets the streak', async () => {
      fetchStatus = 500;                       // planner down: the keyword fallback decides
      const v = make(undefined, { conversation });
      let out = await v.submitText('blorp');
      expect(out.output.reply).toBe(PHRASES.say_item_again);
      for (let i = 1; i < UNCLEAR_TRIES_BEFORE_ONE_WORD; i += 1) out = await v.submitText('fnarg');
      expect(out.output.reply).toBe(PHRASES.say_item_one_word);
      expect(said[said.length - 1]).toMatchObject({ text: PHRASES.say_item_one_word, cacheKey: 'say_item_one_word' });
      out = await v.submitText('zzz');
      expect(out.output.reply).toBe(PHRASES.say_item_one_word);   // stays on the short ask while unclear
      out = await v.submitText('I need eggs');
      expect(out.output.intent).toBe('find_item');
      out = await v.submitText('blorp');
      expect(out.output.reply).toBe(PHRASES.say_item_again);      // streak reset by the clear request
      // A planner reply that is not the canonical fallback is never rewritten.
      fetchStatus = 200;
      fetchBody = { job: 'parseIntent', output: { intent: 'unknown', item: null, reply: 'Try a shorter word.' }, fallback: false, latencyMs: 100 };
      await v.submitText('mumble');
      out = await v.submitText('mumble');
      expect(out.output.reply).toBe('Try a shorter word.');
    });

    it('isDescribeRequest matches the "what do you see" family only', () => {
      for (const t of ["what's around me", 'What is around me?', 'what do you see', 'what can you see', 'describe', 'describe the scene', 'describe what you see', 'look around', "what's ahead"]) {
        expect(isDescribeRequest(t)).toBe(true);
      }
      for (const t of ['I need eggs', 'where am I', 'describe eggs to me later', 'repeat', '']) {
        expect(isDescribeRequest(t)).toBe(false);
      }
    });

    it('a describe request is answered locally by the describer, before the planner, and marked localIntent', async () => {
      const calls: number[] = [];
      let v = make(undefined, { conversation, describe: async () => { calls.push(1); return 'Two people ahead, door on the right.'; } });
      let out = await v.submitText('what do you see');
      expect(calls).toEqual([1]);
      expect(fetchCalls).toEqual([]);                     // the planner was never asked
      expect(out).toMatchObject({ localIntent: 'describe', planner: false, output: { intent: 'unknown', item: null, reply: 'Two people ahead, door on the right.' } });
      expect(said).toEqual([]);                           // the describer spoke its own words
      expect(lines()).toEqual(['you/keyboard:what do you see']);

      // Nothing to describe: the cached fallback line is spoken and logged.
      v = make(undefined, { conversation, describe: async () => null });
      out = await v.submitText('describe');
      expect(out.output.reply).toBe(PHRASES.describe_nothing);
      expect(said).toEqual([expect.objectContaining({ text: PHRASES.describe_nothing, cacheKey: 'describe_nothing', priority: 'NAV' })]);
      expect(lines().slice(1)).toEqual(['you/keyboard:describe', `aisle/speech:${PHRASES.describe_nothing}`]);

      // A throwing describer degrades the same way; without a describer the planner path runs as before.
      v = make(undefined, { conversation, describe: async () => { throw new Error('vision'); } });
      out = await v.submitText('look around');
      expect(out.output.reply).toBe(PHRASES.describe_nothing);
      v = make(undefined, { conversation });
      out = await v.submitText('what do you see');
      expect(out.localIntent).toBeUndefined();
      expect(fetchCalls).toHaveLength(1);
    });
  });
});

describe('round 4: the voice path emits the new events', () => {
  let bus: AppEventBus;
  let store: AppStore;
  let events: Array<{ type: string } & Record<string, unknown>>;
  const said: SpeechRequest[] = [];
  beforeEach(() => {
    bus = createEventBus();
    store = createAppStore({ bus, warn: () => {} });
    events = [];
    bus.onAny((r) => events.push(r.event as { type: string } & Record<string, unknown>));
    said.length = 0;
  });
  const make = (): VoiceInput => createVoiceInput({
    speech: { say: (r: SpeechRequest) => { said.push(r); } } as unknown as SpeechService,
    bus, store, proxyUrl: 'http://proxy', knownItems: () => KNOWN, recognizer: undefined,
    fetchImpl: (async () => { throw new Error('offline'); }) as unknown as typeof fetch,
  });
  it('"take me to CVS" (keyboard) → DESTINATION_REQUESTED', async () => {
    await make().submitText('take me to CVS');
    const e = events.find((x) => x.type === 'DESTINATION_REQUESTED');
    expect(e).toMatchObject({ name: 'CVS', source: 'keyboard' });
  });
  it('"eggs in my fridge" at home (IDLE) → TASK_REQUESTED with context home; in the store → store', async () => {
    await make().submitText('take me to the eggs in my fridge');
    expect(events.find((x) => x.type === 'TASK_REQUESTED')).toMatchObject({ goal: 'eggs in my fridge', context: 'home' });
    events = [];
    store.setState({ mode: 'INDOOR_NAV' });
    await make().submitText('find my keys');
    expect(events.find((x) => x.type === 'TASK_REQUESTED')).toMatchObject({ context: 'store' });
  });

  it('an item named in a store scene (no trip) → the model finds it: TASK_REQUESTED store, not ITEM_REQUESTED', async () => {
    store.setState({ mode: 'IDLE' });
    const v = createVoiceInput({
      speech: { say: (r: SpeechRequest) => { said.push(r); } } as unknown as SpeechService,
      bus, store, proxyUrl: 'http://proxy', knownItems: () => KNOWN, recognizer: undefined,
      fetchImpl: (async () => { throw new Error('offline'); }) as unknown as typeof fetch,
      sceneContext: () => 'store',
    });
    await v.submitText('find the pasta');
    expect(events.find((x) => x.type === 'TASK_REQUESTED')).toMatchObject({ goal: 'pasta', context: 'store' });
    expect(events.find((x) => x.type === 'ITEM_REQUESTED')).toBeUndefined();
  });

  it('the same item on an active trip stays a trip (ITEM_REQUESTED), scene ignored', async () => {
    store.setState({ mode: 'INDOOR_NAV' });
    const v = createVoiceInput({
      speech: { say: (r: SpeechRequest) => { said.push(r); } } as unknown as SpeechService,
      bus, store, proxyUrl: 'http://proxy', knownItems: () => KNOWN, recognizer: undefined,
      fetchImpl: (async () => { throw new Error('offline'); }) as unknown as typeof fetch,
      sceneContext: () => 'store',
    });
    await v.submitText('find the pasta');
    expect(events.find((x) => x.type === 'ITEM_REQUESTED')).toMatchObject({ item: 'pasta' });
    expect(events.find((x) => x.type === 'TASK_REQUESTED')).toBeUndefined();
  });
});

describe('round 4: destinations and guided tasks through the voice path', () => {
  it('fallback parser: "take me to CVS" → navigate_to; home goals → guided_task; store items still win', () => {
    expect(parseIntentFallback('take me to CVS', KNOWN)).toMatchObject({ intent: 'navigate_to', destination: 'CVS' });
    expect(parseIntentFallback('walk me to the library', KNOWN)).toMatchObject({ intent: 'navigate_to', destination: 'library' });
    expect(parseIntentFallback('take me to the eggs in my fridge', KNOWN)).toMatchObject({ intent: 'guided_task', goal: 'eggs in my fridge' });
    expect(parseIntentFallback('get to the living room', KNOWN)).toMatchObject({ intent: 'guided_task' });
    expect(parseIntentFallback('I need eggs', KNOWN)).toMatchObject({ intent: 'find_item', item: 'eggs' });
  });
  it('coercion keeps a planner destination / goal and repairs a missing one from the fallback', () => {
    const fb = parseIntentFallback('take me to CVS', KNOWN);
    expect(coerceParseIntentOutput({ intent: 'navigate_to', item: null, destination: 'CVS Pharmacy', goal: null, reply: 'CVS. Planning a route.' }, fb)).toMatchObject({ intent: 'navigate_to', destination: 'CVS Pharmacy' });
    expect(coerceParseIntentOutput({ intent: 'navigate_to', item: null, destination: null, goal: null, reply: 'Planning a route.' }, fb)).toMatchObject({ intent: 'navigate_to', destination: 'CVS' });
    const fb2 = parseIntentFallback('eggs in my fridge', KNOWN);
    expect(coerceParseIntentOutput({ intent: 'guided_task', item: null, destination: null, goal: null, reply: 'Let me see.' }, fb2)).toMatchObject({ intent: 'guided_task', goal: 'eggs in my fridge' });
  });
});

describe('goal confirmation when a spoken item is uncertain', () => {
  it('goalConfirmQuestion builds a safe question, or null for digits / forbidden / empty', () => {
    expect(goalConfirmQuestion('pasta')).toBe('Pasta. Did I get that right?');
    expect(goalConfirmQuestion('eggs in my fridge')).toBe('Eggs in my fridge. Did I get that right?');
    expect(goalConfirmQuestion('aisle 3')).toBeNull();
    expect(goalConfirmQuestion('')).toBeNull();
  });

  const setup = (scene: 'store' | 'home' | 'street') => {
    const bus = createEventBus();
    const store = createAppStore({ bus, warn: () => {} });
    store.setState({ mode: 'IDLE' });
    const said: SpeechRequest[] = [];
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    bus.onAny((r) => events.push(r.event as { type: string } & Record<string, unknown>));
    const rec = fakeRecognizer();
    const v = createVoiceInput({
      speech: { say: (s: SpeechRequest) => { said.push(s); }, playStream() {}, clearQueue() {}, isSpeaking: () => false, setRate() {} } as unknown as SpeechService,
      bus, store, proxyUrl: 'http://proxy', knownItems: () => KNOWN, recognizer: rec.rec,
      fetchImpl: (async () => { throw new Error('offline'); }) as unknown as typeof fetch,  // planner misses → uncertain
      sceneContext: () => scene,
    });
    return { v, rec, said, events };
  };

  it('an uncertain spoken item in a store scene is confirmed first; "yes" then starts the search', async () => {
    const { v, rec, said, events } = setup('store');
    await v.begin();
    rec.final('find the pasta');
    await v.end();
    expect(said.some((s) => s.text === 'Pasta. Did I get that right?')).toBe(true);
    expect(events.find((e) => e.type === 'TASK_REQUESTED')).toBeUndefined();   // not launched yet

    await v.begin();
    rec.final('yes');
    const out = await v.end();
    expect(events.find((e) => e.type === 'TASK_REQUESTED')).toMatchObject({ goal: 'pasta', context: 'store' });
    expect(out.localIntent).toBe('intercepted');
  });

  it('"no" asks again and starts nothing', async () => {
    const { v, rec, said, events } = setup('store');
    await v.begin();
    rec.final('find the pasta');
    await v.end();
    await v.begin();
    rec.final('no');
    await v.end();
    expect(said[said.length - 1].text).toBe(PHRASES.say_item_again);
    expect(events.find((e) => e.type === 'TASK_REQUESTED')).toBeUndefined();
  });

  it.each(['yes', 'That is correct', 'Yes, that’s correct.', 'That’s right!', 'Okay', 'Yes please'])('accepts %s for the kitchen/eggs mission without replanning', async (answer) => {
    const { v, rec, events } = setup('home');
    await v.begin();
    rec.final('take me to the kitchen where my eggs are');
    await v.end();
    expect(v.isAwaitingConfirmation()).toBe(true);
    await v.begin();
    rec.final(answer);
    const result = await v.end();
    expect(result.planner).toBe(false);
    expect(v.isAwaitingConfirmation()).toBe(false);
    expect(events.filter((e) => e.type === 'TASK_REQUESTED')).toEqual([
      expect.objectContaining({ goal: 'kitchen where my eggs are', context: 'home' }),
    ]);
  });

  it.each(['', 'hmm', 'yes but no'])('keeps the mission after unclear confirmation %p, then accepts a retry', async (answer) => {
    const { v, rec, events, said } = setup('home');
    await v.begin();
    rec.final('get eggs from my fridge');
    await v.end();
    await v.submitText(answer);
    expect(v.isAwaitingConfirmation()).toBe(true);
    expect(events.some((e) => e.type === 'TASK_REQUESTED')).toBe(false);
    expect(said[said.length - 1].text).toContain('still saved');
    await v.submitText('That is correct');
    expect(events.filter((e) => e.type === 'TASK_REQUESTED')).toEqual([
      expect.objectContaining({ goal: 'eggs from my fridge', context: 'home' }),
    ]);
  });

  it('a keyboard item is certain (typed) → starts immediately, no confirmation', async () => {
    const { v, said, events } = setup('store');
    await v.submitText('find the pasta');
    expect(said.some((s) => s.text === 'Pasta. Did I get that right?')).toBe(false);
    expect(events.find((e) => e.type === 'TASK_REQUESTED')).toMatchObject({ goal: 'pasta', context: 'store' });
  });

  it('a spoken route is confirmed before it starts; "yes" then launches the trip (v2 B-4)', async () => {
    const { v, rec, said, events } = setup('street');
    await v.begin();
    rec.final('take me to CVS');
    await v.end();
    expect(said.some((s) => s.text === 'CVS. Did I get that right?')).toBe(true);
    expect(events.find((e) => e.type === 'DESTINATION_REQUESTED')).toBeUndefined();   // not launched yet
    await v.begin();
    rec.final('yes');
    await v.end();
    expect(events.find((e) => e.type === 'DESTINATION_REQUESTED')).toMatchObject({ name: 'CVS' });
  });

  it('a keyboard route starts immediately, no confirmation', async () => {
    const { v, said, events } = setup('street');
    await v.submitText('take me to CVS');
    expect(said.some((s) => s.text === 'CVS. Did I get that right?')).toBe(false);
    expect(events.find((e) => e.type === 'DESTINATION_REQUESTED')).toMatchObject({ name: 'CVS' });
  });
});
