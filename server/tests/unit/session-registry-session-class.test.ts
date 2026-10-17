/**
 * Contract 1.65.0 (command-centre step 1k) — registry `sessionClass`.
 *
 * The registry records a session's class ONCE, at creation. The only stored
 * value is "validation"; absence means "not validation". "child" is NEVER
 * stored — readers derive it from the existing parentSessionId link — and a
 * recorded class can never be cleared or changed by a later upsert.
 */
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SessionRegistryManager } from '../../src/session-registry.js';

describe('registry sessionClass (contract 1.65.0)', () => {
  let dir: string;
  let file: string;
  let reg: SessionRegistryManager;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-registry-class-'));
    file = path.join(dir, 'registry.json');
    reg = new SessionRegistryManager(file);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('stores sessionClass "validation" on create and survives reload', async () => {
    await reg.upsert({ id: 'v-1', sdkType: 'claude', cwd: '/tmp', sessionClass: 'validation' });
    await reg.upsert({ id: 'r-1', sdkType: 'claude', cwd: '/tmp' });
    const reloaded = new SessionRegistryManager(file);
    expect((await reloaded.get('v-1'))?.sessionClass).toBe('validation');
    expect((await reloaded.get('r-1'))?.sessionClass).toBeUndefined();
  });

  it('never clears or changes a recorded class on merge (recorded once at creation)', async () => {
    await reg.upsert({ id: 'v-1', sdkType: 'claude', cwd: '/tmp', sessionClass: 'validation' });
    // A later upsert with the field absent must not clear it…
    await reg.upsert({ id: 'v-1', sdkType: 'claude', cwd: '/tmp/other', model: 'sonnet' });
    expect((await reg.get('v-1'))?.sessionClass).toBe('validation');
    // …and an explicit undefined value must not clear it either.
    await reg.upsert({ id: 'v-1', sdkType: 'claude', cwd: '/tmp/other', sessionClass: undefined });
    expect((await reg.get('v-1'))?.sessionClass).toBe('validation');
    // Once recorded, the value is immutable: the registry accepts no other
    // stored value, so "change" is not expressible — but a merge carrying the
    // same literal keeps it.
    await reg.upsert({ id: 'v-1', sdkType: 'claude', cwd: '/tmp/other', sessionClass: 'validation' });
    expect((await reg.get('v-1'))?.sessionClass).toBe('validation');
  });

  it('never introduces a class on merge for an unclassed session', async () => {
    await reg.upsert({ id: 'r-1', sdkType: 'claude', cwd: '/tmp' });
    await reg.upsert({ id: 'r-1', sdkType: 'claude', cwd: '/tmp/other', sessionClass: undefined });
    expect((await reg.get('r-1'))?.sessionClass).toBeUndefined();
  });

  it('stays a version-1 registry file (additive field, no version break)', async () => {
    await reg.upsert({ id: 'v-1', sdkType: 'claude', cwd: '/tmp', sessionClass: 'validation' });
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as { version: number; entries: Array<{ id: string; sessionClass?: string }> };
    expect(raw.version).toBe(1);
    const entry = raw.entries.find((e) => e.id === 'v-1');
    expect(entry?.sessionClass).toBe('validation');
  });
});
