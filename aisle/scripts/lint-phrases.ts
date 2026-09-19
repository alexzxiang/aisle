/**
 * Phrase lint (02 Task 4, 06 "Integration rules").
 *
 * Two rules, one script, run from the pre-commit hook and CI:
 *
 *   1. The closed phrase table in `src/core/phrases.ts`: every entry ≤ 12 words
 *      (6 for Tier-1 prompts), numbers written as words, no forbidden term. The
 *      one allow-listed long phrase (`disclaimer`) is exempt from the length and
 *      digit checks only.
 *   2. Every *string literal* in app, server, mock and fixture code: no
 *      forbidden term (safe, clear, go, cross now, no cars, you can cross) on a
 *      word boundary. Identifiers (`clearQueue`) and comments are not text and
 *      are never matched. Additionally, a literal passed as `text:` to a
 *      `say({...})` call must satisfy the 12-word and digits-as-words rules,
 *      because it is an utterance.
 *
 * Test files are skipped (they may quote forbidden words in their own
 * forbidden lists), as is any `FORBIDDEN_*` list declaration and any literal
 * that is itself a rule about the words ("Never use the words: safe, ..." in
 * a model prompt). A literal
 * that must legitimately contain a term (e.g. a UI copy line explaining the
 * rule) is opted out with a trailing `// lint-phrases: allow` comment on the
 * same line.
 *
 * Usage:  npx tsx scripts/lint-phrases.ts [--json] [extra files or dirs...]
 *         Markdown extras are scanned inside double-quoted spans only, for
 *         forbidden words (the pitch script in 06 quotes every spoken line).
 * Exit code 1 on any violation.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import {
  MAX_UTTERANCE_WORDS,
  checkPhrase,
  findForbiddenTerm,
  lintPhraseTable,
  type PhraseViolation,
} from '../src/core/phrases';

const ROOT = resolve(__dirname, '..');
const DEFAULT_ROOTS = ['src', 'server', 'mocks', 'fixtures', 'App.tsx'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.expo', 'ios', 'android', 'coverage']);
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const ALLOW_MARK = 'lint-phrases: allow';

export interface LintHit {
  file: string;
  line: number;
  rule: 'phrase-table' | 'forbidden' | 'utterance';
  text: string;
  detail: string;
}

function describe(v: PhraseViolation): string {
  switch (v.kind) {
    case 'forbidden': return `forbidden term "${v.term}"`;
    case 'too_long': return `${v.words} words (max ${v.max})`;
    case 'digit': return 'digits must be written as words';
    case 'empty': return 'empty text';
  }
}

function isTestFile(path: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) || /(^|\/)__tests__\//.test(path);
}

function walk(path: string, out: string[]): void {
  let st;
  try {
    st = statSync(path);
  } catch {
    return;
  }
  if (st.isDirectory()) {
    for (const name of readdirSync(path)) {
      if (SKIP_DIRS.has(name)) continue;
      walk(join(path, name), out);
    }
    return;
  }
  out.push(path);
}

// ---------------------------------------------------------------------------
// TypeScript / JavaScript sources
// ---------------------------------------------------------------------------

function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function lineText(sf: ts.SourceFile, line: number): string {
  return sf.text.split(/\r?\n/)[line - 1] ?? '';
}

/** The forbidden lists themselves (`FORBIDDEN_TERMS`, `FORBIDDEN_PHRASES`, ...) are not text. */
function insideForbiddenTermsDecl(node: ts.Node): boolean {
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && /^FORBIDDEN_/.test(n.name.text)) return true;
  }
  return false;
}

/** `say({ text: <literal> })` (or any `*.say(...)` / `say(...)` call): the literal is an utterance. */
function isSayText(node: ts.Node): boolean {
  const prop = node.parent;
  if (!prop || !ts.isPropertyAssignment(prop)) return false;
  if (!(ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) || prop.name.text !== 'text') return false;
  const obj = prop.parent;
  if (!ts.isObjectLiteralExpression(obj)) return false;
  const call = obj.parent;
  if (!ts.isCallExpression(call)) return false;
  const callee = call.expression;
  const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : '';
  return name === 'say';
}

/**
 * A rule *about* the words is not user text: "Never use the words: safe, clear,
 * ..." in a model prompt, or "must not say go". Such a literal names the
 * forbidden list on purpose and is skipped.
 */
const RULE_STATEMENT_RE = /\b(?:never|do not|don't|must not|avoid|forbidden|banned|prohibited)\b[^.!?]*\b(?:use|say|speak|words?|terms?|phrases?)\b/i;

export function isRuleStatement(text: string): boolean {
  return RULE_STATEMENT_RE.test(text);
}

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) return node.text;
  if (ts.isJsxText(node)) return node.text;
  return null;
}

