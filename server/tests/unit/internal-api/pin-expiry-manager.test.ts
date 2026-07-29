import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  PinExpiryManager,
  MAX_PIN_TTL_MS,
} from '../../../src/internal-api/pin-expiry-manager.js';

describe('PinExpiryManager', () => {
  let dir: string;
  let pin: ReturnType<typeof vi.fn>;
  let unpin: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-pin-mgr-'));
    pin = vi.fn(async () => true);
    unpin = vi.fn(async () => true);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
    vi.useRealTimers();
  });

  function makeManager(overrides: Partial<ConstructorParameters<typeof PinExpiryManager>[0]> = {}) {
    return new PinExpiryManager({ dir, pin, unpin, ...overrides });
  }

  it('grants a pin with the default TTL and records it', async () => {
    const mgr = makeManager();
    await mgr.init();
    const result = await mgr.applyPin('s1', { runtime: 'claude' });
    expect(result.pinned).toBe(true);
    expect(result.pinnedUntil).toBeGreaterThan(Date.now());
    expect(result.retentionLeaseId).toEqual(expect.any(String));
    expect(pin).toHaveBeenCalledWith('s1', `internal-api:${result.retentionLeaseId}`);
    expect(mgr.getPinnedUntil('s1')).toBe(result.pinnedUntil);
  });

  it('honours an explicit ttlSeconds', async () => {
    const mgr = makeManager();
    await mgr.init();
    const before = Date.now();
    const result = await mgr.applyPin('s2', { ttlSeconds: 120 });
    expect(result.pinnedUntil).toBeGreaterThanOrEqual(before + 119_000);
    expect(result.pinnedUntil).toBeLessThanOrEqual(before + 121_000);
  });

  it('clamps an oversized TTL to the hard max', async () => {
    const mgr = makeManager();
    await mgr.init();
    const result = await mgr.applyPin('s3', { ttlSeconds: 999_999_999 });
    expect(result.pinnedUntil).toBeLessThanOrEqual(Date.now() + MAX_PIN_TTL_MS + 1000);
  });

  it('returns PIN_LIMIT_REACHED (and records nothing) when the runtime refuses the pin', async () => {
    pin.mockResolvedValue(false);
    const mgr = makeManager();
    await mgr.init();
    const result = await mgr.applyPin('s4');
    expect(result).toEqual({ pinned: false, reason: 'PIN_LIMIT_REACHED' });
    expect(mgr.getPinnedUntil('s4')).toBeUndefined();
  });

  it('re-pinning extends the deadline', async () => {
    const mgr = makeManager();
    await mgr.init();
    const first = await mgr.applyPin('s5', { ttlSeconds: 60 });
    const second = await mgr.applyPin('s5', { ttlSeconds: 3600 });
    expect(second.pinnedUntil!).toBeGreaterThan(first.pinnedUntil!);
    expect(mgr.getPinnedUntil('s5')).toBe(second.pinnedUntil);
  });

  it('releases one lease without removing another source-owned lease on the same session', async () => {
    const mgr = makeManager();
    await mgr.init();
    const first = await mgr.acquireLease('shared', { ttlSeconds: 3600, ownerId: 'conductor-a' });
    const second = await mgr.acquireLease('shared', { ttlSeconds: 3600, ownerId: 'conductor-b' });

    expect(first.retentionLeaseId).not.toBe(second.retentionLeaseId);
    await mgr.releaseLease('shared', first.retentionLeaseId!, 'conductor-a');
    expect(unpin).toHaveBeenCalledWith('shared', `internal-api:${first.retentionLeaseId}`);
    expect(mgr.listLeases('shared').map((lease) => lease.leaseId)).toEqual([second.retentionLeaseId]);
  });

  it('serializes renewal and release so a released lease cannot reappear', async () => {
    const mgr = makeManager();
    await mgr.init();
    const lease = await mgr.acquireLease('raced', { ownerId: 'owner' });

    await Promise.all([
      mgr.renewLease('raced', lease.retentionLeaseId!, 3600),
      mgr.releaseLease('raced', lease.retentionLeaseId!, 'owner'),
    ]);
    expect(mgr.listLeases('raced')).toEqual([]);

    const restarted = makeManager();
    await restarted.init();
    expect(restarted.listLeases('raced')).toEqual([]);
  });

  it('supports durable leases without applying runtime residency', async () => {
    const mgr = makeManager();
    await mgr.init();
    const result = await mgr.acquireLease('durable', { mode: 'durable', ownerId: 'conductor-a' });
    expect(result.pinned).toBe(false);
    expect(result.retentionMode).toBe('durable');
    expect(pin).not.toHaveBeenCalled();
    expect(mgr.listLeases('durable')).toHaveLength(1);
  });

  it('expireNow revokes pins whose deadline has passed', async () => {
    const mgr = makeManager();
    await mgr.init();
    await mgr.applyPin('expired', { ttlSeconds: 0 });
    await mgr.applyPin('alive', { ttlSeconds: 3600 });

    const result = await mgr.expireNow();
    expect(result.expired).toEqual(['expired']);
    expect(unpin).toHaveBeenCalledWith('expired', expect.stringMatching(/^internal-api:/));
    expect(unpin).not.toHaveBeenCalledWith('alive', expect.anything());
    expect(mgr.getPinnedUntil('expired')).toBeUndefined();
    expect(mgr.getPinnedUntil('alive')).toBeDefined();
  });

  it('clear() removes the ledger record (used on manual unpin / session delete)', async () => {
    const mgr = makeManager();
    await mgr.init();
    await mgr.applyPin('s6');
    await mgr.clear('s6');
    expect(mgr.getPinnedUntil('s6')).toBeUndefined();
  });

  it('init() re-applies non-expired pins and revokes already-expired ones after a restart', async () => {
    const first = makeManager();
    await first.init();
    await first.applyPin('survives', { ttlSeconds: 3600 });
    await first.applyPin('was-expired', { ttlSeconds: 0 });

    // A brand-new manager on the same dir simulates a restart: in-memory pin
    // state is gone, everything comes from the ledger.
    pin.mockClear();
    unpin.mockClear();
    const restarted = makeManager();
    await restarted.init();

    expect(pin).toHaveBeenCalledWith('survives', expect.stringMatching(/^internal-api:/));
    expect(unpin).toHaveBeenCalledWith('was-expired', expect.stringMatching(/^internal-api:/));
    expect(restarted.getPinnedUntil('survives')).toBeDefined();
    expect(restarted.getPinnedUntil('was-expired')).toBeUndefined();
  });

  it('the periodic sweep revokes expired pins on the timer', async () => {
    vi.useFakeTimers();
    const mgr = makeManager({ intervalMs: 1000 });
    await mgr.init();
    await mgr.applyPin('doomed', { ttlSeconds: 0 });
    unpin.mockClear();
    mgr.start();
    vi.advanceTimersByTime(1000);
    // The sweep is async; let pending microtasks/timers flush.
    await vi.advanceTimersByTimeAsync(0);
    expect(unpin).toHaveBeenCalledWith('doomed', expect.stringMatching(/^internal-api:/));
    mgr.stop();
  });
});
