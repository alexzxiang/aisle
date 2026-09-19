import { lintJson, lintMarkdown, lintSource, runLint, type LintHit } from './lint-phrases';

const src = (code: string, file = '/repo/src/x.ts'): LintHit[] => {
  const hits: LintHit[] = [];
  lintSource(file, code, hits);
  return hits;
};

describe('lintSource (string literals only)', () => {
  it('flags forbidden terms in string, template and JSX text, on word boundaries', () => {
    const hits = src(`
      const a = 'The way is clear';
      const b = \`no cars coming\`;
      const c = \`Vehicle \${side}. Go now\`;
      const ok = 'Keep going';
    `);
    expect(hits.map((h) => [h.line, h.detail])).toEqual([
      [2, 'forbidden term "clear"'],
      [3, 'forbidden term "no cars"'],
      [4, 'forbidden term "go"'],
    ]);
    const jsx = src(`export const X = () => <Text>You can cross</Text>;`, '/repo/src/ui/X.tsx');
    expect(jsx).toHaveLength(1);
    expect(jsx[0].detail).toBe('forbidden term "you can cross"');
  });

  it('ignores identifiers and comments', () => {
    expect(src(`
      // the road is clear here, go
      /* safe */
      speech.clearQueue();
      const go = 1; const safe = go + 1;
    `)).toEqual([]);
  });

  it('skips a rule statement about the words (model prompts), but not ordinary text', () => {
    expect(src(`const sys = 'Never use the words: safe, clear, go, cross now, no cars, you can cross.';`)).toEqual([]);
    expect(src(`const sys = 'You must not say go or safe.';`)).toEqual([]);
    expect(src(`const t = 'It is safe. Never mind the rest.';`)).toHaveLength(1);
  });

  it('skips FORBIDDEN_* declarations and lines opted out with the allow mark', () => {
    expect(src(`
      export const FORBIDDEN_TERMS = ['safe', 'clear', 'go'];
      const FORBIDDEN_PHRASES = [...FORBIDDEN_TERMS, 'go now'];
      const help = 'Never says safe or clear'; // lint-phrases: allow
    `)).toEqual([]);
  });

  it('applies the utterance rules to say({ text })', () => {
    const hits = src(`
      speech.say({ text: 'Turn right in 20 feet', priority: 'NAV' });
      say({ text: 'one two three four five six seven eight nine ten eleven twelve thirteen', priority: 'NAV' });
      other({ text: 'a 1 b 2 c 3 d 4 e 5 f 6 g 7 h 8' });
      speech.say({ text: PHRASES.turn_left_now, priority: 'NAV' });
    `);
    expect(hits.map((h) => [h.rule, h.detail])).toEqual([
      ['utterance', 'digits must be written as words'],
      ['utterance', '13 words (max 12)'],
    ]);
  });
});

describe('lintJson / lintMarkdown', () => {
  it('walks fixture values, including JSONL lines, and ignores keys', () => {
    const hits: LintHit[] = [];
    lintJson('/repo/fixtures/a.json', JSON.stringify({ clear: 'fine', reply: 'It is safe' }, null, 2), hits);
    expect(hits).toHaveLength(1);
    expect(hits[0].detail).toBe('forbidden term "safe"');
    const jl: LintHit[] = [];
    lintJson('/repo/fixtures/b.jsonl', '{"speech":"Walk signal on."}\n{"speech":"Go now"}\nnot json\n', jl);
    expect(jl).toEqual([expect.objectContaining({ line: 2, detail: 'forbidden term "go"' })]);
  });

  it('scans only double-quoted spans in Markdown, for forbidden words', () => {
    const hits: LintHit[] = [];
    lintMarkdown('/repo/06.md', [
      'Forbidden words (safe, clear, go) are rejected.',          // prose, not quoted → ignored
      '> "Crossing ahead: Forbes. Signalized."',
      '> "It is safe to cross now"',
      '> "Never say safe or clear on stage"',                     // a rule about the words
      '> "one two three four five six seven eight nine ten eleven twelve thirteen"',  // narrator, not the app
    ].join('\n'), hits);
    expect(hits.map((h) => [h.line, h.rule])).toEqual([[3, 'forbidden']]);
  });
});

describe('runLint over the repository', () => {
  it('is clean: phrase table, src, server, mocks and fixtures', () => {
    const hits = runLint();
    expect(hits.map((h) => `${h.file}:${h.line} ${h.detail} ${JSON.stringify(h.text)}`)).toEqual([]);
  });
});
