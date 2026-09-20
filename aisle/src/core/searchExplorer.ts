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
import type { Pose } from './contracts';
import { stepsWords } from './guide';
import { createExplorationMap, type ExplorationMap, type Openness } from './explorationMap';
import { foodSection, sectionFromFoods, type FoodSection } from './foodCatalog';
import { itemLine } from './itemMission';
import type { SearchLandmark, SearchObservation, SearchView } from './searchObservation';
import { isAffirmative, isNegative } from './yesNo';
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
}
export interface SearchExplorer {
  observe(observation: SearchObservation | undefined, seq: number, capturedAt: number): void;
  tick(target: string, direct: GuideInstruction | null, opts?: { surface?: boolean; confined?: boolean }): SearchDirective | null;
  intercept(text: string): { consumed: boolean; text: string | null };
  target(): string | null;
  context(): string;
  memory(): SearchArea[];
  /** Round 12: cells visited / scanned when a position is known. */
  coverage(): { visited: number; scanned: number } | null;
  pending(): boolean;
  status(): SearchDirective['phase'];
  /** The explorer is walking or waiting for consent (round 14): the navigator holds its guesses. */
  busy(): boolean;
  /**
   * Round 14: the person asked to explore ("explore", "next aisle", "another room"): leave the
   * current spot now — the freshest landmark without asking, else a coverage leg — and say so.
   */
  exploreNow(prefer?: 'aisle' | 'room' | null): SearchDirective;
  repeat(): void;
  restart(): void;
  enterArea(landmark: string): void;
}
export interface SearchExplorerDeps {
  item: string;
  context: 'home' | 'store' | 'street';
  guide: Pick<Guide, 'instructionFor'>;
  heading?: () => number | null;
  steps?: () => number;
  /** Round 12: the phone's position and yaw (ARKit), for exploring a big space by coverage. */
  pose?: () => Pose | null;
  /** The depth grid's bottom row, fresh: nearness ahead / left / right. */
  path?: () => Openness | null;
  /** Round 16: a door the detector sees right now (Open Images `door`), as a doorway landmark. */
  doorway?: () => TargetBox | null;
  map?: ExplorationMap;
  now?: () => number;
}

