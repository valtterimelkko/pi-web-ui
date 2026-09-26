import { createHash } from 'node:crypto';

export interface FileChecksum {
  path: string;
  /** sha256 hex digest, or 'MISSING' if the file did not exist. */
  sha256: string;
}

export function sha256Hex(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

export interface ChecksumMismatch {
  path: string;
  before: string;
  after: string;
}

/** Compare two checksum snapshots (same path set expected) and return every path that changed. */
export function diffChecksums(before: readonly FileChecksum[], after: readonly FileChecksum[]): ChecksumMismatch[] {
  const afterByPath = new Map(after.map((c) => [c.path, c.sha256]));
  const mismatches: ChecksumMismatch[] = [];
  for (const b of before) {
    const a = afterByPath.get(b.path);
    if (a === undefined) {
      mismatches.push({ path: b.path, before: b.sha256, after: 'MISSING-AFTER' });
      continue;
    }
    if (a !== b.sha256) mismatches.push({ path: b.path, before: b.sha256, after: a });
  }
  // Paths that appeared after but were absent before also count as a change.
  const beforePaths = new Set(before.map((c) => c.path));
  for (const a of after) {
    if (!beforePaths.has(a.path)) mismatches.push({ path: a.path, before: 'MISSING-BEFORE', after: a.sha256 });
  }
  return mismatches;
}

/**
 * The production files/dirs the harness must never touch. Kept as a single
 * source of truth so Gate 0's before/after checksum and the isolation
 * assertion below agree on exactly what "production" means.
 */
export function productionGuardedPaths(homeDir: string): string[] {
  const stateRoot = `${homeDir}/.pi-web-ui`;
  const agentDir = `${homeDir}/.pi/agent`;
  return [
    `${stateRoot}/session-registry.json`,
    `${stateRoot}/internal-api.sock`,
    `${stateRoot}/internal-api-token`,
    `${stateRoot}/notifications/opt-ins.json`,
    `${stateRoot}/claude-sessions`,
    `${agentDir}/models.json`,
    `${agentDir}/auth.json`,
    `${agentDir}/settings.json`,
  ];
}

/**
 * Assert that a resolved run directory (or any other path the harness will
 * write to) is not one of, and not nested under, any production path. Pure
 * string-prefix check over already-resolved absolute paths; callers resolve
 * symlinks first (see server/src/live-validation/validation-server-options.ts
 * `assertSafeValidationDirectory`, which this harness's launcher also calls
 * directly for the run directory itself).
 */
export function assertOutsideProductionPaths(candidateResolvedPath: string, productionResolvedPaths: readonly string[]): void {
  for (const prod of productionResolvedPaths) {
    if (candidateResolvedPath === prod || candidateResolvedPath.startsWith(`${prod}/`) || prod.startsWith(`${candidateResolvedPath}/`)) {
      throw new Error(`heap-soak path ${candidateResolvedPath} collides with production path ${prod}`);
    }
  }
}
