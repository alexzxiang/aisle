/**
 * Where a thing probably is when the camera cannot see it (round 11, Stream A).
 *
 * A sighted friend asked for the bananas does not stare at the wall until bananas appear;
 * they think "bananas live on the counter or in the fruit bowl; the counter is over there"
 * and walk. This module is that thinking, kept small and explicit so it can be said out
 * loud in one short sentence per step:
 *
 *   1. what the person said       "on the table"           → the table, before anything else
 *   2. where such things usually  eggs → fridge; keys → table, counter, desk, hook by the door;
 *      live                        remote → couch, coffee table; cereal → cabinet, shelf …
 *   3. what the phone can act on   a place in view beats one remembered from earlier beats
 *                                  one never seen
 *   4. what has been ruled out     a place already scanned without the item is dropped and
 *                                  named later ("I have checked the counter and the table.")
 *
 * Some places are containers: the item is *inside*, so arriving is not enough — the door
 * or drawer must be opened first (`opens`). Nothing here is a detection; a hypothesis is
 * spoken as "usually" / "maybe" and the camera decides.
 */
import type { DetectionClass } from './contracts';
import { classForWords } from './sceneMemory';

export interface PlaceHypothesis {
  /** The place in words the navigator and the detector both understand ("counter", "fridge"). */
  place: string;
  cls: DetectionClass | null;
  /** Commonsense weight 0..1 before evidence. */
  prior: number;
  /** The item would be inside: a door or drawer has to be opened before scanning. */
  opens: boolean;
  why: 'stated' | 'usual';
}

type Usual = ReadonlyArray<[place: string, prior: number]>;
const OPENS = new Set(['fridge', 'freezer', 'cabinet', 'drawer', 'wardrobe', 'dishwasher', 'microwave', 'oven', 'box']);

/** Item words → usual places, best first. The first regex that matches wins. */
const USUAL: ReadonlyArray<[RegExp, Usual]> = [
  [/\b(?:ice ?cream|frozen|popsicles?)\b/, [['freezer', 0.9], ['fridge', 0.5]]],
  [/\b(?:eggs?|milk|cheese|yogu?rt|butter|cream|juice|leftovers?|soda|beer|wine|jam|ketchup|mustard|sauce|salad|meat|chicken|fish|deli)\b/, [['fridge', 0.9], ['countertop', 0.2], ['table', 0.15]]],
  [/\b(?:bananas?|apples?|oranges?|pears?|peach(?:es)?|grapes?|lemons?|limes?|fruit|avocados?|tomato(?:es)?)\b/, [['countertop', 0.5], ['table', 0.45], ['bowl', 0.4], ['fridge', 0.25]]],
  [/\b(?:bread|bagels?|loaf|buns?|rolls?|toast|muffins?|croissants?)\b/, [['countertop', 0.6], ['table', 0.3], ['cabinet', 0.3], ['fridge', 0.15]]],
  [/\b(?:cereal|pasta|rice|oats?|flour|sugar|chips|crackers|cookies|snacks?|cans?|beans|soup|tea|coffee|spices?)\b/, [['cabinet', 0.6], ['shelf', 0.45], ['countertop', 0.35], ['table', 0.15]]],
  [/\b(?:keys?|wallet|purse|glasses|sunglasses|earbuds|headphones|charger|watch)\b/, [['table', 0.45], ['countertop', 0.4], ['desk', 0.35], ['couch', 0.25], ['nightstand', 0.25], ['door', 0.2]]],
  [/\b(?:phone|cell ?phone|tablet|ipad|laptop|computer)\b/, [['desk', 0.5], ['table', 0.45], ['couch', 0.3], ['nightstand', 0.3], ['countertop', 0.25], ['bed', 0.2]]],
  [/\b(?:remote|remote control|controller)\b/, [['couch', 0.6], ['table', 0.5], ['tv', 0.35], ['bed', 0.2]]],
  [/\b(?:cups?|mugs?|glass(?:es)?|plates?|bowls?)\b/, [['cabinet', 0.5], ['sink', 0.4], ['countertop', 0.4], ['dishwasher', 0.3], ['table', 0.3]]],
  [/\b(?:forks?|knives|knife|spoons?|cutlery|silverware|utensils?)\b/, [['drawer', 0.7], ['sink', 0.3], ['countertop', 0.25], ['dishwasher', 0.25]]],
  [/\b(?:pans?|pots?|skillet|wok|kettle|toaster|blender)\b/, [['stove', 0.5], ['countertop', 0.5], ['cabinet', 0.4]]],
  [/\b(?:water|bottle|bottled water)\b/, [['fridge', 0.5], ['countertop', 0.4], ['table', 0.35], ['desk', 0.2]]],
  [/\b(?:pillows?|blankets?|sheets?)\b/, [['bed', 0.7], ['couch', 0.5], ['wardrobe', 0.2]]],
  [/\b(?:towels?|toothbrush|toothpaste|soap|shampoo|razor)\b/, [['sink', 0.5], ['shower', 0.45], ['bathtub', 0.3], ['cabinet', 0.3]]],
  [/\b(?:medicine|pills?|medication|tablets|vitamins?|bandages?)\b/, [['cabinet', 0.5], ['sink', 0.35], ['nightstand', 0.3], ['countertop', 0.25]]],
  [/\b(?:shoes?|sneakers?|boots?|slippers?|coat|jacket|umbrella|bag|backpack)\b/, [['door', 0.5], ['wardrobe', 0.4], ['chair', 0.2], ['bed', 0.15]]],
  [/\b(?:books?|notebook|magazine|newspaper|papers?)\b/, [['shelf', 0.5], ['desk', 0.4], ['table', 0.35], ['nightstand', 0.3], ['couch', 0.2]]],
  [/\b(?:clothes|shirt|sweater|pants|socks|jeans)\b/, [['wardrobe', 0.6], ['drawer', 0.5], ['bed', 0.3], ['chair', 0.25]]],
  [/\b(?:candles?|lamps?|lighter|matches)\b/, [['table', 0.4], ['shelf', 0.35], ['nightstand', 0.3], ['drawer', 0.3]]],
  [/\b(?:pens?|pencils?|scissors|tape|stapler)\b/, [['desk', 0.6], ['drawer', 0.45], ['table', 0.3]]],
  [/\b(?:trash|garbage|bin)\b/, [['trash_can', 0.9], ['sink', 0.3], ['door', 0.2]]],
];

