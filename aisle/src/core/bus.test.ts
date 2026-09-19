import { createEventBus, RingBuffer, DEFAULT_BUS_HISTORY } from './bus';
import type { AppEvent } from './contracts';

describe('RingBuffer', () => {
  it('keeps the last N items oldest → newest', () => {
    const r = new RingBuffer<number>(3);
    expect(r.toArray()).toEqual([]);
    r.push(1); r.push(2);
    expect(r.toArray()).toEqual([1, 2]);
    r.push(3); r.push(4); r.push(5);
    expect(r.toArray()).toEqual([3, 4, 5]);
    expect(r.size).toBe(3);
    expect(r.last(2)).toEqual([4, 5]);
    expect(r.last(10)).toEqual([3, 4, 5]);
    r.clear();
    expect(r.toArray()).toEqual([]);
  });

  it('rejects a non-positive capacity', () => {
    expect(() => new RingBuffer(0)).toThrow();
    expect(() => new RingBuffer(1.5)).toThrow();
  });
});

describe('EventBus', () => {
  it('dispatches synchronously to typed listeners only', () => {
    const bus = createEventBus();
    const seen: string[] = [];
    bus.on('SIGNAL_STATE', (e) => {
      // Extract typing: `state` is available without a cast.
      seen.push(`signal:${e.state}:${e.fresh}`);
    });
    bus.on('CURB_REACHED', (e) => seen.push(`curb:${e.crossingId}`));

    bus.emit({ type: 'SIGNAL_STATE', state: 'WALK', fresh: true, confidence: 0.9 });
    expect(seen).toEqual(['signal:WALK:true']);
    bus.emit({ type: 'CURB_REACHED', crossingId: 'x1' });
    expect(seen).toEqual(['signal:WALK:true', 'curb:x1']);
    bus.emit({ type: 'CHECKOUT_REACHED' });
    expect(seen).toHaveLength(2);
  });

  it('unsubscribes idempotently', () => {
    const bus = createEventBus();
    const cb = jest.fn();
    const off = bus.on('CHECKOUT_REACHED', cb);
    bus.emit({ type: 'CHECKOUT_REACHED' });
    off();
    off();
    bus.emit({ type: 'CHECKOUT_REACHED' });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(bus.listenerCount('CHECKOUT_REACHED')).toBe(0);
  });

  it('survives a listener unsubscribing itself or another during dispatch', () => {
    const bus = createEventBus();
    const order: string[] = [];
    let offB: () => void = () => {};
    bus.on('CHECKOUT_REACHED', () => {
      order.push('a');
      offB();
    });
    offB = bus.on('CHECKOUT_REACHED', () => order.push('b'));
    bus.emit({ type: 'CHECKOUT_REACHED' });
    // Snapshot semantics: b still runs for the emit in progress, never again.
    expect(order).toEqual(['a', 'b']);
    bus.emit({ type: 'CHECKOUT_REACHED' });
    expect(order).toEqual(['a', 'b', 'a']);
  });

  it('isolates a throwing listener', () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const bus = createEventBus();
    const good = jest.fn();
    bus.on('CHECKOUT_REACHED', () => {
      throw new Error('boom');
    });
    bus.on('CHECKOUT_REACHED', good);
    expect(() => bus.emit({ type: 'CHECKOUT_REACHED' })).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it('stamps { seq, ts } and keeps a ring of the last N events', () => {
    let t = 1000;
    const bus = createEventBus({ historySize: 3, now: () => (t += 10) });
    for (let i = 0; i < 5; i += 1) {
      bus.emit({ type: 'OUTDOOR_LEG_ADVANCED', index: i, instruction: 'Keep going' });
    }
    const h = bus.history();
    expect(h).toHaveLength(3);
    expect(h.map((r) => r.seq)).toEqual([3, 4, 5]);
    expect(h.map((r) => r.ts)).toEqual([1030, 1040, 1050]);
    expect(h.map((r) => (r.event as Extract<AppEvent, { type: 'OUTDOOR_LEG_ADVANCED' }>).index)).toEqual([2, 3, 4]);
    expect(bus.recent(1)[0]?.seq).toBe(5);
    expect(bus.seq()).toBe(5);
    bus.clearHistory();
    expect(bus.history()).toEqual([]);
    expect(bus.seq()).toBe(5);
  });

  it('defaults to a 50-event history', () => {
    const bus = createEventBus();
    for (let i = 0; i < DEFAULT_BUS_HISTORY + 7; i += 1) bus.emit({ type: 'CHECKOUT_REACHED' });
    expect(bus.history()).toHaveLength(DEFAULT_BUS_HISTORY);
    expect(bus.history()[0]?.seq).toBe(8);
  });

  it('onAny receives every stamped record', () => {
    const bus = createEventBus();
    const recs: number[] = [];
    const off = bus.onAny((r) => recs.push(r.seq));
    bus.emit({ type: 'CHECKOUT_REACHED' });
    bus.emit({ type: 'ERROR', scope: 't', message: 'm' });
    off();
    bus.emit({ type: 'CHECKOUT_REACHED' });
    expect(recs).toEqual([1, 2]);
  });
});
