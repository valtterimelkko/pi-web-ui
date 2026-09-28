import { describe, expect, it } from 'vitest';
import { checkBuildFreshness } from '../../../src/live-validation/heap-soak/build-freshness.js';

const COMMIT_MS = 1_790_529_385_000; // 2026-09-27T17:16:25Z, the newest server/src|shared/src commit at B0.1
const CLEAN = { sourceTreeDirty: false, sourceTreeStateKnown: true } as const;

describe('checkBuildFreshness (B0.1 defect 1)', () => {
  it('accepts a clean tree whose build is newer than the newest source commit', () => {
    expect(checkBuildFreshness({ ...CLEAN, compiledMtimeMs: COMMIT_MS + 60_000, newestSourceCommitMs: COMMIT_MS }).fresh).toBe(true);
  });

  it('treats a build exactly at the commit second as fresh (no sub-second false positive)', () => {
    expect(checkBuildFreshness({ ...CLEAN, compiledMtimeMs: COMMIT_MS, newestSourceCommitMs: COMMIT_MS }).fresh).toBe(true);
  });

  it('refuses a build older than a later commit that touched server/src or shared/src', () => {
    const result = checkBuildFreshness({ ...CLEAN, compiledMtimeMs: COMMIT_MS - 3_600_000, newestSourceCommitMs: COMMIT_MS });
    expect(result.fresh).toBe(false);
    expect(result.reason).toMatch(/older than the newest commit/);
    expect(result.reason).toMatch(/npm run build/);
  });

  it('refuses when server/src or shared/src has uncommitted changes', () => {
    const result = checkBuildFreshness({ ...CLEAN, sourceTreeDirty: true, compiledMtimeMs: COMMIT_MS + 1, newestSourceCommitMs: COMMIT_MS });
    expect(result.fresh).toBe(false);
    expect(result.reason).toMatch(/uncommitted changes/);
  });

  it('refuses when git status could not be read — unknown cleanliness is not clean (correction 03 item 5)', () => {
    const result = checkBuildFreshness({ ...CLEAN, sourceTreeStateKnown: false, compiledMtimeMs: COMMIT_MS + 60_000, newestSourceCommitMs: COMMIT_MS });
    expect(result.fresh).toBe(false);
    expect(result.reason).toMatch(/git status/);
    expect(result.reason).toMatch(/unknown|unverified/);
  });

  it('refuses when no compiled build exists', () => {
    const result = checkBuildFreshness({ ...CLEAN, compiledMtimeMs: undefined, newestSourceCommitMs: COMMIT_MS });
    expect(result.fresh).toBe(false);
    expect(result.reason).toMatch(/no compiled build/);
    expect(result.reason).toMatch(/server\/dist/);
  });

  it('refuses and names every missing compiled artefact (correction 03 item 6)', () => {
    const result = checkBuildFreshness({
      ...CLEAN,
      compiledMtimeMs: COMMIT_MS + 60_000,
      compiledMissing: ['shared/dist/index.js'],
      newestSourceCommitMs: COMMIT_MS,
    });
    expect(result.fresh).toBe(false);
    expect(result.reason).toMatch(/missing/);
    expect(result.reason).toContain('shared/dist/index.js');
  });

  it('refuses when the git history for the watched trees cannot be read', () => {
    const result = checkBuildFreshness({ ...CLEAN, compiledMtimeMs: COMMIT_MS, newestSourceCommitMs: undefined });
    expect(result.fresh).toBe(false);
    expect(result.reason).toMatch(/cannot be verified/);
  });
});
