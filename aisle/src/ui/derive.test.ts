import { APP_MODES } from '../core/store';
import type { AppEvent, AppMode } from '../core/contracts';
import { findForbidden, wordCount, MAX_UTTERANCE_WORDS } from './copy';
import {
  EMPTY_FACTS,
  ERROR_TTL_MS,
  INSTRUCTION_TTL_MS,
  ageText,
  bandSignal,
  errorSentence,
  heroText,
  isCurrent,
  modeWord,
  reduceUi,
  scanSentence,
  signalWord,
  standingHero,
  stripSlots,
  visibleError,
  type Instruction,
  type UiFacts,
  awarenessSlots,
  detectionSummary,
  AWARENESS_STRIP_MODES,
} from './derive';

const T0 = 1_700_000_000_000;

function run(events: Array<[AppEvent, number]>, from: UiFacts = EMPTY_FACTS): UiFacts {
  return events.reduce((f, [e, ts]) => reduceUi(f, e, ts), from);
}

describe('wording rules', () => {
  const contexts = [
    { item: null, side: null },
    { item: 'eggs', side: 'RIGHT' as const },
  ];

  it.each(APP_MODES)('%s: mode word and standing hero are short, clean, sentence case', (mode) => {
    const w = modeWord(mode);
    expect(w.length).toBeGreaterThan(0);
    expect(w).not.toMatch(/[A-Z]{2,}/);
    expect(findForbidden(w)).toEqual([]);
    for (const ctx of contexts) {
      const h = standingHero(mode, EMPTY_FACTS, ctx);
      expect(wordCount(h)).toBeLessThanOrEqual(MAX_UTTERANCE_WORDS);
      expect(findForbidden(h)).toEqual([]);
    }
  });

  it('signal words are stated, never only coloured', () => {
    expect(signalWord('WALK')).toBe('walk');
    expect(signalWord('DONT_WALK')).toBe('hand');
    expect(signalWord('COUNTDOWN')).toBe('countdown');
    expect(signalWord('UNKNOWN')).toBe('not seen');
  });

  it('scan sentences report perception, never permission (00 principle 8)', () => {
    expect(scanSentence('LEFT', 'none')).toBe('No vehicles seen to the left');
    expect(scanSentence('RIGHT', 'approaching')).toBe('Vehicle approaching from the right');
    expect(scanSentence('LEFT', 'unclear')).toBe("Can't see well to the left");
    expect(scanSentence('RIGHT', 'distant')).toBe('Vehicle in the distance to the right');
    for (const side of ['LEFT', 'RIGHT'] as const) {
      for (const seen of ['none', 'distant', 'approaching', 'unclear'] as const) {
        expect(findForbidden(scanSentence(side, seen))).toEqual([]);
      }
    }
  });
});

