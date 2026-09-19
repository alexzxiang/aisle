import type { AppMode, Detection, SpeechRequest } from './contracts';
import { createEventBus, type AppEventBus } from './bus';
import { createAppStore, type AppStore } from './store';
import { createConversationLog, type ConversationLog } from './conversation';
import {
  DESCRIBE_DEDUPE_KEY,
  DESCRIBE_MIN_INTERVAL_MS,
  DESCRIBE_MODES,
  DESCRIBE_PROMPT,
  DESCRIBE_REPEAT_SUPPRESS_MS,
  DESCRIBE_SILENT_MODES,
  createSceneDescriber,
  type SceneDescriber,
} from './describer';
import type { AskOptions, AskOutcome, SemanticVision } from '../perception/semanticVision';
import { emptyVisionResponse } from '../perception/semanticVision';

const T0 = 1_700_000_000_000;

type Listener<T> = (v: T) => void;

function det(cls: Detection['cls'], x: number): Detection {
  return { cls, box: [x, 0.5, 0.2, 0.3], score: 0.9, trackId: 1 };
}

describe('SceneDescriber', () => {
  let bus: AppEventBus;
  let store: AppStore;
  let conversation: ConversationLog;
  let said: SpeechRequest[];
  let asks: Array<{ question: string; opts: AskOptions | undefined }>;
  let dets: Set<Listener<Detection[]>>;
  let ocr: Set<Listener<Array<{ text: string; box: [number, number, number, number]; confidence: number; timestamp: number }>>>;
  let reply: (speech: string, confidence?: number) => void;
  let describer: SceneDescriber;
  let enabled: boolean;
  let seq: number;

  const vision: Pick<SemanticVision, 'ask'> = {
    ask: (question, opts) => {
      asks.push({ question, opts });
      seq += 1;
      const n = seq;
      return new Promise<AskOutcome>((resolve) => {
        reply = (speech, confidence = 0.9) => {
          const response = { ...emptyVisionResponse(n), speech, confidence };
          resolve({ status: confidence >= 0.5 ? 'applied' : 'low_confidence', seq: n, response, streamed: false, latencyMs: 700 });
        };
      });
    },
  };

  const perception = {
    onDetections: (cb: Listener<Detection[]>) => { dets.add(cb); return () => { dets.delete(cb); }; },
    onOcrText: (cb: Listener<Array<{ text: string; box: [number, number, number, number]; confidence: number; timestamp: number }>>) => { ocr.add(cb); return () => { ocr.delete(cb); }; },
  };

  const scene = (d: Detection[]): void => { for (const cb of Array.from(dets)) cb(d); };
  const mode = (m: AppMode): void => { store.setState({ mode: m }); };
  const flush = async (ms = 0): Promise<void> => { await jest.advanceTimersByTimeAsync(ms); };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    bus = createEventBus();
    store = createAppStore({ bus, warn: () => undefined });
    conversation = createConversationLog();
    said = [];
    asks = [];
    dets = new Set();
    ocr = new Set();
    enabled = true;
    seq = 0;
    describer = createSceneDescriber({
      vision,
      speech: { say: (r) => { said.push(r); } },
      store,
      bus,
      conversation,
      perception,
      enabled: () => enabled,
    });
  });
  afterEach(() => {
    describer.stop();
    jest.useRealTimers();
  });

  it('asks the free question with the twelve-word prompt and a still on entering a walking mode, speaks INFO under the describe dedupe key and logs it', async () => {
    describer.start();
    expect(asks).toHaveLength(0);           // IDLE: nothing
    mode('OUTDOOR_NAV');
    expect(asks).toHaveLength(1);
    expect(asks[0].question).toBe('free');
    expect(asks[0].opts).toMatchObject({ userText: DESCRIBE_PROMPT, image: 512, priority: 'INFO', silent: true });
    reply('Person ahead on the left. Door on the right.');
    await flush();
    expect(said).toEqual([expect.objectContaining({
      text: 'Person ahead on the left. Door on the right.',
      priority: 'INFO',
      dedupeKey: DESCRIBE_DEDUPE_KEY,
      cooldownMs: DESCRIBE_MIN_INTERVAL_MS,
    })]);
    expect(conversation.entries()).toEqual([expect.objectContaining({ role: 'aisle', source: 'describe', text: 'Person ahead on the left. Door on the right.' })]);
    expect(describer.getStats()).toMatchObject({ running: true, asks: 1, spoken: 1, inFlight: false });
  });

  it('cadence: a scene change re-asks, but never more often than every eight seconds, and an unchanged scene is not re-asked', async () => {
    describer.start();
    mode('INDOOR_NAV');
    reply('Shelves both sides.');
    await flush();
    expect(asks).toHaveLength(1);

    scene([det('person', 0.2)]);          // changed, but inside the interval
    await flush(3000);
    expect(asks).toHaveLength(1);
    scene([det('person', 0.6)]);          // changed again
    await flush(DESCRIBE_MIN_INTERVAL_MS - 3000);
    expect(asks).toHaveLength(2);         // one ask once the interval has passed
    reply('Person ahead.');
    await flush();

    await flush(DESCRIBE_MIN_INTERVAL_MS * 3);   // same scene the whole time: no more asks
    expect(asks).toHaveLength(2);

    scene([det('cart', 0.4)]);
    await flush(1000);
    expect(asks).toHaveLength(3);
  });

  it('mode gating: never asks in APPROACH_CROSSING, AT_CURB, CROSSING, TRANSITION, IDLE or DONE', async () => {
    describer.start();
    for (const m of ['APPROACH_CROSSING', 'AT_CURB', 'CROSSING', 'TRANSITION', 'DONE', 'IDLE', 'ONBOARDING', 'ITEM_PICKUP'] as AppMode[]) {
      mode(m);
      scene([det('person', Math.random())]);
      await flush(DESCRIBE_MIN_INTERVAL_MS + 1000);
      expect(asks).toHaveLength(0);
    }
    for (const m of DESCRIBE_SILENT_MODES) expect(DESCRIBE_MODES.has(m)).toBe(false);
  });

  it('curb silence: a result that lands after the mode changed into a crossing mode is dropped, not spoken', async () => {
    describer.start();
    mode('OUTDOOR_NAV');
    expect(asks).toHaveLength(1);
    mode('APPROACH_CROSSING');
    reply('Crosswalk ahead, cars waiting.');
    await flush();
    expect(said).toEqual([]);
    expect(conversation.entries()).toEqual([]);
    expect(describer.getStats().dropped).toBe(1);
  });

  it('preference off: the cadence stops, describeNow still answers', async () => {
    enabled = false;
    describer.start();
    mode('OUTDOOR_NAV');
    scene([det('person', 0.5)]);
    await flush(DESCRIBE_MIN_INTERVAL_MS * 2);
    expect(asks).toHaveLength(0);

    const p = describer.describeNow();
    expect(asks).toHaveLength(1);
    reply('Open doorway ahead.');
    await expect(p).resolves.toBe('Open doorway ahead.');
    expect(said).toEqual([expect.objectContaining({ text: 'Open doorway ahead.', priority: 'NAV', dedupeKey: DESCRIBE_DEDUPE_KEY })]);
    expect(conversation.entries()).toHaveLength(1);
  });

  it('describeNow resolves null at the curb (no question spent), on low confidence, on empty or rule-breaking speech', async () => {
    describer.start();
    mode('AT_CURB');
    await expect(describer.describeNow()).resolves.toBeNull();
    expect(asks).toHaveLength(0);

    mode('INDOOR_NAV');
    reply('');                              // the cadence ask on entering the mode
    await flush();
    let p = describer.describeNow();
    reply('Nothing much.', 0.2);
    await expect(p).resolves.toBeNull();
    p = describer.describeNow();
    reply('');
    await expect(p).resolves.toBeNull();
    p = describer.describeNow();
    reply('It is safe to cross now.');      // forbidden words never reach the speaker
    await expect(p).resolves.toBeNull();
    p = describer.describeNow();
    reply('Aisle 3 ahead.');                // digits neither
    await expect(p).resolves.toBeNull();
    expect(said).toEqual([]);
  });

  it('dedupe: the same wording again inside thirty seconds is not repeated; describeNow is exempt', async () => {
    describer.start();
    mode('OUTDOOR_NAV');
    reply('Wide sidewalk, nobody ahead.');
    await flush();
    expect(said).toHaveLength(1);
    scene([det('bicycle', 0.1)]);
    await flush(DESCRIBE_MIN_INTERVAL_MS);
    expect(asks).toHaveLength(2);
    reply('Wide sidewalk, nobody ahead.');
    await flush();
    expect(said).toHaveLength(1);
    expect(describer.getStats().dropped).toBe(1);

    const p = describer.describeNow();
    reply('Wide sidewalk, nobody ahead.');
    await expect(p).resolves.toBe('Wide sidewalk, nobody ahead.');
    expect(said).toHaveLength(2);

    scene([det('car', 0.9)]);
    await flush(DESCRIBE_REPEAT_SUPPRESS_MS);
    reply('Wide sidewalk, nobody ahead.');
    await flush();
    expect(said).toHaveLength(3);
  });

  it('one question in flight at a time; a transport rejection is reported and never spoken; stop() ends the loop', async () => {
    describer.start();
    mode('OUTDOOR_NAV');
    expect(asks).toHaveLength(1);
    await expect(describer.describeNow()).resolves.toBeNull();   // busy
    expect(asks).toHaveLength(1);
    reply('Curb ahead.');
    await flush();

    const failing = createSceneDescriber({
      vision: { ask: async () => { throw new Error('socket'); } },
      speech: { say: (r) => { said.push(r); } },
      store,
      bus,
      conversation,
      perception,
      enabled: () => true,
    });
    const errors: string[] = [];
    bus.on('ERROR', (e) => errors.push(e.scope));
    failing.start();
    await flush();
    expect(errors).toEqual(['describer']);
    failing.stop();

    describer.stop();
    scene([det('person', 0.3)]);
    await flush(DESCRIBE_MIN_INTERVAL_MS * 2);
    expect(asks).toHaveLength(1);
    expect(describer.getStats().running).toBe(false);
  });
});
