import { describe, expect, it } from 'vitest';
import { MAX_TASK_STEPS, templateTaskPlan, validateFor } from '../../src/outdoor/plannerJobs';
import { groundedFirstStep, TASK_GOLDENS } from './plan.eval';

describe('task-plan grounding goldens', () => {
  for (const golden of TASK_GOLDENS) it(golden.name, () => {
    const plan = templateTaskPlan(golden.input);
    expect(groundedFirstStep(plan, golden)).toBe(true);
    expect(validateFor('taskPlan', plan, golden.input).usedFallback).toBe(false);
    expect(groundedFirstStep({ ...plan, steps: [{ instruction: 'Walk through the kitchen door.', lookFor: 'door' }] }, golden)).toBe(false);
    expect(plan.steps.length).toBeLessThanOrEqual(MAX_TASK_STEPS);
  });

  // v2 C3: "eggs in my fridge" with a fridge in view is face it, open it, reach — not a tour.
  it('plans a seen container in three steps and drops the container from the reach', () => {
    const plan = templateTaskPlan(TASK_GOLDENS[0]!.input);
    expect(plan.steps.map((s) => s.instruction)).toEqual([
      'Turn left toward the fridge.',
      'Open the fridge.',
      'Reach for the eggs.',
    ]);
  });

  it('reaches straight for a target that sits in the open, with no container step', () => {
    const plan = templateTaskPlan(TASK_GOLDENS[1]!.input);   // keys on a table to your right
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[1]!.instruction).toMatch(/^Reach for /);
  });

  it('caps a rambling model plan at four steps', () => {
    const long = { steps: Array.from({ length: 9 }, (_, i) => ({ instruction: `Walk to point ${'x'.repeat(i)}.`, lookFor: 'something' })), askFirst: 'Let me see your surroundings.' };
    expect(validateFor('taskPlan', long, TASK_GOLDENS[0]!.input).output.steps.length).toBeLessThanOrEqual(MAX_TASK_STEPS);
  });
  it('does not anchor to a negated or uncertain landmark', () => {
    for (const description of ['No fridge on the left.', 'Maybe a fridge on the right.']) {
      expect(templateTaskPlan({ ...TASK_GOLDENS[0]!.input, facts: { detections: [], ocr: [], description } }).steps[0]!.instruction).toMatch(/Stay still/);
    }
  });
});
