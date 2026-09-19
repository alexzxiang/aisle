/**
 * Batch pre-generation of the cached phrase set with ElevenLabs Flash v2.5
 * (02 Task 4, 07 §2).
 *
 * For every entry in `src/core/phrases.ts` it POSTs
 *   POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=mp3_44100_64
 *   { text, model_id: 'eleven_flash_v2_5', voice_settings: { stability 0.5, similarity 0.75, style 0 } }
 * and writes `assets/audio/<cacheKey>.mp3`, at most 4 requests in flight
 * (free-plan concurrency; `--concurrency 10` on Creator). Speed stays 1.0:
 * the rate is applied on-device by `SpeechService.setRate`, so one file set
 * serves every setting.
 *
 * It then writes `assets/audio/manifest.ts` — the `require()` map the
 * expo-audio backend preloads — and `assets/audio/manifest.json`, a sidecar
 * with the text hash per key so a re-run regenerates only phrases whose text
 * changed (`--force` regenerates everything).
 *
 * Guards: every phrase passes the language rules first (≤ 12 words, digits as
 * words, no forbidden term; the disclaimer is allow-listed for length only and
 * must come back ≤ 12 s of audio, estimated from the 64 kbps CBR size). A
 * violation aborts before any credit is spent.
 *
 * Runs only with a key: without ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID it
 * prints what it would do and exits 0, so CI and keyless checkouts are not
 * broken; the app then speaks every phrase through expo-speech.
 *
 * Usage:
 *   ELEVENLABS_API_KEY=... ELEVENLABS_VOICE_ID=... npx tsx scripts/generate-audio.ts
 *     [--concurrency 4] [--force] [--dry-run] [--only key1,key2] [--base https://api.us.elevenlabs.io]
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  LONG_PHRASE_ALLOWLIST,
  LONG_PHRASE_MAX_AUDIO_MS,
  MAX_PROMPT_WORDS,
  MAX_UTTERANCE_WORDS,
  PHRASE_LIST,
  checkPhrase,
  type Phrase,
} from '../src/core/phrases';

// ---------------------------------------------------------------------------
// Settings (07 §2)
// ---------------------------------------------------------------------------

export const MODEL_ID = 'eleven_flash_v2_5';
export const OUTPUT_FORMAT = 'mp3_44100_64';
export const OUTPUT_BITRATE_BPS = 64_000;
export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_BASE_URL = 'https://api.elevenlabs.io';
export const VOICE_SETTINGS = Object.freeze({
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0,
  use_speaker_boost: true,
  speed: 1.0,
});
/** One phrase's worth of audio at 1.0 must fit the ≤ 2 s budget; warn, do not fail, above this. */
export const UTTERANCE_WARN_MS = 2000;

const OUT_DIR = resolve(__dirname, '..', 'assets', 'audio');
const MANIFEST_TS = resolve(OUT_DIR, 'manifest.ts');
const MANIFEST_JSON = resolve(OUT_DIR, 'manifest.json');

export interface ManifestEntry {
  key: string;
  file: string;
  textSha1: string;
  bytes: number;
  estimatedMs: number;
  generatedAt: string;
}

