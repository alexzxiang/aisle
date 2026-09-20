/** Store-layout priors, not proof of an item's location or a walking direction. */
const GROUPS = [
  { label: 'breakfast foods', words: ['breakfast', 'cereal', 'granola', 'oatmeal', 'oats', 'porridge', 'muesli'] },
  { label: 'pasta and sauces', words: ['pasta', 'spaghetti', 'penne', 'macaroni', 'noodles', 'marinara', 'pesto', 'pasta sauce'] },
  { label: 'baking supplies', words: ['baking', 'flour', 'sugar', 'baking powder', 'baking soda', 'yeast', 'vanilla', 'cake mix'] },
  { label: 'coffee and tea', words: ['coffee', 'tea', 'espresso', 'decaf', 'teabags', 'cocoa'] },
  { label: 'snacks', words: ['snacks', 'chips', 'crisps', 'crackers', 'pretzels', 'popcorn', 'nuts'] },
  { label: 'canned foods', words: ['canned', 'tinned', 'canned beans', 'canned soup', 'canned tuna', 'canned tomatoes'] },
  { label: 'cleaning supplies', words: ['cleaning', 'detergent', 'dish soap', 'bleach', 'sponges', 'disinfectant', 'laundry'] },
  { label: 'paper products', words: ['paper products', 'paper towels', 'toilet paper', 'tissues', 'napkins'] },
  { label: 'dairy', words: ['dairy', 'milk', 'yogurt', 'cheese', 'butter', 'eggs'] },
  { label: 'frozen foods', words: ['frozen', 'freezer', 'ice cream'] },
] as const;

const normalize = (text: string): string => text.toLowerCase().replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim();
const matches = (text: string, word: string): boolean => new RegExp(`\\b${word}(?:s|es)?\\b`).test(normalize(text));

export function groceryAisle(item: string): typeof GROUPS[number] | null {
  // Preparation/storage qualifiers outrank the ingredient: frozen peas, canned tuna.
  const qualified = GROUPS.find((g) => (g.label === 'frozen foods' && /\bfrozen\b|\bice cream\b/.test(normalize(item)))
    || (g.label === 'canned foods' && /\bcanned\b|\btinned\b/.test(normalize(item))));
  return qualified ?? GROUPS.find((g) => g.words.some((w) => matches(item, w))) ?? null;
}

export function aisleClueScore(item: string, text: string): number {
  const target = normalize(item);
  if (target && normalize(text).includes(target)) return 30;
  const group = groceryAisle(item);
  return group?.words.some((word) => matches(text, word)) ? 18 : 0;
}

/** Require two distinct observed neighbors; repeated descriptions of one product don't count. */
export function relatedGroceryItems(item: string, seen: readonly string[]): string[] {
  const group = groceryAisle(item);
  if (!group) return [];
  const identities = new Set<string>();
  for (const text of seen) {
    const word = group.words.find((w) => matches(text, w));
    if (word && !matches(item, word)) identities.add(word);
  }
  return [...identities];
}
