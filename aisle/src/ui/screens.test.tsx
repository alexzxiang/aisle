/**
 * Every screen rendered against the stubs from src/core/stubs.ts through the
 * registry: accessibility labels present, the forbidden words never rendered,
 * and the few interactions that touch services do what they say.
 */
import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { AccessibilityInfo } from 'react-native';
import { services } from '../core/services';
import { bindStoreToBus, createAppStore, type AppStore } from '../core/store';
import { createStubServices, type StubServices } from '../core/stubs';
import type { AppMode, SceneHypothesis } from '../core/contracts';
import { MAX_UTTERANCE_WORDS, SAY_CARD_EXAMPLES, SAY_CARD_NOTE, SAY_CARD_TITLE, findForbidden, wordCount } from './copy';
import { Root } from './Root';
import { HomeScreen, CANCEL_LABEL, FIND_LABEL, ITEM_FIELD_LABEL, PENDING_NOTE, PRACTICE_LABEL, SETTINGS_LABEL } from './HomeScreen';
import {
  NavScreen,
  REPEAT_LABEL,
  STOP_ARMED_LABEL,
  STOP_ARM_MS,
  STOP_ARM_SCREEN_READER_MS,
  STOP_HINT,
  STOP_HINT_SCREEN_READER,
  STOP_LABEL,
} from './NavScreen';
import { OnboardingScreen, DONE_LABEL, NEXT_LABEL, NO_LABEL, PLAY_AGAIN_LABEL, SKIP_LABEL, YES_LABEL } from './OnboardingScreen';
import { DebugPanel, DEBUG_CLOSE_LABEL } from './DebugPanel';
import { SettingsSheet, CLOSE_LABEL, FASTER_LABEL, SLOWER_LABEL, TRAINING_LABEL } from './SettingsSheet';
import { StateBand, DEBUG_LONG_PRESS_MS, HERO_ANNOUNCE_GRACE_MS, shouldAnnounceHero } from './StateBand';
import { CAMERA_LABEL, CAMERA_PLACEHOLDER, CameraPanel, hasCameraPreview, setCameraPreviewForTests } from './CameraPanel';
import { DESCRIBE_LABEL, NARRATE_LABEL, QUIET_LABEL, TRANSCRIPT_EMPTY, TRANSCRIPT_LABEL, TranscriptPanel, visibleEntries } from './TranscriptPanel';
import { DESCRIBE_SETTING_LABEL } from './SettingsSheet';
import { GlassPanel, isBlurAvailable } from './Glass';
import { stripSlots, EMPTY_FACTS } from './derive';
import { accents, signalColors, tintOf } from './theme';
import type { ConversationEntryLike, ConversationLogPort } from './ports';
import { TalkButton, TALK_HELD_LABEL, TALK_HINT_HOLD, TALK_HINT_TOGGLE, TALK_LABEL, TALK_TOGGLE_HELD_LABEL, TALK_TOGGLE_LABEL } from './TalkButton';
import { stepsFor } from './onboardingSteps';
import { PHRASES, isPhraseKey } from '../core/phrases';

const T0 = 1_700_000_000_000;

let stubs: StubServices;
let store: AppStore;
let unbind: () => void;
const mounted: ReactTestRenderer[] = [];

