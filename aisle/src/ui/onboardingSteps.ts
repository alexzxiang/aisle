/**
 * The one-minute lesson (02 Task 8) as data: one pattern per step, each
 * spoken line one of the pre-generated `onboarding_*` phrases (or the
 * allow-listed `disclaimer`), so the never-cut tutorial is offline, in one
 * voice, and never falls through to live TTS or expo-speech. A step speaks at
 * most two lines: NAV holds one pending slot (01 section 3), so a third line
 * would be dropped. Two-sentence lessons are therefore two steps.
 *
 * `run` performs the step's demonstration through the services it is handed
 * and returns a cleanup; the screen calls the cleanup when the step changes,
 * so no buzz, beacon or ticker outlives its step.
 */
import type { HapticService, SensorService, SignalState } from '../core/contracts';
import { phraseText, type PhraseKey } from '../core/phrases';
import { DISCLAIMER_TEXT } from './copy';
import type { BeaconPort, TickerPort } from './ports';

export interface StepServices {
  haptics: HapticService;
  sensors: SensorService;
  beacon?: BeaconPort;
  ticker?: TickerPort;
  /** Result of the straight-walk calibration, when the step runs it. */
  onCalibrated?(result: { offsetDeg: number; ok: boolean }): void;
}

export type Cleanup = () => void;

/** The most lines one step may speak (NAV: one playing + one pending). */
export const MAX_LINES_PER_STEP = 2;

export interface OnboardingStep {
  id: string;
  /** Spoken in order, each through its cache key. 1..MAX_LINES_PER_STEP entries. */
  lines: readonly PhraseKey[];
  /** Hero on the band; defaults to the first line's text (the disclaimer is too long to be one). */
  hero?: string;
  /** Shorter word on the band above the hero. */
  modeWord: string;
  /** Second line under the hero: what to do with your hands. */
  detail?: string;
  /** Demonstration. Optional: some steps only speak. */
  run?(s: StepServices): Cleanup | void;
  /** Only shown on the very first run (the disclaimer). */
  firstRunOnly?: boolean;
}

export interface SpokenLine {
  cacheKey: PhraseKey;
  text: string;
}

/** What the screen hands to `say()` for this step: canonical text under its key. */
export function spokenLines(step: OnboardingStep): SpokenLine[] {
  return step.lines.map((cacheKey) => ({ cacheKey, text: phraseText(cacheKey) }));
}

export function heroFor(step: OnboardingStep): string {
  return step.hero ?? phraseText(step.lines[0]);
}

/** Long enough for both spoken lines (4 s apart) and a turn away and back. */
export const COURSE_DEMO_MS = 15000;
export const BEACON_DEMO_MS = 10000;
export const TICKER_STEP_MS = 3000;

const noop: Cleanup = () => {};

function afterMs(ms: number, fn: () => void): Cleanup {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
}

/** Cycles the ticker through `states`, TICKER_STEP_MS each, then back to UNKNOWN. */
function tickerCycle(ticker: TickerPort | undefined, states: SignalState[]): Cleanup {
  if (!ticker) return noop;
  const timers: Cleanup[] = [];
  states.forEach((state, i) => {
    if (i === 0) ticker.setState(state);
    else timers.push(afterMs(i * TICKER_STEP_MS, () => ticker.setState(state)));
  });
  timers.push(afterMs(states.length * TICKER_STEP_MS, () => ticker.setState('UNKNOWN')));
  return () => {
    timers.forEach((t) => t());
    ticker.setState('UNKNOWN');
  };
}

