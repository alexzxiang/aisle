import { DEFAULT_COLLAPSE_MS, createConversationLog, type ConversationEntry } from './conversation';

describe('ConversationLog', () => {
  it('appends user and aisle entries in order with ids, timestamps and sources', () => {
    let t = 1000;
    const log = createConversationLog({ now: () => t });
    log.pushUser('I need eggs', 'voice');
    t += 500;
    log.pushAisle('Eggs. Finding it.', 'speech');
    const e = log.entries();
    expect(e).toHaveLength(2);
    expect(e[0]).toEqual({ id: 'c1', role: 'you', text: 'I need eggs', t: 1000, source: 'voice' });
    expect(e[1]).toEqual({ id: 'c2', role: 'aisle', text: 'Eggs. Finding it.', t: 1500, source: 'speech' });
  });

  it('notifies subscribers with an immutable snapshot and stops after unsubscribe', () => {
    const log = createConversationLog();
    const seen: Array<readonly ConversationEntry[]> = [];
    const off = log.subscribe((entries) => seen.push(entries));
    log.pushAisle('Turn left now.');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(log.entries());
    expect(Object.isFrozen(log.entries())).toBe(true);
    off();
    log.pushAisle('Keep going, looking for a sign.');
    expect(seen).toHaveLength(1);
    expect(log.entries()).toHaveLength(2);
  });

  it('collapses the same text for the same role inside the collapse window (prompt pushed by its producer and by the queue)', () => {
    let t = 0;
    const log = createConversationLog({ now: () => t });
    log.pushAisle('Tilt the camera up.', 'prompt');
    t += 1000;
    log.pushAisle('Tilt the camera up.', 'speech');   // the speech queue's copy
    expect(log.entries()).toHaveLength(1);
    expect(log.entries()[0].source).toBe('prompt');
    // A different role is never collapsed; the same text after the window is a new entry.
    log.pushUser('Tilt the camera up.');
    expect(log.entries()).toHaveLength(2);
    t += DEFAULT_COLLAPSE_MS + 1;
    log.pushAisle('Tilt the camera up.', 'speech');
    expect(log.entries()).toHaveLength(3);
  });

  it('ignores empty text, trims whitespace, caps the length and clears', () => {
    const log = createConversationLog({ max: 3 });
    log.pushUser('   ');
    log.pushAisle('');
    expect(log.entries()).toHaveLength(0);
    log.pushUser('  what   do you see ');
    expect(log.entries()[0].text).toBe('what do you see');
    log.pushAisle('one');
    log.pushAisle('two');
    log.pushAisle('three');
    expect(log.entries().map((e) => e.text)).toEqual(['one', 'two', 'three']);
    let notified = 0;
    log.subscribe(() => { notified += 1; });
    log.clear();
    expect(log.entries()).toHaveLength(0);
    expect(notified).toBe(1);
    log.clear();          // already empty: no notification
    expect(notified).toBe(1);
  });

  it('a throwing subscriber does not stop the push or the other subscribers', () => {
    const log = createConversationLog();
    const seen: number[] = [];
    log.subscribe(() => { throw new Error('boom'); });
    log.subscribe((e) => seen.push(e.length));
    expect(() => log.pushAisle('Far curb.')).not.toThrow();
    expect(seen).toEqual([1]);
  });
});
