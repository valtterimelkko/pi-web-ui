/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { SessionWorker } from '../../../src/workers/session-worker.js';
import { getCrashLogger, resetCrashLogger } from '../../../src/workers/crash-logger.js';

/**
 * L3: bounded stdout framing buffer, multibyte-safe framing, idempotent
 * terminate() with no listener leak, and no late-event resurrection.
 *
 * SessionWorker is constructed without spawning; private framing/terminate
 * seams are exercised directly, and a fake process drives the stdout path.
 */
describe('L3: session-worker framing + lifecycle', () => {
  let worker: SessionWorker;

  beforeEach(() => {
    worker = new SessionWorker({ sessionPath: '/tmp/l3.jsonl', maxOldSpaceSize: 256 });
  });
  afterEach(async () => {
    await worker.terminate();
    resetCrashLogger();
  });

  describe('stdout framing buffer', () => {
    it('reassembles a valid JSONL line split across chunks', () => {
      const events: Array<{ type: string }> = [];
      worker.subscribe((e) => events.push(e));
      (worker as any).handleStdout('{"type":"strea');
      (worker as any).handleStdout('ming_started"}\n');
      expect(events.some((e) => e.type === 'streaming_started')).toBe(true);
      expect((worker as any).stdoutBuffer).toBe('');
    });

    it('bounds an unterminated oversized run and emits one controlled error (no partial parse)', () => {
      const events: Array<{ type: string; message?: string }> = [];
      worker.subscribe((e) => events.push(e));
      // > 1 MiB with no newline.
      (worker as any).handleStdout('x'.repeat(2 * 1024 * 1024));
      expect((worker as any).stdoutBuffer).toBe('');
      const errors = events.filter((e) => e.type === 'error');
      expect(errors.length).toBe(1);
      expect(errors[0].message).toMatch(/overflow|buffer/i);
      // A forged partial line must not be parsed as an event.
      const nonError = events.filter((e) => e.type !== 'error');
      expect(nonError).toHaveLength(0);
    });

    it('does not retain every dispatched event in an unused unbounded buffer', () => {
      for (let i = 0; i < 1000; i++) {
        (worker as any).handleStdout(`{"type":"message_update","id":"${i}","delta":"x"}\n`);
      }

      expect((worker as any).state.eventBuffer ?? []).toHaveLength(0);
    });

    it('parses a multibyte UTF-8 JSONL line split at a byte boundary (decoder)', () => {
      const events: Array<{ type: string; message?: string }> = [];
      worker.subscribe((e) => events.push(e));
      const line = '{"type":"error","message":"hi 😀"}\n';
      const buf = Buffer.from(line, 'utf8');
      // Find a byte offset that lands inside the 4-byte emoji sequence.
      const emojiStart = line.indexOf('😀');
      const byteOff = Buffer.byteLength(line.slice(0, emojiStart + 1), 'utf8'); // mid-emoji
      const fakeProc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr?: EventEmitter; kill: ReturnType<typeof vi.fn>; pid: number };
      const fakeStdout = new EventEmitter();
      fakeProc.stdout = fakeStdout;
      fakeProc.stderr = undefined;
      fakeProc.pid = 1;
      // kill emits 'exit' so terminate() in afterEach can resolve.
      fakeProc.kill = vi.fn(() => fakeProc.emit('exit', 0, 'SIGTERM'));
      (worker as any).state.process = fakeProc;
      (worker as any).attachProcessHandlers();
      fakeStdout.emit('data', buf.subarray(0, byteOff));
      fakeStdout.emit('data', buf.subarray(byteOff));
      const err = events.find((e) => e.type === 'error');
      expect(err).toBeDefined();
      expect(err?.message).toBe('hi 😀'); // multibyte char intact, not a replacement char
    });
  });

  describe('RPC response lifecycle', () => {
    function attachRpcProcess() {
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      const writes: string[] = [];
      const proc = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdin: { write: ReturnType<typeof vi.fn> };
        kill: ReturnType<typeof vi.fn>;
        pid: number;
      };
      proc.stdout = stdout;
      proc.stderr = stderr;
      proc.stdin = { write: vi.fn((line: string) => { writes.push(line); return true; }) };
      proc.kill = vi.fn(() => proc.emit('exit', 0, 'SIGTERM'));
      proc.pid = 77;
      (worker as any).state.process = proc;
      (worker as any).attachProcessHandlers();
      return { proc, stdout, writes };
    }

    it('keeps a command pending until its correlated success response arrives', async () => {
      const { stdout, writes } = attachRpcProcess();
      let settled = false;
      const command = worker.sendCommand({ type: 'abort' }).then(() => { settled = true; });
      await Promise.resolve();

      expect(settled).toBe(false);
      expect(worker.pendingRequestCount).toBe(1);
      const sent = JSON.parse(writes[0]) as { id: string };
      stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'response', id: sent.id, command: 'abort', success: true })}\n`));

      await command;
      expect(settled).toBe(true);
      expect(worker.pendingRequestCount).toBe(0);
    });

    it('rejects a failed response and removes its timeout/pending entry', async () => {
      const { stdout, writes } = attachRpcProcess();
      const command = worker.sendCommand({ type: 'set_model', provider: 'bad', modelId: 'missing' });
      const sent = JSON.parse(writes[0]) as { id: string };
      stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'response', id: sent.id, command: 'set_model', success: false, error: 'Model not found' })}\n`));

      await expect(command).rejects.toThrow('Model not found');
      expect(worker.pendingRequestCount).toBe(0);
    });

    it('rejects all outstanding commands once on process exit and ignores late replies', async () => {
      const { proc, stdout, writes } = attachRpcProcess();
      const command = worker.sendCommand({ type: 'abort' });
      const sent = JSON.parse(writes[0]) as { id: string };

      proc.emit('exit', 1, null);
      await expect(command).rejects.toThrow(/exited/i);
      expect(worker.pendingRequestCount).toBe(0);

      stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'response', id: sent.id, command: 'abort', success: true })}\n`));
      expect(worker.pendingRequestCount).toBe(0);
    });

    it('settles 1,000 success/timeout cycles without retaining requests or timers', async () => {
      vi.useFakeTimers();
      try {
        worker = new SessionWorker(
          { sessionPath: '/tmp/l3-cardinality.jsonl', maxOldSpaceSize: 256 },
          { commandTimeoutMs: 25 } as any,
        );
        const { stdout, writes } = attachRpcProcess();
        const baselineTimers = vi.getTimerCount();

        const successful = Array.from({ length: 500 }, () => worker.sendCommand({ type: 'abort' }));
        for (const line of writes.splice(0)) {
          const { id } = JSON.parse(line) as { id: string };
          stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'response', id, command: 'abort', success: true })}\n`));
        }
        await Promise.all(successful);
        expect(worker.pendingRequestCount).toBe(0);
        expect(vi.getTimerCount()).toBe(baselineTimers);

        const timedOut = Array.from({ length: 500 }, () => worker.sendCommand({ type: 'abort' }));
        const settlements = Promise.allSettled(timedOut);
        await vi.advanceTimersByTimeAsync(25);
        expect((await settlements).every((result) => result.status === 'rejected')).toBe(true);
        expect(worker.pendingRequestCount).toBe(0);
        expect(vi.getTimerCount()).toBe(baselineTimers);
      } finally {
        vi.useRealTimers();
      }
    });

    it('times out an unanswered command without retaining pending state', async () => {
      vi.useFakeTimers();
      worker = new SessionWorker(
        { sessionPath: '/tmp/l3-timeout.jsonl', maxOldSpaceSize: 256 },
        { commandTimeoutMs: 25 } as any,
      );
      attachRpcProcess();
      const command = worker.sendCommand({ type: 'abort' });
      const rejection = expect(command).rejects.toThrow(/timeout/i);

      await vi.advanceTimersByTimeAsync(25);

      await rejection;
      expect(worker.pendingRequestCount).toBe(0);
      vi.useRealTimers();
    });
  });

  describe('terminate() idempotency + listener ownership', () => {
    function fakeProc(): EventEmitter & { kill: ReturnType<typeof vi.fn>; pid: number } {
      const ee = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn>; pid: number };
      ee.kill = vi.fn();
      ee.pid = 4321;
      return ee;
    }

    it('is idempotent: a second terminate() does not add another exit listener or re-kill', async () => {
      const proc = fakeProc();
      (worker as any).state.process = proc;
      const p1 = worker.terminate();
      const p2 = worker.terminate();
      expect(p1).toBe(p2); // same promise
      expect(proc.kill).toHaveBeenCalledTimes(1);
      const listenersBeforeExit = proc.listenerCount('exit');
      proc.emit('exit', 0, null);
      await p1;
      // After exit, the once-listener is gone.
      expect(proc.listenerCount('exit')).toBe(listenersBeforeExit - 1);
    });

    it('resolves termination when a failed spawn closes without emitting exit', async () => {
      const proc = fakeProc();
      (worker as any).state.process = proc;
      (worker as any).attachProcessHandlers();
      proc.emit('error', new Error('ENOENT'));
      let settled = false;
      const termination = worker.terminate().then(() => { settled = true; });

      try {
        proc.emit('close', -2, null);
        await Promise.resolve();
        expect(settled).toBe(true);
        expect(getCrashLogger().getStats().totalCrashes).toBe(1);
      } finally {
        proc.emit('exit', -2, null);
        await termination;
      }
    });

    it('1000 terminate cycles do not accumulate exit listeners', async () => {
      for (let i = 0; i < 1000; i++) {
        const proc = fakeProc();
        (worker as any).state.process = proc;
        (worker as any).terminatePromise = null; // reset per cycle
        const p = worker.terminate();
        proc.emit('exit', 0, null);
        await p;
        expect(proc.listenerCount('exit')).toBe(0);
      }
    });
  });

  describe('late events after termination', () => {
    it('does not resurrect status from a late stdout event', async () => {
      const proc = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn>; stdout: EventEmitter; pid: number };
      proc.kill = vi.fn();
      proc.pid = 1;
      proc.stdout = new EventEmitter();
      (worker as any).state.process = proc;
      (worker as any).attachProcessHandlers();
      const p = worker.terminate();
      proc.emit('exit', 0, null); // -> status 'terminated'
      await p;

      const before = worker.status;
      proc.stdout.emit('data', Buffer.from('{"type":"streaming_started"}\n'));
      expect(worker.status).toBe(before); // still terminated, not resurrected to 'streaming'
    });
  });
});
