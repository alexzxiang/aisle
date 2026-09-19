import { audioPortsFrom, voicePortFrom } from './adapters';

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('voicePortFrom', () => {
  it('maps press-in to begin and press-out to end, in that order even when begin is slow', async () => {
    const calls: string[] = [];
    const begin = deferred();
    const input = {
      begin: () => {
        calls.push('begin');
        return begin.promise;
      },
      end: async () => {
        calls.push('end');
        return { ok: true };
      },
      cancel: () => calls.push('cancel'),
    };
    const port = voicePortFrom(input);
    void port.start();
    const stopping = port.stop();
    expect(calls).toEqual(['begin']); // end waits for begin to settle
    begin.resolve();
    await stopping;
    expect(calls).toEqual(['begin', 'end']);
  });

  it('a rejected begin is cancelled so the mic never stays open, and reported', async () => {
    const calls: string[] = [];
    const errors: string[] = [];
    const input = {
      begin: async () => {
        calls.push('begin');
        throw new Error('not-allowed');
      },
      end: async () => {
        calls.push('end');
        return {};
      },
      cancel: () => calls.push('cancel'),
    };
    const port = voicePortFrom(input, { onError: (stage) => errors.push(stage) });
    await port.start();
    expect(calls).toEqual(['begin', 'cancel']);
    expect(errors).toEqual(['start']);
  });

  it('a rejected end is cancelled and reported, never thrown at the button', async () => {
    const calls: string[] = [];
    const errors: string[] = [];
    const input = {
      begin: async () => {
        calls.push('begin');
      },
      end: async () => {
        calls.push('end');
        throw new Error('boom');
      },
      cancel: () => calls.push('cancel'),
    };
    const port = voicePortFrom(input, { onError: (stage) => errors.push(stage) });
    await port.start();
    await expect(port.stop()).resolves.toBeUndefined();
    expect(calls).toEqual(['begin', 'end', 'cancel']);
    expect(errors).toEqual(['stop']);
  });
});

describe('audioPortsFrom', () => {
  it('passes the beacon and ticker through and tolerates a missing channel set', () => {
    const beacon = { setTarget: jest.fn(), setMuted: jest.fn(), isMuted: () => false };
    const ticker = { setState: jest.fn() };
    expect(audioPortsFrom({ beacon, ticker })).toEqual({ beacon, ticker });
    expect(audioPortsFrom({ beacon })).toEqual({ beacon });
    expect(audioPortsFrom(null)).toEqual({});
    expect(audioPortsFrom(undefined)).toEqual({});
  });
});
