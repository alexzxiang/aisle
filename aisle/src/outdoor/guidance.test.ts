import { PHRASES, findForbiddenTerm } from '../core/phrases';
import { destinationPoint } from './geo';
import {
  cacheKeyForText,
  crossingAheadRequests,
  legConfirmRequest,
  legNowRequest,
  legSoonRequest,
  prefetchPhrases,
  prefetchPortOf,
  requestFor,
  variablePhrases,
  vehicleAlertRequest,
} from './guidance';
import type { RouteCrossing, RouteLeg } from './types';
import { WALKING_BETA_WARNING } from './types';

const A = { lat: 40.4428803, lng: -79.9546937 };
function leg(index: number, maneuver: RouteLeg['maneuver'], street: string, lengthM = 100): RouteLeg {
  const end = destinationPoint(A, 240, lengthM);
  return { index, instruction: `Turn right onto ${street}`, maneuver, distanceM: lengthM, polyline: [A, end], startBearingDeg: 240, endBearingDeg: 240, endLat: end.lat, endLng: end.lng, roadSide: 'NONE', street };
}
const crossing = (over: Partial<RouteCrossing> = {}): RouteCrossing => ({
  crossingId: '42', street: 'Forbes Ave', signalized: true, pushButtonLikely: false, bearingDeg: 330,
  nearCurb: A, farCurb: destinationPoint(A, 330, 18), roadSide: 'RIGHT', afterLeg: 0, sAlongM: 120, ...over,
});

describe('cache-key mapping', () => {
  it('canonical text maps to its 01 §3 key, anything else to null', () => {
    expect(cacheKeyForText('Turn right in sixty feet.')).toBe('turn_right_soon');
    expect(cacheKeyForText('  turn LEFT now. ')).toBe('turn_left_now');
    expect(cacheKeyForText('Crossing ahead. Signalized.')).toBe('crossing_ahead_signalized');
    expect(cacheKeyForText('Continue on Forbes Avenue, about two hundred feet.')).toBeNull();
    expect(cacheKeyForText('Turn.')).toBeNull(); // A-side training label, not shared
  });

  it('requestFor sends by key for canonical text and by text otherwise', () => {
    const byKey = requestFor('Turn left now.', { dedupeKey: 'x', cooldownMs: 1000 });
    expect(byKey).toMatchObject({ cacheKey: 'turn_left_now', text: PHRASES.turn_left_now, priority: 'NAV' });
    const byText = requestFor('Continue on Forbes Avenue, about two hundred feet.', { dedupeKey: 'y', cooldownMs: 1000 });
    expect(byText?.cacheKey).toBeUndefined();
    expect(byText?.text).toBe('Continue on Forbes Avenue, about two hundred feet.');
  });

  it('refuses digits and forbidden words', () => {
    expect(requestFor('Turn right in 60 feet.', { dedupeKey: 'x', cooldownMs: 1 })).toBeNull();
    expect(requestFor('The road is clear.', { dedupeKey: 'x', cooldownMs: 1 })).toBeNull();
    expect(requestFor('You can cross now.', { dedupeKey: 'x', cooldownMs: 1 })).toBeNull();
    expect(requestFor('', { dedupeKey: 'x', cooldownMs: 1 })).toBeNull();
  });
});

