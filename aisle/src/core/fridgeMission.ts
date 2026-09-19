import type { TaskPlanOutput } from './contracts';
import { MISSION_PHRASES } from './preparedGuidance';
import { itemOfGoal } from './handGuide';

export type FridgeStage = 'approach' | 'open' | 'find_item' | 'reach' | 'confirm_pickup';
export const FRIDGE_STAGES: readonly FridgeStage[] = ['approach', 'open', 'find_item', 'reach', 'confirm_pickup'];

/** A retrieval mission has prerequisites that a free-form planner cannot omit/reorder. */
export function fridgeMission(goal: string): TaskPlanOutput | null {
  if (!/\b(fridge|refrigerator|freezer)\b/i.test(goal)) return null;
  const appliance = /\bfreezer\b/i.test(goal) ? 'freezer' : 'fridge';
  const wording = (text: string): string => text.replace(/\bfridge\b/g, appliance);
  const item = itemOfGoal(goal);
  if (/\b(fridge|refrigerator|freezer)\b/i.test(item)) return {
    askFirst: `Find the ${appliance}.`,
    steps: [{ instruction: `Find the ${appliance}.`, lookFor: `${appliance} centered and close enough to reach its handle` }],
  };
  return {
    askFirst: wording(MISSION_PHRASES.mission_fridge_approach),
    steps: [
      { instruction: wording(MISSION_PHRASES.mission_fridge_approach), lookFor: `${appliance} centered and close enough to reach its handle` },
      { instruction: wording(MISSION_PHRASES.mission_fridge_open), lookFor: 'door physically open with unobstructed access to shelves; seeing shelves through glass does NOT prove the door is open' },
      { instruction: wording(MISSION_PHRASES.mission_fridge_find), lookFor: `${item} identified inside the open ${appliance}; return the ITEM box, never the ${appliance} box` },
      { instruction: MISSION_PHRASES.mission_fridge_reach, lookFor: `${item} and the outstretched hand together` },
      { instruction: MISSION_PHRASES.mission_pickup_confirm, lookFor: 'user explicitly confirms holding the requested item' },
    ],
  };
}
