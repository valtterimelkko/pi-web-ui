/**
 * Wave K (contract 1.59.0) — durable once-marker store (R3).
 *
 * The marker is SERVER-OWNED: it lives under the server's own data root,
 * beside the run receipts (`<receipts-root>/goal-continue/markers/`), never
 * inside pi-enhancement's `~/.pi/agent/goal-engine/`. Keyed by sessionId plus
 * the goal fingerprint, it survives a restart and makes the auto-continue
 * happen at most once per goal instance (reserve → commit, rollback on a
 * refused dispatch).
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

  it('reserve writes a count-0 marker and is idempotent per fingerprint', async () => {
    const store = createContinueMarkerStore(dir);
    const fp = goalFingerprint('build the thing', 1000);
    const first = await store.reserve('pi-abc', fp, 'restart_interruption', 'boot_orphan');
    expect(first.count).toBe(0);
    expect(first.fingerprint).toBe(fp);
    const again = await store.reserve('pi-abc', fp, 'restart_interruption', 'boot_orphan');
    expect(again.count).toBe(0);
    expect(again.reservedAt).toBe(first.reservedAt);
  });

  it('commit sets count to 1 with a continuedAt timestamp', async () => {
    const store = createContinueMarkerStore(dir);
    const fp = goalFingerprint('obj', 1);
    await store.reserve('pi-abc', fp, 'provider_abort', 'provider_abort');
    await store.commit('pi-abc', fp);
    const marker = await store.get('pi-abc', fp);
    expect(marker?.count).toBe(1);
    expect(typeof marker?.continuedAt).toBe('number');
  });

  it('rollback removes the marker (refused dispatch does not consume the once)', async () => {
    const store = createContinueMarkerStore(dir);
    const fp = goalFingerprint('obj', 2);
    await store.reserve('pi-abc', fp, 'restart_interruption', 'drain');
    await store.rollback('pi-abc', fp);
    expect(await store.get('pi-abc', fp)).toBeNull();
  });

  it('marker survives a new store instance over the same directory (restart persistence)', async () => {
    const fp = goalFingerprint('survives', 7);
    const first = createContinueMarkerStore(dir);
    await first.reserve('pi-xyz', fp, 'restart_interruption', 'receipt');
    await first.commit('pi-xyz', fp);
    const second = createContinueMarkerStore(dir);
    const marker = await second.get('pi-xyz', fp);
    expect(marker?.count).toBe(1);
    expect(await second.hasActiveContinue('pi-xyz')).toBe(true);
  });

  it('hasActiveContinue is true only for a committed marker and is per-session', async () => {
    const store = createContinueMarkerStore(dir);
    const fp = goalFingerprint('obj', 3);
    await store.reserve('pi-abc', fp, 'restart_interruption', 'boot_orphan');
    expect(await store.hasActiveContinue('pi-abc')).toBe(false);
    await store.commit('pi-abc', fp);
    expect(await store.hasActiveContinue('pi-abc')).toBe(true);
    expect(await store.hasActiveContinue('pi-other')).toBe(false);
  });

  it('rollback clears hasActiveContinue', async () => {
    const store = createContinueMarkerStore(dir);
    const fp = goalFingerprint('obj', 4);
    await store.reserve('pi-abc', fp, 'restart_interruption', 'boot_orphan');
    await store.commit('pi-abc', fp);
    await store.rollback('pi-abc', fp);
    expect(await store.hasActiveContinue('pi-abc')).toBe(false);
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
});
