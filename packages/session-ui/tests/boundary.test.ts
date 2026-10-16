/**
 * The package must stay host-agnostic: no imports reaching back into Pi Web
 * UI's client (stores, hooks, lib) and no Node built-ins.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

// jsdom rewrites import.meta.url to an http URL; resolve from the file path.
const SRC = resolve(__dirname, '../src');
const ALLOWED = /^(react|react\/jsx-runtime|react-dom|react-markdown|remark-gfm|react-virtuoso|lucide-react|@pi-web-ui\/session-core(\/[\w-]+)?|\.\/[\w-]+)$/;

describe('session-ui import boundary', () => {
  const files = readdirSync(SRC).filter((name) => /\.(ts|tsx)$/.test(name));

  it('has sources', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const name of files) {
    it(`${name} imports only peers, session-core and siblings`, () => {
      const source = readFileSync(resolve(SRC, name), 'utf8');
      const specifiers = [...source.matchAll(/^\s*(?:import|export)\b[^'";]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
      expect(specifiers.filter((specifier) => !ALLOWED.test(specifier))).toEqual([]);
    });
  }
});
