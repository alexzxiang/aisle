import { explicitHomeGoal } from './indoorIntent';

describe('explicitHomeGoal', () => {
  it.each([
    ['find the bananas on the table', 'bananas on the table'],
    ['Find a bananas on the table', 'bananas on the table'],
    ['please help me find my keys on the counter', 'keys on the counter'],
    ['take me to the fridge', 'fridge'],
    ['take me to my fridge and find my eggs', 'eggs in my fridge'],
    ['get me the remote on the couch', 'remote on the couch'],
    ['find my wallet', 'wallet'],
    ['find my AirPods', 'airpods'],
    ['find my hat', 'hat'],
  ])('%s → %s', (said, goal) => {
    expect(explicitHomeGoal(said)).toBe(goal);
  });

  it.each(['do you see the bananas on the table', 'where are the bananas', 'take me to CVS', 'find the pasta'])('%s is not an explicit home command', (said) => {
    expect(explicitHomeGoal(said)).toBeNull();
  });
});
