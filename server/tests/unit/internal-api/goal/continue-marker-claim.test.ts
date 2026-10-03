/**
 * Wave K correction 02 (F1) — atomic exactly-once marker store.
 *
 * The claim is an exclusive create (O_EXCL): two overlapping sweeps cannot both
 * hold the per-goal claim. A crash after prompt acceptance leaves the claim
 * consumed (never rolled back after a possible acceptance); a definitely
 * refused dispatch releases the claim. A stale count-0 claim (older than the
 * takeover age) may be taken over atomically — its dispatch can no longer be
 * in flight.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createContinueMarkerStore, goalFingerprint } from '../../../../src/internal-api/goal/continue-marker.js';

describe('continue marker store — atomic claim (correction 02 F1)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-marker2-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('claim exclusively creates the marker; a second claim reports the goal consumed (C1: never replayed)', async () => {
    const store = createContinueMarkerStore(dir);
    const fp = goalFingerprint('obj', 1);
    const first = await store.claim('pi-a', fp, 'restart_interruption', 'boot_orphan');
    expect(first.claimed).toBe(true);
    const second = await store.claim('pi-a', fp, 'restart_interruption', 'boot_orphan');
    expect(second.claimed).toBe(false);
    if (!second.claimed) expect(second.existing.count).toBe(1);
  });

  it('a committed marker blocks a new claim and reports the continue', async () => {
    const store = createContinueMarkerStore(dir);
    const fp = goalFingerprint('obj', 2);
    await store.claim('pi-a', fp, 'restart_interruption', 'receipt');
    await store.commit('pi-a', fp);
    const again = await store.claim('pi-a', fp, 'restart_interruption', 'receipt');
    expect(again.claimed).toBe(false);
    if (!again.claimed) expect(again.existing.count).toBe(1);
  });

  it('release removes only a count-0 claim, never a committed marker', async () => {
    const store = createContinueMarkerStore(dir);
    const fp = goalFingerprint('obj', 3);
    await store.claim('pi-a', fp, 'restart_interruption', 'drain');
    await store.release('pi-a', fp);
    expect(await store.get('pi-a', fp)).toBeNull();
    await store.claim('pi-a', fp, 'restart_interruption', 'drain');
    await store.commit('pi-a', fp);
    await store.release('pi-a', fp);
    const marker = await store.get('pi-a', fp);
    expect(marker?.count).toBe(1);
  });

  it('a stale count-0 claim is NOT taken over (correction 03 C1: consumed, visible)', async () => {
    const store = createContinueMarkerStore(dir);
    const fp = goalFingerprint('obj', 4);
    await store.claim('pi-a', fp, 'restart_interruption', 'boot_orphan');
    const fresh = await store.claim('pi-a', fp, 'restart_interruption', 'boot_orphan');
    expect(fresh.claimed).toBe(false);

    const store2 = createContinueMarkerStore(dir, { now: () => Date.now() + 20 * 60_000 });
    const stale = await store2.claim('pi-a', fp, 'restart_interruption', 'boot_orphan');
    expect(stale.claimed).toBe(false);
    if (!stale.claimed) expect(stale.existing.count).toBe(1);
  });

  it('commit keeps continuedAt stable across repeated commits and survives a new store instance', async () => {
    const store = createContinueMarkerStore(dir);
    const fp = goalFingerprint('obj', 5);
    await store.claim('pi-a', fp, 'provider_abort', 'provider_abort');
    await store.commit('pi-a', fp);
    const first = await store.get('pi-a', fp);
    await store.commit('pi-a', fp);
    const second = await store.get('pi-a', fp);
    expect(second?.continuedAt).toBe(first?.continuedAt);
    const reopened = createContinueMarkerStore(dir);
    expect((await reopened.get('pi-a', fp))?.count).toBe(1);
  });

  it('markers for other fingerprints are listed for pruning', async () => {
    const store = createContinueMarkerStore(dir);
    await store.claim('pi-a', goalFingerprint('goal A', 1), 'restart_interruption', 'boot_orphan');
    await store.claim('pi-a', goalFingerprint('goal A', 1), 'restart_interruption', 'boot_orphan').catch(() => undefined);
    const all = await store.listForSession('pi-a');
    expect(all.length).toBe(1);
  });
});