describe('leg and crossing requests', () => {
  const script = { legs: [{ index: 0, soon: 'Turn right in sixty feet.', now: 'Turn right now.', confirm: 'Continue on South Bouquet Street, two hundred feet.' }], crossingAnnouncements: [{ crossingId: '42', text: 'Crossing ahead: Forbes Avenue. Signalized.' }] };

  it('soon / now / confirm carry the dedupe keys and cooldowns from the utterance table', () => {
    const l = leg(0, 'TURN_RIGHT', 'S Bouquet St');
    expect(legSoonRequest(l, script)).toMatchObject({ cacheKey: 'turn_right_soon', dedupeKey: 'leg-0-soon', cooldownMs: 15000 });
    expect(legNowRequest(l, script)).toMatchObject({ cacheKey: 'turn_right_now', dedupeKey: 'leg-0-now', cooldownMs: 15000 });
    expect(legConfirmRequest(l, script)).toMatchObject({ text: 'Continue on South Bouquet Street, two hundred feet.', dedupeKey: 'leg-0-confirm' });
  });

  it('STRAIGHT and ARRIVE legs have no soon / now', () => {
    expect(legSoonRequest(leg(0, 'STRAIGHT', 'Forbes Ave'), null)).toBeNull();
    expect(legNowRequest(leg(0, 'ARRIVE', 'Forbes Ave'), null)).toBeNull();
    expect(legConfirmRequest(leg(0, 'ARRIVE', 'Forbes Ave', 30), null)?.text).toBe('Entrance ahead, about one hundred feet.');
  });

  it('crossing ahead: the compiled announcement once, push_button_likely once when flagged', () => {
    const reqs = crossingAheadRequests(crossing({ pushButtonLikely: true }), script);
    expect(reqs.map((r) => r.text)).toEqual(['Crossing ahead: Forbes Avenue. Signalized.', PHRASES.push_button_likely]);
    expect(reqs[0]).toMatchObject({ dedupeKey: 'xing-42-ahead' });
    expect(reqs[1]).toMatchObject({ cacheKey: 'push_button_likely', dedupeKey: 'xing-42-button' });
  });

  it('a null-signal crossing with no script falls back to "Crossing ahead."', () => {
    const reqs = crossingAheadRequests(crossing({ signalized: null, street: '' }), null);
    expect(reqs.map((r) => r.text)).toEqual(['Crossing ahead.']);
  });

  it('vehicle alerts are CRITICAL, interrupting, two words, per-direction 4 s cooldown', () => {
    const r = vehicleAlertRequest('RIGHT');
    expect(r).toEqual({ text: 'Vehicle right.', cacheKey: 'vehicle_right', priority: 'CRITICAL', interrupt: true, dedupeKey: 'vehicle-RIGHT', cooldownMs: 4000 });
    expect(vehicleAlertRequest('CENTER').cacheKey).toBe('vehicle_ahead');
    expect(findForbiddenTerm(r.text)).toBeNull();
  });
});

describe('pre-synthesis', () => {
  it('lists every variable phrase once, skipping cached ones, warning first', () => {
    const legs = [leg(0, 'TURN_RIGHT', 'S Bouquet St'), leg(1, 'ARRIVE', 'S Bouquet St', 40)];
    const texts = variablePhrases({ legs, crossings: [crossing()], warnings: [WALKING_BETA_WARNING], script: null });
    expect(texts[0]).toBe(WALKING_BETA_WARNING);
    expect(texts).toContain('Continue on South Bouquet Street, about three hundred fifty feet.');
    expect(texts).toContain('Entrance ahead, about one hundred fifty feet.');
    expect(texts).toContain('Crossing ahead: Forbes Avenue. Signalized.');
    // A bundles `signal_read_delayed` (A-side key), so it is not pre-synthesized.
    expect(texts).not.toContain('Signal read is delayed.');
    expect(texts).not.toContain('Turn right in sixty feet.');
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('prefetches four at a time and reports failures without throwing', async () => {
    let inFlight = 0;
    let peak = 0;
    const port = {
      async prefetch(text: string) {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
        if (text === 'bad') throw new Error('boom');
        return `tts:${text}`;
      },
    };
    const report = await prefetchPhrases(['a', 'b', 'c', 'd', 'e', 'bad'], port);
    expect(peak).toBeLessThanOrEqual(4);
    expect(report).toMatchObject({ requested: 6, ok: 5, failed: ['bad'] });
  });

  it('without a prefetch port everything is reported as not prefetched', async () => {
    const report = await prefetchPhrases(['a'], null);
    expect(report).toMatchObject({ requested: 1, ok: 0, failed: ['a'] });
    expect(prefetchPortOf({ say() {} })).toBeNull();
    expect(prefetchPortOf({ prefetch: async () => null })).not.toBeNull();
  });
});
