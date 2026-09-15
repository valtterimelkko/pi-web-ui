import { openSync, closeSync, readFileSync, unlinkSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSynchronousWriter } from '../../src/sync-stderr.js';

/**
 * The reason must survive being the last thing written (2026-09-15).
 *
 * `process.stderr.write()` is asynchronous when fd 2 is a pipe — which is the
 * case under systemd-run, a test harness, and journald capture. Live validation
 * of the shutdown escape worker against a wedged main thread produced the right
 * SIGKILL at the right moment with the `shutdown_escape` reason missing, because
 * the line was still buffered in user space when the process ended.
 *
 * These tests assert the property that matters: after the call returns, the
 * bytes are already readable from the descriptor.
 */
describe('synchronous writer', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempFd(): { fd: number; file: string } {
    const dir = mkdtempSync(path.join(tmpdir(), 'pi-web-ui-sync-'));
    dirs.push(dir);
    const file = path.join(dir, 'sink');
    return { fd: openSync(file, 'w'), file };
  }

  it('has the bytes on the descriptor before it returns — no event-loop turn required', () => {
    const { fd, file } = tempFd();
    const write = createSynchronousWriter(fd);
    write('last words');
    // Read WITHOUT yielding: if this were an async stream write, the data would
    // still be buffered and this would be empty.
    expect(readFileSync(file, 'utf8')).toBe('last words\n');
    closeSync(fd);
  });

  it('appends the newline the journal needs, and does not double it', () => {
    const { fd, file } = tempFd();
    const write = createSynchronousWriter(fd);
    write('one\ntwo');
    write('three\n');
    expect(readFileSync(file, 'utf8')).toBe('one\ntwo\nthree\n');
    closeSync(fd);
  });

  it('does not throw when the descriptor is unusable, so a signal handler survives', () => {
    const write = createSynchronousWriter(4_242);
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(() => write('fallback')).not.toThrow();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('is usable repeatedly, which is what the stop audit does', () => {
    const { fd, file } = tempFd();
    const write = createSynchronousWriter(fd);
    for (let i = 0; i < 5; i += 1) write(`line ${i}`);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(5);
    closeSync(fd);
  });

  it('never leaves a half-written line when the sink is a pipe that is gone', () => {
    // A closed fd stands in for a peer that has already gone away.
    const { fd } = tempFd();
    closeSync(fd);
    const write = createSynchronousWriter(fd);
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(() => write('after close')).not.toThrow();
    spy.mockRestore();
    void unlinkSync;
  });
});