/** An observation older than this steers nothing (a task_step round trip is 3–5 s). */
const FRESH_MS = 8000;
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
/** A consent question unanswered this long is taken as "go ahead" (the person can still say stop). */
export const CONSENT_MS = 10_000;
/** With nothing to head for and no position: walk this far, then look again — at most ADVANCE_MAX times. */
export const ADVANCE_STEPS = 5;
export const ADVANCE_MAX = 3;
export const ADVANCE_MS = 9000;
/** With a position (round 12): one leg of exploration is this long, then a look around. */
export const EXPLORE_LEG_M = 6;
export const EXPLORE_LEG_STEPS = 10;
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
/** In a store the look-around is along the aisle: both shelf faces, then the aisle itself. */
const AISLE_SCANS = [
  'Face the shelf on your left. Pan slowly top to bottom.',
  'Now face the right shelf and pan slowly top to bottom.',
  'Turn to look along the aisle for signs and displays.',
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
  const now = deps.now ?? Date.now;
  const areas: SearchArea[] = [];
  let areaCount = 0;
  let area: SearchArea = freshArea();
  let phase: SearchDirective['phase'] = 'scan';
  let scan = 0;
  let scanAt = -Infinity;
  let lastSeq = -1;
  let observedAt = -Infinity;
  let quality: SearchObservation['quality'] = 'occluded';
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
  const map = deps.map ?? (deps.pose ? createExplorationMap() : null);
  let leg: { yawDeg: number; from: { x: number; z: number }; steps0: number; at: number; aligned: boolean } | null = null;
  let lastPoseVisitAt = -Infinity;
  /** Searching the item's own section shelf by shelf (round 12). */
  let closeMode = false;
  let viewEvidence = new Set<string>();
  let refused = new Set<string>();
  let lastConfined = false;
  const startedAt = now();
  let permissionAt = -Infinity;
  /** A tick after a long silence (the navigator spoke instead) must not resume a stale leg. */
  let lastTickAt = -Infinity;
  const STALE_TICK_MS = 8000;

  function freshArea(): SearchArea {
    const next: SearchArea = { id: `view-area-${++areaCount}`, sign: null, section: 'unknown', items: [], views: [], outcome: 'uninspected', visits: 1 };
    areas.push(next);
    if (areas.length > 24) areas.shift();
    return next;
  }
  const emit = (raw: string, target = targetWords): SearchDirective => {
    const text = fit(raw);
    const interval = phase === 'paused' ? 20000 : phase === 'permission' ? 15000 : 5000;
    const ready = now() - saidAt >= interval || saidAt === -Infinity;
    if (ready && speakable(text)) { saidAt = now(); return { text, target, phase }; }
    return { text: null, target, phase };
  };
  const resetScan = (): void => { scan = 0; scanAt = -Infinity; phase = 'scan'; proposal = null; arrivalHits = 0; saidAt = -Infinity; moveKey = null; lastMoveSteps = null; leg = null; };
  /** A walking line, paced like the navigator's: news after two seconds, the same line again after four. */
  const move = (raw: string, key: string, target: string, haptic: SearchDirective['haptic'] = null): SearchDirective => {
    const t = now();
    const text = fit(raw);
    const news = key !== moveKey;
    if (t - moveSaidAt < (news ? MOVE_CHANGE_FLOOR_MS : MOVE_REPEAT_MS) && !(news && haptic === 'STOP')) return { text: null, target, phase, haptic: null };
    if (!speakable(text)) return { text: null, target, phase, haptic: null };
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
    leg = { yawDeg: choice.yawDeg, from: { x: pose.x, z: pose.z }, steps0: deps.steps?.() ?? 0, at: now(), aligned: choice.turn === 'ahead' };
    phase = 'advance'; moveKey = null; moveSaidAt = -Infinity; proposal = null;
    const turn = choice.turn === 'ahead' ? '' : choice.turn === 'around' ? 'Turn around, then ' : choice.turn === 'left' ? 'Turn left, then ' : choice.turn === 'right' ? 'Turn right, then ' : choice.turn === 'half_left' ? 'Turn half left, then ' : 'Turn half right, then ';
    const line = turn ? `${turn}walk about ${stepsWords(EXPLORE_LEG_STEPS)}. New ground there.` : `Walk forward about ${stepsWords(EXPLORE_LEG_STEPS)}. New ground that way.`;
    void preferTurn;
    return move(line, `leg:${choice.turn}`, targetWords, choice.turn === 'ahead' ? null : 'TURN');
  };
  const arrive = (): SearchDirective => {
    area = freshArea(); area.landmark = proposal?.name;
    viewEvidence = new Set(); signHits = 0; signCandidate = ''; narratedSection = 'unknown';
    resetScan();
    saidAt = now();
    return { text: 'Here. Let me look around this spot.', target: targetWords, phase, haptic: 'CONFIRM' };
  };
  const section = foodSection(deps.item);
  const candidateKey = (l: SearchLandmark): string => `${area.id}:${clean(l.name)}`;
  /** The detector's own doors (Open Images `door`) are doorways too, whether or not Claude listed them. */
  const detectorDoorway = (): (SearchLandmark & { at: number; hits: number }) | null => {
    const box = deps.doorway?.() ?? null;
    if (!box) return null;
    return { name: 'doorway', kind: 'doorway', section: 'unknown', box: box.box, confidence: 0.8, at: box.at, hits: 2 };
  };
  const candidates = (): Array<SearchLandmark & { at: number; hits: number }> => {
    const fresh = landmarks.filter((l) => now() - l.at <= FRESH_MS && l.confidence >= LANDMARK_MIN_CONFIDENCE);
    const door = detectorDoorway();
    return door && !fresh.some((l) => l.kind === 'doorway' && overlap(l.box, door.box) >= 0.3) ? [...fresh, door] : fresh;
  };
  const choose = (): SearchLandmark | null => {
    const prior = clean(targetWords);
    // The current aisle is the wrong section: the way out is its end, not another shelf here.
    const wrongAisle = deps.context === 'store' && section !== 'unknown' && area.section !== 'unknown' && area.section !== section;
    return candidates().filter((l) => (l.hits >= 2 || l.confidence >= 0.75) && !refused.has(candidateKey(l)))
      .filter((l) => clean(l.name) !== clean(area.landmark ?? ''))
      .filter((l) => !areas.some((a) => a.sign && clean(a.sign) === clean(l.name) && a.outcome === 'not_seen_in_scanned_views'))
      .filter((l) => !(l.kind === 'surface' && wrongAisle))
      .sort((a, b) => rank(b) - rank(a))[0] ?? null;
    function rank(l: SearchLandmark): number {
      return (clean(l.name).includes(prior) ? 20 : 0) + (section !== 'unknown' && l.section === section ? 12 : 0)
        + (deps.context === 'store' ? (l.kind === 'aisle_end' ? (wrongAisle ? 9 : 5) : l.kind === 'section' ? 6 : 0) : l.kind === 'doorway' ? 4 : 0)
        + l.confidence;
    }
  };
  const question = (): string => {
    if (deps.context === 'store') {
      if (proposal?.section !== 'unknown' && proposal?.section === section) return `May I guide you toward the ${section} section?`;
      if (proposal?.kind === 'aisle_end') return 'May I take you out of this aisle to look elsewhere?';
      return 'May I guide you toward another part of the store?';
    }
    return proposal?.kind === 'doorway' ? 'May I guide you through the doorway to search elsewhere?' : 'May I guide you toward another visible surface to search?';
  };
  return {
    observe(o, seq, capturedAt) {
      if (!o || seq <= lastSeq || capturedAt > now() || now() - capturedAt > FRESH_MS) return;
      lastSeq = seq;
      observedAt = capturedAt;
      quality = o.confidence >= OBSERVATION_MIN_CONFIDENCE ? o.quality : 'occluded';
      if (o.confidence < OBSERVATION_MIN_CONFIDENCE || quality !== 'usable') return;
      const previous = landmarks;
      // The same landmark comes back under drifting names ("aisle end", "end of aisle"): match by
      // kind and overlap first, name second, and keep the first name so the person hears one word.
      landmarks = o.landmarks.filter((l) => l.confidence >= LANDMARK_MIN_CONFIDENCE).map((l) => {
        const same = previous.find((p) => capturedAt - p.at <= 15000 && (clean(p.name) === clean(l.name) || (p.kind === l.kind && overlap(p.box, l.box) >= 0.3)));
        return { ...l, name: same?.name ?? l.name, at: capturedAt, hits: (same?.hits ?? 0) + 1 };
      });
      // Signs identify the current area only when repeated; merely seeing a distant sign
      // during movement must not teleport the user into that aisle.
      if (phase !== 'move' && o.sign) {
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
      }
      area.items = [...new Set([...area.items, ...o.items])].slice(-20);
      const inferred = sectionFromFoods(o.items);
      const signed = foodSection(o.sign ?? '');
      area.section = signed !== 'unknown' ? signed : inferred !== 'unknown' ? inferred : area.section;
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
      if (phase !== 'move' && o.view !== 'unknown') {
        const heading = deps.heading?.();
        const bearing = typeof heading === 'number' ? Math.round(heading / 30) : '';
        viewEvidence.add(`${o.view}:${bearing}`);
        if (!area.views.includes(o.view)) area.views.push(o.view);
        // Three different named views AND three observations, not repeated identical frames.
        if (area.outcome !== 'item_seen') area.outcome = area.views.length >= 3 && viewEvidence.size >= 3 ? 'not_seen_in_scanned_views' : 'partly_searched';
      }
    },
    tick(target, direct, opts = {}) {
      targetWords = target;
      lastConfined = opts.confined === true;
      const pose = deps.pose?.() ?? null;
      if (map && pose && now() - lastPoseVisitAt >= 500) { map.visit(pose); lastPoseVisitAt = now(); }
      if ((phase === 'move' || phase === 'advance') && lastTickAt !== -Infinity && now() - lastTickAt > STALE_TICK_MS) resetScan();
      lastTickAt = now();
      // A found target always wins, including while permission is pending.
      if (direct?.targetVisible && !opts.surface) { resetScan(); return null; }
      if (phase === 'permission') {
        if (proposal && permissionAt !== -Infinity && now() - permissionAt >= CONSENT_MS) {
          // No answer: an unanswered question must not become the place we stand forever.
          phase = 'move'; moveAt = now(); saidAt = now(); moveKey = null; moveSaidAt = -Infinity; lastMoveSteps = null; landmarkSeenAt = now();
          return { text: fit(`No answer. Heading for the ${proposal.name}. Say stop to stay.`), target: proposal.name, phase, haptic: 'CONFIRM' };
        }
        return emit(question(), proposal?.name);
      }
      if (phase === 'paused') return emit('Search paused. Say search again, or stop.');
      if (phase === 'move' && proposal) {
        const p = landmarks.find((l) => clean(l.name) === clean(proposal!.name) && now() - l.at <= FRESH_MS);
        const box: TargetBox | null = p ? { box: p.box, at: p.at } : null;
        // Use the confirmed landmark's box, never another object of a similar class.
        const g = box ? deps.guide.instructionFor(proposal.name, box, { modelOnly: true, maxAgeMs: FRESH_MS }) : null;
        if (g?.targetVisible) landmarkSeenAt = now();
        if (g?.kind === 'arrived' && g.box && g.box.at !== arrivalAt) { arrivalHits += 1; arrivalAt = g.box.at; }
        else if (g?.kind !== 'arrived') arrivalHits = 0;
        if (arrivalHits >= 2) return arrive();
        if (now() - moveAt > MOVE_GIVE_UP_MS) { refused.add(candidateKey(proposal)); resetScan(); return emit('That took too long. Let me look for another way.'); }
        if (!g?.targetVisible) {
          // Lost from view: keep walking the last bearing briefly, then stop and look.
          if (now() - landmarkSeenAt <= MOVE_LOST_GRACE_MS) return move(`Keep walking. Hold the camera level to find the ${proposal.name}.`, 'lost', proposal.name);
          return move(`Stop. Turn slowly until I see the ${proposal.name} again.`, 'lost-stop', proposal.name, 'STOP');
        }
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
          const blocked = p !== null && p.center >= 0.75;
          const far = map.distance(leg.from, pose) >= EXPLORE_LEG_M || (typeof legSteps === 'number' && legSteps - leg.steps0 >= EXPLORE_LEG_STEPS) || now() - leg.at >= EXPLORE_LEG_MS;
          if (blocked || far) {
            if (blocked) map.markBlocked(pose, pose.yawDeg);
            map.markScanned(pose);
            leg = null;
            resetScan(); saidAt = now();
            return { text: blocked ? 'Something ahead. Stop. Let me look around.' : 'Stop here. Let me look around.', target: targetWords, phase, haptic: blocked ? 'STOP' : 'CONFIRM' };
          }
          if (!leg.aligned) {
            // Still turning onto the leg's heading: keep the turn going, not a "drift" complaint.
            if (Math.abs(err) <= EXPLORE_DRIFT_DEG) leg.aligned = true;
            else return move(err > 0 ? 'Keep turning right.' : 'Keep turning left.', `turning:${err > 0 ? 'r' : 'l'}`, targetWords, 'TURN');
          }
          if (Math.abs(err) > EXPLORE_DRIFT_DEG) return move(err > 0 ? 'Drifting left. A little to the right.' : 'Drifting right. A little to the left.', `drift:${err > 0 ? 'r' : 'l'}`, targetWords, 'TURN');
          return move('Keep walking forward. I am looking as you walk.', 'leg', targetWords);
        }
        // No position: a few steps on, then look again.
        const steps = deps.steps?.();
        // The pedometer says the steps were taken, or enough time passed for them (no pedometer, or a slow walker).
        const walked = (typeof steps === 'number' && steps - advanceSteps0 >= ADVANCE_STEPS) || now() - advanceAt >= ADVANCE_MS;
        if (walked) { resetScan(); saidAt = now(); return { text: 'Stop here. Let me look around again.', target: targetWords, phase, haptic: 'CONFIRM' }; }
        return move(`Walk forward ${stepsWords(ADVANCE_STEPS)}, then I will look again.`, 'advance', targetWords);
      }
      if (pendingNarration && now() - saidAt >= 5000) { const line = pendingNarration; pendingNarration = followUp; followUp = null; return emit(line); }
      if (now() - observedAt > 15000) {
        if (now() - Math.max(startedAt, observedAt) > 30000) {
          phase = 'paused'; saidAt = -Infinity;
          return emit('No usable camera response. Say search again to retry.');
        }
        return emit('Hold the camera steady. I need a current view.');
      }
      if (quality !== 'usable') return emit(quality === 'dark' ? 'The view is dark. Aim toward a brighter area.' : 'The view is blocked or blurred. Hold the camera steady.');
      if (now() - scanAt >= SCAN_MS && now() - saidAt >= 5000) {
        if (scan >= 3) {
          // The right section (apples and oranges here, bananas wanted): search these shelves
          // closely before proposing anywhere else — the thing is probably within a few metres.
          if (section !== 'unknown' && area.section === section && !area.closeSearched && !opts.confined) {
            area.closeSearched = true;
            scan = 0; scanAt = now(); closeMode = true;
            return emit('This is the right section. Let me search these shelves closely.');
          }
          closeMode = false;
          if (opts.confined) {
            phase = 'paused'; saidAt = -Infinity;
            return emit('Item still unconfirmed. Say search again for another shelf scan.');
          }
          proposal = choose();
          if (proposal) { phase = 'permission'; permissionAt = now(); saidAt = -Infinity; return emit(question(), proposal.name); }
          if (map && pose) {
            // Round 12: go where we have not been. The depth grid vetoes blocked ways.
            map.markScanned(pose);
            const started = startLeg(pose);
            if (started) return started;
            phase = 'paused'; saidAt = -Infinity;
            return emit('I have covered this area. Ask someone nearby, or say search again.');
          }
          if (advances < ADVANCE_MAX) {
            advances += 1;
            phase = 'advance'; advanceAt = now(); advanceSteps0 = deps.steps?.() ?? 0; moveKey = null; moveSaidAt = -Infinity;
            return move(`No landmark yet. Walk forward ${stepsWords(ADVANCE_STEPS)}, then I will look again.`, 'advance', targetWords);
          }
          phase = 'paused'; saidAt = -Infinity;
          return emit('No way on from here. Ask someone nearby, or say search again.');
        }
        const corridor = deps.context === 'store' && /\baisle end|end of (?:the )?aisle|corridor\b/i.test(area.landmark ?? '');
        const text = (opts.surface || opts.confined || closeMode ? SHELVES : deps.context === 'store' ? (corridor ? CORRIDOR_SCANS : AISLE_SCANS) : SCANS)[scan]!;
        scan += 1; scanAt = now();
        return emit(text);
      }
      return { text: null, target, phase };
    },
    intercept(text) {
      if (/^(?:search again|keep looking|scan again|try again|look again)[.!]?$/i.test(text.trim())) { resetScan(); return { consumed: true, text: 'Resuming the search. Hold the camera steady.' }; }
      if (/^(?:where have we (?:looked|been)|what have we checked)[?!.]?$/i.test(text.trim())) {
        return { consumed: true, text: areas.some((a) => a.outcome === 'not_seen_in_scanned_views') ? 'We checked several views. Hidden items may still be there.' : 'We have only partly inspected this area.' };
      }
      if (phase !== 'permission') return { consumed: false, text: null };
      if (isAffirmative(text) && proposal && !lastConfined) {
        phase = 'move'; movementSteps = deps.steps?.() ?? 0; moveAt = now(); saidAt = -Infinity; moveKey = null; moveSaidAt = -Infinity; lastMoveSteps = null; landmarkSeenAt = now();
        void movementSteps;
        return { consumed: true, text: `Okay. Heading for the ${proposal.name}.` };
      }
      if (isNegative(text)) {
        if (proposal) refused.add(candidateKey(proposal));
        resetScan();
        return { consumed: true, text: 'We will stay here and inspect another angle.' };
      }
      return { consumed: false, text: null };
    },
    target: () => (phase === 'move' || phase === 'permission') && proposal ? proposal.name : null,
    context() {
      const prior = section === 'unknown' ? '' : `Likely category: ${section}; hypothesis only. `;
      const history = areas.slice(-6).map((a) => `${a.sign ?? a.landmark ?? a.id}: ${a.section}, ${a.outcome}, ${a.views.join('/')}`).join('; ');
      return `${prior}Search ${phase}. Inspect target and visible alternative landmarks. Memory: ${history}. Unseen is not absent. Never infer walking direction from category.`;
    },
    memory: () => areas.map((a) => ({ ...a, items: [...a.items], views: [...a.views] })),
    coverage: () => (map ? { visited: map.visitedCells(), scanned: map.scannedCells() } : null),
    pending: () => phase === 'permission' || phase === 'paused',
    status: () => phase,
    repeat: () => { saidAt = -Infinity; },
    restart: () => { resetScan(); advances = 0; },
    busy: () => phase === 'move' || phase === 'advance' || phase === 'permission',
    exploreNow(prefer = null) {
      // The current spot is done with: remember it as searched, then leave.
      if (area.outcome !== 'item_seen') area.outcome = 'not_seen_in_scanned_views';
      const pose = deps.pose?.() ?? null;
      if (map && pose) map.markScanned(pose);
      // A fresh landmark of the wanted kind (an aisle end, a doorway), without asking — the person asked.
      const wanted = prefer === 'aisle' ? 'aisle_end' : prefer === 'room' ? 'doorway' : null;
      const fresh = landmarks.filter((l) => now() - l.at <= FRESH_MS && l.confidence >= LANDMARK_MIN_CONFIDENCE && !refused.has(candidateKey(l)) && clean(l.name) !== clean(area.landmark ?? ''));
      const pick = (wanted ? fresh.find((l) => l.kind === wanted) : null) ?? choose() ?? fresh.sort((a, b) => b.confidence - a.confidence)[0] ?? null;
      if (pick) {
        proposal = pick;
        phase = 'move'; moveAt = now(); saidAt = -Infinity; moveKey = null; moveSaidAt = -Infinity; lastMoveSteps = null; landmarkSeenAt = now();
        return { text: fit(`Okay. Heading for the ${pick.name}.`), target: pick.name, phase, haptic: 'CONFIRM' };
      }
      if (map && pose) {
        const started = startLeg(pose, prefer === 'aisle');
        if (started) return { ...started, text: started.text ? fit(`Okay. ${started.text}`) : 'Okay. Exploring.' };
      }
      // No position and no landmark: the plain advance.
      advances = Math.min(advances, ADVANCE_MAX - 1);
      advances += 1;
      phase = 'advance'; advanceAt = now(); advanceSteps0 = deps.steps?.() ?? 0; moveKey = null; moveSaidAt = -Infinity;
      return { text: fit(`Okay. Walk forward ${stepsWords(ADVANCE_STEPS)}, then I will look again.`), target: targetWords, phase, haptic: 'CONFIRM' };
    },
    enterArea(landmark) {
      area = freshArea(); area.landmark = landmark; viewEvidence = new Set();
      signHits = 0; signCandidate = ''; narratedSection = 'unknown'; resetScan();
    },
  };
}
