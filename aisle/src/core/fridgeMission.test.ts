import { fridgeMission } from './fridgeMission';
import { parseMissionGoal } from './itemMission';

it.each(['eggs in the freezer', 'eggs in my fridge', 'eggs in the refrigerator'])('retains all retrieval checkpoints: %s', (goal) => {
  expect(parseMissionGoal(goal)).toBeNull();
  const mission = fridgeMission(goal)!;
  expect(mission.steps).toHaveLength(5);
  expect(mission.steps[1].lookFor).toContain('glass does NOT prove');
  expect(mission.steps[2].lookFor).toContain('eggs');
  expect(mission.steps[4].lookFor).toContain('explicitly confirms');
});