function setup(initialMode: AppMode = 'IDLE', extra: Partial<Parameters<typeof createAppStore>[0]> = {}): void {
  stubs = createStubServices();
  store = createAppStore({ bus: stubs.bus, warn: () => undefined, initial: { mode: initialMode, ...extra.initial } });
  unbind = bindStoreToBus(store, stubs.bus);
  const { haptics, speech, sensors, perception, bus } = stubs;
  services.reset();
  services.setAll({ haptics, speech, sensors, perception, bus, store });
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

async function render(el: React.ReactElement): Promise<ReactTestRenderer> {
  let r!: ReactTestRenderer;
  await act(async () => {
    r = create(el);
  });
  mounted.push(r);
  return r;
}

type Json = { type: string; props: Record<string, unknown>; children: Array<Json | string> | null } | string | null;

/** Every string a sighted or VoiceOver user could meet: text, labels, hints, placeholders. */
function collectStrings(node: Json | Json[]): string[] {
  if (node === null) return [];
  if (Array.isArray(node)) return node.flatMap(collectStrings);
  if (typeof node === 'string') return [node];
  const out: string[] = [];
  for (const k of ['accessibilityLabel', 'accessibilityHint', 'placeholder', 'children'] as const) {
    const v = node.props[k];
    if (typeof v === 'string') out.push(v);
  }
  const value = node.props.accessibilityValue as { text?: string } | undefined;
  if (value?.text) out.push(value.text);
  if (node.children) out.push(...collectStrings(node.children));
  return out;
}

function renderedStrings(r: ReactTestRenderer): string[] {
  return collectStrings(r.toJSON() as Json | Json[]);
}

function expectClean(r: ReactTestRenderer): void {
  for (const s of renderedStrings(r)) {
    expect({ text: s, hits: findForbidden(s) }).toEqual({ text: s, hits: [] });
  }
}

function byLabel(r: ReactTestRenderer, label: string): ReactTestInstance {
  const all = r.root.findAll((n: ReactTestInstance) => n.props.accessibilityLabel === label && typeof n.props.accessibilityRole === 'string');
  if (all.length === 0) throw new Error(`no element labelled "${label}"`);
  return all[0];
}

function labelsOf(r: ReactTestRenderer): string[] {
  return r.root
    .findAll((n: ReactTestInstance) => typeof n.props.accessibilityRole === 'string' && typeof n.props.accessibilityLabel === 'string')
    .map((n) => n.props.accessibilityLabel as string);
}

function press(node: ReactTestInstance): Promise<void> {
  return act(async () => {
    (node.props.onPress as () => void)();
  });
}

/** Presence by testID. A panel forwards its testID to more than one node, so only presence is meaningful. */
function hasNode(r: ReactTestRenderer, testID: string): boolean {
  return r.root.findAll((n: ReactTestInstance) => n.props.testID === testID).length > 0;
}

/** A confirmed scene hypothesis, the shape `situate.ts` writes into the store. */
function scene(label: string, confirmed = true): SceneHypothesis {
  return { setting: 'store', label, confidence: 0.9, confirmed, source: 'camera', at: T0 };
}

// ---------------------------------------------------------------------------

describe('HomeScreen', () => {
  it('asks one question, labels every control, renders the three notices, no forbidden words', async () => {
    setup('IDLE');
    const r = await render(<HomeScreen reduceMotion />);
    const strings = renderedStrings(r);
    expect(strings).toContain('What do you need?');
    expect(strings).toContain('Ready');
    expect(strings.some((s) => s.startsWith('Aisle is a prototype'))).toBe(true);
    expect(strings.some((s) => s.includes('video stays on this phone'))).toBe(true);
    expect(strings.some((s) => s.toLowerCase().includes('beta'))).toBe(true);
    const labels = labelsOf(r);
    expect(labels).toEqual(expect.arrayContaining([TALK_LABEL, PRACTICE_LABEL, SETTINGS_LABEL, FIND_LABEL, 'Mode: Ready']));
    expect(r.root.findAll((n: ReactTestInstance) => n.props.accessibilityLabel === ITEM_FIELD_LABEL && typeof n.type === 'string')).toHaveLength(1);
    expectClean(r);
  });

  it('displays the beta notice B supplies', async () => {
    setup('IDLE');
    const r = await render(<HomeScreen reduceMotion betaNotice="Routes for walking are in beta; use caution." />);
    expect(renderedStrings(r)).toContain('Routes for walking are in beta; use caution.');
  });

  it('typing an item and submitting emits ITEM_REQUESTED from the keyboard and taps CONFIRM', async () => {
    setup('IDLE');
    const r = await render(<HomeScreen reduceMotion />);
    const field = r.root.findAll((n: ReactTestInstance) => n.props.accessibilityLabel === ITEM_FIELD_LABEL && typeof n.type === 'string')[0];
    await act(async () => {
      (field.props.onChangeText as (t: string) => void)('  Eggs ');
    });
    await act(async () => {
      (field.props.onSubmitEditing as () => void)();
    });
    const events = stubs.bus.history().map((h) => h.event);
    expect(events).toContainEqual({ type: 'ITEM_REQUESTED', item: 'eggs', source: 'keyboard' });
    expect(store.getState().targetItem).toBe('eggs');
    expect(store.getState().mode).toBe('ONBOARDING'); // first run
    expect(stubs.log.calls).toContainEqual(expect.objectContaining({ service: 'haptics', method: 'play', args: ['CONFIRM'] }));
  });

  it('ignores an empty submission', async () => {
    setup('IDLE');
    const r = await render(<HomeScreen reduceMotion />);
    await press(byLabel(r, FIND_LABEL));
    expect(stubs.bus.history()).toHaveLength(0);
  });

  it('"I need eggs" typed becomes the item eggs, is acknowledged out loud, and Home shows the pending route', async () => {
    setup('IDLE', { initial: { firstRun: false } });
    const r = await render(<HomeScreen reduceMotion now={T0} />);
    const field = r.root.findAll((n: ReactTestInstance) => n.props.accessibilityLabel === ITEM_FIELD_LABEL && typeof n.type === 'string')[0];
    await act(async () => {
      (field.props.onChangeText as (t: string) => void)('I need eggs, please.');
    });
    await press(byLabel(r, FIND_LABEL));
    expect(stubs.bus.history().map((h) => h.event)).toContainEqual({ type: 'ITEM_REQUESTED', item: 'eggs', source: 'keyboard' });
    const say = stubs.log.calls.find((c) => c.service === 'speech' && c.method === 'say');
    expect(say?.args[0]).toEqual(expect.objectContaining({ text: 'Eggs. Planning the route.', priority: 'NAV' }));
    // Returning user: IDLE until ROUTE_READY, and the screen says so.
    expect(store.getState().mode).toBe('IDLE');
    const strings = renderedStrings(r);
    expect(strings).toContain('Planning a route for eggs');
    expect(strings).toContain(PENDING_NOTE);
    expectClean(r);
    await press(byLabel(r, CANCEL_LABEL));
    expect(store.getState().targetItem).toBeNull();
    expect(renderedStrings(r)).toContain('What do you need?');
    expect(labelsOf(r)).not.toContain(CANCEL_LABEL);
  });

  it('a route error is shown as what happened and what to do; internal errors are not', async () => {
    setup('IDLE');
    const r = await render(<HomeScreen reduceMotion now={T0} />);
    await act(async () => {
      stubs.bus.emit({ type: 'ERROR', scope: 'store', message: 'ILLEGAL MODE TRANSITION' });
    });
    expect(r.root.findAll((n: ReactTestInstance) => n.props.accessibilityRole === 'alert')).toHaveLength(0);
    await act(async () => {
      stubs.bus.emit({ type: 'ERROR', scope: 'route', message: 'computeRoutes 503' });
    });
    const alerts = r.root.findAll((n: ReactTestInstance) => n.props.accessibilityRole === 'alert' && typeof n.type === 'string');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].props.children).toBe("Couldn't plan the route. Check the connection and try again.");
    expectClean(r);
  });

  it('"Practice the vibrations" enters ONBOARDING', async () => {
    setup('IDLE', { initial: { firstRun: false } });
    const r = await render(<HomeScreen reduceMotion />);
    await press(byLabel(r, PRACTICE_LABEL));
    expect(store.getState().mode).toBe('ONBOARDING');
  });

  it('holding the talk button says Listening and drives the voice port', async () => {
    setup('IDLE');
    const calls: string[] = [];
    const voice = { start: () => void calls.push('start'), stop: () => void calls.push('stop') };
    const r = await render(<HomeScreen reduceMotion voice={voice} />);
    const talk = byLabel(r, TALK_LABEL);
    await act(async () => {
      (talk.props.onPressIn as () => void)();
    });
    expect(labelsOf(r)).toContain(TALK_HELD_LABEL);
    await act(async () => {
      (byLabel(r, TALK_HELD_LABEL).props.onPressOut as () => void)();
    });
    expect(labelsOf(r)).toContain(TALK_LABEL);
    expect(calls).toEqual(['start', 'stop']);
  });

  it('unmounting while held closes the mic', async () => {
    setup('IDLE');
    const calls: string[] = [];
    const voice = { start: () => void calls.push('start'), stop: () => void calls.push('stop') };
    const r = await render(<HomeScreen reduceMotion voice={voice} />);
    await act(async () => {
      (byLabel(r, TALK_LABEL).props.onPressIn as () => void)();
    });
    await act(async () => {
      r.unmount();
    });
    expect(calls).toEqual(['start', 'stop']);
  });
});

describe('TalkButton under a screen reader', () => {
  it('direct touch: hold mode with the hold hint, no onPress', async () => {
    setup('IDLE');
    const r = await render(<TalkButton screenReader={false} />);
    const talk = byLabel(r, TALK_LABEL);
    expect(talk.props.accessibilityHint).toBe(TALK_HINT_HOLD);
    expect(talk.props.onPress).toBeUndefined();
    expect(typeof talk.props.onPressIn).toBe('function');
    expectClean(r);
  });

  it('VoiceOver: a double-tap toggles the mic on, a second one toggles it off, busy while listening', async () => {
    setup('IDLE');
    const calls: string[] = [];
    const voice = { start: () => void calls.push('start'), stop: () => void calls.push('stop') };
    const r = await render(<TalkButton voice={voice} screenReader />);
    const talk = byLabel(r, TALK_TOGGLE_LABEL);
    // Press-in/out are not wired: a double-tap's instant press-in + press-out cannot open and close the mic.
    expect(talk.props.onPressIn).toBeUndefined();
    expect(talk.props.onPressOut).toBeUndefined();
    expect(talk.props.accessibilityHint).toBe(TALK_HINT_TOGGLE);
    expect(talk.props.accessibilityState).toEqual({ busy: false });
    await press(talk);
    expect(calls).toEqual(['start']);
    const listening = byLabel(r, TALK_TOGGLE_HELD_LABEL);
    expect(listening.props.accessibilityState).toEqual({ busy: true });
    await press(listening);
    expect(calls).toEqual(['start', 'stop']);
    expect(labelsOf(r)).toContain(TALK_TOGGLE_LABEL);
    expectClean(r);
  });

  it('VoiceOver: unmounting while listening closes the mic', async () => {
    setup('IDLE');
    const calls: string[] = [];
    const voice = { start: () => void calls.push('start'), stop: () => void calls.push('stop') };
    const r = await render(<TalkButton voice={voice} screenReader />);
    await press(byLabel(r, TALK_TOGGLE_LABEL));
    await act(async () => {
      r.unmount();
    });
    expect(calls).toEqual(['start', 'stop']);
  });
});

