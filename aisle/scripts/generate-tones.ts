/**
 * Generates the three non-speech clips the audio channel manager needs, as
 * 44.1 kHz 16-bit stereo WAV, with no external tools or keys:
 *
 *   assets/audio/beacon_L.wav   150 ms pulse, hard left  (direction beacon)
 *   assets/audio/beacon_R.wav   150 ms pulse, hard right (direction beacon)
 *   assets/audio/tick.wav        40 ms click, centred     (signal ticker + centre tick)
 *   assets/audio/listen.wav     two rising notes         (round 9: the microphone is live)
 *   assets/audio/sent.wav       two falling notes        (round 9: released, heard, being understood)
 *
 * The beacon is two clips because expo-audio has no pan property (02 Task 5):
 * the manager plays both and sets their volumes by the constant-power law.
 * Run: `npx tsx scripts/generate-tones.ts`. Deterministic; commit the output.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SAMPLE_RATE = 44_100;
const OUT_DIR = resolve(__dirname, '..', 'assets', 'audio');

interface ToneSpec {
  file: string;
  durationMs: number;
  freqHz: number;
  /** Second partial for a rounder beacon; 0 for a pure click. */
  partialHz: number;
  fadeMs: number;
  left: number;
  right: number;
  gain: number;
  /** A second note after the first (an earcon): frequency and its own length. */
  then?: { freqHz: number; durationMs: number };
}

const SPECS: ToneSpec[] = [
  { file: 'beacon_L.wav', durationMs: 150, freqHz: 880, partialHz: 1320, fadeMs: 12, left: 1, right: 0, gain: 0.8 },
  { file: 'beacon_R.wav', durationMs: 150, freqHz: 880, partialHz: 1320, fadeMs: 12, left: 0, right: 1, gain: 0.8 },
  { file: 'tick.wav', durationMs: 40, freqHz: 1760, partialHz: 0, fadeMs: 4, left: 1, right: 1, gain: 0.7 },
  // Siri-like: a fifth up says "listening", the same fifth down says "sent". Short, so the
  // listening one is over before the person starts speaking.
  { file: 'listen.wav', durationMs: 90, freqHz: 659, partialHz: 1318, fadeMs: 8, left: 1, right: 1, gain: 0.55, then: { freqHz: 988, durationMs: 120 } },
  { file: 'sent.wav', durationMs: 90, freqHz: 988, partialHz: 1976, fadeMs: 8, left: 1, right: 1, gain: 0.5, then: { freqHz: 659, durationMs: 120 } },
];

function renderNote(freqHz: number, partialHz: number, durationMs: number, fadeMs: number, gain: number, left: number, right: number): Int16Array {
  const frames = Math.round((durationMs / 1000) * SAMPLE_RATE);
  const fadeFrames = Math.round((fadeMs / 1000) * SAMPLE_RATE);
  const pcm = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    const t = i / SAMPLE_RATE;
    let env = 1;
    if (i < fadeFrames) env = i / fadeFrames;
    else if (i > frames - fadeFrames) env = (frames - i) / fadeFrames;
    let s = Math.sin(2 * Math.PI * freqHz * t);
    if (partialHz > 0) s = 0.75 * s + 0.25 * Math.sin(2 * Math.PI * partialHz * t);
    const v = s * env * gain;
    pcm[i * 2] = Math.round(v * left * 32767);
    pcm[i * 2 + 1] = Math.round(v * right * 32767);
  }
  return pcm;
}

function renderStereo(spec: ToneSpec): Int16Array {
  if (spec.then) {
    const first = renderNote(spec.freqHz, spec.partialHz, spec.durationMs, spec.fadeMs, spec.gain, spec.left, spec.right);
    const second = renderNote(spec.then.freqHz, spec.partialHz > 0 ? spec.then.freqHz * 2 : 0, spec.then.durationMs, spec.fadeMs, spec.gain, spec.left, spec.right);
    const out = new Int16Array(first.length + second.length);
    out.set(first, 0);
    out.set(second, first.length);
    return out;
  }
  const frames = Math.round((spec.durationMs / 1000) * SAMPLE_RATE);
  const fadeFrames = Math.round((spec.fadeMs / 1000) * SAMPLE_RATE);
  const pcm = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    const t = i / SAMPLE_RATE;
    let env = 1;
    if (i < fadeFrames) env = i / fadeFrames;
    else if (i > frames - fadeFrames) env = (frames - i) / fadeFrames;
    let s = Math.sin(2 * Math.PI * spec.freqHz * t);
    if (spec.partialHz > 0) s = 0.75 * s + 0.25 * Math.sin(2 * Math.PI * spec.partialHz * t);
    const v = s * env * spec.gain;
    pcm[i * 2] = Math.round(v * spec.left * 32767);
    pcm[i * 2 + 1] = Math.round(v * spec.right * 32767);
  }
  return pcm;
}

function wavBytes(pcm: Int16Array): Buffer {
  const channels = 2;
  const bytesPerSample = 2;
  const dataBytes = pcm.length * bytesPerSample;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);                 // PCM chunk size
  buf.writeUInt16LE(1, 20);                  // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * channels * bytesPerSample, 28);
  buf.writeUInt16LE(channels * bytesPerSample, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < pcm.length; i += 1) buf.writeInt16LE(pcm[i], 44 + i * 2);
  return buf;
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const spec of SPECS) {
    const bytes = wavBytes(renderStereo(spec));
    const path = resolve(OUT_DIR, spec.file);
    writeFileSync(path, bytes);
    process.stdout.write(`wrote ${path} (${bytes.length} bytes)\n`);
  }
}

main();
