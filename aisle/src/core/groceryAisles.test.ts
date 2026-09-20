import { aisleClueScore, groceryAisle, relatedGroceryItems } from './groceryAisles';

it('distinguishes neighboring pantry aisles and non-food grocery departments', () => {
  expect(aisleClueScore('spaghetti', 'Aisle 4 Pasta Sauces')).toBeGreaterThan(aisleClueScore('spaghetti', 'Aisle 2 Coffee Tea'));
  expect(groceryAisle('dish soap')?.label).toBe('cleaning supplies');
  expect(groceryAisle('frozen peas')?.label).toBe('frozen foods');
  expect(groceryAisle('canned tuna')?.label).toBe('canned foods');
  expect(groceryAisle('unknown product')).toBeNull();
});

it('counts distinct related products without mistaking them for the target', () => {
  expect(relatedGroceryItems('spaghetti', ['penne', 'organic penne', 'pesto', 'coffee'])).toEqual(['penne', 'pesto']);
  expect(relatedGroceryItems('coffee', ['coffee', 'coffee beans'])).toEqual([]);
});