describe('NavScreen', () => {
  it('shows mode word, hero, the three slots and the four controls, in reading order', async () => {
    setup('OUTDOOR_NAV');
    const r = await render(<NavScreen reduceMotion now={T0} />);
    const strings = renderedStrings(r);
    expect(strings).toContain('Walking');
    expect(strings).toContain('Keep walking');
    const labels = labelsOf(r);
    const order = ['Mode: Walking', 'Signal: not seen', 'Vehicles: none reported', 'Aisle: no sign read yet', TALK_LABEL, REPEAT_LABEL, STOP_LABEL];
    const idx = order.map((l) => labels.indexOf(l));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    expectClean(r);
  });

  it('follows bus events: leg instruction, curb, signal state and vehicle warning', async () => {
    setup('OUTDOOR_NAV');
    const r = await render(<NavScreen reduceMotion now={T0} />);
    await act(async () => {
      stubs.bus.emit({ type: 'OUTDOOR_LEG_ADVANCED', index: 0, instruction: 'Turn right in twenty feet' });
    });
    expect(renderedStrings(r)).toContain('Turn right in twenty feet');
    await act(async () => {
      stubs.bus.emit({ type: 'CROSSING_AHEAD', crossingId: 'c1', street: 'Forbes', signalized: true, pushButtonLikely: false, bearingDeg: 90, distanceM: 25 });
      stubs.bus.emit({ type: 'CURB_REACHED', crossingId: 'c1' });
      stubs.bus.emit({ type: 'SIGNAL_STATE', state: 'WALK', fresh: true, confidence: 0.97 });
    });
    expect(store.getState().mode).toBe('AT_CURB');
    const strings = renderedStrings(r);
    expect(strings).toContain('At the curb');
    expect(strings).toContain('Walk signal on');
    expect(labelsOf(r).some((l) => l.startsWith('Signal: walk, seen'))).toBe(true);
    expectClean(r);
  });

  it('a hero from a previous mode does not survive the mode change (re-plan drops the crossing)', async () => {
    setup('OUTDOOR_NAV');
    const r = await render(<NavScreen reduceMotion now={T0} />);
    await act(async () => {
      stubs.bus.emit({ type: 'CROSSING_AHEAD', crossingId: 'c1', street: 'Forbes', signalized: true, pushButtonLikely: false, bearingDeg: 90, distanceM: 25 });
    });
    expect(store.getState().mode).toBe('APPROACH_CROSSING');
    expect(renderedStrings(r)).toContain('Crossing ahead: Forbes. Signalized.');
    await act(async () => {
      stubs.bus.emit({ type: 'ROUTE_READY', legCount: 2, destName: 'Demo', crossingCount: 0 });
    });
    expect(store.getState().mode).toBe('OUTDOOR_NAV');
    expect(renderedStrings(r)).not.toContain('Crossing ahead: Forbes. Signalized.');
    expect(renderedStrings(r)).toContain('Keep walking');
  });

  it('the walk signal stays the hero from the curb into the roadway', async () => {
    setup('AT_CURB');
    const r = await render(<NavScreen reduceMotion now={T0} />);
    await act(async () => {
      stubs.bus.emit({ type: 'SIGNAL_STATE', state: 'WALK', fresh: true, confidence: 0.97 });
      stubs.bus.emit({ type: 'CROSSING_STARTED', crossingId: 'c1' });
    });
    expect(store.getState().mode).toBe('CROSSING');
    expect(renderedStrings(r)).toContain('Crossing');
    expect(renderedStrings(r)).toContain('Walk signal on');
  });

  it('every mode renders clean copy with the right mode word', async () => {
    const modes: AppMode[] = ['OUTDOOR_NAV', 'APPROACH_CROSSING', 'AT_CURB', 'CROSSING', 'TRANSITION', 'INDOOR_NAV', 'AT_ITEM', 'ITEM_PICKUP', 'CHECKOUT_NAV', 'DONE'];
    for (const mode of modes) {
      setup(mode, { initial: { targetItem: 'eggs', targetSide: 'RIGHT' } });
      const r = await render(<NavScreen reduceMotion now={T0} />);
      expectClean(r);
      expect(labelsOf(r).some((l) => l.startsWith('Mode: '))).toBe(true);
      if (mode === 'AT_ITEM') expect(renderedStrings(r)).toContain('Eggs on your right');
      await act(async () => {
        r.unmount();
      });
      mounted.splice(mounted.indexOf(r), 1);
      unbind();
    }
  });

  it('Repeat says the hero through the speech service', async () => {
    setup('OUTDOOR_NAV');
    const r = await render(<NavScreen reduceMotion now={T0} />);
    await act(async () => {
      stubs.bus.emit({ type: 'OUTDOOR_LEG_ADVANCED', index: 1, instruction: 'Turn left now' });
    });
    await press(byLabel(r, REPEAT_LABEL));
    const say = stubs.log.calls.find((c) => c.service === 'speech' && c.method === 'say');
    expect(say?.args[0]).toEqual(expect.objectContaining({ text: 'Turn left now', priority: 'NAV' }));
  });

  it('Stop guidance needs two taps, then aborts to IDLE with a CONFIRM tap', async () => {
    setup('INDOOR_NAV', { initial: { targetItem: 'eggs' } });
    const r = await render(<NavScreen reduceMotion now={T0} />);
    await press(byLabel(r, STOP_LABEL));
    expect(store.getState().mode).toBe('INDOOR_NAV');
    expect(labelsOf(r)).toContain(STOP_ARMED_LABEL);
    await press(byLabel(r, STOP_ARMED_LABEL));
    expect(store.getState().mode).toBe('IDLE');
    expect(store.getState().targetItem).toBeNull();
    expect(stubs.log.calls).toContainEqual(expect.objectContaining({ method: 'play', args: ['CONFIRM'] }));
  });

  it('a two-second hold stops at once', async () => {
    setup('OUTDOOR_NAV');
    const r = await render(<NavScreen reduceMotion now={T0} />);
    const stop = byLabel(r, STOP_LABEL);
    expect(stop.props.delayLongPress).toBe(2000);
    await act(async () => {
      (stop.props.onLongPress as () => void)();
    });
    expect(store.getState().mode).toBe('IDLE');
  });

  it('with a screen reader on, Stop drops the hold, says so, and announces the armed state', async () => {
    setup('OUTDOOR_NAV');
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
    try {
      const r = await render(<NavScreen reduceMotion now={T0} screenReader />);
      const stop = byLabel(r, STOP_LABEL);
      // VoiceOver's activate delivers press-in and press-out together: a hold never arrives.
      expect(stop.props.onLongPress).toBeUndefined();
      expect(stop.props.delayLongPress).toBeUndefined();
      expect(stop.props.accessibilityHint).toBe(STOP_HINT_SCREEN_READER);

      await press(stop);
      expect(store.getState().mode).toBe('OUTDOOR_NAV');
      expect(announce).toHaveBeenCalledWith(STOP_ARMED_LABEL);
      await press(byLabel(r, STOP_ARMED_LABEL));
      expect(store.getState().mode).toBe('IDLE');
    } finally {
      announce.mockRestore();
    }
  });

  it('without a screen reader the hold and its hint stay', async () => {
    setup('OUTDOOR_NAV');
    const r = await render(<NavScreen reduceMotion now={T0} screenReader={false} />);
    const stop = byLabel(r, STOP_LABEL);
    expect(stop.props.onLongPress).toEqual(expect.any(Function));
    expect(stop.props.accessibilityHint).toBe(STOP_HINT);
  });

  it('the armed window is longer under a screen reader', () => {
    expect(STOP_ARM_SCREEN_READER_MS).toBeGreaterThan(STOP_ARM_MS);
  });

  it('the Quiet pill turns narration off and back on, and never stops guidance', async () => {
    setup('OUTDOOR_NAV');
    const r = await render(<NavScreen reduceMotion now={T0} />);
    expect(store.getState().describeSurroundings).toBe(true);

    await press(byLabel(r, QUIET_LABEL));
    expect(store.getState().describeSurroundings).toBe(false);
    // The label now offers the way back, and the trip is untouched.
    expect(labelsOf(r)).toContain(NARRATE_LABEL);
    expect(labelsOf(r)).not.toContain(QUIET_LABEL);
    expect(store.getState().mode).toBe('OUTDOOR_NAV');

    await press(byLabel(r, NARRATE_LABEL));
    expect(store.getState().describeSurroundings).toBe(true);
    expectClean(r);
  });

  it('shows the scene line once something is known, and never through the crossing', async () => {
    setup('INDOOR_NAV');
    const r = await render(<NavScreen reduceMotion now={T0} />);
    expect(hasNode(r, 'scene-panel')).toBe(false);

    await act(async () => {
      (store.setState as unknown as (p: Record<string, unknown>) => void)({ scene: scene('in the dairy aisle') });
    });
    expect(hasNode(r, 'scene-panel')).toBe(true);
    expect(renderedStrings(r)).toContain('You are: in the dairy aisle');

    await act(async () => {
      store.getState().setMode('AT_ITEM');
    });
    expect(renderedStrings(r)).toContain('You are: in the dairy aisle');
  });

  it('suppresses the scene line at the curb, where nothing competes with the band', async () => {
    setup('AT_CURB', { initial: { scene: scene('at a street crossing') } });
    const r = await render(<NavScreen reduceMotion now={T0} />);
    expect(hasNode(r, 'scene-panel')).toBe(false);
    expectClean(r);
  });

  it('in DONE the second target reads Finish and ends the trip', async () => {
    setup('DONE');
    const r = await render(<NavScreen reduceMotion now={T0} />);
    expect(renderedStrings(r)).toContain("You've reached checkout");
    await press(byLabel(r, 'Finish'));
    expect(store.getState().mode).toBe('IDLE');
  });

  it('the hero is the single live region', async () => {
    setup('OUTDOOR_NAV');
    const r = await render(<NavScreen reduceMotion now={T0} />);
    const live = r.root.findAll((n: ReactTestInstance) => n.props.accessibilityLiveRegion !== undefined && typeof n.type === 'string');
    expect(live).toHaveLength(1);
    expect(live[0].props.children).toBe('Keep walking');
  });
});

