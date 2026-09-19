import { describe, expect, it } from 'vitest';
import { createWarmupRegistry, pairsForMode } from './warmup';

describe('pairsForMode', () => {
  it('curb modes warm both Claude pairs, walking/indoor modes warm Haiku only, idle none', () => {
    expect(pairsForMode('AT_CURB')).toEqual(['haiku:vision', 'sonnet:vision']);
    expect(pairsForMode('APPROACH_CROSSING')).toEqual(['haiku:vision', 'sonnet:vision']);
    expect(pairsForMode('INDOOR_NAV')).toEqual(['haiku:vision']);
    expect(pairsForMode('IDLE')).toEqual([]);
  });
});

describe('createWarmupRegistry', () => {
  it('lists the seven pairs and reports null until warmed', () => {
    const reg = createWarmupRegistry({ jobSchemas: {}, runners: { vision: async () => 'ok', nim: async () => '{}' } });
    expect(reg.pairs()).toEqual(['haiku:vision', 'sonnet:vision', 'nim:routeCompile', 'nim:parseIntent', 'nim:disambiguate', 'nim:crossingAnnounce', 'nim:answer']);
    expect(Object.values(reg.schemasWarm()).every((v) => v === null)).toBe(true);
  });

  it('warmAll marks successes with a time and failures with ok:false, keeping the last good time', async () => {
    let t = 1_000_000;
    let nimFails = false;
    const reg = createWarmupRegistry({
      now: () => t,
      jobSchemas: { routeCompile: { type: 'object' }, parseIntent: { type: 'object' } },
      runners: {
        vision: async () => 'claude-haiku-4-5 stop=end_turn 800ms',
        nim: async (job) => {
          if (nimFails) throw new Error('503');
          return `{"job":"${job}"}`;
        },
      },
    });
    await reg.warmAll();
    let s = reg.status();
    expect(s['haiku:vision']?.ok).toBe(true);
    expect(s['nim:routeCompile']?.ok).toBe(true);
    expect(s['nim:routeCompile']?.note).toBe('{"job":"routeCompile"}');
    expect(s['nim:disambiguate']?.ok).toBe(false);          // no schema loaded
    expect(s['nim:disambiguate']?.note).toMatch(/no schema/);
    const firstWarm = s['nim:routeCompile']?.lastWarmAt;

    t += 60_000;
    nimFails = true;
    await reg.warmAll();
    s = reg.status();
    expect(s['nim:routeCompile']?.ok).toBe(false);
    expect(s['nim:routeCompile']?.lastWarmAt).toBe(firstWarm);   // last good time survives
    expect(reg.schemasWarm()['nim:routeCompile']).toBe(firstWarm);
  });

  it('warmForMode fires only that mode\'s pairs and de-duplicates concurrent warms', async () => {
    const calls: string[] = [];
    const reg = createWarmupRegistry({
      jobSchemas: {},
      runners: {
        vision: async (m) => {
          calls.push(m);
          await new Promise((r) => setTimeout(r, 5));
          return 'ok';
        },
        nim: async () => '{}',
      },
    });
    await Promise.all([reg.warmForMode('INDOOR_NAV'), reg.warmForMode('INDOOR_NAV')]);
    expect(calls).toEqual(['haiku']);
    await reg.warmForMode('AT_CURB');
    expect(calls.sort()).toEqual(['haiku', 'haiku', 'sonnet']);
  });

  it('start() schedules warmAll on the interval and stop() clears it', () => {
    let fn: (() => void) | null = null;
    let cleared = false;
    const reg = createWarmupRegistry({
      jobSchemas: {},
      runners: { vision: async () => 'ok', nim: async () => '{}' },
      setIntervalFn: (f) => {
        fn = f;
        return 1;
      },
      clearIntervalFn: () => {
        cleared = true;
      },
    });
    reg.start();
    reg.start();
    expect(fn).not.toBeNull();
    reg.stop();
    expect(cleared).toBe(true);
  });
});
