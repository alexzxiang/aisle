/**
 * The one-minute lesson (02 Task 8) as data: one pattern per step, each
 * spoken line at most twelve words with numbers as words, so every line can
 * pass through SpeechService.say() unchanged. The disclaimer is the single
 * allow-listed long phrase (01 section 3) and goes out under its cache key.
 *
 * `run` performs the step's demonstration through the services it is handed
 * and returns a cleanup; the screen calls the cleanup when the step changes,
 * so no buzz, beacon or ticker outlives its step.
 */
import type { CacheKey, HapticService, SensorService, SignalState } from '../core/contracts';
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

export interface OnboardingStep {
  id: string;
  /** Spoken. <= 12 words, numbers as words (except the allow-listed disclaimer). */
  text: string;
  /** Hero on the band when `text` is too long to be one; defaults to `text`. */
  hero?: string;
  /** Present when the line is one of the pre-generated phrases. */
  cacheKey?: CacheKey;
  /** Shorter word on the band above the hero. */
  modeWord: string;
  /** Second line under the hero: what to do with your hands. */
  detail?: string;
  /** Demonstration. Optional: some steps only speak. */
  run?(s: StepServices): Cleanup | void;
  /** Only shown on the very first run (the disclaimer). */
  firstRunOnly?: boolean;
}

export const COURSE_DEMO_MS = 10000;
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
    text: DISCLAIMER_TEXT,
    hero: 'Aisle is a prototype, not a safety device.',
    detail: DISCLAIMER_TEXT,
    cacheKey: 'disclaimer',
    modeWord: 'Before we start',
    firstRunOnly: true,
  },
  {
    id: 'intro',
    text: "Aisle uses four vibrations and two sounds. Let's learn them.",
    modeWord: 'Practice',
  },
  {
    id: 'course',
    text: 'On course, Aisle stays silent. Turn away and feel the buzz.',
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
    text: 'This is turn.',
    detail: 'Three rising pulses: rotate now.',
    modeWord: 'Turn',
    run(s) {
      s.haptics.play('TURN');
    },
  },
  {
    id: 'stop',
    text: 'This is stop. It means a vehicle or an obstacle.',
    detail: 'One long sharp buzz. Nothing else feels like it.',
    modeWord: 'Stop',
    run(s) {
      s.haptics.play('STOP');
    },
  },
  {
    id: 'confirm',
    text: 'This is okay.',
    detail: 'One soft tap: acknowledged, arrived, or back on course.',
    modeWord: 'Okay',
    run(s) {
      s.haptics.play('CONFIRM');
    },
  },
  {
    id: 'beacon',
    text: 'This pulse points where to walk. Turn until it is centred.',
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
    text: "Slow ticks mean don't walk. Fast ticks mean walk.",
    detail: 'Listen: slow, then fast.',
    modeWord: 'Signal ticks',
    run(s) {
      return tickerCycle(s.ticker, ['DONT_WALK', 'WALK']);
    },
  },
  {
    id: 'ticker-b',
    text: 'Medium ticks mean countdown. No ticks means the signal is unseen.',
    detail: 'Listen: medium, then silence.',
    modeWord: 'Signal ticks',
    run(s) {
      return tickerCycle(s.ticker, ['COUNTDOWN', 'UNKNOWN']);
    },
  },
  {
    id: 'gear',
    text: 'Keep your cane or dog. Use open-ear headphones.',
    detail: 'You must still hear the traffic.',
    modeWord: 'Before you walk',
  },
  {
    id: 'lanyard',
    text: 'Wear the phone on the lanyard, screen out. Ring switch on.',
    detail: 'The camera has to see the street and the signs.',
    modeWord: 'Before you walk',
  },
  {
    id: 'calibrate',
    text: 'Now walk straight for five seconds.',
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
];

export function stepsFor(firstRun: boolean): OnboardingStep[] {
  return ONBOARDING_STEPS.filter((s) => firstRun || !s.firstRunOnly);
}
