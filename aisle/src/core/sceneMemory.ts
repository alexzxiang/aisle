/**
 * SceneMemory — the app remembers where things were (round 6, Stream A step 3).
 *
 * Tier 0 detections arrive with a normalized box in the upright frame and ARKit
 * gives the camera yaw ten times a second. Stamping each detection with the
 * bearing it was seen at (yaw + the box's horizontal offset scaled by the lens's
 * field of view) turns the last minute of frames into a compass of the room:
 * "Where's the fridge?" → "The fridge is to your left." with no camera call,
 * even though the fridge left the frame twenty seconds ago.
 *
 * What it is not: a map. There is no distance beyond "close / a few steps /
 * far" from box size, and no position, only bearings from where the user
 * stands. Walking a few metres blurs it — entries expire after `ttlMs` and a
 * fresh sighting always wins.
 *
 * Consumers:
 *   - voice (`intercept`): "where is the couch" / "where's the door" answered here
 *     before the planner, so the words never become a store trip;
 *   - guidedTask: `describe()` rides along in the planner's facts and the step ask
 *     ("Seen: fridge to your left, sink behind you.");
 *   - the DebugPanel can print `entries()`.
 */
import type { Detection, DetectionClass, PerceptionService, SpeechService } from './contracts';
import type { ConversationLog } from './conversation';
import { PHRASES } from './phrases';

export const MEMORY_TTL_MS = 90_000;
/** Two sightings of a class within this bearing are the same thing. */
export const MEMORY_MERGE_DEG = 25;
/** Portrait horizontal field of view of the wide lens (≈ 56°); ~100° on the ultra-wide. */
export const DEFAULT_HFOV_DEG = 56;
export const MEMORY_MAX_ENTRIES = 24;

export interface MemoryEntry {
  cls: DetectionClass;
  /** Absolute bearing (0 = north) the thing was last seen at. */
  bearingDeg: number;
  /** Box area in the frame at the last sighting (0..1): a rough distance cue. */
  area: number;
  lastSeenAt: number;
  sightings: number;
}

