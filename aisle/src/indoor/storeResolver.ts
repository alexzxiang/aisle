/**
 * Store resolution (04 Task 0): map load, item → aisle, target hand-off.
 *
 * Trigger: `ITEM_REQUESTED {item}` on the bus. One resolver, idempotent,
 * re-runnable on a second request.
 *
 *   1. Load and validate the map (`storeMap.ts`); a bad map is ERROR
 *      {scope: 'store-map'}, never a silent null.
 *   2. Normalize the item like OCR text and look it up in `itemIndex`;
 *      `targetOrder` is the aisle's `order` from `aisles[]`, never parsed.
 *   3. Item absent → B's `disambiguate` job through the injected runner (1.5 s
 *      first token; category-substring fallback). `aisleId` → use it with the side
 *      unknown; `askBack` → speak it once (INFO) and wait for the next request.
 *   4. Nothing resolves → cached `ask_staff`, ERROR {scope: 'store-resolve'},
 *      target null. The indoor leg still runs; the navigator never claims an arrival.
 *   5. Hand the target to A's store: `setStoreId` and `setTargetAisle(aisleId, null)`
 *      (A's existing actions; `targetSide` is A's from TARGET_AISLE_REACHED).
 *   6. Prime OCR (`setKnownSigns`) and pre-synthesize every variable indoor phrase,
 *      ≤ 4 at a time, while the user is still outdoors.
 */
import type {
  DisambiguateInput,
  DisambiguateOutput,
  PerceptionService,
  PlannerResult,
  Side,
  SpeechService,
} from '../core/contracts';
import type { AppEventBus } from '../core/bus';
import type { AppStore } from '../core/store';
import { hasDigit, phraseText } from '../core/phrases';
import { arrivalText } from './navigator';
import { normalizeText } from './ocrMatcher';
import { OBSTACLE_PREFETCH_TEXTS } from './obstacles';
import { pickupPrefetchTexts } from './itemPickup';
import { type AisleStoreMap, aisleById, signVocabulary, validateStoreMap } from './storeMap';

export const DEMO_STORE_ID = 'demo-store-01';
export const PREFETCH_CONCURRENCY = 4;

export interface ResolvedTarget {
  storeId: string;
  /** Spoken item (lower case, words only) or null when it cannot be spoken. */
  item: string | null;
  /** The request as typed / recognized. */
  requestedItem: string;
  aisleId: string;
  order: number;
  spokenLabel: string;
  sideWhenAscending: Side | null;
  shelf?: string;
  packageHint?: string;
  source: 'index' | 'disambiguate' | 'fallback';
}

export type ResolveOutcome =
  | { kind: 'resolved'; target: ResolvedTarget }
  | { kind: 'ask_back'; text: string }
  | { kind: 'unresolved' }
  | { kind: 'map_error'; errors: string[] };

export type DisambiguateRunner = (input: DisambiguateInput) => Promise<PlannerResult<DisambiguateOutput>>;

// ---------------------------------------------------------------------------
// Pure pieces
// ---------------------------------------------------------------------------

/** Items are normalized exactly like OCR text (04 Task 0 step 2), then lower-cased for the index. */
export function normalizeItem(raw: string): string {
  return normalizeText(raw).toLowerCase();
}

/** Speakable form of the request: null when it carries a digit (A rejects digits in text). */
export function speakableItem(raw: string): string | null {
  const s = normalizeItem(raw);
  if (!s || hasDigit(s)) return null;
  return s;
}

export function resolveFromIndex(map: AisleStoreMap, rawItem: string): ResolvedTarget | null {
  const key = normalizeItem(rawItem);
  const entry = map.itemIndex[key] ?? Object.entries(map.itemIndex).find(([k]) => normalizeItem(k) === key)?.[1];
  if (!entry) return null;
  const aisle = aisleById(map, entry.aisleId);
  if (!aisle) return null;
  return {
    storeId: map.storeId,
    item: speakableItem(rawItem),
    requestedItem: rawItem,
    aisleId: aisle.id,
    order: aisle.order,
    spokenLabel: aisle.spokenLabel,
    sideWhenAscending: entry.sideWhenAscending,
    ...(entry.shelf ? { shelf: entry.shelf } : {}),
    ...(entry.packageHint ? { packageHint: entry.packageHint } : {}),
    source: 'index',
  };
}

