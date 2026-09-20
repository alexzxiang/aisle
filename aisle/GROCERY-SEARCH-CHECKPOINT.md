# Grocery search checkpoint

Existing exploration already scans both shelf faces and aisle signs, walks toward
visible landmarks, and records searched areas. This improvement adds specific
aisle priors: breakfast, pasta/sauces, baking, coffee/tea, snacks, canned foods,
cleaning, paper products, dairy, and frozen foods.

Sign candidates now rank by relevance to the requested product, including related
product names. OCR can recognize cleaning/paper aisle clues even when the food
classifier has no category. Fresh boxed landmarks still supply movement geometry.
Two distinct neighboring products or a relevant confirmed sign justify a closer
shelf scan. Broad pantry membership alone does not. Related products and aisle
hypotheses are passed into each semantic search request, separate from identity.

Current-area evidence requires a usable stationary observation. Signs require
repeated readings; moving past a distant sign does not assign its department to
the current area. A promising section is described as uncertain, not confirmed.

Physical store validation remains: scan mixed overhead signs, test pasta beside
coffee, enter the relevant aisle, and confirm that related products narrow the
search without falsely claiming the requested item has been found.

Validation: lint/type checking passed; all four targeted search/guided-task
suites passed (43 tests), followed by the added end-to-end explorer ranking
regression. Changes are local and uncommitted.
