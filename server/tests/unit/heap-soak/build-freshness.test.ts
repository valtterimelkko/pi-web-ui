import { describe, expect, it } from 'vitest';
import { checkBuildFreshness } from '../../../src/live-validation/heap-soak/build-freshness.js';

const COMMIT_MS = 1_790_529_385_000; // 2026-09-27T17:16:25Z, the newest server/src|shared/src commit at B0.1

describe('checkBuildFreshness (B0.1 defect 1)', () => {
  it('accepts a clean tree whose build is newer than the newest source commit', () => {
    const result = checkBuildFreshness({
      compiledMtimeMs: COMMIT_MS + 60_000,
      newestSourceCommitMs: COMMIT_MS,
      sourceTreeDirty: false,
    });
    expect(result.fresh).toBe(true);
  });

  it('treats a build exactly at the commit second as fresh (no sub-second false positive)', () => {
    expect(checkBuildFreshness({ compiledMtimeMs: COMMIT_MS, newestSourceCommitMs: COMMIT_MS, sourceTreeDirty: false }).fresh).toBe(true);
  });

  it('refuses a build older than a later commit that touched server/src or shared/src', () => {
    const result = checkBuildFreshness({
      compiledMtimeMs: COMMIT_MS - 3_600_000,
      newestSourceCommitMs: COMMIT_MS,
      sourceTreeDirty: false,
    });
    expect(result.fresh).toBe(false);
    expect(result.reason).toMatch(/older than the newest commit/);
    expect(result.reason).toContain('server/src');
    expect(result.reason).toMatch(/npm run build/);
  });

  it('refuses when server/src or shared/src has uncommitted changes', () => {
    const result = checkBuildFreshness({
      compiledMtimeMs: COMMIT_MS + 60_000,
      newestSourceCommitMs: COMMIT_MS,
      sourceTreeDirty: true,
    });
    expect(result.fresh).toBe(false);
    expect(result.reason).toMatch(/uncommitted changes/);
  });

  it('refuses when no compiled build exists', () => {
    const result = checkBuildFreshness({ compiledMtimeMs: undefined, newestSourceCommitMs: COMMIT_MS, sourceTreeDirty: false });
    expect(result.fresh).toBe(false);
    expect(result.reason).toMatch(/no compiled build/);
    expect(result.reason).toMatch(/server\/dist/);
  });

  it('refuses when the git history for the watched trees cannot be read', () => {
    const result = checkBuildFreshness({ compiledMtimeMs: COMMIT_MS, newestSourceCommitMs: undefined, sourceTreeDirty: false });
    expect(result.fresh).toBe(false);
    expect(result.reason).toMatch(/cannot be verified/);
  });
});
