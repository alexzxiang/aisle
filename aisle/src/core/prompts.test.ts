import { createEventBus, type AppEventBus } from './bus';
import { createAppStore, type AppStore } from './store';
import { createConversationLog, type ConversationLog } from './conversation';
import { PHRASES } from './phrases';
import { NO_SIGN_PROMPT_MS, wirePrompts, type PromptsBinding } from './prompts';

describe('wirePrompts (proactive prompts → the conversation log)', () => {
  let bus: AppEventBus;
  let store: AppStore;
  let conversation: ConversationLog;
  let binding: PromptsBinding;
  let t: number;

  beforeEach(() => {
    jest.useFakeTimers();
    t = 0;
    bus = createEventBus();
    store = createAppStore({ bus, warn: () => undefined });
    conversation = createConversationLog({ now: () => t, collapseMs: 0 });
    binding = wirePrompts({ bus, store, conversation });
  });
  afterEach(() => {
    binding.dispose();
    jest.useRealTimers();
  });

  const texts = (): string[] => conversation.entries().map((e) => `${e.source}:${e.text}`);

  it('camera and user-action requests from Claude land in the log as prompts, in the spoken wording', () => {
    bus.emit({ type: 'CAMERA_REQUEST', direction: 'up' });
    bus.emit({ type: 'CAMERA_REQUEST', direction: 'none' });   // nothing to say
    bus.emit({ type: 'USER_ACTION', action: 'turn_left' });
    bus.emit({ type: 'USER_ACTION', action: 'reach' });
    bus.emit({ type: 'USER_ACTION', action: 'none' });
    expect(texts()).toEqual([
      `prompt:${PHRASES.tilt_camera_up}`,
      `prompt:${PHRASES.turn_left_a_little}`,
      `prompt:${PHRASES.reach_out}`,
    ]);
    expect(binding.getDebugState().prompts).toBe(3);
  });

  it('INDOOR_NAV with no sign read for twenty seconds logs keep_going, again every twenty seconds, reset by a sign', () => {
    store.setState({ mode: 'INDOOR_NAV' });
    expect(binding.getDebugState().noSignArmed).toBe(true);
    jest.advanceTimersByTime(NO_SIGN_PROMPT_MS - 1);
    expect(texts()).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(texts()).toEqual([`prompt:${PHRASES.keep_going}`]);

    jest.advanceTimersByTime(NO_SIGN_PROMPT_MS / 2);
    bus.emit({ type: 'AISLE_IDENTIFIED', aisleId: 'a1', label: 'Aisle 1', confidence: 0.9, source: 'ocr' });
    jest.advanceTimersByTime(NO_SIGN_PROMPT_MS / 2);
    expect(texts()).toHaveLength(1);          // the sign reset the window
    jest.advanceTimersByTime(NO_SIGN_PROMPT_MS / 2);
    expect(texts()).toHaveLength(2);
    expect(binding.getDebugState().noSignPrompts).toBe(2);
  });

  it('leaving INDOOR_NAV disarms the watch; other modes never prompt; dispose stops everything', () => {
    store.setState({ mode: 'INDOOR_NAV' });
    store.setState({ mode: 'AT_ITEM' });
    expect(binding.getDebugState().noSignArmed).toBe(false);
    jest.advanceTimersByTime(NO_SIGN_PROMPT_MS * 2);
    expect(texts()).toEqual([]);

    store.setState({ mode: 'OUTDOOR_NAV' });
    jest.advanceTimersByTime(NO_SIGN_PROMPT_MS * 2);
    expect(texts()).toEqual([]);

    store.setState({ mode: 'INDOOR_NAV' });
    binding.dispose();
    jest.advanceTimersByTime(NO_SIGN_PROMPT_MS * 2);
    bus.emit({ type: 'CAMERA_REQUEST', direction: 'up' });
    expect(texts()).toEqual([]);
  });

  it('arms at once when constructed in INDOOR_NAV', () => {
    binding.dispose();
    store.setState({ mode: 'INDOOR_NAV' });
    binding = wirePrompts({ bus, store, conversation, noSignMs: 100 });
    jest.advanceTimersByTime(100);
    expect(texts()).toEqual([`prompt:${PHRASES.keep_going}`]);
  });
});