/** 01 §9 fallback for `disambiguate`: category substring match, unique or nothing. */
export function categoryFallback(map: AisleStoreMap, rawItem: string): DisambiguateOutput {
  const key = normalizeItem(rawItem);
  if (!key) return { aisleId: null, confidence: 0, askBack: null };
  const hits = map.aisles.filter((a) => a.categories.some((c) => {
    const cat = normalizeItem(c);
    return cat === key || cat.includes(key) || key.includes(cat);
  }));
  if (hits.length === 1) return { aisleId: hits[0]!.id, confidence: 0.6, askBack: null };
  return { aisleId: null, confidence: 0, askBack: null };
}

export function targetFromDisambiguation(map: AisleStoreMap, rawItem: string, out: DisambiguateOutput, source: 'disambiguate' | 'fallback'): ResolvedTarget | null {
  if (!out.aisleId) return null;
  const aisle = aisleById(map, out.aisleId);
  if (!aisle) return null;
  return {
    storeId: map.storeId,
    item: speakableItem(rawItem),
    requestedItem: rawItem,
    aisleId: aisle.id,
    order: aisle.order,
    spokenLabel: aisle.spokenLabel,
    sideWhenAscending: null,
    source,
  };
}

/** Every variable indoor phrase to pre-synthesize once the target is known (04 Task 0 step 6). */
export function prefetchTexts(map: AisleStoreMap, target: ResolvedTarget | null): string[] {
  const out = new Set<string>();
  for (const a of map.aisles) out.add(`${a.spokenLabel.replace(/\.+$/, '')}.`);
  for (const l of map.landmarks) out.add(`${l.spokenLabel.replace(/\.+$/, '')}.`);
  if (target) {
    const base = { aisleId: target.aisleId, order: target.order, spokenLabel: target.spokenLabel, item: target.item, sideWhenAscending: target.sideWhenAscending };
    out.add(arrivalText(base, null));
    if (target.item) {
      out.add(arrivalText(base, 'LEFT'));
      out.add(arrivalText(base, 'RIGHT'));
    }
    for (const t of pickupPrefetchTexts('LEFT')) out.add(t);
    for (const t of pickupPrefetchTexts('RIGHT')) out.add(t);
    for (const t of pickupPrefetchTexts(null)) out.add(t);
  }
  for (const t of OBSTACLE_PREFETCH_TEXTS) out.add(t);
  return Array.from(out);
}

