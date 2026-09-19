/**
 * Compile-time compatibility of D's mocks with the real client shapes B and C wrote,
 * so the composition root can swap them behind EXPO_PUBLIC_MOCK without adapters.
 * The assignments below are the test; the runtime assertions only keep Jest honest.
 */
import type { PlannerClient as RealPlannerClient } from '../src/outdoor/planner';
import type { VisionTransport } from '../src/perception/semanticVision';
import * as fx from './fixtures';
import { createMockPlanner } from './planner';
import { createMockSemanticVision } from './semanticVision';

describe('mock ↔ real client compatibility', () => {
  it('the SemanticVision mock is a VisionTransport (C) and the Planner mock is a PlannerClient (B)', async () => {
    const vision: VisionTransport = createMockSemanticVision({ fixtures: fx.visionFixtures, latencyScale: 0 });
    const planner: RealPlannerClient = createMockPlanner({ fixtures: fx.planFixtures, latencyScale: 0 });
    const v = await vision.ask({ seq: 1, question: 'storefront', mode: 'OUTDOOR_NAV', facts: { detections: [], ocr: [] } }, { priority: 'NAV' });
    expect(v.seq).toBe(1);
    const p = await planner.run('answer', { question: 'repeat', context: {} });
    expect(p.job).toBe('answer');
  });
});
