/**
 * Vision eval on real phone frames (TEAM-PLAN v2 C2): how often Claude puts the target box in
 * the right place, names the setting and calls a step done — per question and per model — so
 * the prompts are tuned against measurements rather than feelings.
 *
 * 1. Record a run: start the proxy with CAPTURE_FRAMES=1 and do the living-room test.
 * 2. From server/:  npx tsx routes/vision.eval.ts --label
 *    writes labels.json beside the frames. Open each JPEG and fill in the fields its `fill`
 *    lists: target as [x, y, w, h] fractions from the top-left (or null when the target is not
 *    in view), setting, done. The skeleton deliberately does not show the model's answer — that
 *    would anchor the labeller toward agreeing with it and inflate the score.
 * 3. npx tsx routes/vision.eval.ts            scores what the phone was actually told (no calls)
 *    npx tsx routes/vision.eval.ts --rerun    also re-asks Haiku and Sonnet (costs calls)
 *    --dir <path> points at another frame set, e.g. one promoted into fixtures/vision/eval.
 *
 * Acceptance (v2): ≥ 80 % target-box hits. Frames stay git-ignored until someone deliberately
 * promotes a set — they are photos of a home.
 */
import 'dotenv/config';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SceneSetting, VisionQuestion, VisionResponse } from '../../src/core/contracts';
import { MODELS, loadConfig } from '../config';
import { runVision, visionTimeoutFor } from '../lib/anthropic';
import { FRAMES_DIR, type CapturedFrame } from '../lib/frameCapture';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'vision.eval.md');

/** The contract's box, [x, y, w, h] fractions from the top-left. */
export type VisionBox = NonNullable<VisionResponse['target']['box']>;

/** v2: a box counts when it is "within 0.1" — here, both centre coordinates within 0.1 of the label's. */
export const BOX_TOLERANCE = 0.1;
export const TARGET_ACCEPTANCE = 0.8;

export interface Label {
  target?: VisionBox | null;
  setting?: SceneSetting;
  done?: boolean;
}
type Metric = 'target' | 'setting' | 'done';

/** Which answers each question is judged on; the rest are not labelled. */
export const METRICS_FOR: Partial<Record<VisionQuestion, readonly Metric[]>> = {
  task_step: ['target', 'done'],
  hand_guidance: ['target'],
  situate: ['setting'],
};

/**
 * Right when both say "not in view", or both give a box whose centre is within tolerance on each
 * axis. A box where the label says none is a hallucination, and none where there is one a miss.
 */
export function boxHit(pred: VisionBox | null, label: VisionBox | null, tol = BOX_TOLERANCE): boolean {
  if (pred === null || label === null) return pred === label;
  const cx = (b: VisionBox): number => b[0] + b[2] / 2;
  const cy = (b: VisionBox): number => b[1] + b[3] / 2;
  return Math.abs(cx(pred) - cx(label)) <= tol && Math.abs(cy(pred) - cy(label)) <= tol;
}

/** Only the metrics the label actually sets are scored; a missing response fails each of them. */
export function scoreFrame(res: VisionResponse | null, label: Label): Partial<Record<Metric, boolean>> {
  const out: Partial<Record<Metric, boolean>> = {};
  if ('target' in label) out.target = boxHit(res?.target.box ?? null, label.target ?? null) && res !== null;
  if (label.setting !== undefined) out.setting = res?.scene.setting === label.setting;
  if (label.done !== undefined) out.done = res !== null && res.task.done === label.done;
  return out;
}

export interface Row { question: VisionQuestion; source: string; latencyMs: number; score: Partial<Record<Metric, boolean>> }
export interface Summary { question: VisionQuestion; source: string; n: number; p50Ms: number | null; rates: Partial<Record<Metric, { hits: number; n: number }>> }

export function summarize(rows: readonly Row[]): Summary[] {
  const groups = new Map<string, Row[]>();
  for (const r of rows) groups.set(`${r.question}\u0000${r.source}`, [...(groups.get(`${r.question}\u0000${r.source}`) ?? []), r]);
  return [...groups.values()].map((g) => {
    const rates: Summary['rates'] = {};
    for (const r of g) for (const [m, ok] of Object.entries(r.score) as Array<[Metric, boolean]>) {
      const cur = rates[m] ?? { hits: 0, n: 0 };
      rates[m] = { hits: cur.hits + (ok ? 1 : 0), n: cur.n + 1 };
    }
    const ms = g.map((r) => r.latencyMs).sort((a, b) => a - b);
    return { question: g[0]!.question, source: g[0]!.source, n: g.length, p50Ms: ms.length ? ms[Math.floor((ms.length - 1) / 2)]! : null, rates };
  });
}

