import type { PlannerClient } from '../outdoor/planner';
import type { VisionTransport } from '../perception/semanticVision';
import { LatencyRing, liveMetrics, observePlanner, percentile, timedTransport } from './metrics';

describe('percentile / LatencyRing', () => {
  it('nearest-rank p95 and last', () => {
    expect(percentile([], 95)).toBeNull();
    expect(percentile([10], 95)).toBe(10);
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile(values, 50)).toBe(50);
    const ring = new LatencyRing(3);
    expect(ring.last()).toBeNull();
    ring.push(5);
    ring.push(NaN);
    ring.push(-1);
    ring.push(7);
    ring.push(9);
    ring.push(11);
    expect(ring.count()).toBe(3);
    expect(ring.last()).toBe(11);
    expect(ring.p95()).toBe(11);
  });
});

describe('observePlanner / timedTransport', () => {
  it('reports latency and fallback for every planner run and passes the result through', async () => {
    let t = 1000;
    const now = () => t;
    const inner: PlannerClient = {
      async run(job) {
        t += 40;
        return { job, output: { reply: 'Repeating.' } as never, fallback: true, latencyMs: 12 };
      },
    };
    const seen: unknown[] = [];
    const planner = observePlanner(inner, (o) => seen.push(o), now);
    const r = await planner.run('answer', { question: 'repeat', context: {} });
    expect(r.fallback).toBe(true);
    expect(seen).toEqual([{ job: 'answer', latencyMs: 12, fallback: true, roundTripMs: 40 }]);
  });

  it('times a transport ask, including one that rejects, and forwards warm', async () => {
    let t = 0;
    const now = () => t;
    const warmed: string[] = [];
    const inner: VisionTransport = {
      async ask(req) {
        t += 250;
        if (req.seq === 2) throw new Error('boom');
        return { seq: req.seq } as never;
      },
      warm: (mode) => {
        warmed.push(mode);
      },
    };
    const lat: number[] = [];
    const transport = timedTransport(inner, (ms) => lat.push(ms), now);
    await transport.ask({ seq: 1, question: 'free', mode: 'IDLE', facts: { detections: [], ocr: [] } });
    await expect(transport.ask({ seq: 2, question: 'free', mode: 'IDLE', facts: { detections: [], ocr: [] } })).rejects.toThrow('boom');
    expect(lat).toEqual([250, 250]);
    transport.warm?.('INDOOR_NAV');
    expect(warmed).toEqual(['INDOOR_NAV']);
  });
});

describe('liveMetrics', () => {
  it('reads every field live through getters and never throws', () => {
    const ring = new LatencyRing();
    let fps = 80;
    let planner: { latencyMs: number | null; fallback: boolean | null } = { latencyMs: null, fallback: null };
    const m = liveMetrics({
      tier0FrameToEventMs: () => fps,
      tier1: ring,
      tier2: () => planner,
      speech: () => ({ utterancesPerMinute: 3, lastBackend: 'cached', policyDropped: 1 }),
      illegalTransitions: () => 2,
      batteryPercent: () => {
        throw new Error('no battery module');
      },
    });
    expect(m.tier0FrameToEventMs).toBe(80);
    expect(m.tier1LastMs).toBeNull();
    expect(m.tier2FirstTokenMs).toBeNull();
    fps = 120;
    ring.push(900);
    planner = { latencyMs: 700, fallback: false };
    expect(m.tier0FrameToEventMs).toBe(120);
    expect(m.tier1LastMs).toBe(900);
    expect(m.tier1P95Ms).toBe(900);
    expect(m.tier2FirstTokenMs).toBe(700);
    expect(m.tier2Fallback).toBe(false);
    expect(m.utterancesPerMinute).toBe(3);
    expect(m.lastSpeechBackend).toBe('cached');
    expect(m.policyDroppedCount).toBe(1);
    expect(m.illegalTransitions).toBe(2);
    expect(m.batteryPercent).toBeNull();
  });

  it('missing sources read as null', () => {
    const m = liveMetrics({ tier1: new LatencyRing(), tier2: () => ({ latencyMs: null, fallback: null }) });
    expect(m.tier0FrameToEventMs).toBeNull();
    expect(m.utterancesPerMinute).toBeNull();
    expect(m.illegalTransitions).toBeNull();
  });
});
