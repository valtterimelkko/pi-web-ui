import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createAgentSession, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { resolvePlacementConfig } from '../../../src/placement/config.js';
import { resetAppliedPlacement, applyStartupPlacement } from '../../../src/placement/apply-startup.js';
import { createPlacementBashToolDefinition, createPlacementSpawnHook, PLACEMENT_ENV_KEYS } from '../../../src/placement/bash-tool.js';
import { createBashToolDefinition } from '@earendil-works/pi-coding-agent';

const GiB = 1024 * 1024 * 1024;

function placementOn() {
  return resolvePlacementConfig({
    PI_TOOLS_PLACEMENT: 'on',
    PI_TOOLS_CGROUP_ROOT: '/tmp/d0-fake-cg',
    PI_TOOLS_SLICE: '/tmp/d0-fake-cg/t.slice',
    PI_TOOLS_RUNTIME_DIR: '/tmp/d0-rt-bash',
  });
}

const ON = placementOn();

function ensureFakeRoot(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'cgroup.controllers'), 'cpu memory pids\n');
  fs.writeFileSync(path.join(root, 'memory.max'), '1073741824\n');
  fs.writeFileSync(path.join(root, 'memory.high'), '805306368\n');
}

describe('placement bash tool (SDK-equivalence and upstream alarm)', () => {
  beforeEach(() => {
    ensureFakeRoot('/tmp/d0-fake-cg/t.slice');
    applyStartupPlacement(ON);
  });
  const agentDir = mkdtempSync(path.join(tmpdir(), 'd0-agentdir-'));
  afterAll(() => rmSync(agentDir, { recursive: true, force: true }));

  it('keeps the built-in name, parameter schema, description and truncation contract', () => {
    const builtin = createBashToolDefinition('/tmp', {});
    const ours = createPlacementBashToolDefinition({ cfg: ON, sessionId: 's1', settings: undefined, cwd: '/tmp' });
    expect(ours.name).toBe(builtin.name);
    expect(ours.description).toBe(builtin.description);
    expect(JSON.stringify(ours.parameters)).toBe(JSON.stringify(builtin.parameters));
    expect(ours.promptSnippet).toBe(builtin.promptSnippet);
  });

  it('when placement is off the hook is the identity (byte-identical command/env)', () => {
    const off = resolvePlacementConfig({});
    const hook = createPlacementSpawnHook(off, 's1');
    const ctx = { command: 'ls', cwd: '/tmp', env: {} as NodeJS.ProcessEnv };
    const out = hook(ctx);
    expect(out).toBe(ctx);
  });

  it('spawnHook injects the session group env and placement prefix when enabled', () => {
    const hook = createPlacementSpawnHook(ON, 'abc');
    const ctx = { command: 'ls -la', cwd: '/tmp', env: {} as NodeJS.ProcessEnv };
    const out = hook(ctx);
    for (const key of PLACEMENT_ENV_KEYS) expect(out.env).toHaveProperty(key);
    expect(out.env.PI_TOOLS_GROUP).toContain('abc');
    expect(out.command.startsWith('{')).toBe(true);
    expect(out.command).toContain('cgroup.procs');
    expect(out.command.endsWith('ls -la')).toBe(true);
  });

  it('UPSTREAM ALARM: the session activates OUR bash tool via customTools, not the built-in', async () => {
    const ours = createPlacementBashToolDefinition({ cfg: ON, sessionId: 'alarm-1', settings: undefined, cwd: agentDir });
    const settingsManager = SettingsManager.create(agentDir, agentDir);
    const { session } = await createAgentSession({
      cwd: agentDir,
      agentDir,
      sessionManager: SessionManager.inMemory(),
      settingsManager,
      customTools: [ours],
    });
    expect(session.getActiveToolNames()).toContain('bash');
    const active = session.getToolDefinition('bash');
    expect(active).toBeDefined();
    expect(active).toBe(ours); // identity: if a future SDK stops letting customTools override, this fails loudly
    session.dispose();
  }, 60_000);

  it('UPSTREAM ALARM SANITY: without customTools the active bash is NOT ours (the alarm can actually fire)', async () => {
    const ours = createPlacementBashToolDefinition({ cfg: ON, sessionId: 'alarm-2', settings: undefined, cwd: agentDir });
    const settingsManager = SettingsManager.create(agentDir, agentDir);
    const { session } = await createAgentSession({
      cwd: agentDir,
      agentDir,
      sessionManager: SessionManager.inMemory(),
      settingsManager,
    });
    const active = session.getToolDefinition('bash');
    expect(active).toBeDefined();
    expect(active).not.toBe(ours);
    session.dispose();
  }, 60_000);
});
