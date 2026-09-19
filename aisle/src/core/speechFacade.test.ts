import type { SpeechRequest } from './contracts';
import { countWords, findForbiddenTerm } from './phrases';
import type { AisleSpeechService } from './speech';
import { SPOKEN_WALKING_BETA, spokenFormOf, withSpokenForms } from './speechFacade';
import { WALKING_BETA_WARNING } from '../outdoor/types';

function fake() {
  const said: SpeechRequest[] = [];
  const prefetched: string[] = [];
  const speech: AisleSpeechService = {
    say: (r) => {
      said.push(r);
    },
    playStream: jest.fn(),
    clearQueue: jest.fn(),
    isSpeaking: () => false,
    setRate: jest.fn(),
    prefetch: async (t) => {
      prefetched.push(t);
      return `tts:${t.length}`;
    },
    runtimeKeyFor: (t) => `tts:${t.length}`,
    getStats: () => ({ spoken: 1 }) as never,
    dispose: jest.fn(),
  };
  return { speech, said, prefetched };
}

describe('spoken forms', () => {
  it('the spoken walking-beta form fits A\'s rules and maps only the exact display string', () => {
    expect(countWords(SPOKEN_WALKING_BETA)).toBeLessThanOrEqual(12);
    expect(findForbiddenTerm(SPOKEN_WALKING_BETA)).toBeNull();
    expect(countWords(WALKING_BETA_WARNING)).toBeGreaterThan(12);
    expect(spokenFormOf(WALKING_BETA_WARNING)).toBe(SPOKEN_WALKING_BETA);
    expect(spokenFormOf(`${WALKING_BETA_WARNING} `)).toBe(`${WALKING_BETA_WARNING} `);
    expect(spokenFormOf('Turn right now.')).toBe('Turn right now.');
  });

  it('withSpokenForms maps say and prefetch text and forwards everything else', async () => {
    const f = fake();
    const s = withSpokenForms(f.speech);
    s.say({ text: WALKING_BETA_WARNING, priority: 'INFO', dedupeKey: 'route-warning', cooldownMs: 1 });
    s.say({ text: 'Turn right now.', priority: 'NAV', cacheKey: 'turn_right_now' });
    expect(f.said.map((r) => r.text)).toEqual([SPOKEN_WALKING_BETA, 'Turn right now.']);
    expect(f.said[0]).toMatchObject({ priority: 'INFO', dedupeKey: 'route-warning', cooldownMs: 1 });
    expect(await s.prefetch(WALKING_BETA_WARNING)).toBe(`tts:${SPOKEN_WALKING_BETA.length}`);
    expect(f.prefetched).toEqual([SPOKEN_WALKING_BETA]);
    expect(s.runtimeKeyFor(WALKING_BETA_WARNING)).toBe(s.runtimeKeyFor(SPOKEN_WALKING_BETA));
    s.playStream('7', 'NAV');
    s.clearQueue('NAV');
    s.setRate(1.2);
    s.dispose();
    expect(f.speech.playStream).toHaveBeenCalledWith('7', 'NAV');
    expect(f.speech.clearQueue).toHaveBeenCalledWith('NAV');
    expect(f.speech.setRate).toHaveBeenCalledWith(1.2);
    expect(f.speech.dispose).toHaveBeenCalled();
    expect(s.isSpeaking()).toBe(false);
    expect(s.getStats()).toEqual({ spoken: 1 });
  });
});