describe('reduceUi', () => {
  it('returns the same object for events the band does not show', () => {
    const e: AppEvent = { type: 'ITEM_REQUESTED', item: 'eggs', source: 'keyboard' };
    expect(reduceUi(EMPTY_FACTS, e, T0)).toBe(EMPTY_FACTS);
    expect(reduceUi(EMPTY_FACTS, { type: 'COURSE_DEVIATION', meters: 1, side: 'LEFT' }, T0)).toBe(EMPTY_FACTS);
  });

  it('a leg instruction becomes the hero and never expires', () => {
    const f = run([[{ type: 'OUTDOOR_LEG_ADVANCED', index: 0, instruction: 'Turn right in twenty feet' }, T0]]);
    expect(heroText('OUTDOOR_NAV', f, T0)).toBe('Turn right in twenty feet');
    expect(heroText('OUTDOOR_NAV', f, T0 + 10 * 60_000)).toBe('Turn right in twenty feet');
  });

  it('crossing ahead states the street and whether it is signalized', () => {
    const base = { type: 'CROSSING_AHEAD' as const, crossingId: 'x1', street: 'Forbes', pushButtonLikely: true, bearingDeg: 90, distanceM: 25 };
    expect(heroText('APPROACH_CROSSING', run([[{ ...base, signalized: true }, T0]]), T0)).toBe('Crossing ahead: Forbes. Signalized.');
    expect(heroText('APPROACH_CROSSING', run([[{ ...base, signalized: false }, T0]]), T0)).toBe('Crossing ahead: Forbes. No signal here.');
    expect(heroText('APPROACH_CROSSING', run([[{ ...base, signalized: null }, T0]]), T0)).toBe('Crossing ahead: Forbes.');
  });

  it('signal states: fresh WALK, already-on WALK, hand, countdown; UNKNOWN is silent', () => {
    const at = (state: 'WALK' | 'DONT_WALK' | 'COUNTDOWN' | 'UNKNOWN', fresh: boolean): UiFacts =>
      run([[{ type: 'SIGNAL_STATE', state, fresh, confidence: 0.9 }, T0]]);
    expect(heroText('AT_CURB', at('WALK', true), T0)).toBe('Walk signal on');
    expect(heroText('AT_CURB', at('WALK', false), T0)).toBe('Walk already on. Wait for the next one');
    expect(heroText('AT_CURB', at('DONT_WALK', true), T0)).toBe("Don't walk");
    expect(heroText('AT_CURB', at('COUNTDOWN', true), T0)).toBe('Countdown');
    const unknown = at('UNKNOWN', true);
    expect(unknown.instruction).toBeNull();
    expect(heroText('AT_CURB', unknown, T0)).toBe("Can't see the signal");
    expect(bandSignal(unknown)).toBe('UNKNOWN');
    expect(bandSignal(at('WALK', true))).toBe('WALK');
  });

  it('a vehicle warning is the hero for four seconds, then the standing instruction returns', () => {
    const f = run([
      [{ type: 'OUTDOOR_LEG_ADVANCED', index: 0, instruction: 'Keep walking on Forbes' }, T0],
      [{ type: 'VEHICLE_APPROACHING', direction: 'RIGHT', trackId: 3 }, T0 + 1000],
    ]);
    expect(heroText('AT_CURB', f, T0 + 1000)).toBe('Vehicle right');
    // No signal reading yet at the curb: the alignment prompt, not a premature "can't see".
    expect(heroText('AT_CURB', f, T0 + 1000 + INSTRUCTION_TTL_MS.vehicle)).toBe('Line up with the crossing');
    expect(heroText('OUTDOOR_NAV', f, T0 + 1000 + INSTRUCTION_TTL_MS.vehicle)).toBe('Keep walking');
  });

  it('at the curb the standing hero follows what is known: unsignalized, unread, UNKNOWN, a state', () => {
    const cross = (signalized: boolean | null): AppEvent => ({
      type: 'CROSSING_AHEAD', crossingId: 'x', street: 'Forbes', signalized, pushButtonLikely: false, bearingDeg: 0, distanceM: 20,
    });
    expect(standingHero('AT_CURB', run([[cross(false), T0]]))).toBe('No signal here. Listen for traffic');
    expect(standingHero('AT_CURB', run([[cross(true), T0]]))).toBe('Line up with the crossing');
    expect(standingHero('AT_CURB', EMPTY_FACTS)).toBe('Line up with the crossing');
    const unknown = run([[cross(true), T0], [{ type: 'SIGNAL_STATE', state: 'UNKNOWN', fresh: false, confidence: 0 }, T0 + 1]]);
    expect(standingHero('AT_CURB', unknown)).toBe("Can't see the signal");
    const hand = run([[cross(true), T0], [{ type: 'SIGNAL_STATE', state: 'DONT_WALK', fresh: true, confidence: 0.9 }, T0 + 1]]);
    expect(standingHero('AT_CURB', hand)).toBe("Don't walk");
  });

  it('while a route is being planned, Home says so', () => {
    expect(standingHero('IDLE', EMPTY_FACTS, { item: 'eggs', side: null })).toBe('Planning a route for eggs');
    expect(standingHero('IDLE', EMPTY_FACTS, { item: null, side: null })).toBe('What do you need?');
  });

  it('obstacles and hazards say what is ahead', () => {
    expect(heroText('INDOOR_NAV', run([[{ type: 'OBSTACLE_AHEAD', distanceClass: 'NEAR', direction: 'CENTER' }, T0]]), T0)).toBe('Obstacle ahead');
    expect(heroText('INDOOR_NAV', run([[{ type: 'HAZARD', kind: 'CART_AHEAD', direction: 'LEFT' }, T0]]), T0)).toBe('Cart ahead');
    expect(heroText('INDOOR_NAV', run([[{ type: 'HAZARD', kind: 'PERSON_AHEAD', direction: 'LEFT' }, T0]]), T0)).toBe('Person ahead');
  });

  it('scan results read as the perception report', () => {
    const f = run([[{ type: 'SCAN_RESULT', side: 'LEFT', vehiclesSeen: 'none', source: 'detector' }, T0]]);
    expect(heroText('AT_CURB', f, T0)).toBe('No vehicles seen to the left');
  });

  it('store entry, checkout, far curb and abort update the hero and clear the signal', () => {
    const f1 = run([
      [{ type: 'SIGNAL_STATE', state: 'WALK', fresh: true, confidence: 1 }, T0],
      [{ type: 'FAR_CURB_REACHED', crossingId: 'x' }, T0 + 5000],
    ]);
    expect(f1.signal).toBeNull();
    expect(heroText('OUTDOOR_NAV', f1, T0 + 5000)).toBe('Far curb reached');
    const f2 = run([[{ type: 'CROSSING_ABORTED', crossingId: 'x', reason: 'user' }, T0]]);
    expect(heroText('OUTDOOR_NAV', f2, T0)).toBe('Back on the sidewalk');
    expect(heroText('TRANSITION', run([[{ type: 'STORE_ENTERED', reason: 'FUSED', confidence: 0.8 }, T0]]), T0)).toBe('Entering the store');
    expect(heroText('DONE', run([[{ type: 'CHECKOUT_REACHED' }, T0]]), T0)).toBe("You've reached checkout");
  });

  it('hand guidance is one word per step', () => {
    const h = (hint: 'left' | 'right' | 'higher' | 'lower' | 'touching' | 'not_seen'): string =>
      heroText('ITEM_PICKUP', run([[{ type: 'ITEM_HAND_GUIDANCE', hint, step: 1 }, T0]]), T0);
    expect(h('higher')).toBe('Reach higher');
    expect(h('left')).toBe('Reach left');
    expect(h('touching')).toBe('Touching');
    expect(h('not_seen')).toBe('Move your hand slowly');
  });

  it('errors are kept for the DebugPanel and never shown as the hero', () => {
    const f = run([[{ type: 'ERROR', scope: 'store', message: 'boom' }, T0]]);
    expect(f.error?.message).toBe('boom');
    expect(f.instruction).toBeNull();
  });

  it('every hero an event can produce stays within twelve words and the language rule', () => {
    const events: AppEvent[] = [
      { type: 'OUTDOOR_LEG_ADVANCED', index: 0, instruction: 'Turn left now' },
      { type: 'CROSSING_AHEAD', crossingId: 'x', street: 'Fifth Avenue', signalized: true, pushButtonLikely: false, bearingDeg: 0, distanceM: 20 },
      { type: 'CURB_REACHED', crossingId: 'x' },
      { type: 'SIGNAL_STATE', state: 'WALK', fresh: false, confidence: 1 },
      { type: 'SIGNAL_STATE', state: 'COUNTDOWN', fresh: true, confidence: 1 },
      { type: 'VEHICLE_APPROACHING', direction: 'CENTER', trackId: 1 },
      { type: 'SCAN_RESULT', side: 'RIGHT', vehiclesSeen: 'unclear', source: 'claude' },
      { type: 'OBSTACLE_AHEAD', distanceClass: 'MID', direction: 'LEFT' },
      { type: 'HAZARD', kind: 'PERSON_AHEAD', direction: 'RIGHT' },
      { type: 'STORE_ENTERED', reason: 'MANUAL', confidence: 1 },
      { type: 'CHECKOUT_REACHED' },
      { type: 'CROSSING_ABORTED', crossingId: 'x', reason: 'walked_past' },
      { type: 'FAR_CURB_REACHED', crossingId: 'x' },
      { type: 'ITEM_HAND_GUIDANCE', hint: 'lower', step: 2 },
    ];
    for (const e of events) {
      const f = reduceUi(EMPTY_FACTS, e, T0);
      for (const mode of APP_MODES as readonly AppMode[]) {
        const h = heroText(mode, f, T0);
        expect(wordCount(h)).toBeLessThanOrEqual(MAX_UTTERANCE_WORDS);
        expect(findForbidden(h)).toEqual([]);
      }
    }
  });
});

