/**
 * Forbidden-word lint over B's directories (03 "two rules with no exceptions").
 * Scans every string literal in non-test sources under src/outdoor, src/crossing
 * and server/routes for the 01 §3 list; identifiers (`clearQueue`) are not text.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { FORBIDDEN_TERMS, findForbiddenTerm } from '../core/phrases';

const ROOT = path.resolve(__dirname, '..', '..');
const DIRS = ['src/outdoor', 'src/crossing', 'server/routes', 'server/data'];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (name === 'node_modules' || name === 'cache') continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|json|md)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** String literals ('…', "…", `…`) and JSON string values; comments are not spoken. */
function stringLiterals(source: string, isJson: boolean): string[] {
  const re = isJson
    ? /"((?:[^"\\]|\\.)*)"/g
    : /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  return Array.from(source.matchAll(re), (m) => m[1] ?? m[2] ?? m[3] ?? '');
}

describe('forbidden words in B-owned sources', () => {
  const files = DIRS.flatMap((d) => walk(path.join(ROOT, d)));

  it('scans a meaningful number of files', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files.map((f) => [path.relative(ROOT, f), f]))('%s has no forbidden phrase in a string literal', (_rel, file) => {
    const src = readFileSync(file, 'utf8');
    const isJson = file.endsWith('.json');
    const isMd = file.endsWith('.md');
    const texts = isMd ? [src] : stringLiterals(src, isJson);
    const offenders = texts
      .filter((t) => !t.includes('/') && !/^[A-Z_]+$/.test(t))                 // paths, enum members
      .filter((t) => !FORBIDDEN_TERMS.includes(t.toLowerCase()))            // the list itself
      .map((t) => ({ t, term: findForbiddenTerm(t) }))
      .filter((x) => x.term !== null && !/forbidden/i.test(x.t) && !/^(safe|clear|go)$/i.test(x.t));
    expect(offenders).toEqual([]);
  });
});
