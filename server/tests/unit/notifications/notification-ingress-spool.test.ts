import { lstat, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotificationIngressSpool } from '../../../src/notifications/notification-ingress-spool.js';

const NOW = Date.parse('2026-07-16T12:00:00.000Z');

function record(idempotencyKey = 'key-1') {
  return {
    version: 1,
    idempotencyKey,
    title: 'Deploy complete',
    body: 'All checks passed.',
    createdAt: new Date(NOW - 1000).toISOString(),
    expiresAt: new Date(NOW + 60_000).toISOString(),
  };
}

describe('NotificationIngressSpool', () => {
  let dir: string;
  let spool: NotificationIngressSpool;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pi-notification-ingress-'));
    spool = new NotificationIngressSpool(dir, { now: () => NOW, maxFiles: 10, maxFileBytes: 4096 });
    await spool.init();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('atomically claims a valid record and removes it only after completion', async () => {
    await writeFile(join(dir, 'one.json'), JSON.stringify(record()), { mode: 0o600 });

    const claims = await spool.claimBatch();
    expect(claims).toHaveLength(1);
    expect(claims[0].record.idempotencyKey).toBe('key-1');
    expect(claims[0].claimedPath).toContain('.processing-');
    expect((await lstat(claims[0].claimedPath)).isFile()).toBe(true);

    await spool.complete(claims[0]);
    expect(await readdir(dir)).toEqual([]);
  });

  it('recovers a processing file left by a crashed prior process', async () => {
    await writeFile(join(dir, '.processing-999-deadbeef-one.json'), JSON.stringify(record('recover')), { mode: 0o600 });

    await spool.init();
    const claims = await spool.claimBatch();

    expect(claims).toHaveLength(1);
    expect(claims[0].record.idempotencyKey).toBe('recover');
  });

  it('recovers a crashed claim without overwriting a newer same-name record', async () => {
    await writeFile(join(dir, 'one.json'), JSON.stringify(record('newer')), { mode: 0o600 });
    await writeFile(join(dir, '.processing-999-deadbeef-one.json'), JSON.stringify(record('older')), { mode: 0o600 });

    await spool.init();
    const claims = await spool.claimBatch();

    expect(claims.map((claim) => claim.record.idempotencyKey).sort()).toEqual(['newer', 'older']);
  });

  it('rejects malformed, expired, oversized, and symlink entries without following them', async () => {
    await writeFile(join(dir, 'malformed.json'), '{bad', { mode: 0o600 });
    await writeFile(join(dir, 'expired.json'), JSON.stringify({
      ...record('expired'),
      expiresAt: new Date(NOW - 1).toISOString(),
    }), { mode: 0o600 });
    await writeFile(join(dir, 'oversized.json'), 'x'.repeat(5000), { mode: 0o600 });
    const outside = join(dir, '..', `outside-${process.pid}.json`);
    await writeFile(outside, JSON.stringify(record('outside')), { mode: 0o600 });
    await symlink(outside, join(dir, 'link.json'));

    const claims = await spool.claimBatch();

    expect(claims).toEqual([]);
    expect((await readdir(dir)).filter((name) => name.endsWith('.json'))).toEqual([]);
    await rm(outside, { force: true });
  });

  it('bounds one drain batch even when more files are present', async () => {
    for (let i = 0; i < 12; i += 1) {
      await writeFile(join(dir, `${i}.json`), JSON.stringify(record(`key-${i}`)), { mode: 0o600 });
    }

    const claims = await spool.claimBatch();

    expect(claims).toHaveLength(10);
  });
});
