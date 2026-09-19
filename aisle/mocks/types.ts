/**
 * Client-side interfaces the mocks implement for the two proxy-backed services.
 *
 * 01 defines the wire types (VisionRequest/VisionResponse §8, Planner jobs §9) but not
 * the JS client shape; C owns the real SemanticVision client and B the real Planner
 * client. These are the minimal structural shapes D's replayers satisfy — the real
 * clients should be assignable to them (or the names here get flagged, see
 * cross_track_needs in D's report).
 */
import type {
  AnswerInput,
  AnswerOutput,
  CrossingAnnounceInput,
  CrossingAnnounceOutput,
  DisambiguateInput,
  DisambiguateOutput,
  ParseIntentInput,
  ParseIntentOutput,
  PlannerJob,
  PlannerResult,
  RouteCompileInput,
  RouteCompileOutput,
  VisionRequest,
  VisionResponse,
} from '../src/core/contracts';

export interface SemanticVisionClient {
  /** Resolves with the proxy's VisionResponse; rejects on transport failure or a malformed body. */
  ask(req: VisionRequest): Promise<VisionResponse>;
}

export interface PlannerInputMap {
  routeCompile: RouteCompileInput;
  parseIntent: ParseIntentInput;
  disambiguate: DisambiguateInput;
  crossingAnnounce: CrossingAnnounceInput;
  answer: AnswerInput;
}

export interface PlannerOutputMap {
  routeCompile: RouteCompileOutput;
  parseIntent: ParseIntentOutput;
  disambiguate: DisambiguateOutput;
  crossingAnnounce: CrossingAnnounceOutput;
  answer: AnswerOutput;
}

export interface PlannerClient {
  run<J extends PlannerJob>(job: J, input: PlannerInputMap[J]): Promise<PlannerResult<PlannerOutputMap[J]>>;
}

/** Thrown by the mock clients when the DebugPanel network toggle is off. */
export class MockNetworkError extends Error {
  readonly code = 'NETWORK_OFF';
  constructor(what: string) {
    super(`[mock] network is off: ${what}`);
    this.name = 'MockNetworkError';
  }
}
