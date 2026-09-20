import { createSearchExplorer } from './searchExplorer';
import { coerceSearchObservation, type SearchObservation } from './searchObservation';
import { createMissionRunner, exploreRequest, parseMissionGoal } from './itemMission';
import { contextForSetting, settingFromWords, whereaboutsFrom } from './situate';
import { explorationSteps } from './explorationMap';
import { templateTaskPlan } from '../outdoor/plannerJobs';

const opening = { name: 'left opening', kind: 'doorway' as const, boundary: 'open_passage' as const,
  section: 'unknown' as const, confidence: 0.95, box: [0.1, 0.2, 0.3, 0.6] as [number, number, number, number] };
const view = (patch: Partial<SearchObservation> = {}): SearchObservation => ({
  sign: null, items: [], view: 'overview', quality: 'usable', confidence: 0.9, landmarks: [opening], ...patch,
});

it('extracts the environment clause from the actual long store request', () => {
  const place = whereaboutsFrom('I am in a grocery store help me find where the bananas are if they are not nearby please explore to try to find them');
  expect(place).toBe('in a grocery store');
  expect(contextForSetting(settingFromWords(place!))).toBe('store');
  expect(contextForSetting(settingFromWords('in a classroom with tables'))).toBe('classroom');
  expect(contextForSetting(settingFromWords('in my apartment'))).toBe('home');
});

it.each(['Should I go forward or explore some other area', 'Can I go forward to explore more of the grocery store'])('retains exploration intent: %s', text => {
  expect(exploreRequest(text).asked).toBe(true);
});

it.each(['home', 'store', 'classroom'] as const)('coordinates analysis, narration and another view in %s', context => {
  let t = 100000;
  const search = createSearchExplorer({ item: 'keys', context, now: () => t, guide: { instructionFor: () => null } });
  const waits: string[] = [];
  search.analyzing!(true);
  for (let i = 0; i < 10; i++) {
    t += 1000;
    const text = search.tick('keys', null)?.text;
    if (text) waits.push(text);
  }
  expect(waits).toEqual([]);
  expect(search.observe(view({ landmarks: [] }), 1, t - 6000)).toBe(true);
  search.analyzing!(false);
  expect(search.narrating()).toBe(true);
  search.narrated();
  expect(search.tick('keys', null)?.text).toBeNull();
  expect(search.intercept('explore a different view')).toEqual({ consumed: true, text: 'Stay here. Turn the camera slowly left for another view.' });
  expect(search.status()).toBe('scan');
});

it('throttles camera-wait prompts and rejects stale speech evidence', () => {
  let t = 100000;
  const search = createSearchExplorer({ item: 'keys', context: 'home', now: () => t, guide: { instructionFor: () => null } });
  const lines: string[] = [];
  for (let i = 0; i < 29; i++) {
    t += 1000;
    const text = search.tick('keys', null)?.text;
    if (text) lines.push(text);
  }
  expect(lines).toEqual(['Hold the camera steady while I process this view.']);
  expect(search.observe(view(), 1, t - 20000)).toBe(false);
  expect(search.narrating()).toBe(false);
});

it.each(['produce display table', 'produce island', 'display bin'])('accepts observed store supports: %s', name => {
  const search = createSearchExplorer({ item: 'bananas', context: 'store', now: () => 100000, guide: { instructionFor: () => null } });
  search.observe(view({ landmarks: [{ name, kind: 'surface', section: 'produce', box: [0.1, 0.2, 0.3, 0.4], confidence: 0.9 }] }), 1, 100000);
  expect(search.exploreNow(null, false)).toMatchObject({ phase: 'permission', target: name });
});

it.each(['classroom', 'unknown'] as const)('does not introduce household priors in %s', context => {
  const mission = createMissionRunner(parseMissionGoal('bananas')!, { context, guide: { instructionFor: () => null } });
  expect(mission.tick().decision.explore).toBe(true);
  expect(mission.boxTarget()).toBe('bananas');
  expect(mission.userText()).not.toMatch(/Hypothesis:.*(?:bowl|fridge|counter)/);
});

it('waits for a six-second analysis before another pan, then proposes an observed exit', () => {
  let t = 100000;
  const guide = jest.fn(() => null);
  const search = createSearchExplorer({ item: 'keys', context: 'classroom', now: () => t, guide: { instructionFor: guide } });
  search.observe(view(), 1, t);
  expect(search.tick('keys', null)?.text).toMatch(/camera slowly left/);
  search.analyzing!(true);
  t += 6000;
  expect(search.tick('keys', null)?.text).toBeNull();
  search.observe(view(), 2, t);
  search.analyzing!(false);
  t += 6000;
  expect(search.tick('keys', null)).toMatchObject({ phase: 'permission', target: 'left opening' });
  expect(guide).not.toHaveBeenCalled();
  expect(search.memory()[0]?.outcome).not.toBe('not_seen_in_scanned_views');
});

it('does not turn a repeated distant department sign into local shelf evidence', () => {
  let t = 100000;
  const search = createSearchExplorer({ item: 'bananas', context: 'store', now: () => t, guide: { instructionFor: () => null } });
  for (let seq = 1; seq <= 4; seq++) {
    search.observe(view({ sign: 'Produce', landmarks: [opening] }), seq, t);
    search.tick('bananas', null);
    t += 6000;
  }
  expect(search.memory()[0]).toMatchObject({ sign: null, section: 'unknown' });
  expect(search.memory()[0]?.closeSearched).not.toBe(true);
  expect(search.status()).toBe('permission');
});

it('accepts a full resume sentence after camera failure without starting movement', () => {
  let t = 100000;
  const search = createSearchExplorer({ item: 'bananas', context: 'store', now: () => t, guide: { instructionFor: () => null } });
  t += 31000;
  expect(search.tick('bananas', null)?.phase).toBe('paused');
  expect(search.intercept('Continue trying to search for the bananas').consumed).toBe(true);
  expect(search.status()).toBe('scan');
  search.observe(view(), 1, t);
  expect(search.tick('bananas', null)?.phase).toBe('scan');
});

it('uses a structured relocation proposal only when its landmark is actually observed', () => {
  let t = 100000;
  const search = createSearchExplorer({ item: 'keys', context: 'classroom', guide: { instructionFor: () => null }, now: () => t });
  const observation = coerceSearchObservation(view({ strategy: { relevance: 'unlikely', action: 'relocate', landmark: 'imaginary kitchen', reason: 'Desks here.', confidence: 0.99 } }));
  search.observe(observation, 1, t);
  t += 1000;
  search.observe(observation, 2, t);
  expect(search.exploreNow(null, false)).toMatchObject({ phase: 'permission', target: 'left opening' });
});

it('bounds walking by metric depth and keeps non-LiDAR segments short', () => {
  expect(explorationSteps({ center: 0.1 })).toBe(3);
  expect(explorationSteps({ center: 0.1, meters: 5 })).toBe(3);
  expect(explorationSteps({ center: 0.1, meters: 2.5 })).toBe(2);
  expect(explorationSteps({ center: 0.1, meters: 1.4 })).toBe(0);
  expect(explorationSteps({ center: 0.1, meters: NaN })).toBe(0);
});

it.each(['classroom', 'unknown'] as const)('does not invent a home route in the %s fallback', context => {
  const plan = templateTaskPlan({ goal: 'keys', context });
  expect(plan.steps[0]?.instruction).toBe('Stay still and turn the camera slowly.');
  expect(JSON.stringify(plan)).not.toMatch(/fridge|kitchen|next room/);
});