/** Usual places for an item, best first; empty when nothing is known. */
export function usualPlaces(item: string): PlaceHypothesis[] {
  const w = item.toLowerCase();
  for (const [re, places] of USUAL) {
    if (re.test(w)) return places.map(([place, prior]) => ({ place, cls: classForWords(place), prior, opens: OPENS.has(place), why: 'usual' as const }));
  }
  return [];
}

export type PlaceEvidence = 'visible' | 'remembered' | 'unseen';

/**
 * Ranked hypotheses for where to look next: the stated place first, then usual places by
 * prior × what the phone can act on; places already tried are dropped.
 */
export function rankHypotheses(item: string, statedPlace: string | null, tried: readonly string[], evidence: (place: string) => PlaceEvidence): PlaceHypothesis[] {
  const done = new Set(tried.map((p) => p.toLowerCase()));
  const weight: Record<PlaceEvidence, number> = { visible: 1, remembered: 0.8, unseen: 0.5 };
  const out: Array<PlaceHypothesis & { score: number }> = [];
  if (statedPlace && !done.has(statedPlace.toLowerCase())) {
    out.push({ place: statedPlace, cls: classForWords(statedPlace), prior: 1, opens: OPENS.has(classForWords(statedPlace) ?? statedPlace), why: 'stated', score: 10 });
  }
  for (const h of usualPlaces(item)) {
    if (done.has(h.place) || (statedPlace && (statedPlace.toLowerCase() === h.place || classForWords(statedPlace) === h.cls))) continue;
    out.push({ ...h, score: h.prior * weight[evidence(h.place)] });
  }
  return out.sort((a, b) => b.score - a.score).map(({ score, ...h }) => { void score; return h; });
}

/** The spoken reason for heading somewhere: "No bananas in view. They are usually on the counter." */
export function hypothesisLine(itemName: string, plural: boolean, h: PlaceHypothesis, first: boolean, previous: string | null): string {
  const prep = h.opens ? 'in' : h.place === 'door' ? 'by' : 'on';
  const be = plural ? 'are' : 'is';
  if (h.why === 'stated') return `Heading for the ${h.place}.`;
  if (first) return `No ${itemName} in view. ${plural ? 'They' : 'It'} ${be} usually ${prep} the ${spoken(h.place)}.`;
  return `Not ${previous ? `${prepFor(previous)} the ${spoken(previous)}` : 'there'}. Maybe ${prep} the ${spoken(h.place)}.`;
}

/** "I have checked the counter and the table." */
export function checkedLine(tried: readonly string[]): string {
  const names = tried.map(spoken);
  if (names.length === 0) return 'I have not found it yet.';
  if (names.length === 1) return `I have checked the ${names[0]}.`;
  return `I have checked the ${names.slice(0, -1).join(', the ')} and the ${names[names.length - 1]}.`;
}

function prepFor(place: string): string {
  return OPENS.has(place) ? 'in' : place === 'door' ? 'by' : 'on';
}

export function spoken(place: string): string {
  return place.replace(/_/g, ' ').replace(/^countertop$/, 'counter').replace(/^trash can$/, 'bin');
}

/** "try the cabinet", "check the fridge", "it's on the table", "look in the drawer" → the place, or null. */
export function statedPlaceIn(transcript: string): string | null {
  const t = transcript.trim().toLowerCase().replace(/[.!?]+$/, '');
  const m = t.match(/^(?:(?:please |can you |could you )?(?:try|check|look|search)(?: in| on| at| inside| by| under)?|it(?:'s| is)(?: probably| maybe| usually)?(?: in| on| at| inside| by)|maybe(?: in| on| at)?|(?:in|on|at|inside) )\s*(?:the |my |a |an )?([a-z][a-z ]{1,30})$/);
  const words = m?.[1]?.trim() ?? null;
  if (!words) return null;
  const cls = classForWords(words);
  if (!cls && !/^(?:counter|cabinet|drawer|shelf|pantry|closet|hook)/.test(words)) return null;
  if (cls === 'fridge' && /\bfreezer\b/.test(words)) return 'freezer';
  return cls ?? words;
}
