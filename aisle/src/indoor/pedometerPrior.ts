/**
 * Pedometer prior (04 Task 5): steps since the last confirmed sign × 0.7 m,
 * divided by the aisle pitch, is an estimate of how many aisles the user has
 * passed since that sign. Used for exactly three things — keep_going cadence,
 * the plausibility window and early overshoot — and never spoken as fact.
 *
 * Steps only (CMPedometer distance has ~40 % bias). Pure functions.
 */
export const STRIDE_M = 0.7;
/** Typical aisle pitch; measured on the venue walk (04 Task 11) and injected. */
export const DEFAULT_AISLE_PITCH_M = 3.5;

export type TravelDirection = 'ASC' | 'DESC';

export function distanceSinceRead(stepsSinceRead: number, strideM = STRIDE_M): number {
  return Math.max(0, stepsSinceRead) * strideM;
}

/**
 * Estimated order between reads. `null` when the travel direction is unknown:
 * distance without a sign of direction says nothing about which aisle is next.
 */
export function estimateOrder(input: {
  currentOrder: number;
  direction: TravelDirection | null;
  stepsSinceRead: number;
  aislePitchM?: number;
  strideM?: number;
}): number | null {
  if (input.direction === null) return null;
  const pitch = input.aislePitchM ?? DEFAULT_AISLE_PITCH_M;
  const d = distanceSinceRead(input.stepsSinceRead, input.strideM);
  const aisles = d / pitch;
  return input.direction === 'ASC' ? input.currentOrder + aisles : input.currentOrder - aisles;
}

/** Cadence: the next sign should be in view once the user has walked about one pitch. */
export function nextSignDue(stepsSinceRead: number, aislePitchM = DEFAULT_AISLE_PITCH_M, strideM = STRIDE_M): boolean {
  return distanceSinceRead(stepsSinceRead, strideM) >= aislePitchM;
}

/**
 * Early overshoot: the prior has carried the user past `targetOrder + 1` in the
 * direction of travel toward the target, with no read to confirm the arrival.
 */
export function overshot(estimatedOrder: number | null, targetOrder: number, direction: TravelDirection | null): boolean {
  if (estimatedOrder === null || direction === null) return false;
  return direction === 'ASC' ? estimatedOrder > targetOrder + 1 : estimatedOrder < targetOrder - 1;
}

/** Plausibility window for the matcher: within ±span of the current order, widened by the prior's drift. */
export function plausibleWindow(currentOrder: number | null, estimatedOrder: number | null, span = 2): { min: number; max: number } | null {
  if (currentOrder === null) return null;
  const lo = estimatedOrder === null ? currentOrder : Math.min(currentOrder, estimatedOrder);
  const hi = estimatedOrder === null ? currentOrder : Math.max(currentOrder, estimatedOrder);
  return { min: Math.floor(lo - span), max: Math.ceil(hi + span) };
}
