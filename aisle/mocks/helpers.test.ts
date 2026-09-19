/**
 * Pure helpers: replay clock, jsonl parser, rate limiter, network gate, track index,
 * phase event chains.
 */
import type { AppEvent } from '../src/core/contracts';
import { createReplayClock } from './clock';
import { parseJsonl } from './jsonl';
import { createNetworkGate } from './network';
import { DEFAULT_JUMP_CONTEXT, PHASES_PAST_TRANSITION, emitJumpEvents, eventsForPhase } from './phases';
import { RATE_LIMITS_MS, createRateLimiter } from './rateLimit';
import { REPLAY_PHASES, asTrackFixture, isReplayPhase, sampleIndexAt, trackDurationS } from './track';

describe('replay clock', () => {
  it('advances only while playing, scaled by speed, and re-cursors on seek', () => {
    let wall = 1000;
    const c = createReplayClock({ wall: () => wall });
    expect(c.nowMs()).toBe(0);
    wall += 500;
    expect(c.nowMs()).toBe(0); // paused
    c.play();
    wall += 500;
    expect(c.nowMs()).toBe(500);
    c.setSpeed(4);
    wall += 100;
    expect(c.nowMs()).toBe(900);
    c.pause();
    wall += 1000;
    expect(c.nowMs()).toBe(900);
    const seeks: number[] = [];
    c.onSeek((ms) => seeks.push(ms));
    c.seek(-5);
    expect(c.nowMs()).toBe(0);
    c.seek(42_000);
    expect(seeks).toEqual([0, 42_000]);
    expect(c.isPlaying()).toBe(false);
  });
});

describe('parseJsonl', () => {
  it('parses lines, sorts by t, and counts malformed lines without throwing', () => {
    const text = [
      '{"t": 200, "event": "onPose", "payload": {"yawDeg": 1}}',
      '{"t": 100, "event": "onDepth", "payload": {}}',
      '{"t": 300, "event": "onOcrText", "payload": [ {"text": "BROKEN LINE',
      '[1,2,3]',
      '{"t": "x", "event": "onPose"}',
      '{"t": 5, "event": "notAnEvent"}',
      '',
    ].join('\n');
    const p = parseJsonl(text);
    expect(p.lines.map((l) => l.t)).toEqual([100, 200]);
    expect(p.skipped.map((s) => s.reason)).toEqual(['invalid_json', 'not_object', 'bad_t', 'bad_event']);
  });
});

describe('rate limiter', () => {
  it('honours the §7 minimum intervals, per-track keys, and change bypass', () => {
    const r = createRateLimiter();
    expect(RATE_LIMITS_MS.onVehicleApproaching).toBe(4000);
    expect(r.allow('onVehicleApproaching', 0, 7)).toBe(true);
    expect(r.allow('onVehicleApproaching', 1000, 7)).toBe(false);
    expect(r.allow('onVehicleApproaching', 1000, 8)).toBe(true);   // another track
    expect(r.allow('onVehicleApproaching', 4000, 7)).toBe(true);
    expect(r.allow('onSignalState', 0)).toBe(true);
    expect(r.allow('onSignalState', 500)).toBe(false);              // heartbeat too soon
    expect(r.allow('onSignalState', 600, undefined, true)).toBe(true); // state change bypasses
    expect(r.allow('onTrackingState', 0)).toBe(true);
    expect(r.allow('onTrackingState', 1)).toBe(true);               // every change
    r.reset();
    expect(r.allow('onVehicleApproaching', 4100, 7)).toBe(true);
  });
});

describe('network gate', () => {
  it('toggles and notifies once per change', () => {
    const g = createNetworkGate(true);
    const seen: boolean[] = [];
    g.onChange((v) => seen.push(v));
    g.setOnline(true);
    expect(g.toggle()).toBe(false);
    g.setOnline(false);
    g.setOnline(true);
    expect(seen).toEqual([false, true]);
  });
});

