#!/usr/bin/env npx tsx
/**
 * E2a-1 correction 02 — credential/token cleanup assertion for retained run
 * evidence (Luna r1 blocker 1: a 96-byte disposable internal-api-token
 * survived in the retained run dir).
 *
 * Fails (exit 1) if any of the following exist under the given roots:
 *   - files named `internal-api-token*` or matching `*token*`
 *   - `auth.json` files
 *   - `models.json` files that contain any `apiKey`/`api_key` value
 *   - `pi-sessions/*.jsonl` transcripts
 *
 *   npx tsx scripts/e2a-soak/assert-evidence-clean.ts <root> [<root>…]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function find(root: string, args: string[]): string[] {
  const out = execFileSync('find', [root, ...args], { encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

function modelsFileHasKeys(path: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const hasKey = (o: unknown): boolean => {
      if (Array.isArray(o)) return o.some(hasKey);
      if (o !== null && typeof o === 'object') {
        return Object.entries(o as Record<string, unknown>).some(([k, v]) => k === 'apiKey' || k === 'api_key' || hasKey(v));
      }
      return false;
    };
    return hasKey(parsed);
  } catch {
    // Parent FINAL correction 03 (Luna r2): fail closed — a models.json we cannot
    // parse cannot be shown key-free, so it is an offender.
    return true;
  }
}

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error('usage: assert-evidence-clean.ts <root> [<root>…]');
  process.exit(64);
}

const offenders: { kind: string; path: string }[] = [];
for (const root of roots) {
  for (const p of find(root, ['(', '-name', 'internal-api-token*', '-o', '-name', '*token*', '-o', '-name', 'auth.json', ')'])) {
    offenders.push({ kind: 'token/auth file', path: p });
  }
  for (const p of find(root, ['-name', 'models.json'])) {
    if (modelsFileHasKeys(p)) offenders.push({ kind: 'models.json with credential keys', path: p });
  }
  for (const p of find(root, ['-path', '*pi-sessions*', '-name', '*.jsonl'])) {
    offenders.push({ kind: 'session transcript', path: p });
  }
}

console.log(JSON.stringify({ roots, offenders, pass: offenders.length === 0 }, null, 1));
process.exit(offenders.length === 0 ? 0 : 1);
