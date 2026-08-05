import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  PlainWorkerLauncher,
  TransientSystemdWorkerLauncher,
} from '../../../src/workers/worker-launcher.js';

function fakeChild(pid = 4321): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    pid,
    stdin: new EventEmitter(),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(() => true),
  });
  return child;
}

describe('PlainWorkerLauncher', () => {
  it('launches the server-selected executable and reports the child as the resource owner', async () => {
    const child = fakeChild();
    const spawnProcess = vi.fn((_command: string, _args: readonly string[], _options: SpawnOptions) => child);
    const readFile = vi.fn(async (file: string) => {
      if (file === '/proc/4321/task/4321/children') return '4330\n';
      if (file === '/proc/4330/task/4330/children') return '\n';
      if (file === '/proc/4321/status') return 'Name:\tfixture\nVmRSS:\t1024 kB\n';
      if (file === '/proc/4330/status') return 'Name:\thelper\nVmRSS:\t2048 kB\n';
      throw new Error(`unexpected read: ${file}`);
    });
    const launcher = new PlainWorkerLauncher({ spawnProcess, readFile });

    const handle = await launcher.launch({
      executable: '/opt/pi/bin/pi',
      args: ['--mode', 'rpc', '--session', '/tmp/session.jsonl'],
      env: { NODE_OPTIONS: '--max-old-space-size=128' },
    });

    expect(spawnProcess).toHaveBeenCalledWith(
      '/opt/pi/bin/pi',
      ['--mode', 'rpc', '--session', '/tmp/session.jsonl'],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
    );
    expect(handle.process).toBe(child);
    expect(handle.resourceIdentity).toEqual({
      kind: 'plain',
      mainPid: 4321,
      launcherPid: 4321,
    });
    expect(await handle.snapshot()).toMatchObject({
      populated: true,
      memberPids: [4321, 4330],
      memoryCurrentBytes: 3 * 1024 * 1024,
      pidsCurrent: 2,
    });
  });

  it('rejects heavy assignments unless explicitly configured as the frozen baseline', async () => {
    const spawnProcess = vi.fn(() => fakeChild());
    const spec = {
      executable: '/usr/bin/node', args: [], env: {},
      assignment: {
        sessionId: 'session-1', sessionPath: '/tmp/session.jsonl', runId: 'run-1',
        executionInstanceId: 'phase6-v1', attemptEpoch: 1, profile: 'heavy' as const,
      },
    };
    await expect(new PlainWorkerLauncher({ spawnProcess }).launch(spec)).rejects.toThrow(/require containment/i);
    await expect(new PlainWorkerLauncher({ spawnProcess, allowHeavyBaseline: true }).launch(spec)).resolves.toBeDefined();
  });
});

