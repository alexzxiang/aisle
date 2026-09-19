import { PHRASE_LIST, type Phrase } from '../src/core/phrases';
import {
  DEFAULT_CONCURRENCY,
  MODEL_ID,
  OUTPUT_FORMAT,
  VOICE_SETTINGS,
  createElevenLabsClient,
  estimateMp3DurationMs,
  mapWithConcurrency,
  planWork,
  renderManifestTs,
  sha1,
  validateTable,
  type ManifestEntry,
  type ManifestSidecar,
} from './generate-audio';

describe('generate-audio settings (07 §2)', () => {
  it('uses Flash v2.5, 64 kbps mp3, default voice settings, speed 1.0, four in flight', () => {
    expect(MODEL_ID).toBe('eleven_flash_v2_5');
    expect(OUTPUT_FORMAT).toBe('mp3_44100_64');
    expect(VOICE_SETTINGS).toMatchObject({ stability: 0.5, similarity_boost: 0.75, style: 0, speed: 1.0 });
    expect(DEFAULT_CONCURRENCY).toBe(4);
  });

  it('estimates duration from the CBR size', () => {
    expect(estimateMp3DurationMs(8000)).toBe(1000);          // 8000 B × 8 / 64 kbps = 1 s
    expect(estimateMp3DurationMs(96_000)).toBe(12_000);
  });
});

describe('validateTable', () => {
  it('accepts the real table and rejects a forbidden or long phrase before spending credits', () => {
    expect(validateTable(PHRASE_LIST)).toEqual([]);
    const bad: Phrase[] = [
      { key: 'walk_signal_on', text: 'Walk signal on, all clear.', category: 'signal' },
      { key: 'tilt_camera_up', text: 'Please tilt the camera up a little bit', category: 'prompt' },
      { key: 'higher', text: 'Shelf 2', category: 'indoor' },
    ];
    expect(validateTable(bad)).toEqual([
      'walk_signal_on: forbidden term "clear"',
      'tilt_camera_up: 8 words (max 6)',
      'higher: digits must be written as words',
    ]);
  });
});

describe('planWork', () => {
  const list: Phrase[] = [
    { key: 'higher', text: 'Higher.', category: 'indoor' },
    { key: 'lower', text: 'Lower.', category: 'indoor' },
    { key: 'left', text: 'Left.', category: 'indoor' },
  ];
  const entry = (key: string, text: string): ManifestEntry => ({ key, file: `${key}.mp3`, textSha1: sha1(text), bytes: 1, estimatedMs: 1, generatedAt: 'x' });
  const sidecar: ManifestSidecar = {
    model: MODEL_ID, voiceId: 'v', outputFormat: OUTPUT_FORMAT,
    entries: { higher: entry('higher', 'Higher.'), lower: entry('lower', 'OLD TEXT') },
  };

  it('regenerates only phrases whose text changed or whose file is missing', () => {
    const { todo, keep } = planWork(list, sidecar, { force: false, only: null, fileExists: (f) => f !== 'nothing' });
    expect(todo.map((p) => p.key)).toEqual(['lower', 'left']);
    expect(keep.map((p) => p.key)).toEqual(['higher']);
    const missing = planWork(list, sidecar, { force: false, only: null, fileExists: () => false });
    expect(missing.todo.map((p) => p.key)).toEqual(['higher', 'lower', 'left']);
  });

  it('--force regenerates everything, --only narrows, no sidecar means everything', () => {
    expect(planWork(list, sidecar, { force: true, only: null, fileExists: () => true }).todo).toHaveLength(3);
    const only = planWork(list, sidecar, { force: true, only: new Set(['left']), fileExists: () => true });
    expect(only.todo.map((p) => p.key)).toEqual(['left']);
    expect(only.keep).toHaveLength(2);
    expect(planWork(list, null, { force: false, only: null, fileExists: () => true }).todo).toHaveLength(3);
  });
});

describe('mapWithConcurrency', () => {
  it('never has more than the limit in flight and preserves order', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 11 }, (_, i) => i);
    const out = await mapWithConcurrency(items, 4, async (i) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5 + (i % 3) * 5));
      inFlight -= 1;
      return i * 2;
    });
    expect(peak).toBe(4);
    expect(out).toEqual(items.map((i) => i * 2));
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });
});

describe('renderManifestTs', () => {
  it('emits a sorted require map and the meta block', () => {
    const ts = renderManifestTs(
      [
        { key: 'lower', file: 'lower.mp3', textSha1: 'a', bytes: 1, estimatedMs: 1, generatedAt: 'g' },
        { key: 'higher', file: 'higher.mp3', textSha1: 'b', bytes: 1, estimatedMs: 1, generatedAt: 'g' },
      ],
      { voiceId: 'voice-1', generatedAt: '2026-09-19T00:00:00.000Z' },
    );
    expect(ts).toContain("  higher: require('./higher.mp3') as number,\n  lower: require('./lower.mp3') as number,");
    expect(ts).toContain('count: 2');
    expect(ts).toContain('voiceId: "voice-1"');
    expect(ts).toContain('model: "eleven_flash_v2_5"');
    const empty = renderManifestTs([], { voiceId: null, generatedAt: null });
    expect(empty).toContain('generatedAt: null as string | null');
    expect(empty).toContain('count: 0');
  });
});

describe('createElevenLabsClient', () => {
  it('posts the 07 §2 body to the voice endpoint and retries on 429/5xx', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let n = 0;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      n += 1;
      if (n === 1) return { ok: false, status: 429, text: async () => 'slow down', arrayBuffer: async () => new ArrayBuffer(0) } as Response;
      return { ok: true, status: 200, text: async () => '', arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as Response;
    }) as typeof fetch;
    const c = createElevenLabsClient({ apiKey: 'k', voiceId: 'v1', baseUrl: 'https://api.us.elevenlabs.io/', fetchImpl });
    const audio = await c.synthesize('Higher.');
    expect(Array.from(audio)).toEqual([1, 2, 3]);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe('https://api.us.elevenlabs.io/v1/text-to-speech/v1?output_format=mp3_44100_64');
    expect(calls[0].init.headers).toMatchObject({ 'xi-api-key': 'k', accept: 'audio/mpeg' });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ text: 'Higher.', model_id: 'eleven_flash_v2_5', voice_settings: VOICE_SETTINGS });
  });

  it('fails fast on a 4xx other than 429', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 401, text: async () => 'bad key', arrayBuffer: async () => new ArrayBuffer(0) }) as unknown as Response) as typeof fetch;
    const c = createElevenLabsClient({ apiKey: 'k', voiceId: 'v', baseUrl: 'https://x', fetchImpl });
    await expect(c.synthesize('Lower.')).rejects.toThrow(/401/);
  });
});
