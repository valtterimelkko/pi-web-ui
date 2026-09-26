import { readFileSync } from 'node:fs';
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
