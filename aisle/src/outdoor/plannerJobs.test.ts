import { digitsToWords, templateFor, validateFor } from './plannerJobs';
import { describe, expect, it } from '@jest/globals';

describe('digitsToWords + answer validation', () => {
  it('spells bare integers out and leaves decimals, times and codes alone', () => {
    expect(digitsToWords('About 400 feet to the turn.')).toBe('About four hundred feet to the turn.');
    expect(digitsToWords('Turn in 60 feet, then 2 blocks.')).toBe('Turn in sixty feet, then two blocks.');
    expect(digitsToWords('Bus 61C at 3:15, aisle A7.')).toBe('Bus 61C at 3:15, aisle A7.');
  });
  it('accepts a model reply whose only fault was a digit, and reports it as not a fallback', () => {
    const v = validateFor('answer', { reply: 'About 400 feet to the turn.' }, { question: 'how_far', context: { metersToManeuver: 120 } });
    expect(v.output.reply).toBe('About four hundred feet to the turn.');
    expect(v.usedFallback).toBe(false);
  });
  it('still templates a reply that is too long', () => {
    const long = 'You are on Fifth Avenue. The next turn is four hundred feet away on Forbes Avenue.';
    const v = validateFor('answer', { reply: long }, { question: 'how_far', context: { metersToManeuver: 120 } });
    expect(v.usedFallback).toBe(true);
    expect(v.output.reply.split(/\s+/).length).toBeLessThanOrEqual(12);
  });
});

describe('navigate_to / guided_task intents (round 4)', () => {
  const known = ['eggs', 'milk'];
  it('classifies "take me to CVS" as navigate_to with the destination', () => {
    const o = templateFor('parseIntent', { transcript: 'take me to CVS', mode: 'IDLE', knownItems: known });
    expect(o.intent).toBe('navigate_to');
    expect(o.destination).toBe('CVS');
    expect(o.reply).toBe('CVS. Got it.');
  });
  it('a model goal that echoes the verb is trimmed to the thing', () => {
    const v = validateFor('parseIntent', { intent: 'guided_task', item: null, destination: null, goal: 'find the eggs in my kitchen', reply: 'Eggs. Got it.' }, { transcript: 'find the eggs in my kitchen', mode: 'IDLE', knownItems: known });
    expect(v.output.goal).toBe('eggs in my kitchen');
    const v2 = validateFor('parseIntent', { intent: 'guided_task', item: null, destination: null, goal: 'find my keys', reply: 'Keys. Got it.' }, { transcript: 'find my keys', mode: 'IDLE', knownItems: known });
    expect(v2.output.goal).toBe('my keys');
    const v3 = validateFor('parseIntent', { intent: 'navigate_to', item: null, destination: 'take me to CVS', goal: null, reply: 'CVS. Got it.' }, { transcript: 'take me to CVS', mode: 'IDLE', knownItems: known });
    expect(v3.output.destination).toBe('CVS');
  });

  it('classifies home goals as guided_task with the goal text', () => {
    for (const t of ['take me to the eggs in my fridge', 'get to the living room', 'find my keys']) {
      const o = templateFor('parseIntent', { transcript: t, mode: 'IDLE', knownItems: known });
      expect(o.intent).toBe('guided_task');
      expect(o.goal).toBeTruthy();
    }
    expect(templateFor('parseIntent', { transcript: 'take me to the eggs in my fridge', mode: 'IDLE', knownItems: known }).goal).toBe('eggs in my fridge');
  });
  it('a known item still wins over the goal heuristics', () => {
    const o = templateFor('parseIntent', { transcript: 'take me to the eggs', mode: 'IDLE', knownItems: known });
    expect(o.intent).toBe('find_item');
    expect(o.item).toBe('eggs');
  });
  it('validation keeps a model navigate_to and repairs a missing destination from the template', () => {
    const v = validateFor('parseIntent', { intent: 'navigate_to', item: null, destination: 'Giant Eagle', goal: null, reply: 'Giant Eagle. Planning a route.' }, { transcript: 'take me to giant eagle', mode: 'IDLE', knownItems: known });
    expect(v.output).toMatchObject({ intent: 'navigate_to', destination: 'Giant Eagle' });
    expect(v.usedFallback).toBe(false);
    const v2 = validateFor('parseIntent', { intent: 'navigate_to', item: null, destination: null, goal: null, reply: 'Planning a route.' }, { transcript: 'take me to CVS', mode: 'IDLE', knownItems: known });
    expect(v2.output.destination).toBe('CVS');
    expect(v2.usedFallback).toBe(true);
  });
  it('a destination containing a forbidden term is rejected', () => {
    const v = validateFor('parseIntent', { intent: 'navigate_to', item: null, destination: 'safe place', goal: null, reply: 'Planning a route.' }, { transcript: 'hmm', mode: 'IDLE', knownItems: known });
    expect(v.output.destination).toBeNull();
    expect(v.usedFallback).toBe(true);
  });
});

describe('taskPlan job (round 4)', () => {
  it('templates context-specific steps and ends with the goal', () => {
    const home = templateFor('taskPlan', { goal: 'eggs in my fridge', context: 'home' });
    expect(home.askFirst).toBe('Let me see your surroundings.');
    expect(home.steps.length).toBeGreaterThanOrEqual(3);
    expect(home.steps[home.steps.length - 1]!.instruction).toBe('Walk to eggs in my fridge and reach out.');
    const store = templateFor('taskPlan', { goal: 'ramen', context: 'store' });
    expect(store.steps[0]!.instruction).toMatch(/aisle signs/);
  });
  it('validation accepts a good model plan, repairs digits, drops bad steps, and templates an empty plan', () => {
    const v = validateFor('taskPlan', { askFirst: 'Let me look around first.', steps: [
      { instruction: 'Walk to the kitchen door frame.', lookFor: 'a door frame' },
      { instruction: 'Open the fridge, it is 2 steps ahead.', lookFor: 'the fridge door open' },
      { instruction: 'This step is far too long to be spoken in twelve words or fewer for a blind user.', lookFor: 'x' },
      { instruction: 'You can cross now.', lookFor: 'x' },
    ] }, { goal: 'eggs in my fridge', context: 'home' });
    expect(v.output.askFirst).toBe('Let me look around first.');
    expect(v.output.steps.map((s) => s.instruction)).toEqual(['Walk to the kitchen door frame.', 'Open the fridge, it is two steps ahead.']);
    expect(v.usedFallback).toBe(true);
    const empty = validateFor('taskPlan', { askFirst: 'ok', steps: [] }, { goal: 'keys', context: 'home' });
    expect(empty.usedFallback).toBe(true);
    expect(empty.output.steps.length).toBeGreaterThan(0);
  });
});
