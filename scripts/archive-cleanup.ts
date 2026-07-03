#!/usr/bin/env npx tsx
/**
 * Archive-state cleanup helper (standalone — no server imports).
 *
 * Companion to the server-authoritative archive fix. Before that fix,
 * `archivedSessionPaths` was a monotonic grow-only set (the init-time
 * server∪local union was written back on every load), so the server list
 * accumulated every session ever archived on any device — including ones the
 * operator had tried to unarchive. This script helps trim that bloat.
 *
 * The fix itself makes unarchive work going forward (unarchive now sticks and
 * propagates), so this is a ONE-OFF for the already-corrupted list — run it
 * once after deploying the fix, then maintain state from the UI.
 *
 * SAFE BY DEFAULT: with no action flag it only reports what it WOULD do and
 * writes nothing. Pass `--apply` to persist. Writes are atomic (tmp + rename),
 * matching the server's own write semantics so it cannot corrupt the file.
 *
 *   npx tsx scripts/archive-cleanup.ts                            # dry-run: full report, no writes
 *   npx tsx scripts/archive-cleanup.ts --prune-missing --apply    # drop entries whose files are gone
 *   npx tsx scripts/archive-cleanup.ts --older-than-days 60 --apply
 *   npx tsx scripts/archive-cleanup.ts --reset --apply            # clear the list entirely
 *
 * Flags:
 *   --prune-missing        Remove entries whose session file no longer exists on disk.
 *   --older-than-days N    Remove entries whose session file mtime is older than N days.
 *   --reset                Remove ALL entries (you re-archive what you want from the UI).
 *   --apply                Actually write the trimmed list. Without it, only a report is printed.
 *   --prefs <path>         Override the prefs file (default: ~/.pi/agent/web-ui-prefs.json).
 *
 * Actions compose: e.g. --prune-missing --older-than-days 90 removes the union.
 *
 * NOTE: by default this targets the PRODUCTION prefs file. Point --prefs at a
 * copy if you want to preview against real data without touching prod, e.g.:
 *   cp ~/.pi/agent/web-ui-prefs.json /tmp/p.json && npx tsx scripts/archive-cleanup.ts --prefs /tmp/p.json
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PREFS = path.join(os.homedir(), '.pi', 'agent', 'web-ui-prefs.json');

interface Prefs {
  archivedSessionPaths?: string[];
  pinnedSessionPaths?: string[];
  sessionDisplayNames?: Record<string, string>;
  [key: string]: unknown;
}

async function readPrefs(file: string): Promise<Prefs> {
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf-8'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { archivedSessionPaths: [] };
    throw err;
  }
}

// Atomic write: tmp file + rename, mirroring server writePreferences().
async function writePrefs(file: string, prefs: Prefs): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await fs.promises.writeFile(tmp, JSON.stringify(prefs, null, 2), 'utf-8');
  await fs.promises.rename(tmp, file);
}

function parseArgs(argv: string[]) {
  const flags = {
    pruneMissing: false,
    olderThanDays: null as number | null,
    reset: false,
    apply: false,
    prefs: DEFAULT_PREFS,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--prune-missing') flags.pruneMissing = true;
    else if (a === '--older-than-days') flags.olderThanDays = Number(argv[++i]);
    else if (a === '--reset') flags.reset = true;
    else if (a === '--apply') flags.apply = true;
    else if (a === '--prefs') flags.prefs = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: npx tsx scripts/archive-cleanup.ts [--prune-missing] [--older-than-days N] [--reset] [--apply] [--prefs <path>]`);
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return flags;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const prefsPath = flags.prefs;
  const now = Date.now();
  const olderThanMs = flags.olderThanDays != null ? flags.olderThanDays * DAY_MS : null;

  const prefs = await readPrefs(prefsPath);
  const original = prefs.archivedSessionPaths ?? [];

  let kept: string[];
  const removed: string[] = [];
  let missing = 0;
  let stale = 0;

  if (flags.reset) {
    kept = [];
    removed.push(...original);
  } else {
    kept = [];
    for (const p of original) {
      let exists = true;
      let mtime = now;
      try {
        mtime = (await fs.promises.stat(p)).mtimeMs;
      } catch {
        exists = false;
      }

      let drop = false;
      if (!exists) {
        if (flags.pruneMissing) { drop = true; missing++; }
      } else if (olderThanMs != null && now - mtime > olderThanMs) {
        drop = true; stale++;
      }
      if (drop) removed.push(p);
      else kept.push(p);
    }
  }

  const willWrite = flags.apply && (flags.reset || flags.pruneMissing || olderThanMs != null);
  if (willWrite) {
    await writePrefs(prefsPath, { ...prefs, archivedSessionPaths: kept });
  }

  console.log(`Prefs file : ${prefsPath}`);
  console.log(`Mode       : ${flags.apply ? 'APPLY (persisted)' : 'DRY-RUN (no writes)'}`);
  console.log(`Actions    :${flags.reset ? ' --reset' : ''}${flags.pruneMissing ? ' --prune-missing' : ''}${flags.olderThanDays != null ? ` --older-than-days ${flags.olderThanDays}` : ''}`);
  console.log(`Before     : ${original.length} archived path(s)`);
  console.log(`After      : ${kept.length} archived path(s)`);
  console.log(`Removed    : ${removed.length}` + (missing ? `  (missing-file: ${missing})` : '') + (stale ? `  (older-than: ${stale})` : ''));
  if (!flags.apply && removed.length > 0) console.log('\n(dry-run — re-run with --apply to persist)');
  if (removed.length > 0 && removed.length <= 20) {
    console.log('\nRemoved entries:');
    for (const p of removed) console.log(`  - ${p}`);
  }
}

main().catch((err) => {
  console.error('[archive-cleanup] Failed:', err);
  process.exit(1);
});
