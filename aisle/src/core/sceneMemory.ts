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
  /** A detector class, or an Apple scene-classifier identifier ("egg", "milk_carton") seen image-wide. */
  cls: DetectionClass | string;
  /** 'detector' boxes have a side within the frame; 'classifier' labels only know the frame's bearing. */
  source: 'detector' | 'classifier';
  /** Absolute bearing (0 = north) the thing was last seen at. */
  bearingDeg: number;
  /** Box area in the frame at the last sighting (0..1): a rough distance cue. */
  area: number;
  /** Depth-grid nearness at the last sighting (0 far … 1 near), when the phone sent it. */
  near?: number;
  lastSeenAt: number;
  sightings: number;
}

export interface WhereAnswer {
  cls: DetectionClass | string;
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
    [/\b(cheese|cheddar|mozzarella)\b/, 'cheese'], [/\bice cream\b/, 'ice_cream'], [/\bcream\b/, 'cream'],
    [/\bdairy(?: products?)?\b/, 'dairy'], [/\bseafood\b/, 'seafood'], [/\bpasta\b/, 'pasta'], [/\bjuice\b/, 'juice'],
    [/\bcucumbers?\b/, 'cucumber'], [/\b(?:bell )?peppers?\b/, 'pepper'], [/\bgrapes?\b/, 'grape'],
    [/\blemons?\b/, 'lemon'], [/\bpears?\b/, 'pear'], [/\bpeach(?:es)?\b/, 'peach'], [/\bfood containers?\b/, 'food_container'],
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
    [/\b(bananas?)\b/, 'banana'], [/\b(apples?)\b/, 'apple'], [/\b(sandwich)\b/, 'sandwich'], [/\b(oranges?)\b/, 'orange'],
    [/\b(broccoli)\b/, 'broccoli'], [/\b(carrots?)\b/, 'carrot'], [/\b(pizza)\b/, 'pizza'], [/\b(donuts?|doughnuts?)\b/, 'donut'],
    [/\b(cake)\b/, 'cake'], [/\b(wine glass|wine)\b/, 'wine_glass'], [/\b(fork)\b/, 'fork'], [/\b(knife|knives)\b/, 'knife'],
    [/\b(spoon)\b/, 'spoon'], [/\b(remote|remote control)\b/, 'remote'], [/\b(keyboard)\b/, 'keyboard'], [/\b(phone|cell phone|cellphone)\b/, 'cell_phone'],
    [/\b(toaster)\b/, 'toaster'], [/\b(vase)\b/, 'vase'], [/\b(scissors)\b/, 'scissors'], [/\b(teddy|teddy bear)\b/, 'teddy_bear'],
    [/\b(toothbrush)\b/, 'toothbrush'], [/\b(hair ?dr[iy]er)\b/, 'hair_drier'], [/\b(mouse)\b/, 'mouse'], [/\b(tie)\b/, 'tie'],
    // Round 9: the Open Images classes. Order matters where a word could mean two things ("door handle" before "door").
    [/\b(door ?handle|handle|door ?knob|knob)\b/, 'door_handle'], [/\b(doors?|doorway|door ?frame|entrance|exit)\b/, 'door'],
    [/\b(counter ?top|counter|worktop)\b/, 'countertop'], [/\b(cabinets?|cupboards?)\b/, 'cabinet'], [/\b(drawers?)\b/, 'drawer'],
    [/\b(light ?switch|switch)\b/, 'light_switch'], [/\b(stairs?|staircase|stairway|steps)\b/, 'stairs'], [/\b(shelf|shelves|shelving|bookcase|bookshelf)\b/, 'shelf'],
    [/\b(windows?)\b/, 'window'], [/\b(mirror)\b/, 'mirror'], [/\b(pillows?|cushions?)\b/, 'pillow'], [/\b(towels?)\b/, 'towel'],
    [/\b(trash ?can|trash|garbage|bin|waste ?basket|rubbish)\b/, 'trash_can'], [/\b(lamps?)\b/, 'lamp'], [/\b(plates?|dish)\b/, 'plate'],
    [/\b(mugs?|coffee cup)\b/, 'mug'], [/\b(kettle|teapot)\b/, 'kettle'], [/\b(cans?|tin)\b/, 'can'], [/\b(box|boxes|package|parcel)\b/, 'box'],
    [/\b(eggs?|egg carton)\b/, 'egg'], [/\b(milk|milk carton)\b/, 'milk'], [/\b(bread|loaf|bagels?|toast)\b/, 'bread'],
    [/\b(glasses|spectacles|sunglasses|shades)\b/, 'glasses'], [/\b(shoes?|sneakers?|boots?|footwear|slippers?)\b/, 'shoe'],
    [/\b(washing machine|washer|laundry machine)\b/, 'washing_machine'], [/\b(dishwasher)\b/, 'dishwasher'], [/\b(bathtub|bath|tub)\b/, 'bathtub'],
    [/\b(shower)\b/, 'shower'], [/\b(faucet|tap)\b/, 'faucet'], [/\b(desk)\b/, 'desk'], [/\b(stool)\b/, 'stool'],
    [/\b(nightstand|bedside table|night table)\b/, 'nightstand'], [/\b(wardrobe|closet|armoire)\b/, 'wardrobe'],
    [/\b(headphones|earphones|headset)\b/, 'headphones'], [/\b(watch|wristwatch)\b/, 'watch'], [/\b(wheelchair)\b/, 'wheelchair'],
    [/\b(street ?light|lamp ?post|streetlamp)\b/, 'street_light'], [/\b(traffic sign|road sign|street sign|sign)\b/, 'traffic_sign'],
    [/\b(parking meter)\b/, 'parking_meter'], [/\b(curtains?|blinds?|drapes?)\b/, 'curtain'], [/\b(monitor|computer screen)\b/, 'monitor'],
    [/\b(printer)\b/, 'printer'], [/\b(fireplace|hearth)\b/, 'fireplace'], [/\b(ladder)\b/, 'ladder'], [/\b(pan|frying pan|skillet|wok)\b/, 'pan'],
    [/\b(stove|stovetop|hob|burner)\b/, 'stove'], [/\b(cutting board|chopping board)\b/, 'cutting_board'], [/\b(soap|soap dispenser)\b/, 'soap'],
    [/\b(candles?)\b/, 'candle'], [/\b(trees?)\b/, 'tree'], [/\b(bags?|plastic bag|grocery bag|tote)\b/, 'bag'], [/\b(tomato(?:es)?)\b/, 'tomato'],
    [/\b(potato(?:es)?)\b/, 'potato'], [/\b(fruit)\b/, 'fruit'], [/\b(vegetables?|veggies)\b/, 'vegetable'], [/\b(snacks?|cookies?|candy|chips|crackers)\b/, 'snack'],
    [/\b(tablet|ipad)\b/, 'tablet'], [/\b(pens?|pencils?)\b/, 'pen'], [/\b(coins?|change)\b/, 'coin'],
  ];
  for (const [re, cls] of table) if (re.test(w)) return cls;
  return null;
}