describe('TransientSystemdWorkerLauncher', () => {
  it('reports the transient service MainPID and observed cgroup instead of the systemd-run client PID', async () => {
    const launcherClient = fakeChild(1111);
    let launchTokenEntry = '';
    const spawnProcess = vi.fn((_command: string, args: readonly string[]) => {
      launchTokenEntry = args.find((arg) => arg.startsWith('--setenv=PI_WEB_UI_WORKER_LAUNCH_TOKEN='))?.slice('--setenv='.length) ?? '';
      return launcherClient;
    });
    const execFile = vi.fn(async (_command: string, args: readonly string[]) => {
      expect(args[0]).toBe('show');
      if (args.includes('LoadState') && !args.includes('MainPID')) return { stdout: 'LoadState=not-found\n' };
      const properties = [
        'MainPID=2222',
        'InvocationID=0123456789abcdef0123456789abcdef',
        'ControlGroup=/pi.slice/pi-web.slice/pi-web-ui.slice/pi-web-ui-phase6.slice/pi-web-ui-phase6-abc123.slice/pi-web-ui-phase6-abc123-worker-1a08e84c.service',
        'Slice=pi-web-ui-phase6-abc123.slice',
        'MemoryHigh=134217728',
        'MemoryMax=402653184',
        'MemorySwapMax=0',
        'TasksMax=64',
        'CPUWeight=100',
        'KillMode=control-group',
      ];
      if (args.includes('TimeoutStopUSec')) properties.push('TimeoutStopUSec=10s');
      if (args.includes('CPUQuotaPerSecUSec')) properties.push('CPUQuotaPerSecUSec=infinity');
      return { stdout: properties.join('\n') };
    });
    const readFile = vi.fn(async (file: string) => {
      if (file === '/proc/2222/cgroup') {
        return '0::/pi.slice/pi-web.slice/pi-web-ui.slice/pi-web-ui-phase6.slice/pi-web-ui-phase6-abc123.slice/pi-web-ui-phase6-abc123-worker-1a08e84c.service\n';
      }
      if (file === '/proc/2222/environ') return `PATH=/usr/bin\0${launchTokenEntry}\0`;
      if (file.endsWith('/memory.current')) return '1048576\n';
      if (file.endsWith('/memory.events')) return 'low 0\nhigh 2\nmax 0\noom 0\noom_kill 0\n';
      if (file.endsWith('/pids.current')) return '5\n';
      if (file.endsWith('/pids.events')) return 'max 1\n';
      if (file.endsWith('/cgroup.procs')) return '2222\n2223\n';
      if (file.endsWith('/cgroup.events')) return 'populated 1\nfrozen 0\n';
      throw new Error(`unexpected read: ${file}`);
    });
    const launcher = new TransientSystemdWorkerLauncher({
      nonce: 'abc123',
      spawnProcess,
      execFile,
      readFile,
      pollIntervalMs: 1,
      identityTimeoutMs: 100,
    });

    const handle = await launcher.launch({
      executable: '/usr/bin/node',
      args: ['/tmp/fixture.js'],
      env: { NODE_OPTIONS: '--max-old-space-size=128' },
      assignment: {
        sessionId: 'fixture-session',
        sessionPath: '/tmp/fixture.jsonl',
        runId: 'run-1',
        executionInstanceId: 'phase6-v1',
        attemptEpoch: 1,
        profile: 'heavy',
      },
    });

    expect(handle.resourceIdentity).toMatchObject({
      kind: 'systemd-transient',
      mainPid: 2222,
      launcherPid: 1111,
      cgroupPath: '/pi.slice/pi-web.slice/pi-web-ui.slice/pi-web-ui-phase6.slice/pi-web-ui-phase6-abc123.slice/pi-web-ui-phase6-abc123-worker-1a08e84c.service',
      sliceName: 'pi-web-ui-phase6-abc123.slice',
      observedProperties: expect.objectContaining({
        TimeoutStopUSec: '10s',
        CPUQuotaPerSecUSec: 'infinity',
      }),
    });
    expect(handle.resourceIdentity.mainPid).not.toBe(handle.resourceIdentity.launcherPid);
    expect(await handle.snapshot()).toMatchObject({
      populated: true,
      memberPids: [2222, 2223],
      memoryCurrentBytes: 1048576,
      memoryEvents: { high: 2, max: 0, oom: 0, oom_kill: 0 },
      pidsCurrent: 5,
      pidsEvents: { max: 1 },
    });
    expect(spawnProcess).toHaveBeenCalledWith(
      'systemd-run',
      expect.arrayContaining([
        '--pipe', '--wait', '--collect',
        '--property=MemoryHigh=128M',
        '--property=MemoryMax=384M',
        '--property=MemorySwapMax=0',
        '--property=TasksMax=64',
        '--property=CPUWeight=100',
        '--property=KillMode=control-group',
        '--property=TimeoutStopSec=10s',
      ]),
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
    );
  });

  it('fails closed before spawn when the exact generation unit already exists', async () => {
    const spawnProcess = vi.fn();
    const execFile = vi.fn(async () => ({ stdout: 'LoadState=loaded\n' }));
    const launcher = new TransientSystemdWorkerLauncher({ nonce: 'abc123', spawnProcess, execFile });

    await expect(launcher.launch({
      executable: '/usr/bin/node', args: [], env: {},
      assignment: {
        sessionId: 'fixture-session', sessionPath: '/tmp/fixture.jsonl', runId: 'run-1',
        executionInstanceId: 'phase6-v1', attemptEpoch: 1, profile: 'heavy',
      },
    })).rejects.toThrow(/generation unit already exists/i);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('stops and collects an exact failed launch unit even when systemd never assigned a MainPID', async () => {
    const launcherClient = fakeChild(6001);
    const unitName = 'pi-web-ui-phase6-abc123-worker-1a08e84c.service';
    const sliceName = 'pi-web-ui-phase6-abc123.slice';
    const calls: string[][] = [];
    const execFile = vi.fn(async (_command: string, args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === 'stop') return { stdout: '' };
      if (args.includes('LoadState') && !args.includes('MainPID')) return { stdout: 'LoadState=not-found\n' };
      const invocation = args.includes('InvocationID')
        ? 'InvocationID=0123456789abcdef0123456789abcdef\n'
        : '';
      return { stdout: `LoadState=failed\n${invocation}MainPID=0\nSlice=${sliceName}\nControlGroup=\n` };
    });
    const launcher = new TransientSystemdWorkerLauncher({
      nonce: 'abc123', spawnProcess: vi.fn(() => launcherClient), execFile,
      pollIntervalMs: 1, identityTimeoutMs: 5,
    });

    await expect(launcher.launch({
      executable: '/usr/bin/node', args: [], env: {},
      assignment: {
        sessionId: 'fixture-session', sessionPath: '/tmp/fixture.jsonl', runId: 'run-1',
        executionInstanceId: 'phase6-v1', attemptEpoch: 1, profile: 'heavy',
      },
    })).rejects.toThrow(/MainPID|identity/i);
    expect(calls.some((args) => args[0] === 'stop' && args[1] === unitName)).toBe(true);
  });

  it('refuses failed-MainPID cleanup when InvocationID changes before stop', async () => {
    const launcherClient = fakeChild(6101);
    const sliceName = 'pi-web-ui-phase6-abc123.slice';
    const execFile = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args[0] === 'stop') return { stdout: '' };
      if (args.includes('LoadState') && !args.includes('MainPID')) return { stdout: 'LoadState=not-found\n' };
      const invocation = args.includes('Slice')
        ? '0123456789abcdef0123456789abcdef'
        : 'ffffffffffffffffffffffffffffffff';
      return { stdout: `LoadState=failed\nInvocationID=${invocation}\nMainPID=0\nSlice=${sliceName}\nControlGroup=\n` };
    });
    const launcher = new TransientSystemdWorkerLauncher({
      nonce: 'abc123', spawnProcess: vi.fn(() => launcherClient), execFile,
      pollIntervalMs: 1, identityTimeoutMs: 5,
    });

    await expect(launcher.launch({
      executable: '/usr/bin/node', args: [], env: {},
      assignment: {
        sessionId: 'fixture-session', sessionPath: '/tmp/fixture.jsonl', runId: 'run-1',
        executionInstanceId: 'phase6-v1', attemptEpoch: 1, profile: 'heavy',
      },
    })).rejects.toThrow(/reconciliation also failed/i);
    expect(execFile).not.toHaveBeenCalledWith('systemctl', expect.arrayContaining(['stop']));
  });

  it('reconciles its exact nonce unit when post-launch property observation fails', async () => {
    const launcherClient = fakeChild(5001);
    const unitName = 'pi-web-ui-phase6-abc123-worker-3209dce9.service';
    const sliceName = 'pi-web-ui-phase6-abc123.slice';
    const cgroupPath = `/x/${sliceName}/${unitName}`;
    let launchTokenEntry = '';
    const calls: string[][] = [];
    const execFile = vi.fn(async (_command: string, args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === 'stop') return { stdout: '' };
      if (args.includes('LoadState') && !args.includes('MainPID')) return { stdout: 'LoadState=not-found\n' };
      return { stdout: [
        'MainPID=5002', 'InvocationID=0123456789abcdef0123456789abcdef', `Slice=${sliceName}`, `ControlGroup=${cgroupPath}`,
        'MemoryHigh=1', 'MemoryMax=402653184', 'MemorySwapMax=0',
        'TasksMax=64', 'CPUWeight=100', 'KillMode=control-group',
      ].join('\n') };
    });
    const readFile = vi.fn(async (file: string) => {
      if (file === '/proc/5002/cgroup') return `0::${cgroupPath}\n`;
      if (file === '/proc/5002/environ') return `${launchTokenEntry}\0`;
      if (file.endsWith('/cgroup.events')) return 'populated 0\n';
      if (file.endsWith('/cgroup.procs')) return '';
      throw new Error(`unexpected read ${file}`);
    });
    const launcher = new TransientSystemdWorkerLauncher({
      nonce: 'abc123', spawnProcess: vi.fn((_command, args) => {
        launchTokenEntry = args.find((arg) => arg.startsWith('--setenv=PI_WEB_UI_WORKER_LAUNCH_TOKEN='))?.slice('--setenv='.length) ?? '';
        return launcherClient;
      }), execFile, readFile,
      pollIntervalMs: 1, identityTimeoutMs: 5,
    });

    await expect(launcher.launch({
      executable: '/usr/bin/node', args: [], env: {},
      assignment: {
        sessionId: 'fixture-session', sessionPath: '/tmp/session.jsonl', runId: 'run-1',
        executionInstanceId: 'phase6-v1', attemptEpoch: 1, profile: 'heavy',
      },
    })).rejects.toThrow(/MemoryHigh/i);
    expect(calls.some((args) => args[0] === 'stop' && args[1] === unitName)).toBe(true);
  });

  it('rejects non-canonical persisted cgroup paths before filesystem or systemctl access', async () => {
    const execFile = vi.fn();
    const launcher = new TransientSystemdWorkerLauncher({ nonce: 'abc123', execFile });
    await expect(launcher.reconcile({
      kind: 'systemd-transient', mainPid: 42, launcherPid: 41,
      unitName: 'pi-web-ui-phase6-abc123-worker-deadbeef.service',
      sliceName: 'pi-web-ui-phase6-abc123.slice',
      cgroupPath: '/x/pi-web-ui-phase6-abc123.slice/../pi-web-ui-phase6-abc123.slice/pi-web-ui-phase6-abc123-worker-deadbeef.service',
      launchTokenSha256: '0'.repeat(64), observedProperties: {},
    })).rejects.toThrow(/canonical|nonce-owned/i);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('rejects reconciliation of a resource identity outside its nonce-owned slice', async () => {
    const execFile = vi.fn();
    const launcher = new TransientSystemdWorkerLauncher({ nonce: 'abc123', execFile });
    await expect(launcher.reconcile({
      kind: 'systemd-transient', mainPid: 42, launcherPid: 41,
      unitName: 'pi-web-ui-phase6-foreign-worker-deadbeef.service',
      sliceName: 'pi-web-ui-phase6-foreign.slice',
      cgroupPath: '/x/pi-web-ui-phase6-foreign.slice/pi-web-ui-phase6-foreign-worker-deadbeef.service',
      launchTokenSha256: '0'.repeat(64), observedProperties: {},
    })).rejects.toThrow(/nonce-owned/i);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('reconciles a crashed worker whose exact unit was already collected', async () => {
    const unitName = 'pi-web-ui-phase6-abc123-worker-deadbeef.service';
    const sliceName = 'pi-web-ui-phase6-abc123.slice';
    const cgroupPath = `/x/${sliceName}/${unitName}`;
    const execFile = vi.fn(async () => ({ stdout: 'LoadState=not-found\nMainPID=0\nControlGroup=\n' }));
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const launcher = new TransientSystemdWorkerLauncher({
      nonce: 'abc123', execFile, readFile: vi.fn(async () => { throw missing; }),
      pollIntervalMs: 1, identityTimeoutMs: 20,
    });

    await expect(launcher.reconcile({
      kind: 'systemd-transient', mainPid: 5002, launcherPid: 5001,
      unitName, sliceName, cgroupPath, launchTokenSha256: '0'.repeat(64),
      observedProperties: { InvocationID: '0123456789abcdef0123456789abcdef' },
    })).resolves.toEqual({ workerStopped: true, cgroupEmpty: true, unitCollected: true });
    expect(execFile).not.toHaveBeenCalledWith('systemctl', ['stop', unitName]);
  });

  it('refuses teardown when the loaded unit InvocationID no longer matches the observed generation', async () => {
    const unitName = 'pi-web-ui-phase6-abc123-worker-deadbeef.service';
    const sliceName = 'pi-web-ui-phase6-abc123.slice';
    const cgroupPath = `/x/${sliceName}/${unitName}`;
    const execFile = vi.fn(async () => ({
      stdout: `LoadState=loaded\nInvocationID=ffffffffffffffffffffffffffffffff\nMainPID=5002\nControlGroup=${cgroupPath}\n`,
    }));
    const launcher = new TransientSystemdWorkerLauncher({
      nonce: 'abc123', execFile,
      readFile: vi.fn(async (file: string) => file.endsWith('/environ') ? 'PI_WEB_UI_WORKER_LAUNCH_TOKEN=wrong\0' : ''),
    });

    await expect(launcher.reconcile({
      kind: 'systemd-transient', mainPid: 5002, launcherPid: 5001,
      unitName, sliceName, cgroupPath, launchTokenSha256: '0'.repeat(64),
      observedProperties: { InvocationID: '0123456789abcdef0123456789abcdef' },
    })).rejects.toThrow(/identity changed/i);
    expect(execFile).not.toHaveBeenCalledWith('systemctl', ['stop', unitName]);
  });

  it('stops only its observed nonce-owned unit and verifies the cgroup becomes empty', async () => {
    const launcherClient = fakeChild(3111);
    let launchTokenEntry = '';
    const unitName = 'pi-web-ui-phase6-def456-worker-1a08e84c.service';
    const cgroupPath = `/pi-web-ui-phase6-def456.slice/${unitName}`;
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const execFile = vi.fn(async (command: string, args: readonly string[]) => {
      calls.push({ command, args });
      if (args[0] === 'stop') return { stdout: '' };
      if (args.includes('LoadState') && !args.includes('MainPID')) return { stdout: 'LoadState=not-found\n' };
      return {
        stdout: [
          'MainPID=3222', 'InvocationID=0123456789abcdef0123456789abcdef', `ControlGroup=${cgroupPath}`, 'Slice=pi-web-ui-phase6-def456.slice',
          'MemoryHigh=134217728', 'MemoryMax=402653184', 'MemorySwapMax=0',
          'TasksMax=64', 'CPUWeight=100', 'KillMode=control-group',
          'TimeoutStopUSec=10s', 'CPUQuotaPerSecUSec=infinity',
        ].join('\n'),
      };
    });
    const readFile = vi.fn(async (file: string) => {
      if (file === '/proc/3222/cgroup') return `0::${cgroupPath}\n`;
      if (file === '/proc/3222/environ') return `${launchTokenEntry}\0`;
      if (file.endsWith('/cgroup.events')) return 'populated 0\nfrozen 0\n';
      if (file.endsWith('/cgroup.procs')) return '';
      throw new Error(`unexpected read: ${file}`);
    });
    const launcher = new TransientSystemdWorkerLauncher({
      nonce: 'def456', spawnProcess: vi.fn((_command, args) => {
        launchTokenEntry = args.find((arg) => arg.startsWith('--setenv=PI_WEB_UI_WORKER_LAUNCH_TOKEN='))?.slice('--setenv='.length) ?? '';
        return launcherClient;
      }), execFile, readFile,
      pollIntervalMs: 1, identityTimeoutMs: 100,
    });
    const handle = await launcher.launch({
      executable: '/usr/bin/node', args: ['/tmp/fixture.js'], env: {},
      assignment: {
        sessionId: 'fixture-session', sessionPath: '/tmp/fixture.jsonl', runId: 'run-1',
        executionInstanceId: 'phase6-v1', attemptEpoch: 1, profile: 'heavy',
      },
    });

    await handle.terminate();

    expect(calls.some((call) => call.args[0] === 'stop' && call.args[1] === unitName)).toBe(true);
    expect(calls.some((call) => call.args[0] === 'show' && call.args.includes('LoadState'))).toBe(true);
    expect(readFile).toHaveBeenCalledWith(`/sys/fs/cgroup${cgroupPath}/cgroup.events`);
    expect(readFile).toHaveBeenCalledWith(`/sys/fs/cgroup${cgroupPath}/cgroup.procs`);
  });
});
