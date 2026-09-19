import type { TaskPlanOutput } from './contracts';
import { MISSION_PHRASES } from './preparedGuidance';
import { itemOfGoal } from './handGuide';

export type FridgeStage = 'approach' | 'open' | 'find_item' | 'reach' | 'confirm_pickup';
export const FRIDGE_STAGES: readonly FridgeStage[] = ['approach', 'open', 'find_item', 'reach', 'confirm_pickup'];

/** A retrieval mission has prerequisites that a free-form planner cannot omit/reorder. */
export function fridgeMission(goal: string): TaskPlanOutput | null {
  if (!/\b(fridge|refrigerator)\b/i.test(goal)) return null;
  const item = itemOfGoal(goal);
  if (/\b(fridge|refrigerator)\b/i.test(item)) return {
    askFirst: 'Find the fridge.',
    steps: [{ instruction: 'Find the fridge.', lookFor: 'fridge centered and close enough to reach its handle' }],
  };
  return {
    askFirst: MISSION_PHRASES.mission_fridge_approach,
    steps: [
      { instruction: MISSION_PHRASES.mission_fridge_approach, lookFor: 'fridge centered and close enough to reach its handle' },
      { instruction: MISSION_PHRASES.mission_fridge_open, lookFor: 'fridge door open with interior shelves visible; a closed fridge is NOT complete' },
      { instruction: MISSION_PHRASES.mission_fridge_find, lookFor: `${item} identified inside the open fridge; return the ITEM box, never the fridge box` },
      { instruction: MISSION_PHRASES.mission_fridge_reach, lookFor: `${item} and the outstretched hand together` },
      { instruction: MISSION_PHRASES.mission_pickup_confirm, lookFor: 'user explicitly confirms holding the requested item' },
    ],
  };
}