const SPOKEN: Readonly<Partial<Record<DetectionClass, string>>> = {
  tv: 'TV', traffic_light: 'traffic light', stop_sign: 'stop sign', table: 'table', plant: 'plant',
  trash_can: 'trash can', light_switch: 'light switch', door_handle: 'door handle', washing_machine: 'washing machine',
  street_light: 'street light', traffic_sign: 'sign', parking_meter: 'parking meter', cutting_board: 'cutting board', can: 'tin can',
};
export function spokenName(cls: DetectionClass | string): string {
  return SPOKEN[cls as DetectionClass] ?? cls.replace(/_/g, ' ');
}

/** Apple classifier labels below this never enter memory (the taxonomy is huge; the tail is noise). */
export const CLASSIFIER_MIN_CONFIDENCE = 0.3;
/** Scene / material labels that say where you are, not what is there — never "things". */
const CLASSIFIER_NOT_A_THING = /^(indoor|outdoor|room|kitchen|living_room|bedroom|bathroom|hallway|corridor|office|street|sidewalk|building|city|urban|home|house|apartment|wall|floor|ceiling|carpet|wood|metal|glass|plastic|fabric|light|dark|day|night|sky|ground|interior|exterior|nature|landscape|text|document|screen|abstract|pattern|texture|color|black|white|blur)$/;

