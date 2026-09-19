/**
 * Nemotron evidence artifact (03 Task 7, "Beyond the Chatbot"): writes
 * `server/routes/plan.eval.md`. Run from `server/`:
 *
 *   npx tsx routes/plan.eval.ts            # offline: templated fallback only
 *   NVIDIA_API_KEY=… npx tsx routes/plan.eval.ts   # live: model vs template, latency, fallback rate
 *
 * Three measurements, per 03:
 *   1. intent accuracy on 60 utterances (20 clean, 20 noisy-ASR, 20 off-task) with a confusion matrix;
 *   2. leg-wording A/B — raw Google text vs template vs model — with word counts
 *      (the blind "understood at walking pace" rating is a teammate task; the table has the column);
 *   3. p50 / p95 first-token and total latency per job, `nvext` acceptance, fallback rate, thinking leakage.
 * Nothing here runs during the walk.
 */
import 'dotenv/config';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ParseIntentOutput, PlannerJob, TaskPlanInput, TaskPlanOutput } from '../../src/core/contracts';
import { countWords } from '../../src/core/phrases';
import { INTENTS, PLANNER_JOBS, templateParseIntent, templateRouteCompile, templateTaskPlan } from '../../src/outdoor/plannerJobs';
import { plannerPrimary, type PlanAttempt } from '../lib/plannerRace';
import { loadConfig } from '../config';
import { createRequestLog } from '../lib/log';
import { runPlannerJob, warmInputFor, type PlanDeps } from './plan';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'plan.eval.md');
const KNOWN_ITEMS = ['eggs', 'milk', 'bread', 'butter', 'cheese', 'apples', 'bananas', 'rice', 'pasta', 'coffee'];
/**
 * Runs per job in §3. The log starts empty every run and the primary switch needs
 * PLANNER_MIN_SAMPLES before it can fire, so at the default 5 the measurement ends just as the
 * switch becomes possible and §3 only ever shows Nemotron-first latency. Raise it (PLAN_EVAL_N=12)
 * to see the switch inside one run — it costs that many more calls per job on both providers.
 */
const PER_JOB_RUNS = Math.max(1, Number(process.env.PLAN_EVAL_N ?? 5) || 5);

export const TASK_GOLDENS: Array<{ name: string; input: TaskPlanInput; landmark: RegExp; direction: RegExp }> = [
  { name: 'kitchen/fridge', input: { goal: 'find eggs in my fridge', context: 'home', facts: { detections: ['refrigerator'], ocr: [], scene: 'in a kitchen', description: 'Kitchen counter ahead, fridge on your left.' } }, landmark: /fridge|refrigerator/i, direction: /left/i },
  { name: 'living room/keys', input: { goal: 'find my keys', context: 'home', facts: { detections: ['couch', 'table'], ocr: [], scene: 'in a living room', description: 'Keys on the table to your right.' } }, landmark: /keys|table/i, direction: /right/i },
  { name: 'store/eggs', input: { goal: 'find eggs', context: 'store', facts: { detections: [], ocr: ['DAIRY'], scene: 'in a grocery store', description: 'Dairy sign ahead, shelves on both sides.' } }, landmark: /dairy|sign/i, direction: /ahead|forward/i },
  { name: 'street/entrance', input: { goal: 'reach the entrance', context: 'street', facts: { detections: [], ocr: ['ENTRANCE'], scene: 'on a sidewalk', description: 'An entrance on your left.' } }, landmark: /entrance|door/i, direction: /left/i },
  { name: 'unknown', input: { goal: 'find my bag', context: 'unknown', facts: { detections: [], ocr: [], scene: 'unknown', description: 'Too dark to identify objects.' } }, landmark: /camera|look|scan/i, direction: /still|slowly/i },
];