/** Run `fn` over `items` with at most `limit` in flight (ElevenLabs free-plan concurrency is 4). */
export async function runBatched<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  let i = 0;
  const worker = async (): Promise<void> => {
    while (i < items.length) {
      const item = items[i]!;
      i += 1;
      try {
        await fn(item);
      } catch {
        // pre-synthesis is best effort; say() falls back to expo-speech
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export interface StoreResolverOptions {
  bus: Pick<AppEventBus, 'emit' | 'on'>;
  store: Pick<AppStore, 'getState'>;
  speech: Pick<SpeechService, 'say'>;
  perception: Pick<PerceptionService, 'setKnownSigns'>;
  /** The raw store map (a static JSON import) or a loader; validated here. */
  loadStoreMap: () => unknown | Promise<unknown>;
  /** B's planner client for the `disambiguate` job; optional (fallback only when absent). */
  disambiguate?: DisambiguateRunner;
  /** A's `AisleSpeechService.prefetch`; optional. */
  prefetch?: (text: string) => Promise<unknown>;
  /** Loud DebugPanel line for a bad map (04 Task 0 step 1). Default console.warn. */
  warn?: (message: string) => void;
}

export interface StoreResolver {
  resolve(item: string, source?: 'voice' | 'keyboard' | 'mock'): Promise<ResolveOutcome>;
  getTarget(): ResolvedTarget | null;
  getMap(): AisleStoreMap | null;
  /** Fires on every resolution, with null when nothing resolved. */
  onTarget(cb: (t: ResolvedTarget | null, outcome: ResolveOutcome) => void): () => void;
  /** Loads and validates the map without a request (App start). */
  ensureMap(): Promise<AisleStoreMap | null>;
  /**
   * Round 4: a synthesized map for a place the user named ("take me to CVS") — no aisles,
   * entrance = the place. It replaces the loaded map until `restoreMap()`; `getMap()` returns it.
   */
  useMap(m: AisleStoreMap): void;
  restoreMap(): void;
  dispose(): void;
}

export function createStoreResolver(opts: StoreResolverOptions): StoreResolver {
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  let map: AisleStoreMap | null = null;
  let mapErrors: string[] | null = null;
  let mapLoading: Promise<AisleStoreMap | null> | null = null;
  let target: ResolvedTarget | null = null;
  let overridden: AisleStoreMap | null = null;   // the loaded map, while a POI map is in use
  let primed = false;
  const listeners = new Set<(t: ResolvedTarget | null, o: ResolveOutcome) => void>();

  const ensureMap = async (): Promise<AisleStoreMap | null> => {
    if (map) return map;
    if (mapErrors) return null;
    if (!mapLoading) {
      mapLoading = (async () => {
        let raw: unknown;
        try {
          raw = await opts.loadStoreMap();
        } catch (err) {
          raw = null;
          mapErrors = [err instanceof Error ? err.message : String(err)];
        }
        const v = mapErrors ? null : validateStoreMap(raw);
        if (!v || !v.ok) {
          mapErrors = v ? v.errors : mapErrors ?? ['store map failed to load'];
          const message = `store map invalid: ${mapErrors.join('; ')}`;
          warn(`[store-map] ${message}`);
          opts.bus.emit({ type: 'ERROR', scope: 'store-map', message });
          return null;
        }
        for (const w of v.warnings) warn(`[store-map] ${w}`);
        map = v.map;
        return map;
      })();
    }
    return mapLoading;
  };

  const prime = (m: AisleStoreMap): void => {
    if (primed) return;
    primed = true;
    try {
      opts.perception.setKnownSigns(signVocabulary(m));
    } catch {
      // the module may not be started yet; the controller re-primes on start
    }
  };

  const notify = (o: ResolveOutcome): void => {
    for (const cb of Array.from(listeners)) cb(target, o);
  };

  const handoff = (m: AisleStoreMap, t: ResolvedTarget | null): void => {
    const s = opts.store.getState();
    s.setStoreId(m.storeId);
    s.setTargetAisle(t ? t.aisleId : null, null);
  };

  const resolve = async (item: string): Promise<ResolveOutcome> => {
    const m = await ensureMap();
    if (!m) {
      target = null;
      const o: ResolveOutcome = { kind: 'map_error', errors: mapErrors ?? [] };
      notify(o);
      return o;
    }
    prime(m);

    let resolved = resolveFromIndex(m, item);
    let outcome: ResolveOutcome;

    if (!resolved) {
      let out: DisambiguateOutput | null = null;
      if (opts.disambiguate) {
        try {
          const r = await opts.disambiguate({ item: normalizeItem(item), storeMap: m });
          out = r.output;
          if (out.aisleId) resolved = targetFromDisambiguation(m, item, out, r.fallback ? 'fallback' : 'disambiguate');
        } catch {
          out = null;
        }
      }
      if (!resolved && (!out || !out.askBack)) {
        const fb = categoryFallback(m, item);
        if (fb.aisleId) resolved = targetFromDisambiguation(m, item, fb, 'fallback');
      }
      if (!resolved && out?.askBack) {
        target = null;
        handoff(m, null);
        opts.speech.say({ text: out.askBack, priority: 'INFO', dedupeKey: 'ask_back', cooldownMs: 8000 });
        outcome = { kind: 'ask_back', text: out.askBack };
        notify(outcome);
        return outcome;
      }
    }

    if (!resolved) {
      target = null;
      handoff(m, null);
      opts.speech.say({ text: phraseText('ask_staff'), priority: 'NAV', cacheKey: 'ask_staff', dedupeKey: 'ask_staff', cooldownMs: 30_000 });
      opts.bus.emit({ type: 'ERROR', scope: 'store-resolve', message: `no aisle for '${item}'` });
      outcome = { kind: 'unresolved' };
      notify(outcome);
      return outcome;
    }

    target = resolved;
    handoff(m, resolved);
    outcome = { kind: 'resolved', target: resolved };
    notify(outcome);

    if (opts.prefetch) {
      const texts = prefetchTexts(m, resolved);
      void runBatched(texts, PREFETCH_CONCURRENCY, (t) => opts.prefetch!(t));
    }
    return outcome;
  };

  const unsub = opts.bus.on('ITEM_REQUESTED', (e) => {
    void resolve(e.item);
  });

  return {
    resolve,
    getTarget: () => target,
    getMap: () => map,
    onTarget(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    ensureMap,
    useMap(m) {
      if (overridden === null) overridden = map;
      map = m;
      target = null;
      opts.store.getState().setStoreId(m.storeId);
      opts.perception.setKnownSigns(signVocabulary(m));
    },
    restoreMap() {
      if (overridden === null) return;
      map = overridden;
      overridden = null;
      target = null;
      if (map) opts.perception.setKnownSigns(signVocabulary(map));
    },
    dispose() {
      unsub();
      listeners.clear();
    },
  };
}
