/**
 * SearchExplorer — what to do when the camera does not see the thing (round 9, Stream A).
 *
 * "Find the bananas on the table" with no bananas and no table in view used to leave the
 * app repeating "not seen yet". Now it *searches*, the way a sighted friend would:
 *
 *   1. look around from here      → "Turn the camera slowly left." / "…right." / "Turn around slowly."
 *   2. say what this place is     → "Milk and yogurt. This seems to be dairy."  (the sign, when readable)
 *   3. pick somewhere to look next → a landmark Claude can box: an aisle end, a doorway, another
 *                                    surface, a section display; the item's usual section first
 *   4. ask before walking          → "May I guide you toward the produce section?"
 *   5. walk there by geometry      → "Produce display at one o'clock. Turn right a little, then
 *                                    walk eight steps." … "Keep going. Three steps more."
 *   6. inspect the new place       → back to 1, with the old place remembered as searched
 *   7. no landmark anywhere        → "Walk forward five steps, then I will look again." (a few times)
 *
 * Memory: every place visited, its sign / section / foods seen and whether the item was
 * seen there, so a searched aisle is never proposed again and Claude is told what has been
 * checked. Claude supplies the observation (`search` on task_step); this module owns the
 * policy and the words. Consent gates every relocation; "stop" ends everything (voice.ts).
 */
import type { Guide, GuideInstruction, TargetBox } from './guide';
import type { TripRoute } from './tripMemory';
import type { Pose, TaskContext } from './contracts';
import { stepsWords } from './guide';
import { createExplorationMap, explorationSteps, type ExplorationMap, type Openness } from './explorationMap';
import { foodSection, sectionFromFoods, type FoodSection } from './foodCatalog';
import { aisleClueScore, groceryAisle, relatedGroceryItems } from './groceryAisles';
import { itemLine } from './itemMission';
import type { SearchLandmark, SearchObservation, SearchView } from './searchObservation';
import { isAffirmative, isNegative } from './yesNo';
import { createDetectorSearchEvidence, type DetectorFrame } from './detectorSearchEvidence';
import { countWords, findForbiddenTerm, fitWords, hasDigit } from './phrases';

export interface SearchArea {
  id: string;
  sign: string | null;
  landmark?: string;
  section: FoodSection;
  items: string[];
  views: SearchView[];
  /** Means inspected views lacked the item, never that an entire aisle is empty. */
  outcome: 'uninspected' | 'partly_searched' | 'not_seen_in_scanned_views' | 'item_seen';
  visits: number;
  /** The item's own section was recognised here and the shelves were searched closely (round 12). */
  closeSearched?: boolean;
}
export interface SearchDirective {
  text: string | null;
  target: string;
  phase: 'scan' | 'permission' | 'move' | 'advance' | 'paused';
  haptic?: 'TURN' | 'CONFIRM' | 'STOP' | null;
  /**
   * True only for a generic camera-choreography look-around ("point along the aisle") that the
   * model may replace with its own narration of where the item likely is and which way to explore.
   * Informative narration, close-shelf inspection, moves, permission and pauses keep this false —
   * geometry owns those words.
   */
  narratable?: boolean;
}
export interface SearchExplorer {
  verificationPending?(pending: boolean): void;
  analyzing?(pending: boolean): void;
  observe(observation: SearchObservation | undefined, seq: number, capturedAt: number): boolean;
  /** A model sentence owns this scan turn; do not immediately follow it with canned choreography. */
  narrated(): void;
  tick(target: string, direct: GuideInstruction | null, opts?: { surface?: boolean; confined?: boolean }): SearchDirective | null;
  intercept(text: string): { consumed: boolean; text: string | null };
  target(): string | null;
  context(): string;
  memory(): SearchArea[];
  /** Round 12: cells visited / scanned when a position is known; round 17: cells any view touched. */
  coverage(): { visited: number; scanned: number; viewed: number } | null;
  /** The search has given up (said so once); the navigator stops repeating itself too. */
  gaveUp(): boolean;
  pending(): boolean;
  status(): SearchDirective['phase'];
  /** The explorer is walking or waiting for consent (round 14): the navigator holds its guesses. */
  busy(): boolean;
  /**
   * A generic look-around in any environment with the target not yet nearby: the model owns the words this
   * turn (it can say where the item likely is and which way to explore). False the moment the
   * area looks promising, a close-shelf inspection starts, or the explorer moves/asks consent —
   * then the computer-vision geometry owns the words and zeroes the user in.
   */
  narrating(): boolean;
  /**
   * Round 14: the person asked to explore ("explore", "next aisle", "another room"): leave the
   * current spot now — the freshest landmark without asking, else a coverage leg — and say so.
   */
  exploreNow(prefer?: 'aisle' | 'room' | null, consent?: boolean): SearchDirective;
  repeat(): void;
  restart(): void;
  enterArea(landmark: string): void;
}
export interface SearchExplorerDeps {
  automaticExploration?: boolean;
  detectorFrame?: () => DetectorFrame | null;
  item: string;
  context: TaskContext;
  trace?: (event: string, data: Record<string, unknown>) => void;
  guide: Pick<Guide, 'instructionFor'>;
  heading?: () => number | null;
  steps?: () => number;
  /** Round 12: the phone's position and yaw (ARKit), for exploring a big space by coverage. */
  pose?: () => Pose | null;
  /** The depth grid's bottom row, fresh: nearness ahead / left / right. */
  path?: () => Openness | null;
  /** Round 16: a door the detector sees right now (Open Images `door`), as a doorway landmark. */
  doorway?: () => TargetBox | null;
  /** Round 17: the lens's horizontal field of view, for painting what the camera looked at. */
  hfovDeg?: () => number;
  /** Round 17: signs the phone's own OCR reads right now (full-resolution, far better than a still), with boxes. */
  signs?: () => ReadonlyArray<{ text: string; box: [number, number, number, number]; at: number }>;
  map?: ExplorationMap;
  now?: () => number;
}

/** An observation older than this steers nothing (a task_step round trip on Sonnet is 5–8 s). */
const FRESH_MS = 12_000;
/** Claude's confidence in the observation as a whole before it counts; the item's own box needs more (identity). */
const OBSERVATION_MIN_CONFIDENCE = 0.6;
const LANDMARK_MIN_CONFIDENCE = 0.6;
/** A scan pose is held this long before the next one is asked for. */
export const SCAN_MS = 4000;
/** Walking lines: a new line at least this far apart, the same line again after the repeat. */
export const MOVE_CHANGE_FLOOR_MS = 2000;
export const MOVE_REPEAT_MS = 4000;
/** The landmark out of view while walking: keep going this long on the last bearing before stopping to look. */
export const MOVE_LOST_GRACE_MS = 6500;
/** One relocation may take this long before another landmark is chosen. */
export const MOVE_GIVE_UP_MS = 45_000;
/** Remind once after silence; only an affirmative answer authorizes relocation. */
export const CONSENT_MS = 10_000;
/** A grocery shelf viewpoint that yields no new coverage this long is deferred, not cleared. */
export const SAME_VIEW_NO_PROGRESS_MS = 10_000;
/** After giving up, a reminder no more often than this. */
export const GIVE_UP_PULSE_MS = 45_000;
/**
 * An "opening" pause is different from the other give-ups: nothing can lift it except a view
 * the camera has not had yet, so repeating one sentence every forty-five seconds leaves a blind
 * person standing in an aisle in silence, which is exactly the reported stall. Sweep instead —
 * a different quarter of the room each pulse, spaced for the five-to-six-second inference — and
 * when the sweep finds nothing, hand back a choice rather than more silence.
 */
