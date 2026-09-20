/** Category priors help choose a search area. They are never proof of identity/location. */
export const FOOD_SECTIONS = ['produce', 'dairy', 'meat', 'seafood', 'bakery', 'pantry', 'frozen', 'unknown'] as const;
export type FoodSection = typeof FOOD_SECTIONS[number];

export const FOOD_CATALOG: Readonly<Record<Exclude<FoodSection, 'unknown'>, readonly string[]>> = {
  produce: ['banana', 'apple', 'orange', 'pear', 'peach', 'grape', 'berry', 'strawberry', 'blueberry', 'avocado', 'lemon', 'lime', 'tomato', 'potato', 'onion', 'carrot', 'broccoli', 'lettuce', 'spinach', 'cucumber', 'pepper', 'mushroom', 'fruit', 'vegetable'],
  dairy: ['egg', 'milk', 'cheese', 'yogurt', 'yoghurt', 'butter', 'cream', 'mozzarella', 'cheddar', 'cottage cheese'],
  meat: ['meat', 'chicken', 'beef', 'pork', 'turkey', 'steak', 'sausage', 'bacon', 'ham', 'ground beef', 'deli meat'],
  seafood: ['fish', 'salmon', 'tuna', 'shrimp', 'prawn', 'seafood'],
  bakery: ['bread', 'bagel', 'bun', 'roll', 'tortilla', 'cake'],
  pantry: ['rice', 'pasta', 'noodle', 'cereal', 'oat', 'bean', 'lentil', 'flour', 'sugar', 'salt', 'oil', 'soup', 'sauce', 'cracker', 'chip', 'cookie', 'juice', 'coffee', 'tea'],
  frozen: ['frozen', 'ice cream', 'pizza'],
};

export function foodSection(words: string): FoodSection {
  const text = words.toLowerCase().replace(/[_-]/g, ' ');
  if (/\bfrozen\b|\bice cream\b/.test(text)) return 'frozen';
  for (const section of FOOD_SECTIONS) if (section !== 'unknown' && new RegExp(`\\b${section}\\b`).test(text)) return section;
  for (const [section, foods] of Object.entries(FOOD_CATALOG)) {
    if (foods.some((food) => new RegExp(`\\b${food}(?:s|es)?\\b`).test(text))) return section as FoodSection;
  }
  return 'unknown';
}

/** Require independent food identities before inferring a section from contents. */
export function sectionFromFoods(items: readonly string[]): FoodSection {
  const counts = new Map<FoodSection, Set<string>>();
  for (const item of items) {
    const section = foodSection(item);
    if (section === 'unknown') continue;
    const names = counts.get(section) ?? new Set<string>();
    names.add(item.toLowerCase().trim().replace(/s$/, ''));
    counts.set(section, names);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1].size - a[1].size);
  return ranked[0] && ranked[0][1].size >= 2 && ranked[0][1].size > (ranked[1]?.[1].size ?? 0) ? ranked[0][0] : 'unknown';
}