describe('mode-tagged instructions', () => {
  const leg: AppEvent = { type: 'OUTDOOR_LEG_ADVANCED', index: 0, instruction: 'Turn right in twenty feet' };
  const ahead: AppEvent = { type: 'CROSSING_AHEAD', crossingId: 'x', street: 'Forbes', signalized: true, pushButtonLikely: false, bearingDeg: 0, distanceM: 20 };

  it('an instruction tagged with a mode is shown in that mode only', () => {
    const f = reduceUi(EMPTY_FACTS, ahead, T0, 'APPROACH_CROSSING');
    expect(f.instruction?.mode).toBe('APPROACH_CROSSING');
    expect(isCurrent(f.instruction as Instruction, 'APPROACH_CROSSING', T0)).toBe(true);
    expect(isCurrent(f.instruction as Instruction, 'OUTDOOR_NAV', T0)).toBe(false);
    expect(heroText('APPROACH_CROSSING', f, T0)).toBe('Crossing ahead: Forbes. Signalized.');
    // Re-plan dropped the crossing: back in OUTDOOR_NAV the stale line is gone.
    expect(heroText('OUTDOOR_NAV', f, T0)).toBe('Keep walking');
  });

  it('an untagged instruction (history seed) is shown in any mode while fresh', () => {
    const f = reduceUi(EMPTY_FACTS, leg, T0);
    expect(f.instruction?.mode).toBeNull();
    expect(heroText('OUTDOOR_NAV', f, T0)).toBe('Turn right in twenty feet');
    expect(heroText('APPROACH_CROSSING', f, T0)).toBe('Turn right in twenty feet');
  });

  it('the walk signal survives the step off the curb through the standing hero', () => {
    const f = reduceUi(EMPTY_FACTS, { type: 'SIGNAL_STATE', state: 'WALK', fresh: true, confidence: 0.95 }, T0, 'AT_CURB');
    expect(heroText('AT_CURB', f, T0)).toBe('Walk signal on');
    expect(heroText('CROSSING', f, T0 + 500)).toBe('Walk signal on');
  });

  it('"Entering the store" does not follow the user down the aisle', () => {
    const f = reduceUi(EMPTY_FACTS, { type: 'STORE_ENTERED', reason: 'FUSED', confidence: 0.8 }, T0, 'TRANSITION');
    expect(heroText('TRANSITION', f, T0)).toBe('Entering the store');
    expect(heroText('INDOOR_NAV', f, T0 + 3000, { item: 'eggs', side: null })).toBe('Walking to the eggs aisle');
  });
});

