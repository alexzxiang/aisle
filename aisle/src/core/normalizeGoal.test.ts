import { itemOfGoal, normalizeGoal } from './handGuide';
import { fridgeMission } from './fridgeMission';
import { explicitHomeGoal } from './indoorIntent';
import { parseMissionGoal } from './itemMission';

describe('errand phrasings name the item, not the place (the premature "task complete")', () => {
  it.each([
    ['go to the fridge to get the eggs', 'eggs in my fridge'],
    ['fridge to get the eggs', 'eggs in my fridge'],
    ['the fridge and grab some eggs', 'eggs in my fridge'],
    ['the fridge for the milk', 'milk in my fridge'],
    ['open the fridge and get me the milk', 'milk in my fridge'],
    ['the table to get my keys', 'keys on my table'],
    ['the counter and pick up the bananas', 'bananas on my counter'],
    ['eggs in my fridge', 'eggs in my fridge'],
    ['the fridge', 'the fridge'],
    ['bananas on the table', 'bananas on the table'],
  ])('%s → %s', (said, goal) => {
    expect(normalizeGoal(said)).toBe(goal);
  });

  it('the fridge mission gets all five stages for any errand that names a thing; only a bare fridge ends at the door', () => {
    expect(fridgeMission('go to the fridge to get the eggs')?.steps).toHaveLength(5);
    expect(fridgeMission('fridge to get the eggs')?.steps[2]?.lookFor).toContain('eggs identified inside');
    expect(fridgeMission('take me to the fridge')?.steps).toHaveLength(1);
    expect(fridgeMission('the fridge')?.steps).toHaveLength(1);
    expect(fridgeMission('fridge door')?.steps).toHaveLength(1);
    expect(itemOfGoal('go to the fridge to get the eggs')).toBe('eggs');
  });

  it('the spoken command and the navigator read the errand the same way', () => {
    expect(explicitHomeGoal('go to the fridge to get the eggs')).toBe('eggs in my fridge');
    expect(explicitHomeGoal('take me to the fridge and get the milk')).toBe('milk in my fridge');
    expect(parseMissionGoal('the table to get my keys')).toMatchObject({ item: 'keys', place: 'table' });
  });
});
