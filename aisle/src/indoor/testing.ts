/**
 * Test helpers for `src/indoor/` and `src/perception/` (imported by *.test.ts only).
 * A store map in the 01 §6 shape and OCR-read builders; no production code imports this.
 */
import type { OcrRead } from '../core/contracts';
import type { AisleStoreMap } from './storeMap';

export function makeTestMap(): AisleStoreMap {
  return {
    storeId: 'test-store',
    displayName: 'Test Grocery',
    entrance: { lat: 40.4443, lng: -79.9436, radiusM: 35, pinnedBy: 'venue-walk', pinnedAt: '2026-09-18' },
    signHeightM: 2.4,
    aisles: [
      { id: 'a1', label: 'Aisle 1', spokenLabel: 'Aisle one', signText: ['1', 'PRODUCE'], order: 1, categories: ['produce', 'fruit', 'vegetables'] },
      { id: 'a2', label: 'Aisle 2', spokenLabel: 'Aisle two', signText: ['2', 'BAKERY'], order: 2, categories: ['bakery', 'bread'] },
      { id: 'a3', label: 'Aisle 3', spokenLabel: 'Aisle three', signText: ['3', 'DAIRY'], order: 3, categories: ['dairy', 'eggs', 'milk', 'cheese'] },
      { id: 'a4', label: 'Aisle 4', spokenLabel: 'Aisle four', signText: ['4', 'CEREAL'], order: 4, categories: ['cereal', 'breakfast'] },
      { id: 'a5', label: 'Aisle 5', spokenLabel: 'Aisle five', signText: ['5', 'DELI'], order: 5, categories: ['deli', 'meat'] },
      { id: 'a6', label: 'Aisle 6', spokenLabel: 'Aisle six', signText: ['6', 'FROZEN'], order: 6, categories: ['frozen', 'ice cream'] },
      { id: 'a7', label: 'Aisle 7', spokenLabel: 'Aisle seven', signText: ['7', 'SNACKS'], order: 7, categories: ['snacks', 'chips'] },
      { id: 'a8', label: 'Aisle 8', spokenLabel: 'Aisle eight', signText: ['8', 'PAPER'], order: 8, categories: ['paper', 'towels'] },
    ],
    landmarks: [
      { id: 'checkout', label: 'Checkout', spokenLabel: 'Checkout', signText: ['CHECKOUT', 'REGISTERS', 'LANES'], afterAisleOrder: 99 },
      { id: 'entrance', label: 'Entrance', spokenLabel: 'Entrance', signText: ['WELCOME', 'ENTRANCE'], afterAisleOrder: 0 },
    ],
    itemIndex: {
      eggs: { aisleId: 'a3', sideWhenAscending: 'RIGHT', shelf: 'middle', packageHint: 'yellow carton' },
      milk: { aisleId: 'a3', sideWhenAscending: 'RIGHT' },
      bread: { aisleId: 'a2', sideWhenAscending: 'LEFT' },
      chips: { aisleId: 'a7', sideWhenAscending: 'LEFT' },
    },
  };
}

export function read(text: string, t = 0, box: [number, number, number, number] = [0.45, 0.08, 0.14, 0.05], confidence = 0.9): OcrRead {
  return { text, box, confidence, timestamp: t };
}

/** A fake clock for tests: `now()` reads it, `advance(ms)` moves it. */
export function fakeClock(start = 100_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
      return t;
    },
    set(v: number) {
      t = v;
    },
  };
}
