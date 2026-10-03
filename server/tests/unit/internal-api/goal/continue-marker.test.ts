/**
 * Wave K (contract 1.59.0) — durable once-marker store tests.
 *
 * Correction 02 F1 moved the exactly-once primitive to the atomic claim API
 * (see continue-marker-claim.test.ts). This file keeps the store-level
 * behaviours that outlive that rework: restart persistence, per-session keys,
 * fingerprint identity.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createContinueMarkerStore, goalFingerprint } from '../../../../src/internal-api/goal/continue-marker.js';

describe('continue marker store', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-marker-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('marker survives a new store instance over the same directory (restart persistence)', async () => {
    const fp = goalFingerprint('survives', 7);
    const first = createContinueMarkerStore(dir);
    await first.claim('pi-xyz', fp, 'restart_interruption', 'receipt');
    await first.commit('pi-xyz', fp);
    const second = createContinueMarkerStore(dir);
    const marker = await second.get('pi-xyz', fp);
    expect(marker?.count).toBe(1);
    expect(await second.hasActiveContinue('pi-xyz')).toBe(true);
  });

  it('hasActiveContinue is true only for a committed marker and is per-session', async () => {
    const store = createContinueMarkerStore(dir);
    const fp = goalFingerprint('obj', 3);
    await store.claim('pi-abc', fp, 'restart_interruption', 'boot_orphan');
    expect(await store.hasActiveContinue('pi-abc')).toBe(false);
    await store.commit('pi-abc', fp);
    expect(await store.hasActiveContinue('pi-abc')).toBe(true);
    expect(await store.hasActiveContinue('pi-other')).toBe(false);
  });

  it('release after commit is a no-op (a consumed once is never undone)', async () => {
    const store = createContinueMarkerStore(dir);
    const fp = goalFingerprint('obj', 4);
    await store.claim('pi-abc', fp, 'restart_interruption', 'boot_orphan');
    await store.commit('pi-abc', fp);
    await store.release('pi-abc', fp);
    const marker = await store.get('pi-abc', fp);
    expect(marker?.count).toBe(1);
    expect(await store.hasActiveContinue('pi-abc')).toBe(true);
  });

  it('fingerprint differs per objective and startedAt', () => {
    expect(goalFingerprint('a', 1)).not.toBe(goalFingerprint('b', 1));
    expect(goalFingerprint('a', 1)).not.toBe(goalFingerprint('a', 2));
    expect(goalFingerprint('a', 1)).toBe(goalFingerprint('a', 1));
  });

  it('get returns null for an unknown session/fingerprint', async () => {
    const store = createContinueMarkerStore(dir);
    expect(await store.get('pi-none', goalFingerprint('x', 9))).toBeNull();
  });

  it('pruneOtherFingerprints removes only other-goal markers', async () => {
    const store = createContinueMarkerStore(dir);
    const fpA = goalFingerprint('goal A', 1);
    const fpB = goalFingerprint('goal B', 2);
    await store.claim('pi-a', fpA, 'restart_interruption', 'boot_orphan');
    await store.commit('pi-a', fpA);
    await store.claim('pi-a', fpB, 'restart_interruption', 'boot_orphan');
    const pruned = await store.pruneOtherFingerprints('pi-a', fpB);
    expect(pruned).toBe(1);
    expect(await store.get('pi-a', fpB)).not.toBeNull();
    expect(await store.get('pi-a', fpA)).toBeNull();
  });
});