describe('errors', () => {
  it('user-facing scopes say what happened and what to do next; internal scopes stay in the panel', () => {
    expect(errorSentence('route', 'timeout')).toBe("Couldn't plan the route. Check the connection and try again.");
    expect(errorSentence('route-degraded', 'http 502')).toBe('No route data. Heading straight to the store.');
    expect(errorSentence('voice', 'no-speech')).toBe("Didn't catch that. Hold to talk and try again.");
    expect(errorSentence('perception', 'denied')).toBe('The camera is not running. Check the camera permission.');
    expect(errorSentence('network', 'ECONNREFUSED')).toBe('Offline. Cached guidance continues.');
    expect(errorSentence('location', 'denied')).toBe('No location yet. Step outside or check the location permission.');
    for (const internal of ['store', 'speech', 'ui', 'bus', 'haptics']) expect(errorSentence(internal, 'x')).toBeNull();
    expect(errorSentence('transition', 'detector stalled')).toBe('Something failed in transition: detector stalled');
    expect(errorSentence('transition', '')).toBe('Something failed in transition. Try again.');
    expect(errorSentence('x', 'a'.repeat(100))?.length).toBeLessThanOrEqual('Something failed in x: '.length + 60);
  });

  it('a visible error expires with the error TTL and every sentence is clean', () => {
    const f = reduceUi(EMPTY_FACTS, { type: 'ERROR', scope: 'route', message: 'timeout' }, T0);
    expect(visibleError(f, T0)).toBe("Couldn't plan the route. Check the connection and try again.");
    expect(visibleError(f, T0 + ERROR_TTL_MS)).toBeNull();
    expect(visibleError(reduceUi(EMPTY_FACTS, { type: 'ERROR', scope: 'store', message: 'illegal' }, T0), T0)).toBeNull();
    for (const scope of ['route', 'plan', 'voice', 'perception', 'network', 'location', 'transition', 'indoor']) {
      const s = errorSentence(scope, 'failed');
      if (s) expect(findForbidden(s)).toEqual([]);
    }
  });
});