/** "eggs" → "egg": a naive singular, enough to match Apple's identifiers. */
export function singular(word: string): string {
  const w = word.toLowerCase().trim();
  if (w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.endsWith('ses') || w.endsWith('xes') || w.endsWith('ches') || w.endsWith('shes')) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/** Does an Apple identifier ("milk_carton", "egg") name what the user asked for ("eggs", "milk")? */
export function labelMatches(id: string, words: string): boolean {
  const parts = id.toLowerCase().split(/[_\s]+/);
  const asked = words.toLowerCase().replace(/^(the|a|an|my|some|any)\s+/, '').split(/\s+/).map(singular).filter((w) => w.length > 2);
  return asked.some((w) => parts.some((p) => singular(p) === w || p.startsWith(w) || w.startsWith(p)));
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

/** The sentence for an answer; ≤ 12 words, no digits. A classifier sighting has no distance. */
export function whereSentence(cls: DetectionClass | string, relativeDeg: number, area: number, near?: number, opts: { plural?: boolean; noDistance?: boolean } = {}): string {
  const name = spokenName(cls);
  const verb = opts.plural ? 'are' : 'is';
  const dir = directionPhrase(relativeDeg);
  if (dir === 'behind you') return `The ${name} ${verb} behind you. Turn around.`;
  // A remembered bearing, area and frame-relative depth cannot establish the
  // user's current distance after they have moved.
  return `The ${name} ${verb} ${dir}.`;
}

const WHERE_IS_RE = /^(?:where(?:'s| is| are)|do you see|can you see|is there)\s+(?:the |a |an |my |any )?(.{2,40}?)\??$/i;

/**
 * "where's the fridge" → "fridge"; null when the sentence is not a where-question.
 * "find the eggs in my fridge" is a task, not a question, and "where are the eggs in
 * my fridge" names a place — both are left to the planner.
 */
export function whereQuery(transcript: string): string | null {
  const t = transcript.trim().replace(/[.!?]+$/, '');
  if (/\bwhere am i\b|\bwhere are we\b/i.test(t)) return null;
  const m = t.match(WHERE_IS_RE);
  if (!m) return null;
  const q = m[1]!.trim();
  if (/\b(in|on|at|inside|near|next to|by)\s/i.test(q)) return null;
  return q;
}

// ---------------------------------------------------------------------------
// The memory
// ---------------------------------------------------------------------------

export interface SceneMemoryDeps {
  perception: Pick<PerceptionService, 'onDetections' | 'onPose'> & Partial<Pick<PerceptionService, 'onSceneClass'>>;
  speech?: Pick<SpeechService, 'say'>;
  conversation?: Pick<ConversationLog, 'pushAisle'>;
  /** Fallback facing when no ARKit pose has arrived yet (the compass). */
  headingDeg?: () => number | null;
  /** Horizontal field of view of the still frame; a function so the lens can be read after the engine starts. */
  hfovDeg?: number | (() => number);
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
  const hfov = (): number => (typeof deps.hfovDeg === 'function' ? deps.hfovDeg() : deps.hfovDeg ?? DEFAULT_HFOV_DEG);
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
      if (d.cls === 'ped_walk' || d.cls === 'ped_hand' || d.cls === 'ped_countdown' || d.cls === 'hand') continue; // signal heads and the user's own hand are not places
      const bearing = bearingFor(f, d.box, hfov());
      const area = d.box[2] * d.box[3];
      const same = items.find((e) => e.source === 'detector' && e.cls === d.cls && Math.abs(wrap180(e.bearingDeg - bearing)) <= MEMORY_MERGE_DEG);
      if (same) {
        same.bearingDeg = bearing;
        same.area = area;
        same.near = d.near;
        same.lastSeenAt = t;
        same.sightings += 1;
      } else {
        items.push({ cls: d.cls, source: 'detector', bearingDeg: bearing, area, lastSeenAt: t, sightings: 1, ...(typeof d.near === 'number' ? { near: d.near } : {}) });
      }
    }
    prune(t);
  }));

  // Apple's classifier names things the detector has no class for (egg, milk carton, cereal…),
  // image-wide: the bearing is the camera's, the distance unknown.
  if (deps.perception.onSceneClass) {
    unsubs.push(deps.perception.onSceneClass((e) => {
      const f = facing();
      if (f === null) return;
      const t = now();
      for (const l of e.labels.slice(0, 5)) {
        if (l.confidence < CLASSIFIER_MIN_CONFIDENCE) continue;
        const id = l.id.toLowerCase();
        if (CLASSIFIER_NOT_A_THING.test(id)) continue;
        // Preserve classifier evidence even when the detector vocabulary includes it.
        // Vocabulary coverage does not mean that this frame produced a detection.
        const same = items.find((x) => x.source === 'classifier' && x.cls === id && Math.abs(wrap180(x.bearingDeg - f)) <= MEMORY_MERGE_DEG);
        if (same) {
          same.bearingDeg = f;
          same.lastSeenAt = t;
          same.sightings += 1;
        } else {
          items.push({ cls: id, source: 'classifier', bearingDeg: f, area: 0, lastSeenAt: t, sightings: 1 });
        }
      }
      prune(t);
    }));
  }

  const whereIs = (words: string): WhereAnswer | 'unseen' | 'unknown_thing' => {
    prune(now());
    const f = facing();
    const cls = classForWords(words);
    const asked = words.toLowerCase().replace(/^(the|a|an|my|some|any)\s+/, '').trim();
    const plural = /s$/i.test(asked) && !/ss$/i.test(asked);
    if (cls) {
      const e = items.filter((x) => x.source === 'detector' && x.cls === cls).sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0];
      if (e && f !== null) {
        const relativeDeg = wrap180(e.bearingDeg - f);
        return { cls, relativeDeg, ageMs: now() - e.lastSeenAt, phrase: whereSentence(cls, relativeDeg, e.area, e.near) };
      }
    }
    // Not a detector class: something the classifier may have named ("eggs" → "egg").
    const seen = items.filter((x) => x.source === 'classifier' && (labelMatches(x.cls, asked) || (cls !== null && classForWords(x.cls.replace(/_/g, ' ')) === cls))).sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0];
    if (!seen) return asked.length >= 3 ? 'unseen' : 'unknown_thing';
    if (f === null) return 'unseen';
    const relativeDeg = wrap180(seen.bearingDeg - f);
    return { cls: seen.cls, relativeDeg, ageMs: now() - seen.lastSeenAt, phrase: whereSentence(asked, relativeDeg, 0, undefined, { plural, noDistance: true }) };
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
        const cls = classForWords(q);
        const asked = q.toLowerCase().replace(/^(the|a|an|my|some|any)\s+/, '').trim();
        const plural = !cls && /s$/i.test(asked) && !/ss$/i.test(asked);
        say(cls ? `I have not seen a ${spokenName(cls)} yet.` : `I have not seen ${plural ? '' : 'a '}${asked} yet.`);
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