describe('StateBand', () => {
  it('opens the debug panel on a 1.5 s long-press of the mode word, never a tap', async () => {
    setup('OUTDOOR_NAV');
    const open = jest.fn();
    const r = await render(<StateBand mode="OUTDOOR_NAV" hero="Keep walking" onLongPressMode={open} reduceMotion />);
    const word = byLabel(r, 'Mode: Walking');
    expect(word.props.delayLongPress).toBe(DEBUG_LONG_PRESS_MS);
    expect(word.props.onPress).toBeUndefined();
    await act(async () => {
      (word.props.onLongPress as () => void)();
    });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('caps the hero font scale and keeps font scaling on', async () => {
    setup('OUTDOOR_NAV');
    const r = await render(<StateBand mode="OUTDOOR_NAV" hero="Keep walking" reduceMotion />);
    const hero = r.root.findAll((n: ReactTestInstance) => n.props.accessibilityLiveRegion === 'polite' && typeof n.type === 'string')[0];
    expect(hero.props.allowFontScaling).toBe(true);
    expect(hero.props.maxFontSizeMultiplier).toBe(1.6);
  });

  describe('VoiceOver announcement (iOS has no live region)', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('the rule: iOS + screen reader + app speech stayed silent', () => {
      expect(shouldAnnounceHero({ platform: 'ios', screenReader: true, speaking: false, spokenSince: 0 })).toBe(true);
      expect(shouldAnnounceHero({ platform: 'ios', screenReader: false, speaking: false, spokenSince: 0 })).toBe(false);
      expect(shouldAnnounceHero({ platform: 'android', screenReader: true, speaking: false, spokenSince: 0 })).toBe(false); // TalkBack has the live region
      expect(shouldAnnounceHero({ platform: 'ios', screenReader: true, speaking: true, spokenSince: 0 })).toBe(false);
      expect(shouldAnnounceHero({ platform: 'ios', screenReader: true, speaking: false, spokenSince: 1 })).toBe(false);
    });

    it('announces a hero change the speech policy dropped, after the grace period, never the mount', async () => {
      setup('OUTDOOR_NAV');
      const announced: string[] = [];
      const r = await render(<StateBand mode="OUTDOOR_NAV" hero="Keep walking" reduceMotion screenReader announce={(t) => announced.push(t)} />);
      await act(async () => {
        jest.advanceTimersByTime(HERO_ANNOUNCE_GRACE_MS * 2);
      });
      expect(announced).toEqual([]);
      await act(async () => {
        r.update(<StateBand mode="OUTDOOR_NAV" hero="Turn left soon" reduceMotion screenReader announce={(t) => announced.push(t)} />);
      });
      await act(async () => {
        jest.advanceTimersByTime(HERO_ANNOUNCE_GRACE_MS - 1);
      });
      expect(announced).toEqual([]);
      await act(async () => {
        jest.advanceTimersByTime(1);
      });
      expect(announced).toEqual(['Turn left soon']);
    });

    it('stays quiet when app speech carried the change (speaking, or an utterance started since)', async () => {
      setup('OUTDOOR_NAV');
      let spoken = 0;
      let speaking = false;
      const speech = stubs.speech as unknown as { isSpeaking: () => boolean; getStats?: () => { spoken: number } };
      speech.isSpeaking = () => speaking;
      speech.getStats = () => ({ spoken });
      const announced: string[] = [];
      const band = (hero: string) => <StateBand mode="OUTDOOR_NAV" hero={hero} reduceMotion screenReader announce={(t) => announced.push(t)} />;
      const r = await render(band('Keep walking'));

      // Case 1: the utterance is still playing when the grace period ends.
      await act(async () => { r.update(band('Turn left soon')); });
      speaking = true;
      await act(async () => { jest.advanceTimersByTime(HERO_ANNOUNCE_GRACE_MS); });
      expect(announced).toEqual([]);

      // Case 2: it started and already finished inside the grace period.
      speaking = false;
      await act(async () => { r.update(band('Turn left now')); });
      spoken += 1;
      await act(async () => { jest.advanceTimersByTime(HERO_ANNOUNCE_GRACE_MS); });
      expect(announced).toEqual([]);

      // Case 3: nothing spoke → announced.
      await act(async () => { r.update(band('Crossing ahead: Forbes')); });
      await act(async () => { jest.advanceTimersByTime(HERO_ANNOUNCE_GRACE_MS); });
      expect(announced).toEqual(['Crossing ahead: Forbes']);
    });

    it('a newer hero cancels the pending one, and nothing is announced without a screen reader', async () => {
      setup('OUTDOOR_NAV');
      const announced: string[] = [];
      const band = (hero: string, sr = true) => <StateBand mode="OUTDOOR_NAV" hero={hero} reduceMotion screenReader={sr} announce={(t) => announced.push(t)} />;
      const r = await render(band('Keep walking'));
      await act(async () => { r.update(band('Turn left soon')); });
      await act(async () => { jest.advanceTimersByTime(HERO_ANNOUNCE_GRACE_MS / 2); });
      await act(async () => { r.update(band('Turn left now')); });
      await act(async () => { jest.advanceTimersByTime(HERO_ANNOUNCE_GRACE_MS); });
      expect(announced).toEqual(['Turn left now']);

      const r2 = await render(band('Keep walking', false));
      await act(async () => { r2.update(band('Turn right soon', false)); });
      await act(async () => { jest.advanceTimersByTime(HERO_ANNOUNCE_GRACE_MS * 2); });
      expect(announced).toEqual(['Turn left now']);
    });
  });
});

describe('OnboardingScreen', () => {
  it('first run: starts with the disclaimer under its cache key and offers no skip', async () => {
    setup('ONBOARDING', { initial: { firstRun: true, targetItem: 'eggs' } });
    const r = await render(<OnboardingScreen reduceMotion />);
    const strings = renderedStrings(r);
    expect(strings).toContain('Aisle is a prototype, not a safety device.');
    expect(labelsOf(r)).toEqual(expect.arrayContaining([PLAY_AGAIN_LABEL, NEXT_LABEL]));
    expect(labelsOf(r)).not.toContain(SKIP_LABEL);
    const say = stubs.log.calls.find((c) => c.service === 'speech' && c.method === 'say');
    expect(say?.args[0]).toEqual(expect.objectContaining({ cacheKey: 'disclaimer' }));
    expectClean(r);
  });

  it('walks every step, demonstrating each pattern, and finishes into the trip once the route is ready', async () => {
    setup('ONBOARDING', { initial: { firstRun: true, targetItem: 'eggs' } });
    const r = await render(<OnboardingScreen reduceMotion />);
    const n = stepsFor(true).length;
    for (let i = 0; i < n - 1; i += 1) {
      expectClean(r);
      // The rehearsal step offers Yes / No in place of Next; either answer advances.
      const labels = labelsOf(r);
      await press(byLabel(r, labels.includes(NEXT_LABEL) ? NEXT_LABEL : YES_LABEL));
    }
    const methods = stubs.log.calls.filter((c) => c.service === 'haptics').map((c) => `${c.method}:${String(c.args[0] ?? '')}`);
    expect(methods).toEqual(expect.arrayContaining(['startCourse:function', 'stopCourse:', 'play:TURN', 'play:STOP', 'play:CONFIRM']));
    expect(stubs.log.calls.some((c) => c.method === 'calibrateBodyOffset')).toBe(true);
    // Every tutorial line went out under a pre-generated key: offline, one voice, no live TTS.
    const says = stubs.log.calls.filter((c) => c.service === 'speech' && c.method === 'say').map((c) => c.args[0] as { cacheKey?: string; text: string });
    expect(says.length).toBeGreaterThanOrEqual(n);
    for (const say of says) {
      expect(typeof say.cacheKey).toBe('string');
      expect(isPhraseKey(say.cacheKey as string)).toBe(true);
      expect(say.text).toBe(PHRASES[say.cacheKey as keyof typeof PHRASES]);
    }
    expect(labelsOf(r)).toContain(DONE_LABEL);
    await press(byLabel(r, DONE_LABEL));
    expect(store.getState().onboardingComplete).toBe(true);
    expect(store.getState().firstRun).toBe(false);
    expect(store.getState().mode).toBe('ONBOARDING'); // waiting for ROUTE_READY
    await act(async () => {
      stubs.bus.emit({ type: 'ROUTE_READY', legCount: 2, destName: 'Demo Grocery', crossingCount: 1 });
    });
    expect(store.getState().mode).toBe('OUTDOOR_NAV');
  });

  it('the lesson ends by rehearsing the yes / no answer, and either answer moves on', async () => {
    setup('ONBOARDING', { initial: { firstRun: false } });
    const steps = stepsFor(false);
    const rehearsal = steps.findIndex((s) => s.practice === 'yes_no');
    expect(rehearsal).toBeGreaterThan(-1);

    const r = await render(<OnboardingScreen reduceMotion />);
    for (let i = 0; i < rehearsal; i += 1) await press(byLabel(r, NEXT_LABEL));

    // The question is asked out loud, under its own key, and answered here.
    const asked = stubs.log.calls.filter((c) => c.service === 'speech' && c.method === 'say').map((c) => c.args[0] as { cacheKey?: string });
    expect(asked.some((s) => s.cacheKey === 'onboarding_practice_scene')).toBe(true);
    expect(renderedStrings(r)).toContain(PHRASES.onboarding_practice_scene);
    const labels = labelsOf(r);
    expect(labels).toEqual(expect.arrayContaining([YES_LABEL, NO_LABEL]));
    expect(labels).not.toContain(NEXT_LABEL);
    expectClean(r);

    await press(byLabel(r, YES_LABEL));
    // "Got it." — what the awareness loop answers a yes with — then the last step.
    const said = stubs.log.calls.filter((c) => c.service === 'speech' && c.method === 'say').map((c) => c.args[0] as { cacheKey?: string });
    expect(said.some((s) => s.cacheKey === 'noted')).toBe(true);
    expect(stubs.log.calls).toContainEqual(expect.objectContaining({ method: 'play', args: ['CONFIRM'] }));
    expect(labelsOf(r)).toContain(DONE_LABEL);
  });

  it('answering "no" teaches the follow-up the real loop asks', async () => {
    setup('ONBOARDING', { initial: { firstRun: false } });
    const steps = stepsFor(false);
    const rehearsal = steps.findIndex((s) => s.practice === 'yes_no');
    const r = await render(<OnboardingScreen reduceMotion />);
    for (let i = 0; i < rehearsal; i += 1) await press(byLabel(r, NEXT_LABEL));

    await press(byLabel(r, NO_LABEL));
    const said = stubs.log.calls.filter((c) => c.service === 'speech' && c.method === 'say').map((c) => c.args[0] as { cacheKey?: string });
    expect(said.some((s) => s.cacheKey === 'tell_me_where')).toBe(true);
    expect(labelsOf(r)).toContain(DONE_LABEL);
  });

  it('practice from Home: skip returns to IDLE through the abort edge', async () => {
    setup('ONBOARDING', { initial: { firstRun: false, targetItem: null } });
    const r = await render(<OnboardingScreen reduceMotion />);
    expect(renderedStrings(r)).not.toContain('Aisle is a prototype, not a safety device.');
    await press(byLabel(r, SKIP_LABEL));
    expect(store.getState().mode).toBe('IDLE');
  });

  it('"Play it again" re-speaks and re-demonstrates the current step', async () => {
    setup('ONBOARDING', { initial: { firstRun: false } });
    const r = await render(<OnboardingScreen reduceMotion />);
    await press(byLabel(r, NEXT_LABEL)); // course-intro
    await press(byLabel(r, NEXT_LABEL)); // course
    await press(byLabel(r, NEXT_LABEL)); // turn
    const before = stubs.log.calls.filter((c) => c.method === 'play' && c.args[0] === 'TURN').length;
    await press(byLabel(r, PLAY_AGAIN_LABEL));
    const after = stubs.log.calls.filter((c) => c.method === 'play' && c.args[0] === 'TURN').length;
    expect(after).toBe(before + 1);
  });

  it('drives the beacon and ticker ports when provided', async () => {
    setup('ONBOARDING', { initial: { firstRun: false } });
    const beacon = { setTarget: jest.fn() };
    const ticker = { setState: jest.fn() };
    const r = await render(<OnboardingScreen reduceMotion ports={{ beacon, ticker }} />);
    for (let i = 0; i < 6; i += 1) await press(byLabel(r, NEXT_LABEL)); // -> beacon
    expect(beacon.setTarget).toHaveBeenCalledWith({ bearingDeg: 90 });
    await press(byLabel(r, NEXT_LABEL)); // -> ticker-a
    expect(beacon.setTarget).toHaveBeenLastCalledWith(null);
    expect(ticker.setState).toHaveBeenCalledWith('DONT_WALK');
  });
});

describe('DebugPanel', () => {
  it('shows mode, heading, GPS, latency, fps, events and the mock-controls slot, all clean', async () => {
    setup('AT_CURB', { initial: { heading: { trueHeadingDeg: 87, accuracy: 3, timestamp: T0 }, lastFix: { lat: 40.4443, lng: -79.9436, accuracyM: 6, courseDeg: 90, speedMps: 1.2, timestamp: T0 } } });
    await act(async () => {
      stubs.bus.emit({ type: 'SIGNAL_STATE', state: 'DONT_WALK', fresh: true, confidence: 0.9 });
    });
    const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
    const r = await render(
      <DebugPanel visible onClose={() => undefined} metrics={{ utterancesPerMinute: 3.5, tier2FirstTokenMs: 420, tier2Fallback: false }} mockControls={<Text>JUMP TO MODE</Text>} />,
    );
    const strings = renderedStrings(r).join('\n');
    expect(strings).toContain('mode      AT_CURB');
    expect(strings).toContain(' 87°  acc 3');
    expect(strings).toContain('40.44430, -79.94360');
    expect(strings).toContain('first token 420 ms');
    expect(strings).toContain('per min   3.5');
    expect(strings).toContain('detector  0.0 fps');
    expect(strings).toContain('SIGNAL_STATE');
    expect(strings).toContain('JUMP TO MODE');
    expect(labelsOf(r)).toEqual(expect.arrayContaining([DEBUG_CLOSE_LABEL, 'Abort to idle', 'Recalibrate body offset']));
    expectClean(r);
  });

  it('overrides work: training toggle, rate nudge, abort', async () => {
    setup('OUTDOOR_NAV');
    const r = await render(<DebugPanel visible onClose={() => undefined} />);
    await press(byLabel(r, 'Training off'));
    expect(store.getState().trainingMode).toBe(false);
    await press(byLabel(r, 'Rate +'));
    expect(store.getState().speechRate).toBeCloseTo(1.1);
    expect(stubs.log.calls).toContainEqual(expect.objectContaining({ service: 'speech', method: 'setRate', args: [1.1] }));
    await press(byLabel(r, 'Abort to idle'));
    expect(store.getState().mode).toBe('IDLE');
  });

  it('shows the last signal with freshness, the COURSE state, and mutes the beacon and ticker', async () => {
    setup('AT_CURB');
    await act(async () => {
      stubs.bus.emit({ type: 'SIGNAL_STATE', state: 'WALK', fresh: false, confidence: 0.91 });
    });
    const debugState = { running: true, buzzing: true, suspended: false, schedule: { e: 22, intervalMs: 424, style: 'Medium', correction: 'LEFT', roadward: false }, lastPattern: 'TURN' };
    services.set('haptics', { ...stubs.haptics, getDebugState: () => debugState } as typeof stubs.haptics);
    let beaconMuted = false;
    let tickerMuted = false;
    const audio = {
      beacon: { setTarget: jest.fn(), setMuted: (m: boolean) => void (beaconMuted = m), isMuted: () => beaconMuted },
      ticker: { setState: jest.fn(), setMuted: (m: boolean) => void (tickerMuted = m), isMuted: () => tickerMuted },
    };
    const r = await render(<DebugPanel visible onClose={() => undefined} audio={audio} />);
    const strings = renderedStrings(r).join('\n');
    expect(strings).toContain('signal    WALK   fresh no   conf 0.91');
    expect(strings).toContain('course    buzzing   last TURN');
    expect(strings).toContain('e 22°  424 ms Medium   turn left');
    await press(byLabel(r, 'Mute beacon'));
    expect(beaconMuted).toBe(true);
    expect(labelsOf(r)).toContain('Unmute beacon');
    await press(byLabel(r, 'Mute ticker'));
    expect(tickerMuted).toBe(true);
    await press(byLabel(r, 'Unmute ticker'));
    expect(tickerMuted).toBe(false);
    expectClean(r);
  });

  it('mute buttons are disabled when no audio channels are wired', async () => {
    setup('OUTDOOR_NAV');
    const r = await render(<DebugPanel visible onClose={() => undefined} />);
    expect(byLabel(r, 'Mute beacon').props.accessibilityState.disabled).toBe(true);
    expect(byLabel(r, 'Mute ticker').props.accessibilityState.disabled).toBe(true);
    expect(renderedStrings(r).join('\n')).toContain('course    —');
  });

  it('renders nothing visible when closed', async () => {
    setup('OUTDOOR_NAV');
    const r = await render(<DebugPanel visible={false} onClose={() => undefined} />);
    expect(renderedStrings(r)).not.toContain('Debug');
  });
});

describe('SettingsSheet', () => {
  it('has a labelled adjustable rate, a training switch and the headphones note', async () => {
    setup('IDLE');
    const r = await render(<SettingsSheet visible onClose={() => undefined} />);
    const labels = labelsOf(r);
    expect(labels).toEqual(expect.arrayContaining(['Speaking rate', SLOWER_LABEL, FASTER_LABEL, TRAINING_LABEL, CLOSE_LABEL]));
    expect(renderedStrings(r).some((s) => s.includes('open-ear'))).toBe(true);
    expectClean(r);
  });

  it('rate stays within 0.8–1.6 and reaches the speech service', async () => {
    setup('IDLE', { initial: { speechRate: 1.5 } });
    const r = await render(<SettingsSheet visible onClose={() => undefined} />);
    await press(byLabel(r, FASTER_LABEL));
    expect(store.getState().speechRate).toBeCloseTo(1.6);
    expect(byLabel(r, FASTER_LABEL).props.accessibilityState.disabled).toBe(true);
    const adjustable = byLabel(r, 'Speaking rate');
    await act(async () => {
      (adjustable.props.onAccessibilityAction as (e: { nativeEvent: { actionName: string } }) => void)({ nativeEvent: { actionName: 'decrement' } });
    });
    expect(store.getState().speechRate).toBeCloseTo(1.5);
    expect(stubs.log.calls.filter((c) => c.method === 'setRate').map((c) => c.args[0])).toEqual([1.6, 1.5]);
  });

  it('training switch writes the store', async () => {
    setup('IDLE');
    const r = await render(<SettingsSheet visible onClose={() => undefined} />);
    const sw = r.root.findAll((n: ReactTestInstance) => n.props.accessibilityRole === "switch")[0];
    await act(async () => {
      (sw.props.onValueChange as (v: boolean) => void)(false);
    });
    expect(store.getState().trainingMode).toBe(false);
  });
});

describe('Root', () => {
  it('switches screens by mode and mounts the mock controls in the debug panel', async () => {
    setup('IDLE', { initial: { firstRun: false } });
    const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
    const r = await render(<Root reduceMotion now={T0} mockControls={<Text>MOCKS</Text>} />);
    expect(renderedStrings(r)).toContain('What do you need?');
    expect(renderedStrings(r)).not.toContain('MOCKS');

    await act(async () => {
      store.getState().setMode('ONBOARDING');
    });
    expect(labelsOf(r)).toContain(PLAY_AGAIN_LABEL);

    await act(async () => {
      store.getState().abort();
      stubs.bus.emit({ type: 'ROUTE_READY', legCount: 2, destName: 'Demo', crossingCount: 1 });
    });
    expect(store.getState().mode).toBe('OUTDOOR_NAV');
    expect(labelsOf(r)).toContain(STOP_LABEL);

    await act(async () => {
      (byLabel(r, 'Mode: Walking').props.onLongPress as () => void)();
    });
    expect(renderedStrings(r)).toContain('MOCKS');
    await press(byLabel(r, DEBUG_CLOSE_LABEL));
    expect(renderedStrings(r)).not.toContain('MOCKS');
    expectClean(r);
  });

  it('opens and closes settings from Home', async () => {
    setup('IDLE');
    const r = await render(<Root reduceMotion />);
    await press(byLabel(r, SETTINGS_LABEL));
    expect(labelsOf(r)).toContain(CLOSE_LABEL);
    await press(byLabel(r, CLOSE_LABEL));
    expect(labelsOf(r)).not.toContain(CLOSE_LABEL);
  });
});

// ---------------------------------------------------------------------------
// The liquid-glass round: transcript, camera panel, describe pill, motion
// ---------------------------------------------------------------------------

/** A minimal in-memory conversation log with the contract's two read members. */
function fakeLog(initial: ConversationEntryLike[] = []): ConversationLogPort & { push(e: ConversationEntryLike): void } {
  let entries: ConversationEntryLike[] = initial;
  const subs = new Set<(e: readonly ConversationEntryLike[]) => void>();
  return {
    entries: () => entries,
    subscribe: (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    push: (e) => {
      entries = [...entries, e];
      for (const cb of subs) cb(entries);
    },
  };
}

const you = (id: string, text: string): ConversationEntryLike => ({ id, role: 'you', text, t: T0, source: 'voice' });
const aisle = (id: string, text: string): ConversationEntryLike => ({ id, role: 'aisle', text, t: T0, source: 'speech' });

describe('TranscriptPanel', () => {
  it('shows the newest lines, oldest first, as a list of "You:" / "Aisle:" sentences', async () => {
    setup('OUTDOOR_NAV');
    const entries = [you('1', 'I need eggs'), aisle('2', 'Eggs. Planning the route.'), you('3', 'Where am I'), aisle('4', 'Forbes Avenue, near the crossing'), you('5', 'Okay'), aisle('6', 'Keep walking')];
    expect(visibleEntries(entries, 4).map((e) => e.id)).toEqual(['3', '4', '5', '6']);
    const r = await render(<TranscriptPanel entries={entries} max={4} reduceMotion />);
    const list = r.root.findAll((n: ReactTestInstance) => n.props.accessibilityRole === 'list' && typeof n.type === 'string');
    expect(list).toHaveLength(1);
    expect(list[0].props.accessibilityLabel).toBe(TRANSCRIPT_LABEL);
    const lines = r.root
      .findAll((n: ReactTestInstance) => typeof n.type === 'string' && n.props.accessibilityRole === 'text' && typeof n.props.accessibilityLabel === 'string')
      .map((n) => n.props.accessibilityLabel as string)
      .filter((l) => l.startsWith('You: ') || l.startsWith('Aisle: '));
    expect(lines).toEqual(['You: Where am I', 'Aisle: Forbes Avenue, near the crossing', 'You: Okay', 'Aisle: Keep walking']);
    const strings = renderedStrings(r);
    expect(strings).toContain('You');
    expect(strings).toContain('Aisle');
    expect(strings).not.toContain(TRANSCRIPT_EMPTY);
    expect(labelsOf(r)).not.toContain(DESCRIBE_LABEL); // no describer wired
    expectClean(r);
  });

  it('is never the live region and says so when empty', async () => {
    setup('OUTDOOR_NAV');
    const r = await render(<TranscriptPanel entries={[]} reduceMotion />);
    expect(renderedStrings(r)).toContain(TRANSCRIPT_EMPTY);
    expect(r.root.findAll((n: ReactTestInstance) => n.props.accessibilityLiveRegion !== undefined && typeof n.type === 'string')).toHaveLength(0);
  });

  it('the Describe surroundings pill calls describeNow, is busy until it settles, and survives a rejection', async () => {
    setup('INDOOR_NAV');
    let resolve!: (v: string | null) => void;
    const describeNow = jest.fn(() => new Promise<string | null>((res) => { resolve = res; }));
    const r = await render(<TranscriptPanel entries={[]} onDescribe={describeNow} reduceMotion />);
    const pill = byLabel(r, DESCRIBE_LABEL);
    expect(pill.props.accessibilityState.busy).toBe(false);
    await press(pill);
    expect(describeNow).toHaveBeenCalledTimes(1);
    expect(byLabel(r, DESCRIBE_LABEL).props.accessibilityState.busy).toBe(true);
    await press(byLabel(r, DESCRIBE_LABEL)); // ignored while busy
    expect(describeNow).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve('A shelf of cartons on the right');
    });
    expect(byLabel(r, DESCRIBE_LABEL).props.accessibilityState.busy).toBe(false);

    const failing = jest.fn(() => Promise.reject(new Error('vision down')));
    const r2 = await render(<TranscriptPanel entries={[]} onDescribe={failing} reduceMotion />);
    await press(byLabel(r2, DESCRIBE_LABEL));
    expect(byLabel(r2, DESCRIBE_LABEL).props.accessibilityState.busy).toBe(false);
    expectClean(r);
  });
});

