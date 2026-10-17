import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Step 1j item 2 (m-piweb review finding 3): the direct (non-SDK) Claude
 * backend records `nativeSessionId` from the first-turn `session_init`
 * (claude-service.ts: ~544 rewrite branch, ~548 backfill branch), but no test
 * asserted that registry write — mirroring the SDK test
 * "persists the runtime-reported session id to the registry MID-TURN".
 *
 * The direct backend spawns `claude -p --output-format stream-json` and never
 * pipes stdin (the prompt rides `-p` argv); the harness fakes the child
 * process (same shape as claude-process-pool.test.ts) so the registry write
 * happens on the object the service really drives.
 */
const mocked = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: mocked.spawn, default: { ...actual, spawn: mocked.spawn } };
});

const spawnMock = mocked.spawn;

import { ClaudeService } from '../../../src/claude/claude-service.js';
import { getSessionRegistry } from '../../../src/session-registry.js';

interface FakeProc extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  pid: number;
  kill: ReturnType<typeof vi.fn>;
}

function makeMockProcess(): FakeProc {
  const proc = new EventEmitter() as unknown as FakeProc;
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  proc.pid = 12345;
  // No auto-exit: the test ends the turn explicitly, like the pool harness.
  proc.kill = vi.fn(() => true);
  return proc;
}

const line = JSON.stringify;

describe('ClaudeService direct backend nativeSessionId registry write (first-turn session_init)', () => {
  let tmpDir: string;
  let svc: ClaudeService;
  let fakeProc: FakeProc;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'claude-native-id-'));
    fakeProc = makeMockProcess();
    spawnMock.mockImplementation(() => fakeProc as unknown as ReturnType<typeof spawn>);
    svc = new ClaudeService({
      claudeSessionDir: join(tmpDir, 'sessions'),
      registryPath: join(tmpDir, 'registry.json'),
      useChannel: false,
      useSdk: false,
    });
  });

  afterEach(async () => {
    await svc.stop();
    spawnMock.mockReset();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Run the first turn to its session_init line and assert the registry write
   *  landed MID-TURN (the result has not been written yet, the process is
   *  still "running" on the fake wire). Mirrors the SDK MID-TURN test. */
  async function runFirstTurnToInit(sessionId: string, initSessionId: string) {
    const completion = new Promise<void>((resolve) => {
      void svc.sendPrompt(sessionId, 'hello', () => {}, () => resolve()).catch(() => resolve());
    });

    // The direct backend passes the prompt via `-p` argv, so the CLI writes its
    // stream-json wire right after spawn (stdin is ignored).
    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalled();
    }, { timeout: 3000 });
    fakeProc.stdout.write(line({
      type: 'system', subtype: 'init', model: 'sonnet',
      session_id: initSessionId, tools: [], apiKeySource: 'none',
    }) + '\n');

    // MID-TURN: the result line has not been written; the registry write must
    // already carry nativeSessionId.
    const registry = getSessionRegistry(join(tmpDir, 'registry.json'));
    await vi.waitFor(async () => {
      const entry = await registry.get(sessionId);
      expect(entry?.nativeSessionId).toBe(initSessionId);
    }, { timeout: 3000 });

    // Finish the turn cleanly: result line then process exit.
    fakeProc.stdout.write(line({
      type: 'result', subtype: 'success', is_error: false, result: 'Done',
      session_id: initSessionId, usage: { input_tokens: 1, output_tokens: 1 },
    }) + '\n');
    fakeProc.stdout.end();
    fakeProc.emit('exit', 0, null);
    await completion;
  }

  it('backfills nativeSessionId when session_init confirms the minted id MID-TURN (direct CLI passes --session-id)', async () => {
    const { sessionId, claudeSessionId } = await svc.createSession('/tmp/native-id-test', 'sonnet');

    // The id is confirmed unchanged (the CLI honoured --session-id): the
    // registry write is the nativeSessionId backfill branch.
    await runFirstTurnToInit(sessionId, claudeSessionId);

    const registry = getSessionRegistry(join(tmpDir, 'registry.json'));
    const entry = await registry.get(sessionId);
    expect(entry?.claudeSessionId).toBe(claudeSessionId);
    expect(entry?.nativeSessionId).toBe(claudeSessionId);
  });

  it('rewrites claudeSessionId AND records nativeSessionId when the CLI ignored the --session-id hint MID-TURN', async () => {
    const { sessionId, claudeSessionId: minted } = await svc.createSession('/tmp/native-id-test', 'sonnet');
    const runtimeSessionId = 'runtime-minted-transcript-id';

    await runFirstTurnToInit(sessionId, runtimeSessionId);

    const registry = getSessionRegistry(join(tmpDir, 'registry.json'));
    const entry = await registry.get(sessionId);
    expect(entry?.claudeSessionId).toBe(runtimeSessionId);
    expect(entry?.nativeSessionId).toBe(runtimeSessionId);
    expect(entry?.claudeSessionId).not.toBe(minted);
  });
});
