# Nemotron Planner eval (Tier 2, "Beyond the Chatbot")

Generated 2026-09-19T16:32:09.712Z by `server/routes/plan.eval.ts` — mode: **live (Nemotron / Haiku race)**.

Validated JSON jobs race Nemotron and Haiku under per-job deadlines, then use templates. NIM uses non-streaming json_object with the schema in the prompt. parseIntent prefers Haiku after at least five Nemotron samples with a rolling median above three seconds; routeCompile keeps Nemotron first.

## 1. Intent accuracy — 60 utterances (20 clean, 20 noisy-ASR, 20 off-task)

| System | Accuracy | clean | noisy | off-task | item match (find_item) | fallback rate |
|---|---|---|---|---|---|---|
| template (fallback) | 98.3 % | 20/20 | 19/20 | 20/20 | 100.0 % | n/a |
| planner race (live) | 93.3 % | 19/20 | 19/20 | 18/20 | 95.0 % | 1.7 % |

### Confusion matrix — template (fallback) (rows = truth, columns = predicted)

| truth \ pred | find_item | navigate_to | guided_task | repeat | how_far | where_am_i | abort | help | unknown |
|---|---|---|---|---|---|---|---|---|---|
| find_item | 20 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| navigate_to | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| guided_task | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| repeat | 0 | 0 | 0 | 4 | 0 | 0 | 0 | 0 | 0 |
| how_far | 0 | 0 | 0 | 0 | 3 | 0 | 0 | 0 | 1 |
| where_am_i | 0 | 0 | 0 | 0 | 0 | 4 | 0 | 0 | 0 |
| abort | 0 | 0 | 0 | 0 | 0 | 0 | 4 | 0 | 0 |
| help | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 4 | 0 |
| unknown | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 20 |

Failures (1): "how fart is it" → unknown (want how_far).

### Confusion matrix — planner race (live) (rows = truth, columns = predicted)

| truth \ pred | find_item | navigate_to | guided_task | repeat | how_far | where_am_i | abort | help | unknown |
|---|---|---|---|---|---|---|---|---|---|
| find_item | 19 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| navigate_to | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| guided_task | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| repeat | 0 | 0 | 0 | 4 | 0 | 0 | 0 | 0 | 0 |
| how_far | 0 | 0 | 0 | 0 | 4 | 0 | 0 | 0 | 0 |
| where_am_i | 0 | 0 | 0 | 0 | 0 | 4 | 0 | 0 | 0 |
| abort | 0 | 0 | 0 | 0 | 0 | 0 | 4 | 0 | 0 |
| help | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 3 | 0 |
| unknown | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 18 |

Failures (4): "take me to the milk" → navigate_to (want find_item/milk); "instructions" → repeat (want help); "open the door" → guided_task (want unknown); "turn on the lights" → guided_task (want unknown).

## 2. Leg wording A/B — raw Google text vs template vs model

Blind "understood at walking pace" ratings (three teammates, 1–5) are filled into the last column by hand; the word counts are measured. Every spoken phrase must be ≤ 12 words with numbers as words.

| # | Raw Google (words) | Template now / confirm (words) | Model now / confirm (words) (routeCompile: first token 6453 ms, total 6454 ms, fallback false, provider nim) | Rating |
|---|---|---|---|---|
| 0 | Head southwest on Forbes Ave toward S Bouquet St (9) | Turn right now. / Continue on Forbes Avenue, about six hundred feet. (3+8) | Turn right now. / Forbes Avenue one hundred eighty three feet (3+7) | |
| 1 | Turn right onto S Bouquet St / Destination will be on the right (12) | — / Entrance ahead, about two hundred feet. (0+6) | — / Entrance ahead, about sixty one feet. (0+6) | |
| 2 | Turn left onto Fifth Ave (5) | Turn left now. / Continue on Fifth Avenue, about eight hundred feet. (3+8) | Turn left now. / Fifth Avenue two hundred forty feet (3+6) | |
| 3 | Slight right to stay on Centre Ave (7) | Bear right now. / Continue on Centre Avenue, about three hundred feet. (3+8) | Slight right now. / Centre Avenue ninety five feet (3+5) | |
| 4 | Continue onto N Craig St (5) | — / Continue on North Craig Street, about five hundred feet. (0+9) | — / Entrance ahead, about one hundred fifty feet. (0+7) | |

## 3. Per-job latency, fallback rate, thinking