export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  {
    id: 'disclaimer',
    lines: ['disclaimer'],
    hero: 'Aisle is a prototype, not a safety device.',
    detail: DISCLAIMER_TEXT,
    modeWord: 'Before we start',
    firstRunOnly: true,
  },
  {
    id: 'intro',
    lines: ['onboarding_intro'],
    modeWord: 'Practice',
  },
  {
    id: 'course-intro',
    lines: ['onboarding_course_intro'],
    detail: 'Silence is the reward.',
    modeWord: 'Course',
  },
  {
    id: 'course',
    lines: ['onboarding_course_turn_away', 'onboarding_turn_back'],
    detail: 'Turn back until the buzzing stops.',
    modeWord: 'Course',
    run(s) {
      const heading = s.sensors.getHeading()?.trueHeadingDeg ?? 0;
      s.haptics.startCourse(s.sensors.courseErrorFor({ bearingDeg: heading, roadSide: 'NONE' }));
      const stopLater = afterMs(COURSE_DEMO_MS, () => s.haptics.stopCourse());
      return () => {
        stopLater();
        s.haptics.stopCourse();
      };
    },
  },
  {
    id: 'turn',
    lines: ['onboarding_this_is_turn'],
    detail: 'Three rising pulses: rotate now.',
    modeWord: 'Turn',
    run(s) {
      s.haptics.play('TURN');
    },
  },
  {
    id: 'stop',
    lines: ['onboarding_this_is_stop'],
    detail: 'One long sharp buzz. Nothing else feels like it.',
    modeWord: 'Stop',
    run(s) {
      s.haptics.play('STOP');
    },
  },
  {
    id: 'confirm',
    lines: ['onboarding_this_is_okay'],
    detail: 'One soft tap: acknowledged, arrived, or back on course.',
    modeWord: 'Okay',
    run(s) {
      s.haptics.play('CONFIRM');
    },
  },
  {
    id: 'beacon',
    lines: ['onboarding_beacon'],
    detail: 'An extra tick means the target is straight ahead.',
    modeWord: 'Beacon',
    run(s) {
      if (!s.beacon) return noop;
      const heading = s.sensors.getHeading()?.trueHeadingDeg ?? 0;
      s.beacon.setTarget({ bearingDeg: (heading + 90) % 360 });
      const off = afterMs(BEACON_DEMO_MS, () => s.beacon?.setTarget(null));
      return () => {
        off();
        s.beacon?.setTarget(null);
      };
    },
  },
  {
    id: 'ticker-a',
    lines: ['onboarding_ticker_slow_fast'],
    detail: 'Listen: slow, then fast.',
    modeWord: 'Signal ticks',
    run(s) {
      return tickerCycle(s.ticker, ['DONT_WALK', 'WALK']);
    },
  },
  {
    id: 'ticker-b',
    lines: ['onboarding_ticker_countdown'],
    detail: 'Listen: medium, then silence.',
    modeWord: 'Signal ticks',
    run(s) {
      return tickerCycle(s.ticker, ['COUNTDOWN', 'UNKNOWN']);
    },
  },
  {
    id: 'gear',
    lines: ['onboarding_keep_cane'],
    detail: 'You must still hear the traffic.',
    modeWord: 'Before you walk',
  },
  {
    id: 'lanyard',
    lines: ['onboarding_wear_phone', 'onboarding_ring_switch'],
    detail: 'Ring switch on. The camera has to see the street and the signs.',
    modeWord: 'Before you walk',
  },
  {
    id: 'calibrate',
    lines: ['onboarding_walk_straight'],
    detail: 'This teaches Aisle how you hold the phone.',
    modeWord: 'Calibrate',
    run(s) {
      let alive = true;
      s.sensors
        .calibrateBodyOffset()
        .then((r) => {
          if (alive) s.onCalibrated?.(r);
        })
        .catch(() => {
          if (alive) s.onCalibrated?.({ offsetDeg: 0, ok: false });
        });
      return () => {
        alive = false;
      };
    },
  },
  {
    id: 'done',
    lines: ['onboarding_done'],
    detail: 'That is the whole lesson.',
    modeWord: 'Ready',
  },
];

export function stepsFor(firstRun: boolean): OnboardingStep[] {
  return ONBOARDING_STEPS.filter((s) => firstRun || !s.firstRunOnly);
}