export interface ManifestSidecar {
  model: string;
  voiceId: string | null;
  outputFormat: string;
  entries: Record<string, ManifestEntry>;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export function sha1(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

/** 64 kbps CBR: milliseconds ≈ bytes × 8 / 64000 × 1000. Good to a few % (ID3/Xing frames aside). */
export function estimateMp3DurationMs(bytes: number, bitrateBps: number = OUTPUT_BITRATE_BPS): number {
  return Math.round((bytes * 8 * 1000) / bitrateBps);
}

/** Validates the whole table before a single credit is spent. */
export function validateTable(list: readonly Phrase[]): string[] {
  const errors: string[] = [];
  for (const p of list) {
    const v = checkPhrase(p.text, {
      allowLong: LONG_PHRASE_ALLOWLIST.has(p.key),
      maxWords: p.category === 'prompt' ? MAX_PROMPT_WORDS : MAX_UTTERANCE_WORDS,
    });
    for (const x of v) {
      errors.push(
        `${p.key}: ${x.kind === 'forbidden' ? `forbidden term "${x.term}"`
          : x.kind === 'too_long' ? `${x.words} words (max ${x.max})`
            : x.kind === 'digit' ? 'digits must be written as words' : 'empty'}`,
      );
    }
  }
  return errors;
}

/** Which keys need (re)generation given the sidecar. */
export function planWork(
  list: readonly Phrase[],
  sidecar: ManifestSidecar | null,
  opts: { force: boolean; only: ReadonlySet<string> | null; fileExists: (file: string) => boolean },
): { todo: Phrase[]; keep: Phrase[] } {
  const todo: Phrase[] = [];
  const keep: Phrase[] = [];
  for (const p of list) {
    if (opts.only && !opts.only.has(p.key)) {
      keep.push(p);
      continue;
    }
    const prev = sidecar?.entries[p.key];
    const fresh = !opts.force && prev !== undefined && prev.textSha1 === sha1(p.text) && opts.fileExists(prev.file);
    (fresh ? keep : todo).push(p);
  }
  return { todo, keep };
}

/** Runs `fn` over `items` with at most `limit` in flight, preserving order in the result. */
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** The generated `manifest.ts` source. Keys sorted for stable diffs. */
export function renderManifestTs(entries: readonly ManifestEntry[], meta: { voiceId: string | null; generatedAt: string | null }): string {
  const sorted = [...entries].sort((a, b) => a.key.localeCompare(b.key));
  const lines = sorted.map((e) => `  ${e.key}: require('./${e.file}') as number,`);
  return `/**
 * GENERATED by scripts/generate-audio.ts — do not edit by hand.
 *
 * Maps each cache key in src/core/phrases.ts to its bundled mp3 (a Metro asset
 * id from \`require\`). An empty map means the phrases have not been generated on
 * this checkout (needs ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID); the
 * SpeechService then falls back to expo-speech for every phrase and the
 * DebugPanel shows \`expo-speech\` as the backend. Run \`npm run gen:audio\`.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
export const AUDIO_MANIFEST: Readonly<Record<string, number>> = Object.freeze({
${lines.join('\n')}
});

export const AUDIO_MANIFEST_META = Object.freeze({
  generatedAt: ${meta.generatedAt === null ? 'null as string | null' : JSON.stringify(meta.generatedAt)},
  voiceId: ${meta.voiceId === null ? 'null as string | null' : JSON.stringify(meta.voiceId)},
  model: ${JSON.stringify(MODEL_ID)},
  count: ${sorted.length},
});
`;
}

// ---------------------------------------------------------------------------
// ElevenLabs call
// ---------------------------------------------------------------------------

export interface TtsClient {
  synthesize(text: string): Promise<Uint8Array>;
}

export function createElevenLabsClient(opts: { apiKey: string; voiceId: string; baseUrl: string; fetchImpl?: typeof fetch }): TtsClient {
  const f = opts.fetchImpl ?? fetch;
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/v1/text-to-speech/${encodeURIComponent(opts.voiceId)}?output_format=${OUTPUT_FORMAT}`;
  return {
    async synthesize(text) {
      let lastErr: unknown = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const res = await f(url, {
            method: 'POST',
            headers: { 'xi-api-key': opts.apiKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
            body: JSON.stringify({ text, model_id: MODEL_ID, voice_settings: VOICE_SETTINGS }),
          });
          if (res.status === 429 || res.status >= 500) {
            lastErr = new Error(`HTTP ${res.status}`);
            await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
            continue;
          }
          if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
          const buf = new Uint8Array(await res.arrayBuffer());
          if (buf.byteLength === 0) throw new Error('empty audio body');
          return buf;
        } catch (e) {
          lastErr = e;
          if (attempt === 2) break;
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function readSidecar(): ManifestSidecar | null {
  try {
    if (!existsSync(MANIFEST_JSON)) return null;
    return JSON.parse(readFileSync(MANIFEST_JSON, 'utf8')) as ManifestSidecar;
  } catch {
    return null;
  }
}

function argValue(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const dryRun = args.includes('--dry-run');
  const concurrency = Number(argValue(args, '--concurrency') ?? DEFAULT_CONCURRENCY) || DEFAULT_CONCURRENCY;
  const onlyArg = argValue(args, '--only');
  const only = onlyArg ? new Set(onlyArg.split(',').map((s) => s.trim()).filter(Boolean)) : null;
  const baseUrl = argValue(args, '--base') ?? process.env.ELEVENLABS_BASE_URL ?? DEFAULT_BASE_URL;
  const apiKey = process.env.ELEVENLABS_API_KEY ?? '';
  const voiceId = process.env.ELEVENLABS_VOICE_ID ?? '';

  const errors = validateTable(PHRASE_LIST);
  if (errors.length > 0) {
    for (const e of errors) process.stderr.write(`phrase table: ${e}\n`);
    process.exit(1);
  }

  const sidecar = readSidecar();
  const { todo, keep } = planWork(PHRASE_LIST, sidecar, {
    force,
    only,
    fileExists: (file) => existsSync(resolve(OUT_DIR, file)),
  });

  process.stdout.write(`generate-audio: ${PHRASE_LIST.length} phrases, ${todo.length} to synthesize, ${keep.length} unchanged\n`);
  if (todo.length === 0) {
    process.stdout.write('nothing to do\n');
    return;
  }
  if (!apiKey || !voiceId) {
    process.stdout.write('ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID not set: skipping synthesis (the app will use expo-speech for these keys).\n');
    for (const p of todo) process.stdout.write(`  would generate ${p.key}: "${p.text}"\n`);
    return;
  }
  if (dryRun) {
    for (const p of todo) process.stdout.write(`  dry-run ${p.key}: "${p.text}"\n`);
    return;
  }
  if (sidecar && sidecar.voiceId && sidecar.voiceId !== voiceId && !force) {
    process.stderr.write(`voice changed (${sidecar.voiceId} → ${voiceId}); re-run with --force so both tiers share one voice (07 §2)\n`);
    process.exit(1);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const client = createElevenLabsClient({ apiKey, voiceId, baseUrl });
  const generatedAt = new Date().toISOString();
  const entries: Record<string, ManifestEntry> = { ...(force || (sidecar?.voiceId && sidecar.voiceId !== voiceId) ? {} : sidecar?.entries ?? {}) };
  const failures: string[] = [];

  await mapWithConcurrency(todo, concurrency, async (p) => {
    const file = `${p.key}.mp3`;
    try {
      const audio = await client.synthesize(p.text);
      const estimatedMs = estimateMp3DurationMs(audio.byteLength);
      const limit = LONG_PHRASE_ALLOWLIST.has(p.key) ? LONG_PHRASE_MAX_AUDIO_MS : null;
      if (limit !== null && estimatedMs > limit) {
        failures.push(`${p.key}: ~${estimatedMs} ms exceeds the ${limit} ms allow-list cap`);
        return;
      }
      if (limit === null && estimatedMs > UTTERANCE_WARN_MS) {
        process.stderr.write(`warn ${p.key}: ~${estimatedMs} ms (> ${UTTERANCE_WARN_MS} ms budget; shorten the text)\n`);
      }
      writeFileSync(resolve(OUT_DIR, file), audio);
      entries[p.key] = { key: p.key, file, textSha1: sha1(p.text), bytes: audio.byteLength, estimatedMs, generatedAt };
      process.stdout.write(`  ok ${p.key} (${audio.byteLength} B, ~${estimatedMs} ms)\n`);
    } catch (e) {
      failures.push(`${p.key}: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  // Drop entries whose key left the table.
  const live = new Set<string>(PHRASE_LIST.map((p) => p.key));
  for (const k of Object.keys(entries)) if (!live.has(k)) delete entries[k];
  // Only keep entries whose file is actually on disk.
  const present = Object.values(entries).filter((e) => {
    try {
      return statSync(resolve(OUT_DIR, e.file)).size > 0;
    } catch {
      return false;
    }
  });

  const next: ManifestSidecar = { model: MODEL_ID, voiceId, outputFormat: OUTPUT_FORMAT, entries: Object.fromEntries(present.map((e) => [e.key, e])) };
  writeFileSync(MANIFEST_JSON, `${JSON.stringify(next, null, 2)}\n`);
  writeFileSync(MANIFEST_TS, renderManifestTs(present, { voiceId, generatedAt }));
  process.stdout.write(`manifest: ${present.length} keys → ${MANIFEST_TS}\n`);

  if (failures.length > 0) {
    for (const f of failures) process.stderr.write(`failed ${f}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.exit(1);
  });
}
