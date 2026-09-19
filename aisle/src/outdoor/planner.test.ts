import { createPlannerClient, localFallback } from './planner';
import { templateParseIntent } from './plannerJobs';

const ok = (body: unknown): typeof fetch => (async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch;

describe('planner client', () => {
  it('returns the proxy result after re-validating it on the phone', async () => {
    const seen: unknown[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.push(JSON.parse(String(init.body)));
      return { ok: true, status: 200, json: async () => ({ job: 'parseIntent', output: { intent: 'find_item', item: 'eggs', reply: 'Eggs. Finding a route.' }, fallback: false, latencyMs: 640 }) };
    }) as unknown as typeof fetch;
    const client = createPlannerClient({ baseUrl: 'http://p', fetchImpl });
    const r = await client.run('parseIntent', { transcript: 'I need eggs', mode: 'IDLE', knownItems: ['eggs'] });
    expect(seen[0]).toEqual({ job: 'parseIntent', input: { transcript: 'I need eggs', mode: 'IDLE', knownItems: ['eggs'] } });
    expect(r).toMatchObject({ job: 'parseIntent', fallback: false, latencyMs: 640, output: { intent: 'find_item', item: 'eggs' } });
  });

  it('a proxy output with a bare digit is repaired by spelling it out (no fallback)', async () => {
    const client = createPlannerClient({ baseUrl: 'http://p', fetchImpl: ok({ job: 'answer', output: { reply: 'About 200 feet to the turn.' }, fallback: false, latencyMs: 300 }) });
    const r = await client.run('answer', { question: 'how_far', context: { metersToManeuver: 61 } });
    expect(r.fallback).toBe(false);
    expect(r.output.reply).toBe('About two hundred feet to the turn.');
  });

  it('a proxy output that cannot be repaired (over twelve words) is templated and flagged fallback', async () => {
    const long = 'You are on Fifth Avenue and the next turn is two hundred feet away on Forbes.';
    const client = createPlannerClient({ baseUrl: 'http://p', fetchImpl: ok({ job: 'answer', output: { reply: long }, fallback: false, latencyMs: 300 }) });
    const r = await client.run('answer', { question: 'how_far', context: { metersToManeuver: 61 } });
    expect(r.fallback).toBe(true);
    expect(r.output.reply).toBe('About two hundred feet to the turn.');
  });

  it('proxy unreachable → the local template, never a throw', async () => {
    const client = createPlannerClient({ baseUrl: 'http://p', fetchImpl: (async () => { throw new Error('offline'); }) as unknown as typeof fetch });
    const input = { transcript: 'were am i', mode: 'OUTDOOR_NAV' as const, knownItems: ['eggs'] };
    const r = await client.run('parseIntent', input);
    expect(r.fallback).toBe(true);
    expect(r.output).toEqual(templateParseIntent(input));
    expect(r.output.intent).toBe('where_am_i');
  });

  it('localFallback wraps the template with the 01 §9 envelope', () => {
    const r = localFallback('answer', { question: 'replan', context: {} }, 12);
    expect(r).toEqual({ job: 'answer', output: { reply: 'Re-routing.' }, fallback: true, latencyMs: 12 });
  });
});
