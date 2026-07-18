import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { readOcConfig, findThinkingOption, getOcSessionId } from '../../../../scripts/validate-thinking-e2e.js';

/**
 * T1: the thinking-validation SCANNER portion (config/registry parsing) is
 * async and safe — no live providers are called. Covers fixture parity,
 * unreadable/missing file handling, and the pure thinking-option finder.
 */
describe('T1: validate-thinking-e2e scanner (async, no live providers)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'thinking-scanner-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('readOcConfig parses a fixture config (async)', async () => {
    const cfgPath = path.join(dir, 'opencode.json');
    await fs.writeFile(
      cfgPath,
      JSON.stringify({
        provider: { zai: { models: { 'glm-5.2': { options: { thinking: { type: 'enabled' } } } } } },
      }),
    );
    const cfg = await readOcConfig(cfgPath);
    expect(findThinkingOption(cfg)).toEqual({ type: 'enabled' });
  });

  it('readOcConfig returns {} for a missing/unreadable file (no throw)', async () => {
    const cfg = await readOcConfig(path.join(dir, 'does-not-exist.json'));
    expect(cfg).toEqual({});
  });

  it('readOcConfig returns {} for invalid JSON (no throw)', async () => {
    const cfgPath = path.join(dir, 'broken.json');
    await fs.writeFile(cfgPath, '{ not valid json');
    const cfg = await readOcConfig(cfgPath);
    expect(cfg).toEqual({});
  });

  it('findThinkingOption returns null when no thinking option is configured', () => {
    expect(findThinkingOption({})).toBeNull();
    expect(findThinkingOption({ provider: { zai: { models: { 'glm-5.2': {} } } } })).toBeNull();
  });

  it('getOcSessionId resolves the OpenCode session id from a registry fixture (async)', async () => {
    const regPath = path.join(dir, 'registry.json');
    await fs.writeFile(
      regPath,
      JSON.stringify({ sessions: [{ id: 'pi-1', opencodeSessionId: 'oc-9' }] }),
    );
    expect(await getOcSessionId('pi-1', regPath)).toBe('oc-9');
    expect(await getOcSessionId('pi-other', regPath)).toBeNull();
  });

  it('getOcSessionId returns null for a missing registry (no throw)', async () => {
    expect(await getOcSessionId('pi-1', path.join(dir, 'nope.json'))).toBeNull();
  });

  it('the scanner stays async: a read yields to the event loop', async () => {
    // A microtask/scheduler tick runs between the readFile call and resolution.
    const cfgPath = path.join(dir, 'opencode.json');
    await fs.writeFile(cfgPath, '{}');
    let ticked = false;
    const p = readOcConfig(cfgPath);
    queueMicrotask(() => { ticked = true; });
    await p;
    expect(ticked).toBe(true);
  });
});