describe('CameraPanel', () => {
  afterEach(() => setCameraPreviewForTests(null));

  it('renders the placeholder when no preview module is in the build, with the three strip sentences over it', async () => {
    setup('OUTDOOR_NAV');
    setCameraPreviewForTests(null);
    expect(hasCameraPreview()).toBe(false);
    const r = await render(<CameraPanel slots={stripSlots(EMPTY_FACTS, T0)} accent={accents.outdoor} reduceMotion />);
    expect(renderedStrings(r)).toContain(CAMERA_PLACEHOLDER);
    const labels = labelsOf(r);
    expect(labels).toEqual(expect.arrayContaining([CAMERA_LABEL, 'Signal: not seen', 'Vehicles: none reported', 'Aisle: no sign read yet']));
    expect(labels.indexOf(CAMERA_LABEL)).toBeLessThan(labels.indexOf('Signal: not seen'));
    expectClean(r);
  });

  it("mounts Agent C's preview with detections on when it is present", async () => {
    setup('OUTDOOR_NAV');
    const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
    const seen: Array<Record<string, unknown>> = [];
    setCameraPreviewForTests((p) => {
      seen.push(p as Record<string, unknown>);
      return <Text>LIVE PREVIEW</Text>;
    });
    expect(hasCameraPreview()).toBe(true);
    const r = await render(<CameraPanel slots={stripSlots(EMPTY_FACTS, T0)} reduceMotion />);
    expect(renderedStrings(r)).toContain('LIVE PREVIEW');
    expect(renderedStrings(r)).not.toContain(CAMERA_PLACEHOLDER);
    expect(seen[0]).toEqual(expect.objectContaining({ showDetections: true }));
  });
});

