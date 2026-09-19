import { decodePolyline, encodePolyline } from './polyline';
import { initialBearingDeg } from './geo';

describe('polyline codec', () => {
  it('decodes the Google documentation example', () => {
    // https://developers.google.com/maps/documentation/utilities/polylinealgorithm
    const pts = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(pts).toHaveLength(3);
    expect(pts[0].lat).toBeCloseTo(38.5, 5);
    expect(pts[0].lng).toBeCloseTo(-120.2, 5);
    expect(pts[1].lat).toBeCloseTo(40.7, 5);
    expect(pts[1].lng).toBeCloseTo(-120.95, 5);
    expect(pts[2].lat).toBeCloseTo(43.252, 5);
    expect(pts[2].lng).toBeCloseTo(-126.453, 5);
  });

  it('round-trips Pittsburgh coordinates at 1e-5', () => {
    const pts = [
      { lat: 40.4419581, lng: -79.9564358 },
      { lat: 40.4419969, lng: -79.9563804 },
      { lat: 40.4424879, lng: -79.9556804 },
    ];
    const back = decodePolyline(encodePolyline(pts));
    expect(back).toHaveLength(3);
    for (let i = 0; i < pts.length; i += 1) {
      expect(back[i].lat).toBeCloseTo(pts[i].lat, 5);
      expect(back[i].lng).toBeCloseTo(pts[i].lng, 5);
    }
  });

  it('returns an empty list for an empty string and tolerates truncation', () => {
    expect(decodePolyline('')).toEqual([]);
    expect(decodePolyline('_p~iF')).toEqual([]);
  });

  it('gives the initial bearing between decoded points against known geometry', () => {
    // Forbes Ave at S Bouquet runs roughly north-east (~45°) heading toward Schenley.
    const pts = decodePolyline(encodePolyline([
      { lat: 40.4419581, lng: -79.9564358 },
      { lat: 40.4424879, lng: -79.9556804 },
    ]));
    const b = initialBearingDeg(pts[0], pts[1]);
    expect(b).toBeGreaterThan(40);
    expect(b).toBeLessThan(55);
  });
});
