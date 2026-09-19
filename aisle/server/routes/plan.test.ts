import { createServer, type Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { FORBIDDEN_TERMS, findForbiddenTerm } from '../../src/core/phrases';
import { JOB_SPECS, PLANNER_JOBS, templateFor } from '../../src/outdoor/plannerJobs';
import type { StreamHandle } from '../lib/deadline';
import { createRequestLog } from '../lib/log';
import type { NimChatParams, NimChatResult } from '../lib/nim';
import { testConfig } from '../test/fakes';
import { createPlanRouter, runPlannerJob, warmInputFor, warmPlannerSchemas, type NimStarter } from './plan';

/** A fake NIM handle: first token after `firstTokenMs`, full text after `totalMs`, or a rejection. */
function fakeNim(opts: { text?: string; firstTokenMs?: number; totalMs?: number; reject?: string; thinkingLeaked?: boolean }): NimStarter & { params: NimChatParams[]; aborted: number } {
  const params: NimChatParams[] = [];
  const starter = ((p: NimChatParams): StreamHandle<NimChatResult> => {
    params.push(p);
    const t0 = Date.now();
    const first = opts.firstTokenMs ?? 5;
    const total = opts.totalMs ?? first + 5;
    const firstToken = new Promise<number>((res, rej) => {
      setTimeout(() => (opts.reject ? rej(new Error(opts.reject)) : res(first)), first);
    });
    const result = new Promise<NimChatResult>((res, rej) => {
      setTimeout(() => (opts.reject ? rej(new Error(opts.reject)) : res({
        text: opts.text ?? '{}', provider: 'nim', model: 'nvidia/nemotron-3.5-lightning-30b-a3b', keyLabel: 'primary',
        firstTokenMs: first, totalMs: Date.now() - t0, thinkingLeaked: opts.thinkingLeaked ?? false, failovers: [],
      })), total);
    });
    firstToken.catch(() => undefined);
    result.catch(() => undefined);
    return { firstToken, result, abort: () => { starter.aborted += 1; }, provider: 'nim', model: 'nvidia/nemotron-3.5-lightning-30b-a3b' };
  }) as NimStarter & { params: NimChatParams[]; aborted: number };
  starter.params = params;
  starter.aborted = 0;
  return starter;
}

const routeInput = {
  steps: [
    { index: 0, instruction: 'Head southwest on Forbes Ave toward S Bouquet St', maneuver: 'TURN_RIGHT', distanceM: 183, startBearingDeg: 235 },
    { index: 1, instruction: 'Turn right onto S Bouquet St', maneuver: 'ARRIVE', distanceM: 61, startBearingDeg: 330 },
  ],
  crossings: [{ crossingId: '9', afterStep: 0, street: 'Forbes Ave', signalized: true, pushButtonLikely: false, bearingDeg: 330 }],
};

describe('runPlannerJob', () => {
  it('sends the job prompt and schema, accepts a valid answer, fallback false', async () => {
    const nim = fakeNim({ text: JSON.stringify({ legs: [{ index: 0, soon: 'Turn right in sixty feet.', now: 'Turn right now.', confirm: 'Continue on South Bouquet Street, two hundred feet.' }, { index: 1, soon: '', now: '', confirm: 'Entrance ahead, two hundred feet.' }], crossingAnnouncements: [{ crossingId: '9', text: 'Crossing ahead: Forbes Avenue. Signalized.' }] }) });
    const log = createRequestLog({ sink: () => {} });
    const r = await runPlannerJob('routeCompile', routeInput, { nim, log });
    expect(r.fallback).toBe(false);
    expect(r.output.legs[0]?.now).toBe('Turn right now.');
    expect(nim.params[0]?.schema).toBe(JOB_SPECS.routeCompile.schema);
    expect(nim.params[0]?.system).toBe(JOB_SPECS.routeCompile.prompt);
    expect(nim.params[0]?.maxTokens).toBe(400);
    expect(nim.params[0]?.temperature).toBe(0);
    expect(log.recent({ route: 'plan' })).toHaveLength(1);
    expect(log.recent()[0]).toMatchObject({ key: 'routeCompile', fallback: false, provider: 'nim' });
  });

  it('first-token deadline miss → the template with fallback true and the upstream aborted', async () => {
    const nim = fakeNim({ firstTokenMs: 5000, totalMs: 5100 });
    let clock = 0;
    const timers: Array<{ fn: () => void; at: number }> = [];
    const r = await (async () => {
      const p = runPlannerJob('parseIntent', { transcript: 'I need eggs', mode: 'IDLE', knownItems: ['eggs'] }, {
        nim,
        log: createRequestLog({ sink: () => {} }),
        now: () => clock,
        setTimeoutFn: (fn, ms) => { timers.push({ fn, at: clock + ms }); return timers.length; },
        clearTimeoutFn: () => {},
      });
      // Fire the 1.5 s deadline timer.
      await new Promise((r) => setTimeout(r, 1));
      clock = 1500;
      for (const t of timers.splice(0)) t.fn();
      return p;
    })();
    expect(r.fallback).toBe(true);
    expect(r.reason).toBe('first_token_deadline');
    expect(r.output).toEqual(templateFor('parseIntent', { transcript: 'I need eggs', mode: 'IDLE', knownItems: ['eggs'] }));
    expect(r.output.intent).toBe('find_item');
    expect(nim.aborted).toBe(1);
  });

  it('upstream rejection (429 storm past every failover) → template, reason upstream_error', async () => {
    const nim = fakeNim({ reject: 'http 429' });
    const r = await runPlannerJob('answer', { question: 'how_far', context: { metersToManeuver: 61 } }, { nim, log: createRequestLog({ sink: () => {} }) });
    expect(r.fallback).toBe(true);
    expect(r.reason).toBe('upstream_error');
    expect(r.output.reply).toBe('About two hundred feet to the turn.');
  });

  it('no NIM key configured → template, never a throw', async () => {
    const r = await runPlannerJob('answer', { question: 'replan', context: {} }, { config: testConfig({ nvidiaApiKey: null, openRouterApiKey: null }), log: createRequestLog({ sink: () => {} }) });
    expect(r).toMatchObject({ fallback: true, output: { reply: 'Re-routing.' } });
  });

  it('digits, > 12 words and forbidden words are repaired per field and flagged', async () => {
    const nim = fakeNim({ text: JSON.stringify({ legs: [
      { index: 0, soon: 'Turn right in 60 feet.', now: 'Turn right now.', confirm: 'The way is clear, continue on South Bouquet Street for two hundred feet ahead of you now.' },
      { index: 1, soon: '', now: '', confirm: 'Entrance ahead, about two hundred feet.' },
    ], crossingAnnouncements: [{ crossingId: '9', text: 'Crossing ahead: Forbes Avenue. Signalized. You can cross.' }] }) });
    const r = await runPlannerJob('routeCompile', routeInput, { nim, log: createRequestLog({ sink: () => {} }) });
    expect(r.fallback).toBe(true);
    expect(r.reason).toBe('validation');
    expect(r.output.legs[0]?.soon).toBe('Turn right in sixty feet.');
    expect(r.output.legs[0]?.now).toBe('Turn right now.');
    expect(r.output.legs[0]?.confirm).toBe('Continue on Forbes Avenue, about six hundred feet.');   // the template: the street this leg walks along
    expect(r.output.legs[1]?.confirm).toBe('Entrance ahead, about two hundred feet.');
    expect(r.output.crossingAnnouncements[0]?.text).toBe('Crossing ahead: Forbes Avenue. Signalized.');
    for (const leg of r.output.legs) for (const t of [leg.soon, leg.now, leg.confirm]) {
      expect(findForbiddenTerm(t)).toBeNull();
      expect(/\d/.test(t)).toBe(false);
    }
  });

  it('non-JSON output is an upstream error → template', async () => {
    const nim = fakeNim({ text: 'Sure! Here are your directions...' });
    const r = await runPlannerJob('answer', { question: 'repeat', context: { lastPhrase: 'Turn left now.' } }, { nim, log: createRequestLog({ sink: () => {} }) });
    expect(r.fallback).toBe(true);
    expect(r.output.reply).toBe('Turn left now.');
  });

  it('thinking leakage is reported, not spoken', async () => {
    const nim = fakeNim({ text: '{"reply":"Keep going."}', thinkingLeaked: true });
    const log = createRequestLog({ sink: () => {} });
    const r = await runPlannerJob('answer', { question: 'repeat', context: {} }, { nim, log });
    expect(r.thinkingLeaked).toBe(true);
    expect(r.output.reply).toBe('Keep going.');
    expect(log.recent()[0]?.extra).toMatchObject({ thinkingLeaked: true });
  });

  it('every job has a warm input, a template and a clean templated output', async () => {
    const results = await warmPlannerSchemas({ config: testConfig({ nvidiaApiKey: null, openRouterApiKey: null }), log: createRequestLog({ sink: () => {} }) });
    for (const job of PLANNER_JOBS) {
      expect(results[job].fallback).toBe(true);
      const out = templateFor(job, warmInputFor(job) as never);
      const texts = JSON.stringify(out).match(/"[^"]*"/g) ?? [];
      for (const t of texts) expect(FORBIDDEN_TERMS.some((f) => new RegExp(`\\b${f}\\b`, 'i').test(t) && !/crossing:signals/.test(t))).toBe(false);
    }
  });
});

describe('POST /api/plan', () => {
  let server: Server | null = null;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  async function start(nim: NimStarter): Promise<string> {
    const app = express();
    app.use(express.json());
    app.use('/api/plan', createPlanRouter({ nim, log: createRequestLog({ sink: () => {} }) }));
    server = createServer(app);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const addr = server.address();
    return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  }

  it('answers with the 01 §9 envelope under D\'s mount', async () => {
    const base = await start(fakeNim({ text: '{"intent":"find_item","item":"eggs","reply":"Eggs. Finding a route."}' }));
    const res = await fetch(`${base}/api/plan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ job: 'parseIntent', input: { transcript: 'eggs please', mode: 'IDLE', knownItems: ['eggs', 'milk'] } }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { job: string; output: { intent: string; item: string | null }; fallback: boolean; latencyMs: number };
    expect(body.job).toBe('parseIntent');
    expect(body.fallback).toBe(false);
    expect(body.output).toEqual({ intent: 'find_item', item: 'eggs', destination: null, goal: null, reply: 'Eggs. Finding a route.' });
    expect(typeof body.latencyMs).toBe('number');
  });

  it('rejects a malformed body with 400 and unknown jobs', async () => {
    const base = await start(fakeNim({}));
    const bad = await fetch(`${base}/api/plan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ job: 'chat', input: {} }) });
    expect(bad.status).toBe(400);
    const missing = await fetch(`${base}/api/plan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: {} }) });
    expect(missing.status).toBe(400);
  });
});
