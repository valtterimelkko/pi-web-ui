import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { SessionRegistryManager } from '../../src/session-registry.js';

describe('SessionRegistryManager cross-process atomic save', () => {
  let tmpDir: string;
  let registryPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-reg-atomic-test-'));
    registryPath = path.join(tmpDir, 'session-registry.json');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('uses unique temporary filenames so concurrent writes never collide on rename', async () => {
    const reg1 = new SessionRegistryManager(registryPath);
    const reg2 = new SessionRegistryManager(registryPath);

    await Promise.all([
      reg1.upsert({ id: 's1', sdkType: 'pi', path: '/tmp/s1.jsonl', cwd: '/tmp', status: 'idle' }),
      reg2.upsert({ id: 's2', sdkType: 'claude', path: 's2', cwd: '/tmp', status: 'idle' }),
    ]);

    const content = await fs.readFile(registryPath, 'utf-8');
    expect(() => JSON.parse(content)).not.toThrow();
  });
});