export interface WhereAnswer {
  cls: DetectionClass;
  /** Signed offset from the user's current facing: + = to the right. */
  relativeDeg: number;
  ageMs: number;
  phrase: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (tested)
// ---------------------------------------------------------------------------

export function wrap180(deg: number): number {
  let d = ((deg + 180) % 360 + 360) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

/** Bearing of a box seen at camera yaw `yawDeg`: centre x 0..1 across the field of view. */
export function bearingFor(yawDeg: number, box: Detection['box'], hfovDeg: number = DEFAULT_HFOV_DEG): number {
  const cx = box[0] + box[2] / 2;
  return ((yawDeg + (cx - 0.5) * hfovDeg) % 360 + 360) % 360;
}

/** "a fridge", "the couch" words → a class. Null for things the detector cannot name. */
export function classForWords(words: string): DetectionClass | null {
  const w = words.toLowerCase();
  const table: ReadonlyArray<[RegExp, DetectionClass]> = [
    [/\b(fridge|refrigerator|freezer)\b/, 'fridge'], [/\b(couch|sofa|settee)\b/, 'couch'], [/\b(tv|television|telly|screen)\b/, 'tv'],
    [/\b(table|dining table|desk)\b/, 'table'], [/\b(chair|seat|stool)\b/, 'chair'], [/\b(bed)\b/, 'bed'],
    [/\b(sink|faucet|tap)\b/, 'sink'], [/\b(oven|stove|cooker|range)\b/, 'oven'], [/\b(microwave)\b/, 'microwave'],
    [/\b(toilet|loo)\b/, 'toilet'], [/\b(laptop|computer)\b/, 'laptop'], [/\b(bottle|water)\b/, 'bottle'],
    [/\b(cup|mug|glass)\b/, 'cup'], [/\b(bowl)\b/, 'bowl'], [/\b(plant|flowers?)\b/, 'plant'], [/\b(book)\b/, 'book'],
    [/\b(clock)\b/, 'clock'], [/\b(dog|puppy)\b/, 'dog'], [/\b(cat|kitten)\b/, 'cat'], [/\b(backpack|bag|rucksack)\b/, 'backpack'],
    [/\b(handbag|purse)\b/, 'handbag'], [/\b(suitcase|luggage)\b/, 'suitcase'], [/\b(umbrella)\b/, 'umbrella'],
    [/\b(traffic light|light|signal)\b/, 'traffic_light'], [/\b(stop sign)\b/, 'stop_sign'], [/\b(hydrant)\b/, 'hydrant'],
    [/\b(bench)\b/, 'bench'], [/\b(person|someone|people|man|woman)\b/, 'person'], [/\b(car)\b/, 'car'], [/\b(bus)\b/, 'bus'],
    [/\b(bike|bicycle)\b/, 'bicycle'], [/\b(cart|trolley)\b/, 'cart'],
  ];
  for (const [re, cls] of table) if (re.test(w)) return cls;
  return null;
}

const SPOKEN: Readonly<Partial<Record<DetectionClass, string>>> = {
  tv: 'TV', traffic_light: 'traffic light', stop_sign: 'stop sign', table: 'table', plant: 'plant',
};
export function spokenName(cls: DetectionClass): string {
  return SPOKEN[cls] ?? cls.replace(/_/g, ' ');
}

/** "ahead", "ahead to your left", "to your right", "behind you to the left", "behind you". */
export function directionPhrase(relativeDeg: number): string {
  const a = Math.abs(relativeDeg);
  const side = relativeDeg < 0 ? 'left' : 'right';
  if (a <= 15) return 'ahead';
  if (a <= 60) return `ahead to your ${side}`;
  if (a <= 120) return `to your ${side}`;
  if (a <= 165) return `behind you to the ${side}`;
  return 'behind you';
}

export function distancePhrase(area: number): string {
  if (area >= 0.2) return 'close';
  if (area >= 0.04) return 'a few steps away';
  return 'far';
}

/** The sentence for an answer; ≤ 12 words, no digits. */
export function whereSentence(cls: DetectionClass, relativeDeg: number, area: number): string {
  const name = spokenName(cls);
  const dir = directionPhrase(relativeDeg);
  const dist = distancePhrase(area);
  if (dir === 'behind you') return `The ${name} is behind you. Turn around.`;
  return `The ${name} is ${dir}, ${dist}.`;
}

const WHERE_IS_RE = /^(?:where(?:'s| is| are)|find|do you see|can you see|is there)\s+(?:the |a |an |my |any )?(.{2,40}?)\??$/i;

/** "where's the fridge" → "fridge"; null when the sentence is not a where-question. */
export function whereQuery(transcript: string): string | null {
  const t = transcript.trim().replace(/[.!?]+$/, '');
  if (/\bwhere am i\b|\bwhere are we\b/i.test(t)) return null;
  const m = t.match(WHERE_IS_RE);
  return m ? m[1]!.trim() : null;
}

// ---------------------------------------------------------------------------
// The memory
// ---------------------------------------------------------------------------

export interface SceneMemoryDeps {
  perception: Pick<PerceptionService, 'onDetections' | 'onPose'>;
  speech?: Pick<SpeechService, 'say'>;
  conversation?: Pick<ConversationLog, 'pushAisle'>;
  /** Fallback facing when no ARKit pose has arrived yet (the compass). */
  headingDeg?: () => number | null;
  hfovDeg?: number;
  ttlMs?: number;
  now?: () => number;
}

export interface SceneMemory {
  /** Voice, before the planner: answers "where is the X" from memory. True when consumed. */
  intercept(transcript: string): boolean;
  whereIs(words: string): WhereAnswer | 'unseen' | 'unknown_thing';
  /** "fridge to your left, couch behind you" — the freshest few, for prompts. Empty string when nothing. */
  describe(): string;
  entries(): MemoryEntry[];
  /** Current facing in degrees, or null. */
  facing(): number | null;
  dispose(): void;
}

export function createSceneMemory(deps: SceneMemoryDeps): SceneMemory {
  const now = deps.now ?? Date.now;
  const ttl = deps.ttlMs ?? MEMORY_TTL_MS;
  const hfov = deps.hfovDeg ?? DEFAULT_HFOV_DEG;
  let yaw: number | null = null;
  let yawAt = 0;
  const items: MemoryEntry[] = [];
  const unsubs: Array<() => void> = [];

  const facing = (): number | null => {
    if (yaw !== null && now() - yawAt < 5000) return yaw;
    const h = deps.headingDeg?.();
    return typeof h === 'number' && Number.isFinite(h) ? h : yaw;
  };

  const prune = (t: number): void => {
    for (let i = items.length - 1; i >= 0; i -= 1) if (t - items[i]!.lastSeenAt > ttl) items.splice(i, 1);
    if (items.length > MEMORY_MAX_ENTRIES) {
      items.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
      items.length = MEMORY_MAX_ENTRIES;
    }
  };

  unsubs.push(deps.perception.onPose((p) => {
    if (Number.isFinite(p.yawDeg)) {
      yaw = ((p.yawDeg % 360) + 360) % 360;
      yawAt = now();
    }
  }));

  unsubs.push(deps.perception.onDetections((dets) => {
    const f = facing();
    if (f === null) return;
    const t = now();
    for (const d of dets) {
      if (d.cls === 'ped_walk' || d.cls === 'ped_hand' || d.cls === 'ped_countdown') continue;
      const bearing = bearingFor(f, d.box, hfov);
      const area = d.box[2] * d.box[3];
      const same = items.find((e) => e.cls === d.cls && Math.abs(wrap180(e.bearingDeg - bearing)) <= MEMORY_MERGE_DEG);
      if (same) {
        same.bearingDeg = bearing;
        same.area = area;
        same.lastSeenAt = t;
        same.sightings += 1;
      } else {
        items.push({ cls: d.cls, bearingDeg: bearing, area, lastSeenAt: t, sightings: 1 });
      }
    }
    prune(t);
  }));

  const whereIs = (words: string): WhereAnswer | 'unseen' | 'unknown_thing' => {
    const cls = classForWords(words);
    if (!cls) return 'unknown_thing';
    prune(now());
    const f = facing();
    const candidates = items.filter((e) => e.cls === cls).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    const e = candidates[0];
    if (!e || f === null) return 'unseen';
    const relativeDeg = wrap180(e.bearingDeg - f);
    return { cls, relativeDeg, ageMs: now() - e.lastSeenAt, phrase: whereSentence(cls, relativeDeg, e.area) };
  };

  const say = (text: string, cacheKey?: 'show_surroundings'): void => {
    deps.speech?.say({ text, priority: 'NAV', dedupeKey: 'memory-answer', cooldownMs: 1000, ...(cacheKey ? { cacheKey } : {}) });
    deps.conversation?.pushAisle(text, 'prompt');
  };

  return {
    intercept(transcript) {
      const q = whereQuery(transcript);
      if (!q) return false;
      const a = whereIs(q);
      if (a === 'unknown_thing') return false;          // let the planner / Claude have it
      if (a === 'unseen') {
        const cls = classForWords(q)!;
        say(`I have not seen a ${spokenName(cls)} yet.`);
        say(PHRASES.show_surroundings, 'show_surroundings');
        return true;
      }
      say(a.phrase);
      return true;
    },
    whereIs,
    describe() {
      prune(now());
      const f = facing();
      if (f === null || items.length === 0) return '';
      return items
        .slice()
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
        .slice(0, 4)
        .map((e) => `${spokenName(e.cls)} ${directionPhrase(wrap180(e.bearingDeg - f))}`)
        .join(', ');
    },
    entries: () => items.slice(),
    facing,
    dispose() {
      for (const u of unsubs.splice(0)) u();
      items.length = 0;
    },
  };
}
