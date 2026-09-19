import type { TaskContext } from './contracts';
import { itemOfGoal } from './handGuide';

/** A likely storage place is a question, never evidence of a visible target. */
export function suggestedLocation(goal: string, context: TaskContext): { place: string; question: string } | null {
  if (/\b(in|on|at|inside|from|near|by)\b/i.test(goal)) return null;
  const item = itemOfGoal(goal).toLowerCase();
  if (context === 'home') {
    if (/\b(eggs?|milk|butter|cheese|yogurt)\b/.test(item)) return { place: 'fridge', question: 'Could it be refrigerated? Should we check the fridge?' };
    if (/\b(keys?|phone|wallet)\b/.test(item)) return { place: 'table', question: 'Could it be on a table? Should we check there?' };
    if (/\bremote\b/.test(item)) return { place: 'couch', question: 'Could it be by the couch? Should we check there?' };
  }
  if (context === 'store' && /\b(eggs?|milk|butter|cheese|yogurt)\b/.test(item)) {
    return { place: 'dairy section', question: 'It might be refrigerated. Should we look for dairy signs?' };
  }
  return null;
}

export interface TargetSearch {
  target: string;
  proposal: string | null;
  phase: 'proposal' | 'location' | 'direction' | 'scan' | 'paused';
  text: string;
  at: number;
  prompts: number;
}

export function startTargetSearch(target: string, at: number, proposal: ReturnType<typeof suggestedLocation> = null): TargetSearch {
  return { target, at, proposal: proposal?.place ?? null, phase: proposal ? 'proposal' : 'direction',
    text: proposal?.question ?? 'Which direction should I look? You can say you are unsure.', prompts: 1 };
}

export const SEARCH_WAIT_MS = 15_000;
export const SEARCH_SCAN_MS = 12_000;
export const SEARCH_PAUSED = 'Search paused. Tell me a location, or say retry.';

/** Bounded prompts: an unanswered question never turns into an endless scan. */
export function searchTimeout(s: TargetSearch, at: number): boolean {
  if (s.phase === 'paused' || at - s.at < (s.phase === 'scan' ? SEARCH_SCAN_MS : SEARCH_WAIT_MS)) return false;
  s.at = at;
  s.prompts += 1;
  if (s.prompts > 2) { s.phase = 'paused'; s.text = SEARCH_PAUSED; }
  else if (s.phase === 'scan') { s.phase = 'location'; s.text = 'Which room or nearby landmark should we check?'; }
  return true;
}

export type SearchAnswer = { kind: 'location'; place: string } | { kind: 'prompt' };

export function answerTargetSearch(s: TargetSearch, transcript: string, at: number): SearchAnswer | null {
  const t = transcript.toLowerCase().replace(/[’‘]/g, "'").replace(/[.!?,]/g, '').trim();
  if (/\b(stop|cancel|quit|abort|never mind)\b/.test(t)) return null;
  const yes = /^(?:yes(?: please)?|yeah|yep|sure|correct|that's right|that is right|okay|ok)$/;
  const no = /^(?:no|nope|not there|not in the fridge)$/;
  if (s.phase === 'proposal' && yes.test(t) && s.proposal) return { kind: 'location', place: s.proposal };
  // Explicit commands belong to voice intent handling; a short place answer belongs here.
  if (/^(?:find|get|take me|help me|i need|i want)\b/.test(t)) return null;
  const place = t.match(/\b(fridge|refrigerator|table|counter|couch|sofa|bed|desk|kitchen|bedroom|living room|dairy section)\b/)?.[1];
  const normalizedPlace = place === 'refrigerator' ? 'fridge' : place === 'sofa' ? 'couch' : place;
  const hasDirection = /\b(left|right|behind|ahead|in front|upper|lower|top|bottom|up|down)\b/.test(t);
  if (normalizedPlace && !(hasDirection && s.target.includes(normalizedPlace)) && !/\b(no|not|isn't|isnt|don't|dont)\b/.test(t)) {
    return { kind: 'location', place: normalizedPlace };
  }
  if (hasDirection && !/\b(no|not|don't|dont)\b/.test(t)) {
    const side = t.includes('left') ? 'left' : t.includes('right') ? 'right' : t.includes('behind') ? 'behind'
      : /\b(upper|top|up)\b/.test(t) ? 'up' : /\b(lower|bottom|down)\b/.test(t) ? 'down' : 'ahead';
    s.phase = 'scan';
    s.text = side === 'behind' ? 'Stay in place. Turn slowly to show me behind you.'
      : side === 'ahead' ? 'Stay still. Point the camera ahead.'
      : side === 'up' || side === 'down' ? `Stay still. Tilt the camera ${side} slowly.` : `Stay still. Pan the camera ${side} slowly.`;
  } else if (/^(?:retry|try again)$/.test(t)) {
    s.prompts = 1;
    s.phase = 'direction';
    s.text = 'Which direction should I look? You can say you are unsure.';
  } else if (/\b(don't know|dont know|unsure|not sure|no idea|cannot see|can't see)\b/.test(t)) {
    s.phase = 'scan'; s.text = 'Stay still. Pan the camera slowly across the room.';
  } else if (no.test(t)) {
    s.proposal = null; s.phase = 'location'; s.text = 'Where did you last keep it? Name a room or landmark.';
  } else if (/^(?:repeat|what next|next|done|continue|yes|okay|ok)$/.test(t)) {
    // Repeat the pending question instead of skipping an unseen prerequisite.
  } else return null;
  s.at = at;
  return { kind: 'prompt' };
}