describe('NavScreen with the conversation and the describer', () => {
  it('renders the transcript from the log, follows new lines, and keeps the reading order band > camera > transcript > talk', async () => {
    setup('INDOOR_NAV', { initial: { targetItem: 'eggs' } });
    const log = fakeLog([you('1', 'I need eggs'), aisle('2', 'Eggs. Planning the route.')]);
    const describeNow = jest.fn(async () => 'Shelves on both sides');
    const r = await render(<NavScreen reduceMotion now={T0} conversation={log} describeNow={describeNow} />);
    let labels = labelsOf(r);
    const order = ['Mode: In the store', CAMERA_LABEL, 'Signal: not seen', 'You: I need eggs', 'Aisle: Eggs. Planning the route.', DESCRIBE_LABEL, TALK_LABEL, REPEAT_LABEL, STOP_LABEL];
    const idx = order.map((l) => labels.indexOf(l));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    await act(async () => {
      log.push(aisle('3', 'Aisle four is on your right'));
    });
    labels = labelsOf(r);
    expect(labels).toContain('Aisle: Aisle four is on your right');
    expect(labels.indexOf('Aisle: Aisle four is on your right')).toBeGreaterThan(labels.indexOf('You: I need eggs'));
    await press(byLabel(r, DESCRIBE_LABEL));
    expect(describeNow).toHaveBeenCalledTimes(1);
    expectClean(r);
  });

  it('stands without a log or a describer: empty transcript line, no pill, camera placeholder', async () => {
    setup('OUTDOOR_NAV');
    const r = await render(<NavScreen reduceMotion now={T0} />);
    expect(renderedStrings(r)).toContain(TRANSCRIPT_EMPTY);
    expect(renderedStrings(r)).toContain(CAMERA_PLACEHOLDER);
    expect(labelsOf(r)).not.toContain(DESCRIBE_LABEL);
  });

  it('tolerates a log whose entries() throws', async () => {
    setup('OUTDOOR_NAV');
    const broken: ConversationLogPort = { entries: () => { throw new Error('boom'); }, subscribe: () => () => undefined };
    const r = await render(<NavScreen reduceMotion now={T0} conversation={broken} />);
    expect(renderedStrings(r)).toContain(TRANSCRIPT_EMPTY);
  });
});