export function lintSource(file: string, source: string, hits: LintHit[]): void {
  const kind = /\.tsx$|\.jsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const rel = relative(ROOT, file);
  const visit = (node: ts.Node): void => {
    const text = literalText(node);
    if (text !== null && text.trim().length > 0 && !insideForbiddenTermsDecl(node)) {
      const line = lineOf(sf, node.getStart(sf));
      if (!lineText(sf, line).includes(ALLOW_MARK)) {
        const term = findForbiddenTerm(text);
        if (term && !isRuleStatement(text)) hits.push({ file: rel, line, rule: 'forbidden', text, detail: `forbidden term "${term}"` });
        if (isSayText(node)) {
          for (const v of checkPhrase(text, { allowLong: false, maxWords: MAX_UTTERANCE_WORDS })) {
            if (v.kind !== 'forbidden') hits.push({ file: rel, line, rule: 'utterance', text, detail: describe(v) });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

// ---------------------------------------------------------------------------
// JSON fixtures and Markdown
// ---------------------------------------------------------------------------

function jsonStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) jsonStrings(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) jsonStrings(v, out);
}

export function lintJson(file: string, source: string, hits: LintHit[]): void {
  const rel = relative(ROOT, file);
  const lines = source.split(/\r?\n/);
  // JSONL: one document per line; JSON: one document. Either way report the line the string sits on.
  const docs: Array<{ text: string; line: number }> = [];
  if (file.endsWith('.jsonl')) {
    lines.forEach((l, i) => {
      if (l.trim()) docs.push({ text: l, line: i + 1 });
    });
  } else {
    docs.push({ text: source, line: 1 });
  }
  for (const doc of docs) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(doc.text);
    } catch {
      continue; // not our job to validate JSON
    }
    const strings: string[] = [];
    jsonStrings(parsed, strings);
    for (const s of strings) {
      const term = findForbiddenTerm(s);
      if (!term) continue;
      const idx = lines.findIndex((l, i) => i + 1 >= doc.line && l.includes(s.slice(0, 40)));
      hits.push({ file: rel, line: idx >= 0 ? idx + 1 : doc.line, rule: 'forbidden', text: s, detail: `forbidden term "${term}"` });
    }
  }
}

export function lintMarkdown(file: string, source: string, hits: LintHit[]): void {
  const rel = relative(ROOT, file);
  const lines = source.split(/\r?\n/);
  lines.forEach((l, i) => {
    const quoted = l.match(/"([^"]{3,})"/g) ?? [];
    for (const q of quoted) {
      const text = q.slice(1, -1);
      // Forbidden words only: a narrator's line or a judge's question is not an app utterance.
      const term = findForbiddenTerm(text);
      if (term && !isRuleStatement(text)) hits.push({ file: rel, line: i + 1, rule: 'forbidden', text, detail: `forbidden term "${term}"` });
    }
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function runLint(extraPaths: string[] = []): LintHit[] {
  const hits: LintHit[] = [];

  // 1. The phrase table.
  for (const r of lintPhraseTable()) {
    for (const v of r.violations) {
      hits.push({ file: 'src/core/phrases.ts', line: 0, rule: 'phrase-table', text: r.key, detail: describe(v) });
    }
  }

  // 2. Source, fixtures, extras.
  const files: string[] = [];
  for (const r of [...DEFAULT_ROOTS.map((p) => resolve(ROOT, p)), ...extraPaths.map((p) => resolve(process.cwd(), p))]) {
    walk(r, files);
  }
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f)) continue;
    seen.add(f);
    if (isTestFile(f)) continue;
    const ext = extname(f);
    let src: string;
    try {
      src = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    if (CODE_EXT.has(ext)) lintSource(f, src, hits);
    else if (ext === '.json' || ext === '.jsonl') lintJson(f, src, hits);
    else if (ext === '.md') lintMarkdown(f, src, hits);
  }
  return hits;
}

function main(): void {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const extras = args.filter((a) => !a.startsWith('--'));
  const hits = runLint(extras);
  if (json) {
    process.stdout.write(`${JSON.stringify(hits, null, 2)}\n`);
  } else if (hits.length === 0) {
    process.stdout.write('lint-phrases: ok (phrase table, string literals, fixtures)\n');
  } else {
    for (const h of hits) {
      const where = h.line > 0 ? `${h.file}:${h.line}` : h.file;
      process.stdout.write(`${where}  [${h.rule}]  ${h.detail}  — ${JSON.stringify(h.text.slice(0, 80))}\n`);
    }
    process.stdout.write(`lint-phrases: ${hits.length} violation(s)\n`);
  }
  process.exit(hits.length === 0 ? 0 : 1);
}

if (require.main === module) main();
