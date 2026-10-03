/**
 * Wave K correction 03 (C1/C4) — marker store semantics.
 *
 * - A count-0 claim is NEVER replayed, fresh or stale: found at a later boot it
 *   is treated as consumed (no takeover — removed this round).
 * - A corrupt marker file is treated as consumed, never silent.
 * - `confirm()` records the distinct verified state (C4): only a verified
 *   continue (same fingerprint reading running, or same-fingerprint terminal)
 *   is confirmed; unknown and accepted-but-unverified never confirm.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createContinueMarkerStore, goalFingerprint } from '../../../../src/internal-api/goal/continue-marker.js';

describe('continue marker store — correction 03', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-marker3-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('a count-0 claim is never replayed: claim reports it as consumed (count 1, corrupt-or-claimed)', async () => {
    const store = createContinueMarkerStore(dir);
    const fp = goalFingerprint('obj', 1);
    await store.claim('pi-a', fp, 'restart_interruption', 'boot_orphan');
    const again = await store.claim('pi-a', fp, 'restart_interruption', 'boot_orphan');
    expect(again.claimed).toBe(false);
    if (!again.claimed) expect(again.existing.count).toBe(1);
  });

  it('a stale count-0 claim is not taken over either', async () => {
    const store = createContinueMarkerStore(dir);
    const fp = goalFingerprint('obj', 2);
    const past = createContinueMarkerStore(dir, { now: () => Date.now() - 60 * 60_000 });
    await past.claim('pi-a', fp, 'restart_interruption', 'boot_orphan');
    const again = await store.claim('pi-a', fp, 'restart_interruption', 'boot_orphan');
    expect(again.claimed).toBe(false);
    if (!again.claimed) expect(again.existing.count).toBe(1);
  });

  it('a corrupt marker file is reported as consumed, never silent', async () => {
    const store = createContinueMarkerStore(dir);
    const fp = goalFingerprint('obj', 3);
    await fsp.mkdir(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `pi-a.${fp.slice(0, 16)}.json`), '{not json at all', 'utf8');
    const again = await store.claim('pi-a', fp, 'restart_interruption', 'boot_orphan');
    expect(again.claimed).toBe(false);
    if (!again.claimed) {
      expect(again.existing.count).toBe(1);
      expect((again.existing as { corrupt?: boolean }).corrupt).toBe(true);
    }
  });

  it('confirm records the verified state; commit alone does not confirm', async () => {
    const store = createContinueMarkerStore(dir);
    const fp = goalFingerprint('obj', 4);
    await store.claim('pi-a', fp, 'restart_interruption', 'receipt');
    await store.commit('pi-a', fp);
    expect((await store.get('pi-a', fp))?.state).toBe('delivered');
    await store.confirm('pi-a', fp);
    const marker = await store.get('pi-a', fp);
    expect(marker?.state).toBe('confirmed');
    expect(await store.hasConfirmedContinue('pi-a', fp)).toBe(true);
  });

  it('confirm is idempotent and survives a new store instance', async () => {
    const store = createContinueMarkerStore(dir);
    const fp = goalFingerprint('obj', 5);
    await store.claim('pi-a', fp, 'restart_interruption', 'receipt');
    await store.commit('pi-a', fp);
    await store.confirm('pi-a', fp);
    await store.confirm('pi-a', fp);
    const reopened = createContinueMarkerStore(dir);
    expect((await reopened.get('pi-a', fp))?.state).toBe('confirmed');
  });
});
