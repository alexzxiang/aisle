/**
 * Client-side interfaces the mocks implement for the two proxy-backed services.
 *
 * 01 defines the wire types (VisionRequest/VisionResponse §8, Planner jobs §9) but not
 * the JS client shape; C owns the real SemanticVision client and B the real Planner
 * client. These are the minimal structural shapes D's replayers satisfy — the real
 * clients should be assignable to them (or the names here get flagged, see
 * cross_track_needs in D's report).
 */
import type { VisionRequest, VisionResponse } from '../src/core/contracts';

export interface SemanticVisionClient {
  /** Resolves with the proxy's VisionResponse; rejects on transport failure or a malformed body. */
  ask(req: VisionRequest): Promise<VisionResponse>;
}

/**
 * The Planner client shape is B's (`src/outdoor/planner.ts`): `run<J>(job, JobInput<J>)`.
 * Re-exported here so the mock and the real client are the same type and the
 * composition root swaps them with no adapter.
 */
export type { PlannerClient } from '../src/outdoor/planner';
export type { JobInput as PlannerJobInput, JobOutput as PlannerJobOutput } from '../src/outdoor/plannerJobs';

/** Thrown by the mock clients when the DebugPanel network toggle is off. */
export class MockNetworkError extends Error {
  readonly code = 'NETWORK_OFF';
  constructor(what: string) {
    super(`[mock] network is off: ${what}`);
    this.name = 'MockNetworkError';
  }
}
