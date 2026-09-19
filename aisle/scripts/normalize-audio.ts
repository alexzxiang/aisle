/** Short clips can hit the peak ceiling well below -16 LUFS. Compress peaks first.
 * Record the output hash so repeated gen:audio runs do not recompress old clips. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ManifestSidecar, ManifestEntry } from './generate-audio';

const version = 'speech-compressed-lufs-v2';
const root = resolve(__dirname, '../assets/audio');
const manifestPath = resolve(root, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ManifestSidecar;
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
let changed = 0;
for (const raw of Object.values(manifest.entries)) {
  const entry = raw as ManifestEntry & { normalizationVersion?: string; normalizedSha256?: string };
  if (process.argv.includes('--prepared') && !/^(guide|mission)_/.test(entry.key)) continue;
  const path = resolve(root, entry.file);
  if (entry.normalizationVersion === version && entry.normalizedSha256 === sha(readFileSync(path))) continue;
  const tmp = resolve(root, `${entry.key}.norm.mp3`);
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', path,
    '-af', 'acompressor=threshold=0.03:ratio=4:attack=1:release=80:makeup=2,loudnorm=I=-16:TP=-1.5:LRA=11',
    '-ar', '44100', '-ac', '1', '-codec:a', 'libmp3lame', '-b:a', '64k', tmp], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Audio normalization failed for ${entry.key}: ${result.error?.message ?? result.stderr}`);
  renameSync(tmp, path);
  const bytes = readFileSync(path);
  entry.bytes = bytes.length;
  entry.estimatedMs = Math.round(bytes.length / 8);
  entry.normalizationVersion = version;
  entry.normalizedSha256 = sha(bytes);
  changed++;
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`Normalized ${changed} clips; unchanged clips skipped by hash.\n`);