/** A narrow, reproducible grounding check, not a claim of physical task completion. */
export function groundedFirstStep(plan: TaskPlanOutput, golden: typeof TASK_GOLDENS[number]): boolean {
  const text = plan.steps[0]?.instruction ?? '';
  return golden.landmark.test(text) && golden.direction.test(text) &&
    !(golden.name === 'unknown' && /\b(walk|reach|open)\b/i.test(text));
}

type Intent = ParseIntentOutput['intent'];
interface Utterance { text: string; intent: Intent; item?: string; kind: 'clean' | 'noisy' | 'off-task' }

export const UTTERANCES: Utterance[] = [
  // 20 clean
  { text: 'I need eggs', intent: 'find_item', item: 'eggs', kind: 'clean' },
  { text: 'take me to the milk', intent: 'find_item', item: 'milk', kind: 'clean' },
  { text: 'where is the bread', intent: 'find_item', item: 'bread', kind: 'clean' },
  { text: 'find butter', intent: 'find_item', item: 'butter', kind: 'clean' },
  { text: 'I want some cheese', intent: 'find_item', item: 'cheese', kind: 'clean' },
  { text: 'apples please', intent: 'find_item', item: 'apples', kind: 'clean' },
  { text: 'get me bananas', intent: 'find_item', item: 'bananas', kind: 'clean' },
  { text: 'looking for rice', intent: 'find_item', item: 'rice', kind: 'clean' },
  { text: 'pasta', intent: 'find_item', item: 'pasta', kind: 'clean' },
  { text: 'I need coffee', intent: 'find_item', item: 'coffee', kind: 'clean' },
  { text: 'repeat that', intent: 'repeat', kind: 'clean' },
  { text: 'say that again', intent: 'repeat', kind: 'clean' },
  { text: 'how far is the turn', intent: 'how_far', kind: 'clean' },
  { text: 'how far to the crossing', intent: 'how_far', kind: 'clean' },
  { text: 'where am I', intent: 'where_am_i', kind: 'clean' },
  { text: 'what street is this', intent: 'where_am_i', kind: 'clean' },
  { text: 'stop the route', intent: 'abort', kind: 'clean' },
  { text: 'cancel', intent: 'abort', kind: 'clean' },
  { text: 'help', intent: 'help', kind: 'clean' },
  { text: 'what can you do', intent: 'help', kind: 'clean' },
  // 20 noisy ASR
  { text: 'eggs please', intent: 'find_item', item: 'eggs', kind: 'noisy' },
  { text: 'i need egs', intent: 'find_item', item: 'eggs', kind: 'noisy' },
  { text: 'take me two the milk', intent: 'find_item', item: 'milk', kind: 'noisy' },
  { text: 'where is the bred', intent: 'find_item', item: 'bread', kind: 'noisy' },
  { text: 'fine butter', intent: 'find_item', item: 'butter', kind: 'noisy' },
  { text: 'i want sum chees', intent: 'find_item', item: 'cheese', kind: 'noisy' },
  { text: 'aples', intent: 'find_item', item: 'apples', kind: 'noisy' },
  { text: 'get me banana', intent: 'find_item', item: 'bananas', kind: 'noisy' },
  { text: 'looking for rise', intent: 'find_item', item: 'rice', kind: 'noisy' },
  { text: 'coffe', intent: 'find_item', item: 'coffee', kind: 'noisy' },
  { text: 'repeat', intent: 'repeat', kind: 'noisy' },
  { text: 'say again', intent: 'repeat', kind: 'noisy' },
  { text: 'how far', intent: 'how_far', kind: 'noisy' },
  { text: 'how fart is it', intent: 'how_far', kind: 'noisy' },
  { text: 'were am i', intent: 'where_am_i', kind: 'noisy' },
  { text: 'where are we', intent: 'where_am_i', kind: 'noisy' },
  { text: 'stop', intent: 'abort', kind: 'noisy' },
  { text: 'never mind', intent: 'abort', kind: 'noisy' },
  { text: 'help me', intent: 'help', kind: 'noisy' },
  { text: 'instructions', intent: 'help', kind: 'noisy' },
  // 20 off-task
  { text: 'what time is it', intent: 'unknown', kind: 'off-task' },
  { text: 'tell me a joke', intent: 'unknown', kind: 'off-task' },
  { text: 'is it going to rain', intent: 'unknown', kind: 'off-task' },
  { text: 'call my mother', intent: 'unknown', kind: 'off-task' },
  { text: 'play some music', intent: 'unknown', kind: 'off-task' },
  { text: 'hello', intent: 'unknown', kind: 'off-task' },
  { text: 'thank you', intent: 'unknown', kind: 'off-task' },
  { text: 'the weather is nice today', intent: 'unknown', kind: 'off-task' },
  { text: 'set an alarm for seven', intent: 'unknown', kind: 'off-task' },
  { text: 'who won the game', intent: 'unknown', kind: 'off-task' },
  { text: 'um', intent: 'unknown', kind: 'off-task' },
  { text: 'I like turtles', intent: 'unknown', kind: 'off-task' },
  { text: 'open the door', intent: 'unknown', kind: 'off-task' },
  { text: 'read my messages', intent: 'unknown', kind: 'off-task' },
  { text: 'what is two plus two', intent: 'unknown', kind: 'off-task' },
  { text: 'text John', intent: 'unknown', kind: 'off-task' },
  { text: 'turn on the lights', intent: 'unknown', kind: 'off-task' },
  { text: 'good morning', intent: 'unknown', kind: 'off-task' },
  { text: 'how are you', intent: 'unknown', kind: 'off-task' },
  { text: 'nothing', intent: 'unknown', kind: 'off-task' },
];

