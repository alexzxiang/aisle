/** Explicit home commands win over a model's grocery-route guess. Questions remain questions. */
export function explicitHomeGoal(transcript: string): string | null {
  let t = transcript.trim().replace(/[.!?]+$/, '').toLowerCase();
  if (!/\b(fridge|refrigerator|freezer|kitchen|living room|bedroom|bathroom|couch|sofa|my keys|my phone)\b/.test(t)) return null;
  t = t.replace(/^(?:please\s+)?(?:(?:can|could|would) you\s+)?(?:please\s+)?/, '');
  const prefix = /^(?:(?:take|bring|walk|guide|lead|send|navigate) me (?:to|toward)|(?:help me )?(?:find|get|fetch|retrieve|reach)|(?:i|we) (?:need|want)(?: to (?:find|get))?|how (?:do i|can i) get to|go to)\s+/i;
  if (!prefix.test(t)) return null;
  t = t.replace(prefix, '').replace(/^(?:the|some)\s+/, '').trim();
  const retrieval = t.match(/^(?:my |the )?(fridge|refrigerator)(?:\s+and\s+)(?:help me\s+)?(?:find|get|fetch|retrieve)(?:\s+me)?\s+(?:my |the |some )?(.+)$/i);
  if (retrieval) t = `${retrieval[2]} in my fridge`;
  // ASR sometimes appends a second way of asking the same question.
  t = t.replace(/\s+how (?:do i|can i) get to.*$/, '').trim();
  return t.length > 0 && t.length <= 120 ? t : null;
}
