import { describe, expect, it } from 'vitest';
import { templateTaskPlan, validateFor } from '../../src/outdoor/plannerJobs';
import { groundedFirstStep, TASK_GOLDENS } from './plan.eval';

describe('task-plan grounding goldens', () => {
  for (const golden of TASK_GOLDENS) it(golden.name, () => {
    const plan = templateTaskPlan(golden.input);
    expect(groundedFirstStep(plan, golden)).toBe(true);
    expect(validateFor('taskPlan', plan, golden.input).usedFallback).toBe(false);
    expect(groundedFirstStep({ ...plan, steps: [{ instruction: 'Walk through the kitchen door.', lookFor: 'door' }] }, golden)).toBe(false);
  });
  it('does not anchor to a negated or uncertain landmark', () => {
    for (const description of ['No fridge on the left.', 'Maybe a fridge on the right.']) {
      expect(templateTaskPlan({ ...TASK_GOLDENS[0]!.input, facts: { detections: [], ocr: [], description } }).steps[0]!.instruction).toMatch(/Stay still/);
    }
  });
});
