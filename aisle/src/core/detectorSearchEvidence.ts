import type { Detection, Pose } from './contracts';
import { classForWords } from './sceneMemory';
import { CLASS_HEIGHT_M } from './guide';
import { distanceFromBox } from './distance';

export interface DetectorFrame { at: number; detections: readonly Detection[] }
// These exposed targets have detector classes. Packaging and generic food classes
// cannot support even provisional negative evidence.
const EXPOSED_TARGETS = new Set(['banana', 'apple', 'orange', 'tomato', 'potato']);
const SURFACES = new Set(['shelf', 'table', 'countertop', 'bowl']);

/** A local retry-priority signal, never an absence claim. Duplicate/stale frames
 * and changing views cannot accumulate evidence. Range is an explicit size estimate. */
export function createDetectorSearchEvidence(item: string) {
  const target = classForWords(item);
  let previousAt = -Infinity;
  let sample: { at: number; frames: number; surface: number; pose: Pose } | null = null;
  return {
    update(frame: DetectorFrame | null, pose: Pose | null, now: number, hfov = 56): boolean {
      if (!target || !EXPOSED_TARGETS.has(target) || !frame || !pose || pose.trackingState !== 'NORMAL'
        || now - frame.at > 750 || now < frame.at || now - pose.timestamp > 500) { sample = null; return false; }
      if (frame.at <= previousAt) return false;
      const gap = frame.at - previousAt;
      previousAt = frame.at;
      if (frame.detections.some(d => d.cls === target && d.score >= 0.35)) { sample = null; return false; }
      const surface = frame.detections.find(d => {
        if (!SURFACES.has(d.cls) || d.score < 0.8 || d.box[2] < 0.3 || d.box[3] < 0.2) return false;
        const cx = d.box[0] + d.box[2] / 2;
        const distance = distanceFromBox(d.box, CLASS_HEIGHT_M[d.cls] ?? 1.2, hfov);
        return cx >= 0.3 && cx <= 0.7 && distance !== null && distance <= 2;
      });
      if (!surface) { sample = null; return false; }
      if (!sample || gap > 750 || sample.surface !== surface.trackId || sample.pose.worldSessionId !== pose.worldSessionId
        || Math.hypot(sample.pose.x - pose.x, sample.pose.z - pose.z) > 0.5
        || Math.abs(((sample.pose.yawDeg - pose.yawDeg + 540) % 360) - 180) > 20) {
        sample = { at: frame.at, frames: 1, surface: surface.trackId, pose: { ...pose } };
        return false;
      }
      sample.frames++;
      return sample.frames >= 8 && frame.at - sample.at >= 3000;
    },
  };
}
