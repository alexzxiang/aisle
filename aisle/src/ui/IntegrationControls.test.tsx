import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { AppMode } from '../core/contracts';
import { services } from '../core/services';
import { bindStoreToBus, createAppStore, type AppStore } from '../core/store';
import { createStubServices } from '../core/stubs';
import type { Trip } from '../core/trip';
import { findForbidden } from './copy';
import { AT_CURB_LABEL, IntegrationControls, NEXT_CHECKOUT_LABEL, START_PICKUP_LABEL, tripLine } from './IntegrationControls';

let store: AppStore;
let unbind: () => void;
const mounted: ReactTestRenderer[] = [];

function setup(mode: AppMode): void {
  const stubs = createStubServices();
  store = createAppStore({ bus: stubs.bus, warn: () => undefined, initial: { mode } });
  unbind = bindStoreToBus(store, stubs.bus);
  services.reset();
  services.setAll({ haptics: stubs.haptics, speech: stubs.speech, sensors: stubs.sensors, perception: stubs.perception, bus: stubs.bus, store });
}

afterEach(async () => {
  for (const r of mounted.splice(0)) {
    await act(async () => {
      r.unmount();
    });
  }
  unbind?.();
  services.reset();
});

function fakeTrip(active = true) {
  const calls: string[] = [];
  const trip: Pick<Trip, 'curbReached' | 'startPickup' | 'nextFromItem' | 'getDebugState'> & { calls: string[] } = {
    calls,
    curbReached: () => {
      calls.push('curb');
    },
    startPickup: async () => {
      calls.push('pickup');
    },
    nextFromItem: () => {
      calls.push('next');
      store.getState().nextFromItem();
    },
    getDebugState: () => ({
      active,
      starts: 1,
      lastError: null,
      manualSignal: 'WALK',
      runner: active ? ({ legIndex: 1, legCount: 4, remainingM: 32.4 } as never) : null,
      crossing: active ? ({ state: 'READING', ladderRung: 1 } as never) : null,
    }),
  };
  return trip;
}

async function render(el: React.ReactElement): Promise<ReactTestRenderer> {
  let r!: ReactTestRenderer;
  await act(async () => {
    r = create(el);
  });
  mounted.push(r);
  return r;
}

function labels(r: ReactTestRenderer): string[] {
  return r.root.findAll((n: ReactTestInstance) => typeof n.props.accessibilityLabel === 'string').map((n) => n.props.accessibilityLabel as string);
}

function press(r: ReactTestRenderer, label: string): void {
  const n = r.root.find((x: ReactTestInstance) => x.props.accessibilityLabel === label && typeof x.props.onPress === 'function');
  act(() => n.props.onPress());
}

describe('IntegrationControls', () => {
  it('formats the trip line', () => {
    const t = fakeTrip();
    expect(tripLine(t.getDebugState())).toBe('trip active (1)  leg 2/4  32 m  crossing reading rung 1  manual WALK');
    expect(tripLine(fakeTrip(false).getDebugState())).toBe('trip idle (1)  no route  crossing —  manual WALK');
  });

  it('shows only the controls that make sense in the mode, forwards presses, and uses no forbidden words', async () => {
    setup('APPROACH_CROSSING');
    const t = fakeTrip();
    const r = await render(<IntegrationControls trip={t} proxyUrl="http://p:8787" mock now={0} pollMs={0} />);
    expect(labels(r)).toContain(AT_CURB_LABEL);
    expect(labels(r)).not.toContain(START_PICKUP_LABEL);
    press(r, AT_CURB_LABEL);
    expect(t.calls).toEqual(['curb']);
    const text = JSON.stringify(r.toJSON());
    expect(findForbidden(text)).toEqual([]);
    expect(text).toContain('MOCK');
  });

  it('at the item: hand guidance and next; next moves the store to CHECKOUT_NAV and the buttons disappear', async () => {
    setup('AT_ITEM');
    const t = fakeTrip();
    const r = await render(<IntegrationControls trip={t} proxyUrl="http://p:8787" mock={false} now={0} pollMs={0} />);
    expect(labels(r)).toEqual(expect.arrayContaining([START_PICKUP_LABEL, NEXT_CHECKOUT_LABEL]));
    expect(labels(r)).not.toContain(AT_CURB_LABEL);
    press(r, START_PICKUP_LABEL);
    press(r, NEXT_CHECKOUT_LABEL);
    expect(t.calls).toEqual(['pickup', 'next']);
    expect(store.getState().mode).toBe('CHECKOUT_NAV');
    expect(labels(r)).not.toContain(NEXT_CHECKOUT_LABEL);
    expect(JSON.stringify(r.toJSON())).toContain('LIVE');
  });
});