describe('HomeScreen transcript', () => {
  it('shows the last lines once there are any, without the describe pill', async () => {
    setup('IDLE', { initial: { firstRun: false } });
    const log = fakeLog([]);
    const r = await render(<HomeScreen reduceMotion now={T0} conversation={log} />);
    expect(renderedStrings(r)).not.toContain(TRANSCRIPT_EMPTY);
    await act(async () => {
      log.push(you('1', 'I need eggs'));
      log.push(aisle('2', 'Eggs. Planning the route.'));
    });
    expect(labelsOf(r)).toEqual(expect.arrayContaining(['You: I need eggs', 'Aisle: Eggs. Planning the route.']));
    expect(labelsOf(r)).not.toContain(DESCRIBE_LABEL);
    expectClean(r);
  });

  it('before the first line, the card says what to say; the conversation replaces it', async () => {
    setup('IDLE', { initial: { firstRun: true } });
    const log = fakeLog([]);
    const r = await render(<HomeScreen reduceMotion now={T0} conversation={log} />);

    const strings = renderedStrings(r);
    expect(strings).toContain(SAY_CARD_TITLE);
    expect(strings).toContain(SAY_CARD_NOTE);
    for (const example of SAY_CARD_EXAMPLES) {
      expect(strings.some((s) => s.includes(example))).toBe(true);
    }
    // One summary a screen reader reads in a breath, rather than five stray lines.
    expect(hasNode(r, 'say-card')).toBe(true);
    expect(labelsOf(r).some((l) => l.startsWith(SAY_CARD_TITLE) && l.includes(SAY_CARD_NOTE))).toBe(true);
    expectClean(r);

    await act(async () => {
      log.push(you('1', 'I need eggs'));
    });
    expect(renderedStrings(r)).not.toContain(SAY_CARD_TITLE);
    expect(hasNode(r, 'say-card')).toBe(false);
  });

  it('every example is something the app actually answers, and is speakable', async () => {
    for (const example of SAY_CARD_EXAMPLES) {
      expect(findForbidden(example)).toEqual([]);
      expect(wordCount(example)).toBeLessThanOrEqual(MAX_UTTERANCE_WORDS);
    }
  });
});