/** Raw Google instructions from the recorded demo route and a few typical ones. */
export const GOOGLE_STEPS = [
  { index: 0, instruction: 'Head southwest on Forbes Ave toward S Bouquet St', maneuver: 'TURN_RIGHT', distanceM: 183, startBearingDeg: 250 },
  { index: 1, instruction: 'Turn right onto S Bouquet St\nDestination will be on the right', maneuver: 'ARRIVE', distanceM: 61, startBearingDeg: 308 },
  { index: 2, instruction: 'Turn left onto Fifth Ave', maneuver: 'TURN_LEFT', distanceM: 240, startBearingDeg: 65 },
  { index: 3, instruction: 'Slight right to stay on Centre Ave', maneuver: 'SLIGHT_RIGHT', distanceM: 95, startBearingDeg: 80 },
  { index: 4, instruction: 'Continue onto N Craig St', maneuver: 'STRAIGHT', distanceM: 150, startBearingDeg: 10 },
];

interface IntentRun { name: string; predictions: ParseIntentOutput[]; latencies: number[]; fallbacks: number }

function confusion(preds: ParseIntentOutput[]): { matrix: Record<Intent, Record<Intent, number>>; accuracy: number; byKind: Record<string, string>; itemAccuracy: number } {
  const matrix = {} as Record<Intent, Record<Intent, number>>;
  for (const a of INTENTS) {
    matrix[a] = {} as Record<Intent, number>;
    for (const b of INTENTS) matrix[a][b] = 0;
  }
  let correct = 0;
  let itemCorrect = 0;
  let itemTotal = 0;
  const kinds: Record<string, { n: number; ok: number }> = {};
  UTTERANCES.forEach((u, i) => {
    const p = preds[i]!;
    matrix[u.intent][p.intent] += 1;
    const ok = p.intent === u.intent;
    if (ok) correct += 1;
    if (u.item) {
      itemTotal += 1;
      if (p.item === u.item) itemCorrect += 1;
    }
    kinds[u.kind] = kinds[u.kind] ?? { n: 0, ok: 0 };
    kinds[u.kind]!.n += 1;
    if (ok) kinds[u.kind]!.ok += 1;
  });
  const byKind: Record<string, string> = {};
  for (const [k, v] of Object.entries(kinds)) byKind[k] = `${v.ok}/${v.n}`;
  return { matrix, accuracy: correct / UTTERANCES.length, byKind, itemAccuracy: itemTotal ? itemCorrect / itemTotal : 0 };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)} %`;
}

function quantile(xs: number[], q: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))] ?? null;
}

async function runIntents(live: boolean, deps: PlanDeps): Promise<IntentRun[]> {
  const template: IntentRun = { name: 'template (fallback)', predictions: [], latencies: [], fallbacks: 0 };
  for (const u of UTTERANCES) template.predictions.push(templateParseIntent({ transcript: u.text, mode: 'OUTDOOR_NAV', knownItems: KNOWN_ITEMS }));
  const runs = [template];
  if (live) {
    const model: IntentRun = { name: 'planner race (live)', predictions: [], latencies: [], fallbacks: 0 };
    for (const u of UTTERANCES) {
      const r = await runPlannerJob('parseIntent', { transcript: u.text, mode: 'OUTDOOR_NAV', knownItems: KNOWN_ITEMS }, deps);
      model.predictions.push(r.output);
      model.latencies.push(r.latencyMs);
      if (r.fallback) model.fallbacks += 1;
    }
    runs.push(model);
  }
  return runs;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const live = !process.argv.includes('--offline') && Boolean(config.nvidiaApiKey || config.openRouterApiKey || config.anthropicApiKey);
  const log = createRequestLog({ sink: () => {} });
  const deps: PlanDeps = { config, log };
  const lines: string[] = [];
  lines.push('# Nemotron Planner eval (Tier 2, "Beyond the Chatbot")');
  lines.push('');
  lines.push(`Generated ${new Date().toISOString()} by \`server/routes/plan.eval.ts\` — mode: **${live ? 'live (Nemotron / Haiku race)' : 'offline (templates only; model measurements unavailable)'}**.`);
  lines.push('');
  lines.push('Validated JSON jobs race Nemotron and Haiku under per-job deadlines, then use templates. NIM uses non-streaming json_object with the schema in the prompt. parseIntent prefers Haiku after at least five Nemotron samples with a rolling median above three seconds; routeCompile keeps Nemotron first.');
  lines.push('');

  // 1. Intent accuracy
  const runs = await runIntents(live, deps);
  lines.push('## 1. Intent accuracy — 60 utterances (20 clean, 20 noisy-ASR, 20 off-task)');
  lines.push('');
  lines.push('| System | Accuracy | clean | noisy | off-task | item match (find_item) | fallback rate |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const r of runs) {
    const c = confusion(r.predictions);
    lines.push(`| ${r.name} | ${pct(c.accuracy)} | ${c.byKind.clean} | ${c.byKind.noisy} | ${c.byKind['off-task']} | ${pct(c.itemAccuracy)} | ${r.latencies.length ? pct(r.fallbacks / r.latencies.length) : 'n/a'} |`);
  }
  lines.push('');
  for (const r of runs) {
    const c = confusion(r.predictions);
    lines.push(`### Confusion matrix — ${r.name} (rows = truth, columns = predicted)`);
    lines.push('');
    lines.push(`| truth \\ pred | ${INTENTS.join(' | ')} |`);
    lines.push(`|---|${INTENTS.map(() => '---').join('|')}|`);
    for (const t of INTENTS) lines.push(`| ${t} | ${INTENTS.map((p) => String(c.matrix[t][p])).join(' | ')} |`);
    lines.push('');
    const misses = UTTERANCES.map((u, i) => ({ u, p: r.predictions[i]! })).filter(({ u, p }) => p.intent !== u.intent || (u.item && p.item !== u.item));
    if (misses.length > 0) {
      lines.push(`Failures (${misses.length}): ${misses.map(({ u, p }) => `"${u.text}" → ${p.intent}${p.item ? `/${p.item}` : ''} (want ${u.intent}${u.item ? `/${u.item}` : ''})`).join('; ')}.`);
      lines.push('');
    }
  }

  // 2. Wording A/B
  lines.push('## 2. Leg wording A/B — raw Google text vs template vs model');
  lines.push('');
  lines.push('Blind "understood at walking pace" ratings (three teammates, 1–5) are filled into the last column by hand; the word counts are measured. Every spoken phrase must be ≤ 12 words with numbers as words.');
  lines.push('');
  const template = templateRouteCompile({ steps: GOOGLE_STEPS, crossings: [] });
  let modelLegs: typeof template.legs | null = null;
  let compileMeta = '';
  if (live) {
    const r = await runPlannerJob('routeCompile', { steps: GOOGLE_STEPS, crossings: [] }, deps);
    modelLegs = r.output.legs;
    compileMeta = ` (routeCompile: first token ${r.firstTokenMs ?? 'n/a'} ms, total ${r.latencyMs} ms, fallback ${r.fallback}, provider ${r.provider ?? 'n/a'})`;
  }
  lines.push(`| # | Raw Google (words) | Template now / confirm (words) | Model now / confirm (words)${compileMeta} | Rating |`);
  lines.push('|---|---|---|---|---|');
  GOOGLE_STEPS.forEach((s, i) => {
    const raw = s.instruction.replace(/\n/g, ' / ');
    const t = template.legs[i]!;
    const m = modelLegs?.[i];
    const fmt = (l: { now: string; confirm: string } | undefined): string => (l ? `${l.now || '—'} / ${l.confirm} (${countWords(l.now)}+${countWords(l.confirm)})` : 'n/a');
    lines.push(`| ${i} | ${raw} (${countWords(raw)}) | ${fmt(t)} | ${fmt(m)} | |`);
  });
  lines.push('');

  // 3. Latency / acceptance
  lines.push('## 3. Per-job latency, fallback rate, thinking');
  lines.push('');
  if (!live) {
    lines.push('Offline run: no model calls were made. Deadlines under test: `server/routes/plan.test.ts` exercises the first-token miss, the upstream 429 rejection, the missing-key path and per-field validation; `server/lib/nim.test.ts` (Agent D) exercises the NIM → OpenRouter failover and thinking-leak stripping.');
  } else {
    lines.push('| Job | n | first token p50 / p95 (ms) | total p50 / p95 (ms) | fallback rate | thinking leaked |');
    lines.push('|---|---|---|---|---|---|');
    const jobs: readonly PlannerJob[] = PLANNER_JOBS;
    for (const job of jobs) {
      const first: number[] = [];
      const total: number[] = [];
      let fallbacks = 0;
      let leaked = 0;
      const n = job === 'parseIntent' ? 0 : PER_JOB_RUNS;
      for (let i = 0; i < n; i += 1) {
        const r = await runPlannerJob(job, warmInputFor(job) as never, deps);
        if (r.firstTokenMs !== null) first.push(r.firstTokenMs);
        total.push(r.latencyMs);
        if (r.fallback) fallbacks += 1;
        if (r.thinkingLeaked) leaked += 1;
      }
      if (job === 'parseIntent') {
        const run = runs.find((r) => r.name.startsWith('planner'));
        if (run) {
          total.push(...run.latencies);
          fallbacks = run.fallbacks;
        }
        for (const row of log.recent({ route: 'plan', key: job })) if (row.firstTokenMs != null) first.push(row.firstTokenMs);
      }
      const q = (xs: number[], p: number): string => String(quantile(xs, p) ?? 'n/a');
      lines.push(`| ${job} | ${total.length} | ${q(first, 0.5)} / ${q(first, 0.95)} | ${q(total, 0.5)} / ${q(total, 0.95)} | ${total.length ? pct(fallbacks / total.length) : 'n/a'} | ${leaked} |`);
    }
    lines.push('');
    lines.push(`Nemotron model: \`${config.nvidiaModel}\`. Non-streaming completion latency is also reported as first-token latency; it is not streaming TTFT.`);
  }
  lines.push('', '## 4. Golden task plans — first-step grounding', '', '| Case | Template first step | Grounded | Model first step | Grounded | Provider / fallback |', '|---|---|---|---|---|---|');
  let templateGrounded = 0;
  let modelGrounded = 0;
  for (const golden of TASK_GOLDENS) {
    const template = templateTaskPlan(golden.input);
    const model = live ? await runPlannerJob('taskPlan', golden.input, deps) : null;
    const templateOk = groundedFirstStep(template, golden);
    const modelOk = model ? groundedFirstStep(model.output, golden) : false;
    if (templateOk) templateGrounded++;
    if (modelOk && !model?.fallback) modelGrounded++;
    lines.push(`| ${golden.name} | ${template.steps[0]?.instruction} | ${templateOk} | ${model?.output.steps[0]?.instruction ?? 'not run'} | ${model ? modelOk : 'n/a'} | ${model ? `${model.provider} / ${model.fallback}` : 'n/a'} |`);
  }
  lines.push('', `Template grounding: ${templateGrounded}/5. Model-only grounding: ${live ? `${modelGrounded}/5` : 'not measured (no live calls)'}. Checks require the observed landmark and side in step one; unknown scenes require a stationary scan.`);
  lines.push('', '## 5. Provider attempts', '', '| Job | Provider | completed n | p50 / p95 (ms) | invalid | errors | timeouts | cancelled |', '|---|---|---|---|---|---|---|---|');
  for (const job of PLANNER_JOBS) {
    const attempts = log.recent({ route: 'plan', key: job }).flatMap((r) => (r.extra?.attempts ?? []) as PlanAttempt[]);
    for (const provider of ['nim', 'anthropic', 'openrouter']) {
      const rows = attempts.filter((a) => a.provider === provider);
      const completed = rows.filter((a) => a.status === 'valid' || a.status === 'invalid').map((a) => a.elapsedMs);
      const n = (status: PlanAttempt['status']) => rows.filter((a) => a.status === status).length;
      lines.push(`| ${job} | ${provider} | ${completed.length} | ${quantile(completed, 0.5) ?? 'n/a'} / ${quantile(completed, 0.95) ?? 'n/a'} | ${n('invalid')} | ${n('error')} | ${n('timeout')} | ${n('cancelled')} |`);
    }
  }
  const reasons = new Map<string, number>();
  for (const job of PLANNER_JOBS) {
    for (const a of log.recent({ route: 'plan', key: job }).flatMap((r) => (r.extra?.attempts ?? []) as PlanAttempt[])) {
      if (a.error) reasons.set(`${a.provider}: ${a.error}`, (reasons.get(`${a.provider}: ${a.error}`) ?? 0) + 1);
    }
  }
  if (reasons.size > 0) {
    lines.push('', 'Error reasons (sanitized, most frequent first):', '');
    for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1])) lines.push(`- ${count} × \`${reason}\``);
  }
  lines.push('', `Primary each job would start with next, given this run's samples (${PER_JOB_RUNS} runs per job in §3): ` +
    `${PLANNER_JOBS.map((j) => `${j} → ${plannerPrimary(j, log)}`).join(', ')}. ` +
    'routeCompile is pinned to Nemotron. Deadline-limited samples are lower bounds used for routing; cancellations are excluded from medians.', '');
  lines.push('');
  lines.push('## Failure we found');
  lines.push('');
  lines.push('The templated classifier confuses "how fart is it" (ASR for "how far is it") only because the regex needs the phrase "how far"; a keyword classifier cannot recover from in-word ASR errors, which is exactly the gap the model column is for. Conversely, the model is never trusted on the fixed crossing announcement: its `text` is regenerated from the judged facts, because one hallucinated "Signalized." at a marked crossing would be a safety error a grammar cannot catch.');
  lines.push('');

  await fs.writeFile(OUT, `${lines.join('\n')}\n`, 'utf8');
  process.stdout.write(`${lines.join('\n')}\n\nwrote ${OUT}\n`);
  if (live && modelGrounded !== TASK_GOLDENS.length) process.exitCode = 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  });
}