export const OPENING_SWEEP_MS = 9000;
export const OPENING_SWEEP: readonly string[] = [
  'Turn slowly to your left and hold the camera steady.',
  'Now turn slowly to your right and hold steady.',
  'Turn all the way around slowly and hold steady.',
];
export const OPENING_EXHAUSTED = 'I cannot find a way on here. Say explore to move.';
/** With nothing to head for and no position: walk this far, then look again — at most ADVANCE_MAX times. */
export const ADVANCE_STEPS = 5;
export const ADVANCE_MAX = 3;
export const ADVANCE_MS = 9000;
/** With a position (round 12): one leg of exploration is this long, then a look around. */
export const EXPLORE_LEG_M = 2.1;
export const EXPLORE_LEG_STEPS = 3;
export const EXPLORE_LEG_MS = 15_000;
/** Heading error beyond this earns a nudge while walking a leg. */
export const EXPLORE_DRIFT_DEG = 30;
/** Total exploration budget before the app admits the area is covered. */
export const EXPLORE_BUDGET_MS = 5 * 60_000;
const SCANS = [
  'Turn the camera slowly left.',
  'Now turn the camera slowly right.',
  'Turn around slowly so I can see behind you.',
];
const SHELVES = [
  'Pan slowly across the upper shelf.',
  'Now pan across the middle shelf.',
  'Tilt down and scan the lower shelf.',
];
const SURFACES = [
  'Hold steady and show the surface in front of you.',
  'Point toward the edge of the furniture. Hold steady.',
  'Tilt down to show the visible floor around the furniture.',
];
/** In a store the look-around is along the aisle: both shelf faces, then the aisle itself. */
const AISLE_SCANS = [
  'Point along the aisle. Hold steady for signs and openings.',
  'Turn the camera left. Hold steady for a quick look.',
  'Turn the camera right. Hold steady for a quick look.',
];
/** At an aisle end, in the corridor: the signs above the aisles are the map. */
const CORRIDOR_SCANS = [
  'Turn slowly left and look up for the aisle signs.',
  'Now turn slowly right and look up for the aisle signs.',
  'Look straight along the corridor for section displays.',
];
const cap = (s: string): string => (s.length ? s[0]!.toUpperCase() + s.slice(1) : s);
/** Intersection over union of two [x, y, w, h] boxes. */
export function overlap(a: [number, number, number, number], b: [number, number, number, number]): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union > 0 ? inter / union : 0;
}
const clean = (s: string): string => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const speakable = (s: string): boolean => !hasDigit(s) && !findForbiddenTerm(s) && countWords(s) <= 12;
/** A line that ran long (a three-word landmark name) keeps its instruction instead of being dropped. */
const fit = (s: string): string => (countWords(s) <= 12 ? s : fitWords(s));