describe('Root conversation wiring', () => {
  it('uses a log registered under "conversation" when no prop is given', async () => {
    setup('IDLE', { initial: { firstRun: false } });
    const log = fakeLog([you('1', 'I need milk'), aisle('2', 'Milk. Planning the route.')]);
    (services as unknown as { set(name: string, v: unknown): void }).set('conversation', log);
    const r = await render(<Root reduceMotion now={T0} />);
    expect(labelsOf(r)).toContain('You: I need milk');
  });

  it('ignores a registry value that is not a log', async () => {
    setup('IDLE', { initial: { firstRun: false } });
    (services as unknown as { set(name: string, v: unknown): void }).set('conversation', { nope: true });
    const r = await render(<Root reduceMotion now={T0} />);
    expect(labelsOf(r).some((l) => l.startsWith('You: '))).toBe(false);
  });
});

describe('SettingsSheet describe surroundings', () => {
  it('has the switch, default on, and writes describeSurroundings to the store', async () => {
    setup('IDLE');
    const r = await render(<SettingsSheet visible onClose={() => undefined} reduceMotion />);
    const sw = r.root.findAll((n: ReactTestInstance) => n.props.accessibilityRole === 'switch' && n.props.accessibilityLabel === DESCRIBE_SETTING_LABEL)[0];
    expect(sw.props.value).toBe(true);
    await act(async () => {
      (sw.props.onValueChange as (v: boolean) => void)(false);
    });
    expect((store.getState() as unknown as { describeSurroundings?: boolean }).describeSurroundings).toBe(false);
    expect(r.root.findAll((n: ReactTestInstance) => n.props.accessibilityRole === 'switch' && n.props.accessibilityLabel === DESCRIBE_SETTING_LABEL)[0].props.value).toBe(false);
    expectClean(r);
  });

  it("prefers the store's own setter when the core declares one", async () => {
    setup('IDLE');
    const setDescribeSurroundings = jest.fn();
    (store.setState as unknown as (p: Record<string, unknown>) => void)({ describeSurroundings: true, setDescribeSurroundings });
    const r = await render(<SettingsSheet visible onClose={() => undefined} reduceMotion />);
    const sw = r.root.findAll((n: ReactTestInstance) => n.props.accessibilityRole === 'switch' && n.props.accessibilityLabel === DESCRIBE_SETTING_LABEL)[0];
    await act(async () => {
      (sw.props.onValueChange as (v: boolean) => void)(false);
    });
    expect(setDescribeSurroundings).toHaveBeenCalledWith(false);
  });
});

describe('motion and reduce-motion', () => {
  it('the glass tint swaps instantly under reduce-motion and cross-fades otherwise', async () => {
    setup('OUTDOOR_NAV');
    const tintOfPanel = (r: ReactTestRenderer): string[] =>
      r.root.findAll((n: ReactTestInstance) => n.props.testID === 'glass-tint' && typeof n.type === 'string').map((n) => {
        const flat = ([] as Array<Record<string, unknown>>).concat(...[n.props.style as Array<Record<string, unknown>>].flat(2)).filter(Boolean);
        return String(flat.map((x) => x.backgroundColor).filter(Boolean).pop());
      });
    const r = await render(<StateBand mode="OUTDOOR_NAV" hero="Keep walking" reduceMotion />);
    expect(tintOfPanel(r)).toEqual([tintOf(accents.outdoor, 0.18)]);
    await act(async () => {
      r.update(<StateBand mode="CROSSING" signal="WALK" hero="Walk signal on" reduceMotion />);
    });
    expect(tintOfPanel(r)).toEqual([tintOf(signalColors.WALK, 0.18)]);

    // Without reduce-motion the settled layer stays until the 250 ms fade finishes.
    const r2 = await render(<StateBand mode="OUTDOOR_NAV" hero="Keep walking" reduceMotion={false} />);
    await act(async () => {
      r2.update(<StateBand mode="CROSSING" signal="WALK" hero="Walk signal on" reduceMotion={false} />);
    });
    expect(tintOfPanel(r2)).toEqual([tintOf(accents.outdoor, 0.18)]);
  });

  it('the listening ring is a still halo under reduce-motion and an animated pulse otherwise', async () => {
    setup('IDLE');
    const ring = (r: ReactTestRenderer): Record<string, unknown> => {
      const n = r.root.findAll((x: ReactTestInstance) => x.props.testID === 'talk-ring')[0];
      return Object.assign({}, ...([n.props.style].flat(3).filter(Boolean) as Array<Record<string, unknown>>));
    };
    const r = await render(<TalkButton screenReader={false} reduceMotion />);
    expect(ring(r).opacity).toBe(0);
    await act(async () => {
      (byLabel(r, TALK_LABEL).props.onPressIn as () => void)();
    });
    expect(ring(r).opacity).toBe(0.35);
    await act(async () => {
      (byLabel(r, TALK_HELD_LABEL).props.onPressOut as () => void)();
    });
    expect(ring(r).opacity).toBe(0);

    const r2 = await render(<TalkButton screenReader={false} reduceMotion={false} />);
    await act(async () => {
      (byLabel(r2, TALK_LABEL).props.onPressIn as () => void)();
    });
    expect(typeof ring(r2).opacity).toBe('object'); // an Animated interpolation, not a number
    await act(async () => {
      (byLabel(r2, TALK_HELD_LABEL).props.onPressOut as () => void)();
    });
  });

  it('a glass panel mounts visible under reduce-motion and animated otherwise; blur is optional', async () => {
    setup('IDLE');
    const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
    const r = await render(<GlassPanel reduceMotion testID="p"><Text>inside</Text></GlassPanel>);
    const outer = r.root.findAll((n: ReactTestInstance) => n.props.testID === 'p' && typeof n.type === 'string')[0];
    const style = Object.assign({}, ...([outer.props.style].flat(3).filter(Boolean) as Array<Record<string, unknown>>));
    expect(Number((style.opacity as { __getValue?: () => number }).__getValue?.() ?? style.opacity)).toBe(1);
    expect(renderedStrings(r)).toContain('inside');
    expect(typeof isBlurAvailable()).toBe('boolean');
  });
});
