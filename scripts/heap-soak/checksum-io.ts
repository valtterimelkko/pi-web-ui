import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { sha256Hex, type FileChecksum } from '../../server/src/live-validation/heap-soak/isolation.js';

/** Read-only checksum of a fixed path list. Missing files checksum to the sentinel 'MISSING'. */
export function computeChecksums(paths: readonly string[]): FileChecksum[] {
  return paths.map((p) => {
    try {
      return { path: p, sha256: sha256Hex(readFileSync(p)) };
    } catch {
      return { path: p, sha256: 'MISSING' };
    }
  });
}

/**
 * A single sha256 over a directory tree (sorted relative path + file bytes).
 * Used to prove that overlaid extension fixes never touched the production
 * `~/.pi/agent/extensions` directory (B0 defect 6). Returns 'MISSING' when the
 * directory does not exist.
 */
export function hashDirectoryTree(dir: string): string {
  if (!existsSync(dir)) return 'MISSING';
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  walk(dir);
  files.sort();
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(path.relative(dir, file));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}