/** Adds an entry for every frame not yet labelled, never touching one a person already filled in. */
export function labelSkeleton(frames: readonly CapturedFrame[], existing: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing };
  for (const f of frames) {
    const fill = METRICS_FOR[f.question];
    if (!fill || f.id in out) continue;
    out[f.id] = { question: f.question, image: f.image?.file ?? null, asked: f.userText, fill };
  }
  return out;
}

async function loadFrames(dir: string): Promise<CapturedFrame[]> {
  const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith('.json') && n !== 'labels.json').sort();
  const frames: CapturedFrame[] = [];
  for (const n of names) {
    try { frames.push(JSON.parse(await fs.readFile(path.join(dir, n), 'utf8')) as CapturedFrame); } catch { /* not a frame */ }
  }
  return frames;
}

async function loadLabels(file: string): Promise<Record<string, Label & { fill?: unknown }>> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, Label>; } catch { return {}; }
}

const pct = (h: { hits: number; n: number } | undefined): string => (h && h.n ? `${Math.round((100 * h.hits) / h.n)} % (${h.hits}/${h.n})` : '—');

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dirAt = argv.indexOf('--dir');
  const dir = dirAt >= 0 && argv[dirAt + 1] ? path.resolve(argv[dirAt + 1]!) : FRAMES_DIR;
  const labelsFile = path.join(dir, 'labels.json');
  const frames = await loadFrames(dir);
  if (frames.length === 0) {
    process.stdout.write(`No frames in ${dir}. Start the proxy with CAPTURE_FRAMES=1 and run the living-room test first.\n`);
    process.exitCode = 1;
    return;
  }

  if (argv.includes('--label')) {
    const next = labelSkeleton(frames, await loadLabels(labelsFile));
    await fs.writeFile(labelsFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    process.stdout.write(`wrote ${labelsFile} (${Object.keys(next).length} frames). Fill in each entry's "fill" fields.\n`);
    return;
  }

  const labels = await loadLabels(labelsFile);
  const labelled = frames.filter((f) => METRICS_FOR[f.question] && labels[f.id] && Object.keys(scoreFrame(null, labels[f.id]!)).length > 0);
  const rows: Row[] = labelled.map((f) => ({ question: f.question, source: `recorded (${f.model})`, latencyMs: f.totalMs, score: scoreFrame(f.response, labels[f.id]!) }));

  if (argv.includes('--rerun')) {
    const config = loadConfig();
    for (const f of labelled) {
      const image = f.image ? { base64: (await fs.readFile(path.join(dir, f.image.file))).toString('base64'), width: f.image.width, height: f.image.height } : undefined;
      const req = { seq: 1, question: f.question, mode: f.mode, facts: f.facts, ...(image ? { image } : {}), ...(f.userText ? { userText: f.userText } : {}) };
      for (const model of [MODELS.haiku, MODELS.sonnet]) {
        const r = await runVision(req, {}, { apiKey: config.anthropicApiKey, timeoutMs: visionTimeoutFor(f.question), model });
        rows.push({ question: f.question, source: model, latencyMs: r.totalMs, score: scoreFrame(r.response, labels[f.id]!) });
      }
    }
  }

  const summary = summarize(rows);
  const lines = [
    '# Vision eval on real phone frames (TEAM-PLAN v2 C2)', '',
    `Generated ${new Date().toISOString()} by \`server/routes/vision.eval.ts\`: ${frames.length} captured frames, ${labelled.length} labelled.`,
    `A target box is a hit when its centre is within ${BOX_TOLERANCE} of the label's on both axes; "not in view" must match too. Acceptance: ≥ ${TARGET_ACCEPTANCE * 100} % target hits.`, '',
    '| Question | Source | n | target box | setting | done | p50 ms |', '|---|---|---|---|---|---|---|',
    ...summary.map((s) => `| ${s.question} | ${s.source} | ${s.n} | ${pct(s.rates.target)} | ${pct(s.rates.setting)} | ${pct(s.rates.done)} | ${s.p50Ms ?? '—'} |`),
    '',
  ];
  const below = summary.filter((s) => s.rates.target && s.rates.target.n > 0 && s.rates.target.hits / s.rates.target.n < TARGET_ACCEPTANCE);
  lines.push(below.length ? `Below acceptance: ${below.map((s) => `${s.question} / ${s.source}`).join('; ')}.` : 'Every labelled target-box group meets acceptance.', '');
  await fs.writeFile(OUT, `${lines.join('\n')}\n`, 'utf8');
  process.stdout.write(`${lines.join('\n')}\nwrote ${OUT}\n`);
  if (labelled.length === 0) process.stdout.write('Nothing is labelled yet: run with --label, then fill in labels.json.\n');
  if (below.length) process.exitCode = 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((e) => { process.stderr.write(`${(e as Error).message}\n`); process.exit(1); });
