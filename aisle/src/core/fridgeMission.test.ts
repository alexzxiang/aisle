import { fridgeMission, likelyFridgeGoal } from './fridgeMission';
import { parseMissionGoal } from './itemMission';

it.each(['eggs in the freezer', 'eggs in my fridge', 'eggs in the refrigerator'])('retains all retrieval checkpoints: %s', (goal) => {
  expect(parseMissionGoal(goal)).toBeNull();
  const mission = fridgeMission(goal)!;
  expect(mission.steps).toHaveLength(5);
  expect(mission.steps[1].lookFor).toContain('glass does NOT prove');
  expect(mission.steps[2].lookFor).toContain('eggs');
  expect(mission.steps[4].lookFor).toContain('explicitly confirms');
});

it('uses storage priors only for unseen foods at home without explicit locations', () => {
  expect(likelyFridgeGoal('eggs', 'home', false)).toBe('eggs in the fridge');
  expect(likelyFridgeGoal('milk', 'home', false)).toBe('milk in the fridge');
  for (const [goal, context, observed] of [
    ['eggs', 'store', false], ['eggs', 'home', true],
    ['eggs on a rack', 'home', false], ['eggs in the pantry', 'home', false],
    ['orange', 'home', false],
  ] as const) expect(likelyFridgeGoal(goal, context, observed)).toBeNull();
});
