import type { Guide, GuideInstruction, TargetBox } from './guide';
import { foodSection, sectionFromFoods, type FoodSection } from './foodCatalog';
import type { SearchLandmark, SearchObservation, SearchView } from './searchObservation';
import { isAffirmative, isNegative } from './yesNo';
import { countWords, findForbiddenTerm, hasDigit } from './phrases';

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
}
export interface SearchDirective {
  text: string | null;
  target: string;
  phase: 'scan' | 'permission' | 'move' | 'paused';
}
export interface SearchExplorer {
  observe(observation: SearchObservation | undefined, seq: number, capturedAt: number): void;
  tick(target: string, direct: GuideInstruction | null, opts?: { surface?: boolean; confined?: boolean }): SearchDirective | null;
  intercept(text: string): { consumed: boolean; text: string | null };
  target(): string | null;
  context(): string;
  memory(): SearchArea[];
  pending(): boolean;
  status(): SearchDirective['phase'];
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
  now?: () => number;
}

const FRESH_MS = 6000;
const SCAN_MS = 6000;
const SCANS = [
  'Stay still. Turn the camera slowly left.',
  'Now turn the camera slowly right.',
  'Turn around slowly so I can inspect behind you.',
  'Tilt the camera up to look for signs and doorways.',
];
const SHELVES = [
  'Pan slowly across the upper shelf.',
  'Now pan across the middle shelf.',
  'Tilt down and scan the lower shelf.',
  'Change the camera angle to see behind visible packages.',
];
const clean = (s: string): string => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const speakable = (s: string): boolean => !hasDigit(s) && !findForbiddenTerm(s) && countWords(s) <= 12;

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
  let narratedSection = 'unknown';
  let signCandidate = '';
  let signHits = 0;
  let movementSteps = 0;
  let lastMoveStep = -Infinity;
  let moveAt = 0;
  let arrivalAt = -Infinity;
  let arrivalHits = 0;
  let viewEvidence = new Set<string>();
  let refused = new Set<string>();
  let lastConfined = false;
  const startedAt = now();

  function freshArea(): SearchArea {
    const next: SearchArea = { id: `view-area-${++areaCount}`, sign: null, section: 'unknown', items: [], views: [], outcome: 'uninspected', visits: 1 };
    areas.push(next);
    if (areas.length > 24) areas.shift();
    return next;
  }
  const emit = (text: string, target = targetWords): SearchDirective => {
    const interval = phase === 'paused' ? 20000 : phase === 'permission' ? 15000 : 5000;
    const ready = now() - saidAt >= interval || saidAt === -Infinity;
    if (ready && speakable(text)) { saidAt = now(); return { text, target, phase }; }
    return { text: null, target, phase };
  };
  const resetScan = (): void => { scan = 0; scanAt = -Infinity; phase = 'scan'; proposal = null; arrivalHits = 0; saidAt = -Infinity; };
  const section = foodSection(deps.item);
  const candidateKey = (l: SearchLandmark): string => `${area.id}:${clean(l.name)}`;
  const choose = (): SearchLandmark | null => {
    const prior = clean(targetWords);
    return landmarks.filter((l) => now() - l.at <= FRESH_MS && l.hits >= 2 && l.confidence >= 0.8 && !refused.has(candidateKey(l)))
      .filter((l) => clean(l.name) !== clean(area.landmark ?? ''))
      .filter((l) => !areas.some((a) => a.sign && clean(a.sign) === clean(l.name) && a.outcome === 'not_seen_in_scanned_views'))
      .sort((a, b) => rank(b) - rank(a))[0] ?? null;
    function rank(l: SearchLandmark): number {
      return (clean(l.name).includes(prior) ? 20 : 0) + (section !== 'unknown' && l.section === section ? 10 : 0)
        + (deps.context === 'store' ? l.kind === 'aisle_end' ? 5 : 0 : l.kind === 'doorway' ? 4 : 0);
    }
  };
  const question = (): string => {
    if (deps.context === 'store') {
      if (proposal?.section !== 'unknown' && proposal?.section === section) return `May I guide you toward the ${section} section?`;
      return 'May I guide you toward another part of the store?';
    }
    return proposal?.kind === 'doorway' ? 'May I guide you toward the doorway to search elsewhere?' : 'May I guide you toward another visible surface to search?';
  };
  return {
    observe(o, seq, capturedAt) {
      if (!o || seq <= lastSeq || capturedAt > now() || now() - capturedAt > FRESH_MS) return;
      lastSeq = seq;
      observedAt = capturedAt;
      quality = o.confidence >= 0.75 ? o.quality : 'occluded';
      if (o.confidence < 0.75 || quality !== 'usable') return;
      const previous = landmarks;
      landmarks = o.landmarks.filter((l) => l.confidence >= 0.8).map((l) => ({ ...l, at: capturedAt, hits: (previous.find((p) => clean(p.name) === clean(l.name) && capturedAt - p.at <= 15000)?.hits ?? 0) + 1 }));
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
        const text = foods ? `${foods}. This seems to be ${area.section}.` : `This seems to be the ${area.section} section.`;
        if (speakable(text)) pendingNarration = text;
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
      // A found target always wins, including while permission is pending.
      if (direct?.targetVisible && !opts.surface) { resetScan(); return null; }
      if (phase === 'permission') return emit(question(), proposal?.name);
      if (phase === 'paused') return emit('Search paused. Say search again, or stop.');
      if (phase === 'move' && proposal) {
        if (quality !== 'usable' || now() - observedAt > FRESH_MS) return emit('Pause walking. I need a steady view of the landmark.', proposal.name);
        const p = landmarks.find((l) => clean(l.name) === clean(proposal!.name) && now() - l.at <= FRESH_MS);
        const box: TargetBox | null = p ? { box: p.box, at: p.at } : null;
        // Use the confirmed landmark's box, never another object of a similar class.
        const g = box ? deps.guide.instructionFor(proposal.name, box, { modelOnly: true, maxAgeMs: FRESH_MS }) : null;
        const steps = deps.steps?.() ?? movementSteps;
        if (g?.kind === 'arrived' && g.box && g.box.at !== arrivalAt) { arrivalHits += 1; arrivalAt = g.box.at; }
        else if (g?.kind !== 'arrived') arrivalHits = 0;
        if (arrivalHits >= 2 || steps - movementSteps >= 3) {
          area = freshArea(); area.landmark = proposal.name;
          viewEvidence = new Set(); signHits = 0; signCandidate = ''; narratedSection = 'unknown';
          resetScan();
          return emit('Pause here. Let me inspect this view.');
        }
        if (now() - moveAt > 45000) { refused.add(candidateKey(proposal)); resetScan(); return emit('Pause. Let us find another visible landmark.'); }
        if (!g?.targetVisible) return emit('Pause walking. Turn the camera slowly to find the landmark.', proposal.name);
        if (g.kind === 'sidestep') return emit('Pause. Something is in the way. Scan left and right.', proposal.name);
        if (g.relativeDeg !== null && Math.abs(g.relativeDeg) > 12) return emit(g.relativeDeg < 0 ? 'Turn left a little toward the visible landmark.' : 'Turn right a little toward the visible landmark.', proposal.name);
        // One requested step, then wait for pedometer progress. No timer can claim motion.
        if (steps === lastMoveStep) return emit('Pause and hold the camera steady.', proposal.name);
        if (now() - saidAt < 5000) return { text: null, target: proposal.name, phase };
        lastMoveStep = steps;
        return emit('Walk one step toward the visible landmark, then pause.', proposal.name);
      }
      if (pendingNarration && now() - saidAt >= 5000) { const line = pendingNarration; pendingNarration = null; return emit(line); }
      if (now() - observedAt > 15000) {
        if (now() - Math.max(startedAt, observedAt) > 30000) {
          phase = 'paused'; saidAt = -Infinity;
          return emit('No usable camera response. Say search again to retry.');
        }
        return emit('Hold the camera steady. I need a current view.');
      }
      if (quality !== 'usable') return emit(quality === 'dark' ? 'The view is dark. Aim toward a brighter area.' : 'The view is blocked or blurred. Hold the camera steady.');
      if (now() - scanAt >= SCAN_MS && now() - saidAt >= 5000) {
        if (scan >= 4) {
          if (opts.confined) {
            phase = 'paused'; saidAt = -Infinity;
            return emit('Item still unconfirmed. Say search again for another shelf scan.');
          }
          proposal = choose();
          if (proposal) { phase = 'permission'; saidAt = -Infinity; return emit(question(), proposal.name); }
          phase = 'paused'; saidAt = -Infinity;
          return emit('No route landmark found. Say search again, or ask someone nearby.');
        }
        const text = (opts.surface || opts.confined ? SHELVES : SCANS)[scan]!;
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
        phase = 'move'; movementSteps = deps.steps?.() ?? 0; lastMoveStep = -Infinity; moveAt = now(); saidAt = -Infinity;
        return { consumed: true, text: 'I will guide you toward the visible landmark, then scan.' };
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
    pending: () => phase === 'permission' || phase === 'paused',
    status: () => phase,
    repeat: () => { saidAt = -Infinity; },
    restart: resetScan,
    enterArea(landmark) {
      area = freshArea(); area.landmark = landmark; viewEvidence = new Set();
      signHits = 0; signCandidate = ''; narratedSection = 'unknown'; resetScan();
    },
  };
}
