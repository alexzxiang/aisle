import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REQUIRED_KEYS } from './config';

/**
 * The setup instructions say `cp .env.example .env`, and for a long time that file did not
 * exist — the root .gitignore's `.env*` matched it, so nobody could commit one. These keep it
 * present, complete and value-free rather than trusting it to stay that way.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const example = readFileSync(join(HERE, '.env.example'), 'utf8');
const config = readFileSync(join(HERE, 'config.ts'), 'utf8');

const listed = new Set([...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!));
const read = new Set([...config.matchAll(/str\(env, '([A-Z][A-Z0-9_]*)'\)/g)].map((m) => m[1]!));

describe('.env.example', () => {
  it('lists every variable config.ts reads', () => {
    expect([...read].filter((k) => !listed.has(k))).toEqual([]);
  });

  it('lists nothing config.ts ignores, so it cannot advertise a dead setting', () => {
    expect([...listed].filter((k) => !read.has(k))).toEqual([]);
  });

  it('covers all five required keys', () => {
    expect(REQUIRED_KEYS.filter((k) => !listed.has(k))).toEqual([]);
  });

  it('carries no values — it is a template, and a filled one would be a leaked key', () => {
    const populated = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=(.+)$/gm)].map((m) => m[0]);
    expect(populated).toEqual([]);
  });
});
