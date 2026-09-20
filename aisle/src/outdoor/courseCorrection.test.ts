import { initialCorrection, stepCorrection } from './courseCorrection';

function samples(heading: number, bearing: number) {
  let state = initialCorrection();
  const requests = [];
  for (const at of [1000, 2000, 3000, 4000]) {
    const result = stepCorrection(state, heading, bearing, at);
    state = result.state;
    if (result.request) requests.push(result.request.text);
  }
  return requests;
}

it('gives the shortest left/right correction across north after sustained evidence', () => {
  expect(samples(320, 10)).toEqual(['Bear right to follow the route.']);
  expect(samples(40, 350)).toEqual(['Bear left to follow the route.']);
  expect(samples(180, 0)).toEqual(['Pause. Turn around to face the route.']);
  expect(samples(10, 0)).toEqual([]);
});

it('does not accumulate duplicate fixes, changing directions, or long gaps', () => {
  let state = initialCorrection();
  for (const [heading, at] of [[90, 1000], [90, 1000], [270, 2000], [90, 3000], [90, 10000]]) {
    const result = stepCorrection(state, heading, 0, at);
    expect(result.request).toBeNull();
    state = result.state;
  }
});