| Job | n | first token p50 / p95 (ms) | total p50 / p95 (ms) | fallback rate | thinking leaked |
|---|---|---|---|---|---|
| routeCompile | 5 | 1530 / 4238 | 5613 / 8012 | 0.0 % | 0 |
| parseIntent | 60 | 751 / 1286 | 756 / 4508 | 1.7 % | 0 |
| disambiguate | 5 | 736 / 737 | 4504 / 4508 | 0.0 % | 0 |
| crossingAnnounce | 5 | 1017 / 1152 | 1206 / 8011 | 0.0 % | 0 |
| answer | 5 | 652 / 659 | 1512 / 4508 | 0.0 % | 0 |
| taskPlan | 5 | 4454 / 4906 | 6034 / 8010 | 0.0 % | 0 |

Nemotron model: `nvidia/nemotron-3.5-lightning-30b-a3b`. Non-streaming completion latency is also reported as first-token latency; it is not streaming TTFT.

## 4. Golden task plans — first-step grounding

| Case | Template first step | Grounded | Model first step | Grounded | Provider / fallback |
|---|---|---|---|---|---|
| kitchen/fridge | Turn left toward the fridge. | true | Turn left to face the fridge. | true | nim / false |
| living room/keys | Turn right toward the table. | true | Turn right to face the table. | true | nim / false |
| store/eggs | Face the dairy sign ahead. | true | Turn slowly toward the dairy sign ahead. | true | nim / false |
| street/entrance | Turn left toward the entrance. | true | Turn left to face the entrance. | true | nim / false |
| unknown | Stay still and turn the camera slowly. | true | Stay still and turn the camera slowly. | true | nim / false |

Template grounding: 5/5. Model-only grounding: 5/5. Checks require the observed landmark and side in step one; unknown scenes require a stationary scan.

## 5. Provider attempts

| Job | Provider | completed n | p50 / p95 (ms) | invalid | errors | timeouts | cancelled |
|---|---|---|---|---|---|---|---|
| routeCompile | nim | 4 | 4239 / 5613 | 0 | 0 | 2 | 0 |
| routeCompile | anthropic | 6 | 923 / 930 | 0 | 0 | 0 | 0 |
| routeCompile | openrouter | 0 | n/a / n/a | 0 | 0 | 0 | 0 |
| parseIntent | nim | 4 | 1026 / 1286 | 0 | 14 | 3 | 39 |
| parseIntent | anthropic | 59 | 751 / 1056 | 1 | 0 | 1 | 0 |
| parseIntent | openrouter | 0 | n/a / n/a | 0 | 0 | 0 | 0 |
| disambiguate | nim | 2 | 736 / 736 | 0 | 0 | 3 | 0 |
| disambiguate | anthropic | 5 | 705 / 734 | 0 | 0 | 0 | 0 |
| disambiguate | openrouter | 0 | n/a / n/a | 0 | 0 | 0 | 0 |
| crossingAnnounce | nim | 3 | 1153 / 1153 | 0 | 0 | 2 | 0 |
| crossingAnnounce | anthropic | 5 | 746 / 768 | 0 | 0 | 0 | 0 |
| crossingAnnounce | openrouter | 0 | n/a / n/a | 0 | 0 | 0 | 0 |
| answer | nim | 3 | 540 / 540 | 0 | 0 | 2 | 0 |
| answer | anthropic | 3 | 658 / 658 | 0 | 0 | 0 | 2 |
| answer | openrouter | 0 | n/a / n/a | 0 | 0 | 0 | 0 |
| taskPlan | nim | 8 | 3569 / 5161 | 0 | 0 | 2 | 0 |
| taskPlan | anthropic | 7 | 1728 / 1822 | 0 | 0 | 0 | 3 |
| taskPlan | openrouter | 0 | n/a / n/a | 0 | 0 | 0 | 0 |

Next parseIntent primary: anthropic. Deadline-limited samples are lower bounds used for routing; cancellations are excluded from medians.


## Failure we found

The templated classifier confuses "how fart is it" (ASR for "how far is it") only because the regex needs the phrase "how far"; a keyword classifier cannot recover from in-word ASR errors, which is exactly the gap the model column is for. Conversely, the model is never trusted on the fixed crossing announcement: its `text` is regenerated from the judged facts, because one hallucinated "Signalized." at a marked crossing would be a safety error a grammar cannot catch.

