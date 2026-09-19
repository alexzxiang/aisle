# Nemotron Planner eval (Tier 2, "Beyond the Chatbot")

Generated 2026-09-17T22:41:40.278Z by `server/routes/plan.eval.ts` — mode: **offline (templated fallback only; set NVIDIA_API_KEY to add the model column)**.

Nemotron routes, classifies, judges and decides; it never chats and never sees a frame. Every job is schema-bound (`nvext.guided_json`), thinking off, streamed, behind a 1.5 s first-token deadline with a deterministic template so the walk never waits.

## 1. Intent accuracy — 60 utterances (20 clean, 20 noisy-ASR, 20 off-task)

| System | Accuracy | clean | noisy | off-task | item match (find_item) | fallback rate |
|---|---|---|---|---|---|---|
| template (fallback) | 98.3 % | 20/20 | 19/20 | 20/20 | 100.0 % | n/a |

### Confusion matrix — template (fallback) (rows = truth, columns = predicted)

| truth \ pred | find_item | repeat | how_far | where_am_i | abort | help | unknown |
|---|---|---|---|---|---|---|---|
| find_item | 20 | 0 | 0 | 0 | 0 | 0 | 0 |
| repeat | 0 | 4 | 0 | 0 | 0 | 0 | 0 |
| how_far | 0 | 0 | 3 | 0 | 0 | 0 | 1 |
| where_am_i | 0 | 0 | 0 | 4 | 0 | 0 | 0 |
| abort | 0 | 0 | 0 | 0 | 4 | 0 | 0 |
| help | 0 | 0 | 0 | 0 | 0 | 4 | 0 |
| unknown | 0 | 0 | 0 | 0 | 0 | 0 | 20 |

Failures (1): "how fart is it" → unknown (want how_far).

## 2. Leg wording A/B — raw Google text vs template vs model

Blind "understood at walking pace" ratings (three teammates, 1–5) go in the last column by hand; the word counts are measured. Every spoken phrase must be ≤ 12 words with numbers as words.

| # | Raw Google (words) | Template now / confirm (words) | Nemotron now / confirm (words) | Rating |
|---|---|---|---|---|
| 0 | Head southwest on Forbes Ave toward S Bouquet St (9) | Turn right now. / Continue on Forbes Avenue, about six hundred feet. (3+8) | n/a | |
| 1 | Turn right onto S Bouquet St / Destination will be on the right (12) | — / Entrance ahead, about two hundred feet. (0+6) | n/a | |
| 2 | Turn left onto Fifth Ave (5) | Turn left now. / Continue on Fifth Avenue, about eight hundred feet. (3+8) | n/a | |
| 3 | Slight right to stay on Centre Ave (7) | Bear right now. / Continue on Centre Avenue, about three hundred feet. (3+8) | n/a | |
| 4 | Continue onto N Craig St (5) | — / Continue on North Craig Street, about five hundred feet. (0+9) | n/a | |

## 3. Latency, `nvext` acceptance, fallback rate, thinking

Offline run: no model calls were made. Deadlines under test: `server/routes/plan.test.ts` exercises the first-token miss, the upstream 429 rejection, the missing-key path and per-field validation; `server/lib/nim.test.ts` (Agent D) exercises the NIM → OpenRouter failover and thinking-leak stripping.

## Failure we found

The templated classifier confuses "how fart is it" (ASR for "how far is it") only because the regex needs the phrase "how far"; a keyword classifier cannot recover from in-word ASR errors, which is exactly the gap the model column is for. Conversely, the model is never trusted on the fixed crossing announcement: its `text` is regenerated from the judged facts, because one hallucinated "Signalized." at a marked crossing would be a safety error a grammar cannot catch.

