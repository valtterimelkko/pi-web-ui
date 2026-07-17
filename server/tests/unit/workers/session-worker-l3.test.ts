import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { SessionWorker } from '../../../src/workers/session-worker.js';
import { resetCrashLogger } from '../../../src/workers/crash-logger.js';

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
      expect(err!.message).toBe('hi 😀'); // multibyte char intact, not a replacement char
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
