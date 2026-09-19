/** Read-only replay. Optional measurements: { "frame-id": { distanceM, hfovDeg?, widthM?, heightM? } }. */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { distanceFromBox, REACH_DISTANCE_M } from '../src/core/distance';
import type { Detection } from '../src/core/contracts';

const directory = process.argv[2] ?? 'server/data/cache/frames';
const labels: Record<string, { distanceM: number; hfovDeg?: number; widthM?: number; heightM?: number }> =
  process.argv[3] ? JSON.parse(readFileSync(process.argv[3], 'utf8')) : {};
const files = readdirSync(directory).filter((file) => file.endsWith('.json')).sort();
const samples: Array<{ id: string; estimateM: number; oldReach: boolean; reach: boolean; actualM?: number }> = [];
for (const file of files) {
  const frame = JSON.parse(readFileSync(join(directory, file), 'utf8'));
  const fridge = (frame.facts?.detections as Detection[] | undefined)?.filter((d) => d.cls === 'fridge' && d.score >= 0.6)
    .sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3])[0];
  if (!fridge) continue;
  const label = labels[frame.id];
  const distance = distanceFromBox(fridge.box, label?.heightM ?? 1.7, label?.hfovDeg ?? 56, label?.widthM ?? 0.7);
  if (distance === null) continue;
  let oldDistance = 1.7 / (1.4 * Math.max(0.02, fridge.box[3]));
  if ((fridge.near ?? 0) >= 0.75 && fridge.box[3] >= 0.75) oldDistance = Math.min(oldDistance, 1);
  else if ((fridge.near ?? 0) >= 0.5) oldDistance = Math.min(oldDistance, 2.5);
  const centered = Math.abs(fridge.box[0] + fridge.box[2] / 2 - 0.5) <= 0.18;
  if (label && (!Number.isFinite(label.distanceM) || label.distanceM <= 0)) throw new Error(`Invalid measurement: ${frame.id}`);
  samples.push({ id: frame.id, estimateM: distance, oldReach: centered && Math.round(oldDistance / 0.7) <= 1,
    reach: centered && distance <= REACH_DISTANCE_M, ...(label ? { actualM: label.distanceM } : {}) });
}
const measured = samples.filter((s) => s.actualM !== undefined);
console.log(JSON.stringify({
  frames: files.length, fridgeFrames: samples.length,
  oldReachCandidates: samples.filter((s) => s.oldReach).length,
  newReachCandidates: samples.filter((s) => s.reach).length,
  measuredFrames: measured.length,
  meanAbsoluteErrorM: measured.length ? measured.reduce((sum, s) => sum + Math.abs(s.estimateM - s.actualM!), 0) / measured.length : null,
  prematureReach: measured.length ? measured.filter((s) => s.reach && s.actualM! > REACH_DISTANCE_M).length : null,
  note: 'Candidate counts are not accuracy. Unlabelled frames cannot establish metric calibration. Defaults assume a seventy-centimetre-wide fridge and a portrait wide lens.',
}, null, 2));