/** A bounded search, with consent and measured progress before changing the search area. */
export function createSearchExplorer(deps: SearchExplorerDeps): SearchExplorer {
  const detectorEvidence = createDetectorSearchEvidence(deps.item);
  let detectorChecked = false;
  let verificationUntil = -Infinity;
  const now = deps.now ?? Date.now;
  const areas: SearchArea[] = [];
  let areaCount = 0;
  let area: SearchArea = freshArea();
  let phase: SearchDirective['phase'] = 'scan';
  let scan = 0;
  let scanAt = -Infinity;
  let lastSeq = -1;
  let observedAt = -Infinity;
  let analyzing = false;
  let cameraWaitAt = -Infinity;
  let modelNarratedAt = -Infinity;
  let strategy: SearchObservation['strategy'];
  let explained = '';
  let quality: SearchObservation['quality'] = 'occluded';
  let unusableStreak = 0;
  let landmarks: Array<SearchLandmark & { at: number; hits: number }> = [];
  let proposal: SearchLandmark | null = null;
  let targetWords = deps.item;
  let saidAt = -Infinity;
  let pendingNarration: string | null = null;
  let followUp: string | null = null;
  let narratedSection = 'unknown';
  let signCandidate = '';
  let signHits = 0;
  let movementSteps = 0;
  let moveAt = 0;
  let arrivalAt = -Infinity;
  let arrivalHits = 0;
  let moveKey: string | null = null;
  let moveSaidAt = -Infinity;
  let lastMoveSteps: number | null = null;
  let landmarkSeenAt = -Infinity;
  let advances = 0;
  let advanceAt = -Infinity;
  let advanceSteps0 = 0;
  /** Round 12: the leg being walked when a position is known. */
  const map = deps.map ?? (deps.pose ? createExplorationMap(now) : null);
  let leg: { yawDeg: number; from: { x: number; z: number }; steps0: number; at: number; aligned: boolean; alignedAt: number | null } | null = null;
  let lastPoseVisitAt = -Infinity;
  /** Searching the item's own section shelf by shelf (round 12). */
  let closeMode = false;
  let viewEvidence = new Set<string>();
  let refused = new Set<string>();
  let exitIntent: 'room' | 'aisle' | null = null;
  let exitScan = 0;
  let exitScanAt = -Infinity;
  let lastConfined = false;
  let startedAt = now();
  let mapGeneration = map?.trip.generation() ?? 0;
  let memoryRoute: TripRoute | null = null;
  let pendingLeg: Pose | null = null;
  let trackingStopped = false;
  let localScanAt = now();
  let localOrigin: Pose | null = null;
  let coverageProgressAt = now();
  let missingBands = 3;
  let motionAt = 0;
  let motionPose: Pose | null = null;
  let crossing = false;
  const stalled = (pose: Pose | null): boolean => {
    if (!pose) return false;
    if (!motionPose || motionAt < moveAt || Math.hypot(pose.x - motionPose.x, pose.z - motionPose.z) >= 0.35) {
      motionPose = pose; motionAt = now();
    }
    return now() - motionAt > 18000;
  };
  let permissionAt = -Infinity;
  let gaveUpAt = -Infinity;
  let lastPulseAt = -Infinity;
  let pauseRecovery: 'camera' | 'opening' | null = null;
  let pauseText = 'Search paused. Say resume, or stop.';
  /** How far through OPENING_SWEEP this pause has got; reset whenever the search moves on. */
  let openingSweep = 0;
  /** A tick after a long silence (the navigator spoke instead) must not resume a stale leg. */
  let lastTickAt = -Infinity;
  const STALE_TICK_MS = 8000;

  function freshArea(): SearchArea {
    const next: SearchArea = { id: `view-area-${++areaCount}`, sign: null, section: 'unknown', items: [], views: [], outcome: 'uninspected', visits: 1 };
    areas.push(next);
    if (areas.length > 24) areas.shift();
    return next;
  }
  const emit = (raw: string, target = targetWords, narratable = false): SearchDirective => {
    const text = fit(raw);
    const interval = phase === 'paused' ? 20000 : phase === 'permission' ? 15000 : 5000;
    const ready = now() - saidAt >= interval || saidAt === -Infinity;
    if (ready && speakable(text)) {
      saidAt = now();
      deps.trace?.('search_decision', { phase, target, text, area: area.id, context: deps.context });
      return { text, target, phase, narratable };
    }
    return { text: null, target, phase, narratable };
  };
  const resetScan = (): void => { scan = 0; scanAt = -Infinity; phase = 'scan'; pauseRecovery = null; proposal = null; memoryRoute = null; pendingLeg = null; arrivalHits = 0; saidAt = -Infinity; moveKey = null; lastMoveSteps = null; leg = null; crossing = false; };
  const resumeScan = (renewBudget: boolean): void => {
    resetScan();
    if (renewBudget) startedAt = now();
    localScanAt = now(); coverageProgressAt = now(); missingBands = 3;
    gaveUpAt = -Infinity; unusableStreak = 0; advances = 0; openingSweep = 0;
  };
  const pause = (text: string, recovery: typeof pauseRecovery): SearchDirective => {
    phase = 'paused'; pauseRecovery = recovery; pauseText = text; openingSweep = 0;
    gaveUpAt = now(); lastPulseAt = now(); saidAt = -Infinity;
    return emit(text);
  };
  /** A walking line, paced like the navigator's: news after two seconds, the same line again after four. */
  const move = (raw: string, key: string, target: string, haptic: SearchDirective['haptic'] = null): SearchDirective => {
    const t = now();
    const text = fit(raw);
    const news = key !== moveKey;
    if (t - moveSaidAt < (news ? MOVE_CHANGE_FLOOR_MS : MOVE_REPEAT_MS) && !(news && haptic === 'STOP')) return { text: null, target, phase, haptic: null };
    if (!speakable(text)) return { text: null, target, phase, haptic: null };
    deps.trace?.('search_movement', { phase, key, target, path: deps.path?.() ?? null, pose: deps.pose?.() ?? null });
    moveKey = key;
    moveSaidAt = t;
    saidAt = t;
    return { text, target, phase, haptic };
  };
  /** Begin a coverage leg from here toward unvisited ground; null when everything around is visited or blocked. */
  const startLeg = (pose: Pose, preferTurn = false): SearchDirective | null => {
    if (!map) return null;
    const choice = now() - startedAt <= EXPLORE_BUDGET_MS ? map.bestHeading(pose, pose.yawDeg, deps.path?.() ?? null) : null;
    if (!choice) return null;
    leg = { yawDeg: choice.yawDeg, from: { x: pose.x, z: pose.z }, steps0: deps.steps?.() ?? 0, at: now(), aligned: false, alignedAt: null };
    phase = 'advance'; moveKey = null; moveSaidAt = -Infinity; proposal = null;
    const turn = choice.turn === 'ahead' ? '' : choice.turn === 'around' ? 'Turn around, then ' : choice.turn === 'left' ? 'Turn left, then ' : choice.turn === 'right' ? 'Turn right, then ' : choice.turn === 'half_left' ? 'Turn half left, then ' : 'Turn half right, then ';
    const line = turn ? `${turn}hold still. Let me check that direction.` : 'Hold still. Let me check the path ahead.';
    void preferTurn;
    return move(line, `leg:${choice.turn}`, targetWords, choice.turn === 'ahead' ? null : 'TURN');
  };
  const arrive = (): SearchDirective => {
    if (proposal) recentlyReached.set(clean(proposal.name), now());
    if (proposal) map?.trip.arrive(proposal.name, proposal.kind === 'doorway' || proposal.kind === 'aisle_end' ? proposal.kind : 'area');
    const portal = proposal && (proposal.kind === 'doorway' || proposal.kind === 'aisle_end') ? proposal : null;
    const at = deps.pose?.();
    if (portal && at && ['open_passage', 'cross_aisle'].includes(portal.boundary ?? '')) {
      leg = { yawDeg: (at.yawDeg + (portal.box[0] + portal.box[2] / 2 - 0.5) * (deps.hfovDeg?.() ?? 56) + 360) % 360, from: { x: at.x, z: at.z }, steps0: deps.steps?.() ?? 0, at: now(), aligned: false, alignedAt: null };
      crossing = true; phase = 'advance'; moveKey = null; moveSaidAt = -Infinity;
      return { text: 'At the opening. Hold still while I check beyond it.', target: portal.name, phase, haptic: 'CONFIRM' };
    }
    localScanAt = now(); coverageProgressAt = now(); missingBands = 3; localOrigin = at ?? null;
    area = freshArea(); area.landmark = proposal?.name;
    viewEvidence = new Set(); signHits = 0; signCandidate = ''; narratedSection = 'unknown';
    resetScan();
    saidAt = now();
    return { text: 'Here. Let me look around this spot.', target: targetWords, phase, haptic: 'CONFIRM' };
  };
  const section = foodSection(deps.item);
  const recentlyReached = new Map<string, number>();
  const candidateKey = (l: SearchLandmark): string => `${area.id}:${clean(l.name)}`;
  // Containers are not grocery destinations. Apply this to every selection path,
  // including explicit "explore" requests, so a fallback cannot reintroduce them.
  const groceryDestination = (l: SearchLandmark): boolean => deps.context === 'store'
    ? !/\b(bowls?|countertops?|desks?|tables?)\b/i.test(l.name)
      || /\b(?:display|merchandise|produce|bakery) tables?\b/i.test(l.name)
    : deps.context === 'classroom' ? !/\b(fridge|freezer|produce|pantry|bedroom)\b/i.test(l.name) : true;
  const promisingHere = (): boolean => quality === 'usable' && (
    (strategy?.confidence !== undefined && strategy.confidence >= 0.8 && strategy.relevance === 'promising' && strategy.action === 'inspect')
    || (deps.context === 'store' && (relatedGroceryItems(deps.item, area.items).length >= 2
      || !groceryAisle(deps.item) && section !== 'unknown' && area.items.filter(i => foodSection(i) === section).length >= 2)));
  /** The detector's own doors (Open Images `door`) are doorways too, whether or not Claude listed them. */
  const detectorDoorway = (): (SearchLandmark & { at: number; hits: number }) | null => {
    const box = deps.doorway?.() ?? null;
    if (!box) return null;
    return { name: 'doorway', kind: 'doorway', section: 'unknown', box: box.box, confidence: 0.8, at: box.at, hits: 2 };
  };
  /** A sign the phone's OCR reads that names a department ("DAIRY", "PRODUCE") or an aisle is a section landmark. */
  const ocrSigns = (): Array<SearchLandmark & { at: number; hits: number }> => {
    const out: Array<SearchLandmark & { at: number; hits: number }> = [];
    for (const s of deps.signs?.() ?? []) {
      if (s.at > now() || now() - s.at > 4000) continue;
      const sec = foodSection(s.text);
      const aisle = /\baisle\b/i.test(s.text);
      if (sec === 'unknown' && !aisle && !groceryAisle(s.text)) continue;
      out.push({ name: `${s.text.trim().toLowerCase()} sign`, kind: 'section', section: sec, box: s.box, confidence: 0.8, at: s.at, hits: 2 });
    }
    return out;
  };
  const candidates = (): Array<SearchLandmark & { at: number; hits: number }> => {
    const fresh = landmarks.filter((l) => (!['doorway', 'aisle_end'].includes(l.kind) || (l.hits >= 2 && l.confidence >= 0.8 && ['open_passage', 'cross_aisle'].includes(l.boundary ?? ''))) && now() - l.at <= FRESH_MS && l.confidence >= LANDMARK_MIN_CONFIDENCE);
    const door = detectorDoorway();
    const withDoor = door && !fresh.some((l) => l.kind === 'doorway' && overlap(l.box, door.box) >= 0.3) ? [...fresh, door] : fresh;
    const signs = ocrSigns().filter((s) => !withDoor.some((l) => l.kind === 'section' && overlap(l.box, s.box) >= 0.3));
    return [...withDoor, ...signs].filter(groceryDestination)
      .filter(l => !exitIntent || l.kind === (exitIntent === 'room' ? 'doorway' : 'aisle_end'))
      .filter(l => !/\b(bowls?|baskets?)\b/i.test(l.name) || l.hits >= 2 && l.confidence >= 0.85);
  };
  const choose = (): SearchLandmark | null => {
    const prior = clean(targetWords);
    // The current aisle is the wrong section: the way out is its end, not another shelf here.
    const wrongAisle = deps.context === 'store' && section !== 'unknown' && area.section !== 'unknown' && area.section !== section;
    return candidates().filter((l) => !['doorway', 'aisle_end'].includes(l.kind) || (l.hits >= 2 && l.confidence >= 0.8 && ['open_passage', 'cross_aisle'].includes(l.boundary ?? '')))
      .filter((l) => (l.hits >= 2 || l.confidence >= 0.75) && !refused.has(candidateKey(l)))
      .filter((l) => clean(l.name) !== clean(area.landmark ?? ''))
      .filter((l) => now() - (recentlyReached.get(clean(l.name)) ?? -Infinity) >= 120000)
      .filter((l) => deps.context !== 'store' || !map?.trip.aisleVisited(l.name, deps.item))
      .filter((l) => !(l.kind === 'surface' && wrongAisle))
      .sort((a, b) => rank(b) - rank(a))[0] ?? null;
    function rank(l: SearchLandmark): number {
      return (strategy && strategy.confidence >= 0.8 && clean(strategy.landmark) === clean(l.name) ? 25 : 0)
        + (deps.context === 'store' ? aisleClueScore(deps.item, l.name) : 0)
        + (deps.context === 'store' && area.landmark && area.landmark !== 'cross aisle corridor'
          && (l.kind === 'aisle_end' || l.kind === 'doorway') ? 50 : 0)
        + (clean(l.name).includes(prior) ? 20 : 0) + (section !== 'unknown' && l.section === section ? 12 : 0)
        + (deps.context === 'store' ? (l.kind === 'aisle_end' ? (wrongAisle ? 9 : 5) : l.kind === 'section' ? 6 : 0) : l.kind === 'doorway' ? 4 : 0)
        + l.confidence;
    }
  };
  const question = (): string => {
    if (deps.automaticExploration) {
      if (memoryRoute) return 'I will retrace our route to another place. Say stop anytime.';
      if (proposal?.kind === 'aisle_end') return 'I will guide you toward another aisle. Say stop anytime.';
      return 'I will explore a new direction now. Say stop anytime.';
    }
    if (memoryRoute) return 'I remember another place to check. May we retrace our route?';
    if (pendingLeg) return 'May I explore a new direction from here?';
    if (deps.context === 'store') {
      if (proposal?.section !== 'unknown' && proposal?.section === section) return `May I guide you toward the ${section} section?`;
      if (proposal?.kind === 'aisle_end') return 'May I take you out of this aisle to look elsewhere?';
      return 'May I guide you toward another part of the store?';
    }
    return proposal?.kind === 'doorway' ? 'May I guide you through the doorway to search elsewhere?' : 'May I guide you toward another visible surface to search?';
  };
  const leaveStalledView = (pose: Pose | null): SearchDirective | null => {
    if (lastConfined || now() < verificationUntil || (!detectorChecked && (now() - observedAt > FRESH_MS || analyzing))) return null;
    const coverage = map?.trip.coverage(deps.item, pose ?? undefined);
    if (coverage && coverage.missing.length < missingBands) { missingBands = coverage.missing.length; coverageProgressAt = now(); }
    const budget = promisingHere() ? 35000 : 6000;
    if (!detectorChecked && (now() - localScanAt < budget || scan < 1)) return null;
    if (coverage?.positive && !detectorChecked) return null;
    if (coverage?.checked) {
      area.outcome = 'not_seen_in_scanned_views';
      map?.trip.noteAisleSearch(deps.item, 'checked');
    } else {
      map?.trip.noteAisleSearch(deps.item, 'inconclusive');
    }
    map?.trip.defer(deps.item);
    deps.trace?.('search_leave', { context: deps.context, area: area.id, budget, outcome: area.outcome, relevance: strategy?.relevance ?? 'unknown', reason: detectorChecked ? 'detector_no_candidate_local_view' : 'dwell', absenceConfirmed: false });
    const exit = candidates()
      .filter(l => (l.kind === 'aisle_end' || l.kind === 'doorway') && l.hits >= 2 && l.confidence >= 0.8
        && ['open_passage', 'cross_aisle'].includes(l.boundary ?? '') && !refused.has(candidateKey(l))
        && now() - (recentlyReached.get(clean(l.name)) ?? -Infinity) >= 120000)
      .sort((a, b) => Number(b.kind === 'aisle_end') - Number(a.kind === 'aisle_end') || b.confidence - a.confidence)[0] ?? null;
    if (exit) {
      proposal = exit; phase = 'permission'; permissionAt = now(); saidAt = -Infinity;
      return emit(question(), exit.name);
    }
    // A grounded destination elsewhere beats another neighboring container.
    const destination = choose();
    if (destination && (destination.kind !== 'surface' && destination.kind !== 'appliance'
      || strategy?.action === 'relocate' && strategy.confidence >= 0.8 && clean(strategy.landmark) === clean(destination.name))) {
      proposal = destination; phase = 'permission'; permissionAt = now(); saidAt = -Infinity;
      return emit(question(), destination.name);
    }
    memoryRoute = map?.trip.route(deps.item, section) ?? null;
    if (memoryRoute) {
      phase = 'permission'; permissionAt = now(); saidAt = -Infinity;
      return emit(question());
    }
    if (map && pose) map.markScanned(pose);
    if (map && pose && map.bestHeading(pose, pose.yawDeg, deps.path?.() ?? null)) {
      pendingLeg = pose; phase = 'permission'; permissionAt = now(); saidAt = -Infinity;
      return emit(question());
    }
    return pause('No opening seen. Turn slowly; I am checking for another way.', 'opening');
  };
  return {
    observe(o, seq, capturedAt) {
      if (!o || seq <= lastSeq || capturedAt > now() || now() - capturedAt > FRESH_MS) {
        deps.trace?.('search_rejected', { reason: !o ? 'missing_search' : 'stale_or_duplicate', seq, capturedAt });
        return false;
      }
      const currentPose = deps.pose?.() ?? null;
      if (currentPose) map?.ingestPose(currentPose);
      map?.trip.observe(o, deps.item, capturedAt);
      // A delayed frame describes its capture viewpoint, not where the camera faces now.
      const capturePose = map?.trip.poseAt(capturedAt);
      if (map && deps.pose && !capturePose) { deps.trace?.('search_rejected', { reason: 'capture_pose_missing', seq }); return false; }
      if (capturePose && currentPose && (Math.hypot(capturePose.x - currentPose.x, capturePose.z - currentPose.z) > 1
        || Math.abs(((capturePose.yawDeg - currentPose.yawDeg + 540) % 360) - 180) > 25)) { deps.trace?.('search_rejected', { reason: 'viewpoint_changed', seq }); return false; }
      lastSeq = seq;
      observedAt = capturedAt;
      quality = o.confidence >= OBSERVATION_MIN_CONFIDENCE ? o.quality : 'occluded';
      strategy = o.strategy;
      if (strategy && strategy.confidence >= 0.8 && strategy.reason !== explained && speakable(strategy.reason)
        && !/\b(walk|run|move|head|proceed|turn|step|reach|grab|touch|enter|exit|open|cross|go|safe|absent|nearby)\b/i.test(strategy.reason) && !pendingNarration) {
        pendingNarration = strategy.reason; explained = strategy.reason;
      }
      unusableStreak = quality === 'usable' ? 0 : unusableStreak + 1;
      // "blurred" and "occluded" are Claude's words for a cluttered kitchen at arm's length; the
      // landmarks it lists in such a frame are still ways on. Only very low confidence is discarded.
      if (o.confidence < 0.5) return false;
      const previous = landmarks;
      // The same landmark comes back under drifting names ("aisle end", "end of aisle"): match by
      // kind and overlap first, name second, and keep the first name so the person hears one word.
      landmarks = o.landmarks.filter((l) => l.confidence >= LANDMARK_MIN_CONFIDENCE).map((l) => {
        const same = previous.find((p) => capturedAt - p.at <= 15000 && p.boundary === l.boundary && (clean(p.name) === clean(l.name) || (p.kind === l.kind && overlap(p.box, l.box) >= 0.3)));
        return { ...l, name: same?.name ?? l.name, at: capturedAt, hits: (same?.hits ?? 0) + 1 };
      });
      // Signs identify the current area only when repeated; merely seeing a distant sign
      // during movement must not teleport the user into that aisle.
      const reliableArea = phase !== 'move' && phase !== 'advance' && o.quality === 'usable' && o.confidence >= OBSERVATION_MIN_CONFIDENCE;
      const localProducts = sectionFromFoods(o.items);
      if (reliableArea && o.sign && (localProducts !== 'unknown' && localProducts === foodSection(o.sign)
        || !!area.landmark && !/\b(sign|banner)\b/i.test(area.landmark) && clean(area.landmark).includes(clean(o.sign)))) {
        const key = clean(o.sign);
        signHits = key === signCandidate ? signHits + 1 : 1;
        signCandidate = key;
        if (signHits >= 2 && area.sign === null) {
          const known = areas.find((a) => a !== area && clean(a.sign ?? '') === key);
          if (known) { areas.splice(areas.indexOf(area), 1); area = known; area.visits += 1; }
          else area.sign = o.sign;
          const text = `The sign here reads ${o.sign}.`;
          if (speakable(text)) pendingNarration = text;
        }
      } else { signHits = 0; signCandidate = ''; }
      if (reliableArea) area.items = [...new Set([...area.items, ...o.items])].slice(-20);
      const inferred = reliableArea ? sectionFromFoods(o.items) : 'unknown';
      const signed = reliableArea && signHits >= 2 ? foodSection(area.sign ?? '') : 'unknown';
      area.section = signed !== 'unknown' ? signed : inferred !== 'unknown' ? inferred : area.section;
      if (deps.context === 'store' && reliableArea) {
        map?.trip.noteAisle(area.sign ?? (area.section !== 'unknown' ? `${area.section} aisle` : 'unmarked aisle'), area.section);
      }
      if (area.section !== 'unknown' && area.section !== narratedSection && !pendingNarration) {
        const foods = o.items.filter((i) => foodSection(i) === area.section).slice(0, 2).join(' and ');
        const text = foods ? `${cap(foods)} here. This seems to be ${area.section}.` : `This seems to be the ${area.section} section.`;
        if (speakable(text)) pendingNarration = text;
        // …and where the item belongs, when that is somewhere else: the reason for the walk to come.
        if (section !== 'unknown' && section !== area.section) {
          const why = `${cap(deps.item)} should be in ${section}. Let me find the way.`;
          if (speakable(why)) followUp = why;
        }
        narratedSection = area.section;
      }
      if (o.item?.box && o.item.confidence >= 0.8) area.outcome = 'item_seen';
      if (phase !== 'move' && o.view !== 'unknown' && o.quality === 'usable') {
        const heading = deps.heading?.();
        const bearing = typeof heading === 'number' ? Math.round(heading / 30) : '';
        viewEvidence.add(`${o.view}:${bearing}`);
        if (!area.views.includes(o.view)) area.views.push(o.view);
        // Three different named views AND three observations, not repeated identical frames.
        if (area.outcome !== 'item_seen') area.outcome = map?.trip.coverage(deps.item, currentPose ?? undefined).checked ? 'not_seen_in_scanned_views' : 'partly_searched';
      }
      // A pause stops movement, not perception. Fresh evidence can resolve a
      // camera failure or reveal a way on; the next scan still asks consent.
      if (phase === 'paused' && quality === 'usable'
        && ((o.item?.box && o.item.confidence >= 0.8) || (now() - startedAt <= EXPLORE_BUDGET_MS
          && (pauseRecovery === 'camera' || (pauseRecovery === 'opening' && (choose() !== null
            || !!currentPose && !!map?.bestHeading(currentPose, currentPose.yawDeg, deps.path?.() ?? null))))))) {
        resumeScan(false);
      }
      return quality === 'usable';
    },
    tick(target, direct, opts = {}) {
      targetWords = target;
      lastConfined = opts.confined === true;
      const pose = deps.pose?.() ?? null;
      detectorChecked = detectorEvidence.update(deps.detectorFrame?.() ?? null, pose, now(), deps.hfovDeg?.() ?? 56)
        && now() >= verificationUntil;
      if (map && pose) map.ingestPose(pose);
      if (pose && (!localOrigin || Math.hypot(pose.x - localOrigin.x, pose.z - localOrigin.z) > 1.5)) {
        localOrigin = pose; localScanAt = now(); coverageProgressAt = now(); missingBands = 3;
      }
      if (map && map.trip.generation() !== mapGeneration) {
        mapGeneration = map.trip.generation(); resetScan(); landmarks = []; observedAt = -Infinity;
      }
      if (deps.pose && (!pose || (map && !map.trip.ready()))) {
        if (!trackingStopped) { resetScan(); trackingStopped = true; saidAt = -Infinity; }
        const line = emit('Stop. Hold the phone steady while I recover our position.');
        return { ...line, haptic: line.text ? 'STOP' : null };
      }
      if (trackingStopped) { trackingStopped = false; resetScan(); }
      if (map && pose && now() - lastPoseVisitAt >= 500) {
        map.visit(pose);
        // Relative monocular depth is not a metric range. Do not paint through walls.
        // Actual surfaces are recorded as native 3D points in trip memory instead.

        lastPoseVisitAt = now();
      }
      if ((phase === 'move' || phase === 'advance') && lastTickAt !== -Infinity && now() - lastTickAt > STALE_TICK_MS) resetScan();
      lastTickAt = now();
      // A found target always wins, including while permission is pending.
      if (direct?.targetVisible && !opts.surface) { resetScan(); return null; }
      if (exitIntent && phase === 'scan') {
        if (choose()) return this.exploreNow(exitIntent);
        if (now() - exitScanAt < OPENING_SWEEP_MS) return { text: null, target: targetWords, phase };
        exitScanAt = now();
        const text = exitScan < OPENING_SWEEP.length ? OPENING_SWEEP[exitScan++]
          : 'No exit confirmed. Describe its direction, or ask someone nearby.';
        return emit(text);
      }
      if (phase === 'permission') {
        if (deps.automaticExploration && now() - permissionAt >= 5000) {
          const next = this.intercept('yes');
          return { text: next.text, target: proposal?.name ?? targetWords, phase };
        }
        if (permissionAt !== -Infinity && now() - permissionAt >= CONSENT_MS) {
          return emit('Please say yes to move, or no to stay.', proposal?.name);
        }
        return emit(question(), proposal?.name);
      }
      if (phase === 'paused') {
        // Only a new viewpoint can lift an opening pause, so walk the person through one
        // instead of repeating the same sentence into the silence.
        if (pauseRecovery === 'opening' && openingSweep < OPENING_SWEEP.length) {
          if (now() - lastPulseAt < OPENING_SWEEP_MS) return { text: null, target: targetWords, phase };
          lastPulseAt = now();
          const line = OPENING_SWEEP[openingSweep]!;
          openingSweep += 1;
          deps.trace?.('search_decision', { phase, text: line, area: area.id, context: deps.context, sweep: openingSweep });
          return { text: line, target: targetWords, phase };
        }
        if (pauseRecovery === 'opening' && pauseText !== OPENING_EXHAUSTED) pauseText = OPENING_EXHAUSTED;
        // Keep the actual reason, rather than replacing it with a generic nag.
        return now() - lastPulseAt >= GIVE_UP_PULSE_MS
          ? (lastPulseAt = now(), { text: pauseText, target: targetWords, phase })
          : { text: null, target: targetWords, phase };
      }
      if (phase === 'move' && memoryRoute && pose && map) {
        const route = map.trip.route(deps.item, section, memoryRoute.destination.id);
        if (!route || Math.hypot(memoryRoute.destination.x - pose.x, memoryRoute.destination.z - pose.z) < 1) {
          resetScan(); area = freshArea();
          return emit('Stop here. Let me check this area again.');
        }
        if (stalled(pose) || now() - moveAt > MOVE_GIVE_UP_MS) {
          map.trip.defer(deps.item, memoryRoute.destination.id);
          resetScan(); return emit('Stop. This route is stalled. Let me find another way.');
        }
        memoryRoute = route;
        const yaw = Math.atan2(route.waypoint.x - pose.x, -(route.waypoint.z - pose.z)) * 180 / Math.PI;
        const err = ((yaw - pose.yawDeg + 540) % 360) - 180;
        if (Math.abs(err) > 25) return move(err > 0 ? 'Turn slowly right.' : 'Turn slowly left.', `route-turn:${err > 0}`, targetWords, 'TURN');
        const path = deps.path?.();
        if (!path || path.center >= 0.7 || explorationSteps(path) === 0) return move('Stop. I need to check the path ahead.', 'route-blocked', targetWords, 'STOP');
        return move(`Walk forward ${stepsWords(explorationSteps(path))} along our previous route.`, 'route-forward', targetWords);
      }
      if (phase === 'move' && proposal) {
        const p = candidates().find((l) => clean(l.name) === clean(proposal!.name) && now() - l.at <= FRESH_MS);
        const box: TargetBox | null = p ? { box: p.box, at: p.at } : null;
        // Use the confirmed landmark's box, never another object of a similar class.
        let g = box ? deps.guide.instructionFor(proposal.name, box, { modelOnly: true, maxAgeMs: FRESH_MS }) : null;
        if (g?.kind === 'arrived' && /\b(sign|banner)\b/i.test(proposal.name)) {
          refused.add(candidateKey(proposal)); resetScan();
          return emit('Sign nearby. Hold still while I locate the actual display.');
        }
        if (g?.kind === 'forward') {
          const path = deps.path?.();
          if (path && explorationSteps(path) === 0) return move('Stop. There is not enough measured room ahead.', 'metric-blocked', proposal.name, 'STOP');
          g = { ...g, steps: Math.min(g.steps ?? 3, path ? explorationSteps(path) : 3) };
        }
        if (g?.targetVisible) landmarkSeenAt = now();
        if (g?.kind === 'arrived' && g.box && g.box.at !== arrivalAt) { arrivalHits += 1; arrivalAt = g.box.at; }
        else if (g?.kind !== 'arrived') arrivalHits = 0;
        if (arrivalHits >= 2) return arrive();
        if (stalled(pose) || now() - moveAt > MOVE_GIVE_UP_MS) { refused.add(candidateKey(proposal)); resetScan(); return emit('That took too long. Let me look for another way.'); }
        if (!g?.targetVisible) {
          // Lost from view: keep walking the last bearing briefly, then stop and look.
          if (deps.path?.() && deps.path()!.center < 0.7 && now() - landmarkSeenAt <= MOVE_LOST_GRACE_MS) return move(`Keep walking. Hold the camera level to find the ${proposal.name}.`, 'lost', proposal.name);
          return move(`Stop. Turn slowly until I see the ${proposal.name} again.`, 'lost-stop', proposal.name, 'STOP');
        }
        if (deps.pose && (!deps.path?.() || deps.path()!.center >= 0.7) && g.kind === 'forward') return move('Stop. I need to check the path ahead.', 'blocked', proposal.name, 'STOP');
        if (g.kind === 'sidestep') return move(g.text, 'sidestep', proposal.name, 'STOP');
        if (g.kind === 'arrived') return move(`${cap(proposal.name)} just ahead. Slow down.`, 'arriving', proposal.name);
        const line = itemLine(proposal.name, g);
        // Push: fewer steps than the last line is progress.
        if (g.kind === 'forward' && g.steps !== null && lastMoveSteps !== null && g.steps < lastMoveSteps) {
          lastMoveSteps = g.steps;
          return move(`Keep going. ${cap(stepsWords(g.steps))} more.`, `forward:${g.steps}`, proposal.name);
        }
        if (g.kind === 'forward' && g.steps !== null) lastMoveSteps = g.steps;
        return move(line.text, line.key, proposal.name, line.haptic === 'TURN' ? 'TURN' : null);
      }
      if (phase === 'advance') {
        if (map && leg && pose) {
          // A leg of exploration: hold the heading, stop at a blockage or after the leg's length.
          const legSteps = deps.steps?.();
          const err = ((leg.yawDeg - pose.yawDeg + 540) % 360) - 180;   // + = the heading is to the right
          const p = deps.path?.() ?? null;
          // A blockage counts only once the person faces the leg's heading and has had a moment to
          // step off; at the start the table they were scanning is still in front of the camera.
          const settled = leg.aligned && leg.alignedAt !== null && now() - leg.alignedAt >= 1500;
          const blocked = settled && p !== null && (p.center >= 0.7 || explorationSteps(p) === 0);
          const rad = leg.yawDeg * Math.PI / 180;
          const travelled = crossing ? Math.max(0, (pose.x - leg.from.x) * Math.sin(rad) - (pose.z - leg.from.z) * Math.cos(rad)) : map.distance(leg.from, pose);
          const far = travelled >= (crossing ? 1.5 : EXPLORE_LEG_M) || (typeof legSteps === 'number' && legSteps - leg.steps0 >= EXPLORE_LEG_STEPS) || now() - leg.at >= EXPLORE_LEG_MS;
          if (blocked || far) {
            const noProgress = travelled < 0.5;
            if (blocked || noProgress) map.markBlocked(pose, leg.yawDeg);
            if (!blocked && travelled >= 1.5) {
              if (crossing) exitIntent = null;
              if (crossing && deps.context === 'store') map.trip.leaveAisle();
              area = freshArea(); area.landmark = crossing ? (deps.context === 'store' ? 'cross aisle corridor' : 'beyond opening') : undefined;
              localScanAt = now(); coverageProgressAt = now(); missingBands = 3; localOrigin = pose; viewEvidence = new Set();
              narratedSection = 'unknown'; signHits = 0; signCandidate = ''; strategy = undefined; closeMode = false;
            }
            map.markScanned(pose);
            leg = null;
            resetScan(); saidAt = now();
            return { text: blocked ? 'Something ahead. Stop. Let me look around.' : noProgress ? 'Stop. No progress this way. Let me find another opening.' : 'Stop here. Let me look around.', target: targetWords, phase, haptic: blocked ? 'STOP' : 'CONFIRM' };
          }
          if (!leg.aligned) {
            // Still turning onto the leg's heading: keep the turn going, not a "drift" complaint.
            if (Math.abs(err) <= EXPLORE_DRIFT_DEG) { leg.aligned = true; leg.alignedAt = now(); }
            else return move(err > 0 ? 'Keep turning right.' : 'Keep turning left.', `turning:${err > 0 ? 'r' : 'l'}`, targetWords, 'TURN');
          }
          if (Math.abs(err) > EXPLORE_DRIFT_DEG) return move(err > 0 ? 'Drifting left. A little to the right.' : 'Drifting right. A little to the left.', `drift:${err > 0 ? 'r' : 'l'}`, targetWords, 'TURN');
          if (!p || p.center >= 0.7) return move('Stop. Let me check the path before moving.', 'check-path', targetWords, 'STOP');
          const remaining = Math.min(crossing ? 2 : 3, explorationSteps(p));
          if (remaining === 0) return move('Stop. There is not enough measured room ahead.', 'metric-blocked', targetWords, 'STOP');
          return move(`Walk forward ${stepsWords(remaining)}, then stop for another look.`, 'leg', targetWords);
        }
        // No position: a few steps on, then look again.
        const steps = deps.steps?.();
        // The pedometer says the steps were taken, or enough time passed for them (no pedometer, or a slow walker).
        const walked = (typeof steps === 'number' && steps - advanceSteps0 >= ADVANCE_STEPS) || now() - advanceAt >= ADVANCE_MS;
        if (walked) { resetScan(); saidAt = now(); return { text: 'Stop here. Let me look around again.', target: targetWords, phase, haptic: 'CONFIRM' }; }
        return move(`Walk forward ${stepsWords(ADVANCE_STEPS)}, then I will look again.`, 'advance', targetWords);
      }
      if (now() - startedAt > EXPLORE_BUDGET_MS) return pause('No match after several areas. Continue searching, or ask someone nearby?', null);
      const moveOn = leaveStalledView(pose);
      if (moveOn) return moveOn;
      if (pendingNarration && now() - saidAt >= 5000) { const line = pendingNarration; pendingNarration = followUp; followUp = null; return emit(line); }
      if (now() < verificationUntil) return emit('Checking a possible match. Hold the camera steady.');
      if (!analyzing && promisingHere() && !area.closeSearched && !opts.confined && now() - saidAt >= 5000) {
        area.closeSearched = true; closeMode = true; scan = 0; scanAt = now();
        return emit('This area looks promising. Let me inspect it more closely.');
      }
      if (now() - observedAt > 15000) {
        if (now() - Math.max(startedAt, observedAt) > 30000) {
          return pause('Waiting for camera analysis. Hold steady; I am retrying.', 'camera');
        }
        // A normal model round trip is not a new camera failure on every tick.
        // Keep the last instruction while analysis is pending; announce a real
        // outage once, then the paused-state retry uses its own slow cadence.
        if (analyzing || now() - cameraWaitAt < 30000) return { text: null, target, phase };
        const wait = emit('Hold the camera steady while I process this view.');
        if (wait.text) cameraWaitAt = now();
        return wait;
      }
      if (unusableStreak >= 3 && landmarks.length === 0 && now() - localScanAt < 45000) return emit(quality === 'dark' ? 'The view is dark. Aim toward a brighter area.' : 'The view is blocked or blurred. Hold the camera steady.');
      if (unusableStreak >= 3 && landmarks.length === 0 && now() - localScanAt >= 45000) {
        map?.trip.defer(deps.item);
        return pause('View blocked or blurred. Adjust the camera; I am still checking.', 'camera');
      }
      // Do not prompt another pan while the previous view is being analyzed.
      if (!analyzing && observedAt >= scanAt && now() - scanAt >= SCAN_MS && now() - saidAt >= 5000) {
        if (scan >= 3) {
          const coverage = map?.trip.coverage(deps.item, pose ?? undefined);
          if (coverage && coverage.missing.length < missingBands) { missingBands = coverage.missing.length; coverageProgressAt = now(); }
          const plausible = opts.confined || promisingHere();
          if (coverage?.checked) {
            area.outcome = 'not_seen_in_scanned_views';
            if (deps.context === 'store') map?.trip.noteAisleSearch(deps.item, 'checked');
          }
          const viewpointStalled = deps.context === 'store' && coverage !== null && coverage !== undefined
            && now() - coverageProgressAt >= SAME_VIEW_NO_PROGRESS_MS;
          if (viewpointStalled && !coverage?.checked) {
            map?.trip.noteAisleSearch(deps.item, 'inconclusive');
            map?.trip.defer(deps.item);
          }
          if (coverage && plausible && !coverage.checked && !coverage.positive && !viewpointStalled
            && now() - localScanAt < 60000) {
            return emit((deps.context === 'store' || opts.confined ? SHELVES : SURFACES)[Math.max(0, ['upper', 'middle', 'lower'].indexOf(coverage.missing[0] ?? 'upper'))]!);
          }
          // The right section (apples and oranges here, bananas wanted): search these shelves
          // closely before proposing anywhere else — the thing is probably within a few metres.
          const promising = promisingHere();
          if (promising && !area.closeSearched && !opts.confined && !viewpointStalled) {
            area.closeSearched = true;
            scan = 0; scanAt = now(); closeMode = true;
            return emit('This section looks promising. Let me search these shelves closely.');
          }
          closeMode = false;
          if (opts.confined) {
            return pause('Not found inside. Say explore to search somewhere else.', null);
          }
          if (now() - startedAt > EXPLORE_BUDGET_MS) {
            return pause('Search paused. We can keep looking, or ask someone nearby.', null);
          }
          memoryRoute = map?.trip.route(deps.item, section) ?? null;
          if (memoryRoute) { phase = 'permission'; permissionAt = now(); saidAt = -Infinity; return emit(question()); }
          proposal = choose();
          if (proposal) { phase = 'permission'; permissionAt = now(); saidAt = -Infinity; return emit(question(), proposal.name); }
          if (map && pose) {
            // Round 12: go where we have not been. The depth grid vetoes blocked ways.
            map.markScanned(pose);
            if (map.bestHeading(pose, pose.yawDeg, deps.path?.() ?? null)) {
              pendingLeg = pose; phase = 'permission'; permissionAt = now(); saidAt = -Infinity;
              return emit(question());
            }
            return pause('No opening seen. Turn slowly; I am checking for another aisle.', 'opening');
          }
          return pause('No opening seen. Turn slowly; I am checking for another way.', 'opening');
        }
        const corridor = deps.context === 'store' && /\baisle end|end of (?:the )?aisle|corridor\b/i.test(area.landmark ?? '');
        // Generic exploration can use model narration in every environment; close inspection stays deterministic.
        const generic = !(opts.confined || closeMode || (opts.surface && promisingHere()));
        const text = (opts.confined || closeMode || (opts.surface && promisingHere()) ? (deps.context === 'store' || opts.confined ? SHELVES : SURFACES) : deps.context === 'store' ? (corridor ? CORRIDOR_SCANS : AISLE_SCANS) : SCANS)[scan]!;
        scan += 1; scanAt = now();
        // Keep a deterministic fallback if the model supplies no usable speech.
        return emit(text, targetWords, generic && now() - modelNarratedAt < 15000);
      }
      return { text: null, target, phase };
    },
    intercept(text) {
      if (deps.automaticExploration && (phase === 'permission' || phase === 'move' || phase === 'advance')
        && (isNegative(text) || /^(?:stay here|do not move|don't move|wait)[.!]?$/i.test(text.trim()))) {
        if (proposal) refused.add(candidateKey(proposal));
        resetScan();
        pause('Staying here. Say explore when you want to move.', null);
        return { consumed: true, text: 'Staying here. Say explore when you want to move.' };
      }
      if (/\b(?:explore|look at|show|try|check|scan) (?:a |the )?(?:different|another|new) (?:view|angle)\b/i.test(text)) {
        resumeScan(true);
        scan = 1; scanAt = now(); saidAt = now();
        return { consumed: true, text: 'Stay here. Turn the camera slowly left for another view.' };
      }
      if (/^(?:please )?(?:search(?: again)?|resume(?: searching| search| the search)?|continue(?: trying to)?(?: searching| search| the search)?|keep (?:looking|searching)|scan again|try again|look again)(?: for (?:the )?.+)?[.!]?$/i.test(text.trim())) { resumeScan(true); return { consumed: true, text: 'Resuming the search. Hold the camera steady.' }; }
      if (/^(?:where have we (?:looked|been)|what have we checked)[?!.]?$/i.test(text.trim())) {
        return { consumed: true, text: areas.some((a) => a.outcome === 'not_seen_in_scanned_views') ? 'We checked several views. Hidden items may still be there.' : 'We have only partly inspected this area.' };
      }
      if (phase !== 'permission') return { consumed: false, text: null };
      if (isAffirmative(text)) map?.trip.defer(deps.item);
      if (isAffirmative(text) && !lastConfined && (memoryRoute || pendingLeg)) {
        if (deps.pose && (!deps.pose() || !map?.trip.ready())) return { consumed: true, text: 'Hold still while I recover our position.' };
        if (pendingLeg) {
          const p = deps.pose?.(); pendingLeg = null;
          const next = p ? startLeg(p) : null;
          if (!next) resetScan();
          return { consumed: true, text: next?.text ?? 'Let me check another direction.' };
        }
        phase = 'move'; moveAt = now(); saidAt = -Infinity; moveKey = null; moveSaidAt = -Infinity;
        return { consumed: true, text: 'Okay. Retracing our route. I will check for obstacles.' };
      }
      if (isAffirmative(text) && proposal && !lastConfined) {
        phase = 'move'; movementSteps = deps.steps?.() ?? 0; moveAt = now(); saidAt = -Infinity; moveKey = null; moveSaidAt = -Infinity; lastMoveSteps = null; landmarkSeenAt = now();
        void movementSteps;
        return { consumed: true, text: `Okay. Heading for the ${proposal.name}.` };
      }
      if (isNegative(text) || /^(?:stay here|do not move|don't move|wait)[.!]?$/i.test(text.trim())) {
        if (proposal) refused.add(candidateKey(proposal));
        resetScan();
        if (deps.automaticExploration) {
          pause('Staying here. Say explore when you want to move.', null);
          return { consumed: true, text: 'Staying here. Say explore when you want to move.' };
        }
        return { consumed: true, text: 'We will stay here and inspect another angle.' };
      }
      return { consumed: false, text: null };
    },
    target: () => (phase === 'move' || phase === 'permission') && proposal ? proposal.name : null,
    context() {
      const prior = (exitIntent ? `Active objective: leave this ${exitIntent}. Locate an actual open doorway or cross-aisle in search.landmarks with boundary and box. Doorless openings count. Do not substitute tables, bowls, baskets or item-location guesses. If no opening is visible, report that honestly and request a new camera view. ` : '') + (section === 'unknown' ? '' : `Likely category: ${section}; hypothesis only. `);
      const history = areas.slice(-6).map((a) => `${a.sign ?? a.landmark ?? a.id}: ${a.section}, ${a.outcome}, ${a.views.join('/')}`).join('; ');
      const aisle = deps.context === 'store' ? groceryAisle(deps.item) : null;
      const neighbors = relatedGroceryItems(deps.item, area.items);
      const clues = aisle ? `Likely aisle: ${aisle.label}. Related products: ${aisle.words.join(', ')}. Observed related products: ${neighbors.join(', ') || 'none'}. Read overhead signs verbatim, including aisle numbers and categories. Box the corresponding visible aisle entrance or display; do not invent its direction. ` : '';
      return `${prior}${clues}Search ${phase}. Inspect target and visible alternative landmarks. Coverage: ${JSON.stringify(map?.trip.coverage(deps.item) ?? null)}. Memory: ${history}. Trip: ${map?.trip.describe(deps.item) ?? ''}. Unseen is not absent. Never infer walking direction from category.`;
    },
    memory: () => areas.map((a) => ({ ...a, items: [...a.items], views: [...a.views] })),
    analyzing: (pending) => { analyzing = pending; },
    verificationPending: pending => { verificationUntil = pending ? now() + 12000 : -Infinity; },
    coverage: () => (map ? { visited: map.visitedCells(), scanned: map.scannedCells(), viewed: map.viewedCells() } : null),
    gaveUp: () => gaveUpAt !== -Infinity,
    pending: () => phase === 'permission' || phase === 'paused',
    status: () => phase,
    repeat: () => { saidAt = -Infinity; },
    restart: () => resumeScan(true),
    busy: () => exitIntent !== null || phase === 'move' || phase === 'advance' || phase === 'permission',
    narrating: () => phase === 'scan' && quality === 'usable' && now() - observedAt <= FRESH_MS && !trackingStopped && !closeMode && !lastConfined && !promisingHere(),
    narrated: () => { modelNarratedAt = now(); saidAt = now(); pendingNarration = null; followUp = null; },
    exploreNow(prefer = null, consent = true) {
      if (prefer && !exitIntent) { exitScan = 0; exitScanAt = -Infinity; }
      exitIntent = prefer ?? exitIntent;
      gaveUpAt = -Infinity; startedAt = now(); localScanAt = now();
      map?.trip.defer(deps.item);
      // The current spot is done with: remember it as searched, then leave.
      // A request to leave is not evidence that the shelves were inspected.
      const pose = deps.pose?.() ?? null;
      if (deps.pose && (!pose || !map?.trip.ready())) return { text: 'Stop. Hold still while I recover our position.', target: targetWords, phase: 'scan', haptic: 'STOP' };
      if (map && pose) map.markScanned(pose);
      // A fresh landmark of the wanted kind (an aisle end, a doorway), without asking — the person asked.
      const wanted = prefer === 'aisle' ? 'aisle_end' : prefer === 'room' ? 'doorway' : null;
      const fresh = candidates().filter((l) => (!['doorway', 'aisle_end'].includes(l.kind) || (l.hits >= 2 && l.confidence >= 0.8 && ['open_passage', 'cross_aisle'].includes(l.boundary ?? ''))) && now() - l.at <= FRESH_MS && l.confidence >= LANDMARK_MIN_CONFIDENCE && !refused.has(candidateKey(l)) && clean(l.name) !== clean(area.landmark ?? '')
        && now() - (recentlyReached.get(clean(l.name)) ?? -Infinity) >= 120000
        && (deps.context !== 'store' || !map?.trip.aisleVisited(l.name, deps.item)));
      const pick = (wanted ? fresh.find((l) => l.kind === wanted) : null) ?? choose() ?? fresh.sort((a, b) => b.confidence - a.confidence)[0] ?? null;
      if (pick) {
        proposal = pick;
        if (!consent) { phase = 'permission'; permissionAt = now(); saidAt = -Infinity; return emit(question(), pick.name); }
        phase = 'move'; moveAt = now(); saidAt = -Infinity; moveKey = null; moveSaidAt = -Infinity; lastMoveSteps = null; landmarkSeenAt = now();
        return { text: fit(`Okay. Heading for the ${pick.name}.`), target: pick.name, phase, haptic: 'CONFIRM' };
      }
      if (map && pose && !exitIntent) {
        if (!consent && map.bestHeading(pose, pose.yawDeg, deps.path?.() ?? null)) {
          pendingLeg = pose; phase = 'permission'; permissionAt = now(); saidAt = -Infinity; return emit(question());
        }
        const started = startLeg(pose, prefer === 'aisle');
        if (started) return { ...started, text: started.text ? fit(`Okay. ${started.text}`) : 'Okay. Exploring.' };
      }
      resetScan();
      return { text: 'Turn slowly so I can find another opening.', target: targetWords, phase, haptic: 'TURN' };
    },
    enterArea(landmark) {
      exitIntent = null;
      area = freshArea(); area.landmark = landmark; viewEvidence = new Set();
      signHits = 0; signCandidate = ''; narratedSection = 'unknown'; resetScan();
    },
  };
}