describe('strip slots', () => {
  it('always has the three slots in the same order, filled or not', () => {
    const empty = stripSlots(EMPTY_FACTS, T0);
    expect(empty.map((s) => s.key)).toEqual(['signal', 'vehicles', 'aisle']);
    expect(empty.map((s) => `${s.label}: ${s.value}`)).toEqual([
      'Signal: not seen',
      'Vehicles: none reported',
      'Aisle: no sign read yet',
    ]);
  });

  it('reads as sentences with ages', () => {
    const f = run([
      [{ type: 'SIGNAL_STATE', state: 'WALK', fresh: true, confidence: 1 }, T0],
      [{ type: 'VEHICLE_APPROACHING', direction: 'RIGHT', trackId: 1 }, T0 + 500],
      [{ type: 'AISLE_IDENTIFIED', aisleId: 'a3', label: 'Aisle 3', confidence: 0.9, source: 'ocr' }, T0 + 2000],
    ]);
    const lines = stripSlots(f, T0 + 3000).map((s) => `${s.label}: ${s.value}`);
    expect(lines).toEqual([
      'Signal: walk, seen 3 s ago',
      'Vehicles: right, seen 3 s ago',
      'Aisle: Aisle 3, seen 1 s ago',
    ]);
  });

  it('shows already-on walk, scan reports and arrival side', () => {
    const f = run([
      [{ type: 'SIGNAL_STATE', state: 'WALK', fresh: false, confidence: 1 }, T0],
      [{ type: 'SCAN_RESULT', side: 'LEFT', vehiclesSeen: 'none', source: 'detector' }, T0 + 1000],
      [{ type: 'AISLE_IDENTIFIED', aisleId: 'a3', label: 'Aisle 3', confidence: 0.9, source: 'ocr' }, T0],
      [{ type: 'TARGET_AISLE_REACHED', aisleId: 'a3', side: 'RIGHT' }, T0 + 2000],
    ]);
    const lines = stripSlots(f, T0 + 2000).map((s) => `${s.label}: ${s.value}`);
    expect(lines[0]).toBe('Signal: walk already on, seen 2 s ago');
    expect(lines[1]).toBe('Vehicles: no vehicles seen to the left, seen 1 s ago');
    expect(lines[2]).toBe('Aisle: Aisle 3, on your right, seen 0 s ago');
  });

  it('the newer of vehicle and scan wins the vehicles slot', () => {
    const f = run([
      [{ type: 'VEHICLE_APPROACHING', direction: 'LEFT', trackId: 1 }, T0 + 5000],
      [{ type: 'SCAN_RESULT', side: 'RIGHT', vehiclesSeen: 'approaching', source: 'claude' }, T0 + 1000],
    ]);
    expect(stripSlots(f, T0 + 5000)[1].value).toBe('left, seen 0 s ago');
  });

  it('ages never go negative and stop counting past 99 s', () => {
    expect(ageText(T0 + 500, T0)).toBe('seen 0 s ago');
    expect(ageText(T0, T0 + 100_000)).toBe('seen a while ago');
    expect(ageText(T0, T0 + 1499)).toBe('seen 1 s ago');
  });
});

describe('awareness strip (IDLE / guided task)', () => {
  it('summarises the detector\'s tracks in words', () => {
    expect(detectionSummary([])).toBe('nothing yet');
    expect(detectionSummary([{ cls: 'person' }])).toBe('a person');
    expect(detectionSummary([{ cls: 'person' }, { cls: 'person' }, { cls: 'cart' }])).toBe('two persons, a cart');
    expect(detectionSummary([{ cls: 'car' }, { cls: 'car' }, { cls: 'car' }, { cls: 'car' }])).toBe('several cars');
    expect(detectionSummary([{ cls: 'ped_walk' }])).toBe('a walk signal');
    // The depth grid's nearness tags the closest thing (round 6b).
    expect(detectionSummary([{ cls: 'table', near: 0.8 }, { cls: 'backpack', near: 0.3 }])).toBe('a table (close), a backpack');
    expect(detectionSummary([{ cls: 'cell_phone', near: 0.9 }])).toBe('a cell phone (close)');
  });

  it('awarenessSlots: camera, what it sees, what to say', () => {
    expect(awarenessSlots({ scene: null, cameraLive: false, detections: [] })).toEqual([
      { key: 'camera', label: 'Camera', value: 'needs a rebuild' },
      { key: 'sees', label: 'Sees', value: 'nothing yet' },
      { key: 'say', label: 'Say', value: 'where you are, or what you need' },
    ]);
    expect(awarenessSlots({ scene: { label: 'in a kitchen', confirmed: false }, cameraLive: true, detections: [{ cls: 'person' }] })).toEqual([
      { key: 'camera', label: 'Camera', value: 'live' },
      { key: 'sees', label: 'Sees', value: 'a person' },
      { key: 'say', label: 'Say', value: 'yes or no' },
    ]);
    expect(awarenessSlots({ scene: { label: 'in a kitchen', confirmed: true }, cameraLive: true, detections: [] })[2].value).toBe('where you are, or what you need');
    expect(Array.from(AWARENESS_STRIP_MODES)).toEqual(['IDLE', 'ONBOARDING', 'GUIDED_TASK', 'DONE']);
  });
});
