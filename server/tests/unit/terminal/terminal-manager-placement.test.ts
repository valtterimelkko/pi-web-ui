import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  applyStartupPlacement,
  resetAppliedPlacement,
  resolvePlacementConfig,
} from '../../../src/placement/index.js';

const mockSpawnCalls: Array<{ file: string; args: string[]; options: any }> = [];
let exitHandler: ((e: { exitCode: number; signal?: number }) => void) | null = null;

const mockPtyProcess = {
  pid: 4321,
  onData: vi.fn(),
  onExit: vi.fn((cb: (e: { exitCode: number; signal?: number }) => void) => {
    exitHandler = cb;
  }),
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
};

vi.mock('node-pty', () => ({
  default: {
    spawn: vi.fn((file: string, args: string[], options: any) => {
      mockSpawnCalls.push({ file, args, options });
      return mockPtyProcess;
    }),
  },
  spawn: vi.fn((file: string, args: string[], options: any) => {
    mockSpawnCalls.push({ file, args, options });
    return mockPtyProcess;
  }),
}));

import { TerminalManager } from '../../../src/terminal/terminal-manager.js';

describe('TerminalManager placement in tools slice', () => {
  let manager: TerminalManager;
  let tmpDir: string;
  let toolsRoot: string;
  let runtimeDir: string;

  beforeEach(() => {
    mockSpawnCalls.length = 0;
    exitHandler = null;
    resetAppliedPlacement();
    for (const k of [
      'PI_TOOLS_CG', 'PI_TOOLS_ROOT', 'PI_TOOLS_GROUP', 'PI_TOOLS_MEM_MAX', 'PI_TOOLS_MEM_HIGH',
      'PI_TOOLS_PIDS_MAX', 'PI_TOOLS_SWAP_MAX', 'PI_TOOLS_SHELL', 'PI_TOOLS_DEGRADE_FILE',
    ]) {
      delete process.env[k];
    }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term-placement-test-'));
    toolsRoot = path.join(tmpDir, 'tools-root');
    runtimeDir = path.join(tmpDir, 'runtime');
    fs.mkdirSync(toolsRoot, { recursive: true });
    fs.mkdirSync(runtimeDir, { recursive: true });
    // Write fake cgroup.controllers
    fs.writeFileSync(path.join(toolsRoot, 'cgroup.controllers'), 'memory pids\n');
    fs.writeFileSync(path.join(toolsRoot, 'cgroup.subtree_control'), 'memory pids\n');
    fs.writeFileSync(path.join(toolsRoot, 'memory.max'), '10737418240\n');
    manager = new TerminalManager();
  });

  afterEach(() => {
    manager.destroyAll();
    resetAppliedPlacement();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('spawns the shell directly when placement is not active', async () => {
    const result = await manager.create('client-unplaced', '/tmp', 80, 24);
    expect(result.success).toBe(true);
    expect(mockSpawnCalls).toHaveLength(1);

    const call = mockSpawnCalls[0];
    const expectedShell = process.env.SHELL || '/bin/bash';
    expect(call.file).toBe(expectedShell);
    expect(call.args).toEqual([]);
    expect(call.options.env.PI_TOOLS_CG).toBeUndefined();
  });

  it('spawns through the placement wrapper in an own- group when placement is active', async () => {
    const cfg = resolvePlacementConfig({
      PI_TOOLS_PLACEMENT: 'on',
      PI_TOOLS_CGROUP_ROOT: tmpDir,
      PI_TOOLS_SLICE: toolsRoot,
      PI_TOOLS_RUNTIME_DIR: runtimeDir,
    });
    applyStartupPlacement(cfg, {
      systemctlShow: () => toolsRoot,
      verifyCgroupRoot: () => true,
      enableSubtreeControllers: () => true,
    });

    const result = await manager.create('client-placed', '/tmp', 80, 24);
    expect(result.success).toBe(true);
    expect(mockSpawnCalls).toHaveLength(1);

    const call = mockSpawnCalls[0];
    const expectedShell = process.env.SHELL || '/bin/bash';
    // When placed, wrapper executable is spawned with [shell] as argv
    expect(call.file).toContain('placement-wrapper.sh');
    expect(call.args).toEqual([expectedShell]);
    expect(call.options.env.PI_TOOLS_CG).toBeDefined();
    expect(call.options.env.PI_TOOLS_CG).toContain(toolsRoot);
    expect(call.options.env.PI_TOOLS_CG).toMatch(/\/own-[0-9a-f]+$/);
    expect(call.options.env.PI_TOOLS_ROOT).toBe(toolsRoot);
  });

  it('invokes group cleanup when the placed terminal process exits', async () => {
    // Simulate cgroupfs rmdir where virtual files disappear with directory removal
    const rmdirSpy = vi.spyOn(fs, 'rmdirSync').mockImplementation((p) => {
      fs.rmSync(p, { recursive: true, force: true });
    });

    const cfg = resolvePlacementConfig({
      PI_TOOLS_PLACEMENT: 'on',
      PI_TOOLS_CGROUP_ROOT: tmpDir,
      PI_TOOLS_SLICE: toolsRoot,
      PI_TOOLS_RUNTIME_DIR: runtimeDir,
    });
    applyStartupPlacement(cfg, {
      systemctlShow: () => toolsRoot,
      verifyCgroupRoot: () => true,
      enableSubtreeControllers: () => true,
    });

    await manager.create('client-exit', '/tmp', 80, 24);
    const call = mockSpawnCalls[0];
    const groupPath = call.options.env.PI_TOOLS_CG;
    fs.mkdirSync(groupPath, { recursive: true });
    expect(fs.existsSync(groupPath)).toBe(true);

    // Simulate process exit
    expect(exitHandler).toBeDefined();
    exitHandler!({ exitCode: 0 });

    expect(rmdirSpy).toHaveBeenCalledWith(groupPath);
    expect(fs.existsSync(groupPath)).toBe(false);
  });

  it('invokes group cleanup when placed terminal is destroyed', async () => {
    const rmdirSpy = vi.spyOn(fs, 'rmdirSync').mockImplementation((p) => {
      fs.rmSync(p, { recursive: true, force: true });
    });

    const cfg = resolvePlacementConfig({
      PI_TOOLS_PLACEMENT: 'on',
      PI_TOOLS_CGROUP_ROOT: tmpDir,
      PI_TOOLS_SLICE: toolsRoot,
      PI_TOOLS_RUNTIME_DIR: runtimeDir,
    });
    applyStartupPlacement(cfg, {
      systemctlShow: () => toolsRoot,
      verifyCgroupRoot: () => true,
      enableSubtreeControllers: () => true,
    });

    await manager.create('client-destroy', '/tmp', 80, 24);
    const call = mockSpawnCalls[0];
    const groupPath = call.options.env.PI_TOOLS_CG;
    fs.mkdirSync(groupPath, { recursive: true });
    expect(fs.existsSync(groupPath)).toBe(true);

    manager.destroy('client-destroy');

    expect(rmdirSpy).toHaveBeenCalledWith(groupPath);
    expect(fs.existsSync(groupPath)).toBe(false);
  });

  it('falls back to unplaced shell and logs degrade when placed spawn fails', async () => {
    const cfg = resolvePlacementConfig({
      PI_TOOLS_PLACEMENT: 'on',
      PI_TOOLS_CGROUP_ROOT: tmpDir,
      PI_TOOLS_SLICE: toolsRoot,
      PI_TOOLS_RUNTIME_DIR: runtimeDir,
    });
    applyStartupPlacement(cfg, {
      systemctlShow: () => toolsRoot,
      verifyCgroupRoot: () => true,
      enableSubtreeControllers: () => true,
    });

    const ptyMod = (await import('node-pty')).default;
    // Make first spawn call (with wrapper) fail
    vi.mocked(ptyMod.spawn).mockImplementationOnce((file: string, args: string[], options: any) => {
      mockSpawnCalls.push({ file, args, options });
      throw new Error('EACCES: permission denied on wrapper');
    });

    const result = await manager.create('client-fallback', '/tmp', 80, 24);
    expect(result.success).toBe(true);

    // First call was wrapper, second call fell back to raw shell
    expect(mockSpawnCalls).toHaveLength(2);
    expect(mockSpawnCalls[0].file).toContain('placement-wrapper.sh');
    const expectedShell = process.env.SHELL || '/bin/bash';
    expect(mockSpawnCalls[1].file).toBe(expectedShell);
    expect(mockSpawnCalls[1].options.env.PI_TOOLS_CG).toBeUndefined();

    // Check degrade file
    const degradeFile = path.join(runtimeDir, 'degrade.log');
    expect(fs.existsSync(degradeFile)).toBe(true);
    const logContent = fs.readFileSync(degradeFile, 'utf8');
    expect(logContent).toContain('client-fallback');
    expect(logContent).toContain('terminal-spawn-failed');
  });
});