describe('track helpers', () => {
  const track = asTrackFixture({ hz: 1, samples: [{ t: 0 }, { t: 1 }, { t: 5 }, { t: 9 }] });
  it('binary-searches the last sample at or before t', () => {
    expect(sampleIndexAt(track, -1)).toBe(-1);
    expect(sampleIndexAt(track, 0)).toBe(0);
    expect(sampleIndexAt(track, 4.9)).toBe(1);
    expect(sampleIndexAt(track, 5)).toBe(2);
    expect(sampleIndexAt(track, 100)).toBe(3);
    expect(trackDurationS(track)).toBe(9);
  });
  it('guards the fixture shape and the phase list', () => {
    expect(() => asTrackFixture({})).toThrow(/hz\/samples/);
    expect(REPLAY_PHASES).toHaveLength(9);
    expect(isReplayPhase('AT_CURB')).toBe(true);
    expect(isReplayPhase('IDLE')).toBe(false);
  });
});

describe('phase jumps', () => {
  it('builds the legal chain for every phase (01 §1)', () => {
    const t = (phase: Parameters<typeof eventsForPhase>[0]) => eventsForPhase(phase).map((e) => e.type);
    expect(t('OUTDOOR_NAV')).toEqual(['ROUTE_READY']);
    expect(t('APPROACH_CROSSING')).toEqual(['ROUTE_READY', 'CROSSING_AHEAD']);
    expect(t('AT_CURB')).toEqual(['ROUTE_READY', 'CROSSING_AHEAD', 'CURB_REACHED']);
    expect(t('CROSSING')).toEqual(['ROUTE_READY', 'CROSSING_AHEAD', 'CURB_REACHED', 'CROSSING_STARTED']);
    expect(t('TRANSITION')).toEqual(['ROUTE_READY', 'STORE_ENTERED']);
    expect(t('INDOOR_NAV')).toEqual(['ROUTE_READY', 'STORE_ENTERED']);
    expect(t('AT_ITEM')).toEqual(['ROUTE_READY', 'STORE_ENTERED', 'TARGET_AISLE_REACHED']);
    expect(t('ITEM_PICKUP')).toEqual(['ROUTE_READY', 'STORE_ENTERED', 'TARGET_AISLE_REACHED', 'ITEM_HAND_GUIDANCE']);
    expect(t('CHECKOUT_NAV')).toEqual(['ROUTE_READY', 'STORE_ENTERED', 'TARGET_AISLE_REACHED', 'ITEM_HAND_GUIDANCE']);
    expect(PHASES_PAST_TRANSITION.has('INDOOR_NAV')).toBe(true);
    expect(PHASES_PAST_TRANSITION.has('TRANSITION')).toBe(false);
  });

  it('aborts to IDLE first, clears firstRun, prefixes ITEM_REQUESTED and short-circuits the TRANSITION cap', () => {
    const emitted: AppEvent[] = [];
    const calls: string[] = [];
    let mode: 'IDLE' | 'OUTDOOR_NAV' = 'OUTDOOR_NAV';
    const store = {
      getMode: () => mode,
      abort: () => { calls.push('abort'); mode = 'IDLE'; },
      setFirstRun: (v: boolean) => calls.push(`firstRun=${v}`),
      transitionEnded: () => calls.push('transitionEnded'),
    };
    const out = emitJumpEvents('AT_ITEM', { bus: { emit: (e) => emitted.push(e) }, store });
    expect(calls).toEqual(['abort', 'firstRun=false', 'transitionEnded']);
    expect(out.map((e) => e.type)).toEqual(['ITEM_REQUESTED', 'ROUTE_READY', 'STORE_ENTERED', 'TARGET_AISLE_REACHED']);
    expect(emitted).toEqual(out);
    expect(out[0]).toEqual({ type: 'ITEM_REQUESTED', item: DEFAULT_JUMP_CONTEXT.item, source: 'mock' });
    const entered = out.find((e) => e.type === 'STORE_ENTERED');
    expect(entered).toEqual({ type: 'STORE_ENTERED', reason: 'MANUAL', confidence: 1 });
  });

  it('does not call transitionEnded for a jump that stops in TRANSITION', () => {
    const calls: string[] = [];
    emitJumpEvents('TRANSITION', {
      bus: { emit: () => undefined },
      store: { getMode: () => 'IDLE', abort: () => calls.push('abort'), setFirstRun: () => undefined, transitionEnded: () => calls.push('transitionEnded') },
    });
    expect(calls).toEqual([]);
  });
});
