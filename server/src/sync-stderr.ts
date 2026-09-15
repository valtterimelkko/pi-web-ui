/**
 * Synchronous stderr writes for the last thing a dying process has to say
 * (2026-09-15).
 *
 * `process.stderr.write()` is NOT synchronous in general. Node's documentation
 * is explicit: writes are synchronous for files and, on POSIX, for TTYs — but
 * **asynchronous for pipes and sockets**. A reason written with it immediately
 * before ending the process is therefore buffered in user space and lost, which
 * is precisely how this module came to exist: live-validating the shutdown
 * escape worker against a genuinely wedged main thread produced
 * `EXIT_CODE=137` at the right moment with the `shutdown_escape` line missing
 * from the output.
 *
 * `fs.writeSync(2, ...)` performs a blocking `write(2)` syscall on the
 * descriptor, so the bytes are handed to the kernel before the next statement
 * runs — including when fd 2 is a pipe into the journal, a test harness, or
 * `systemd-run`.
 *
 * Used by the shutdown instrument (main thread and worker thread), where the
 * process may not survive to the next event-loop turn.
 */

import { writeSync } from 'node:fs';

/**
 * Build a line writer that blocks until the line is handed to the kernel.
 *
 * Falls back to `process.stderr.write` only if the descriptor itself is
 * unusable, so a broken fd degrades to best-effort rather than throwing inside
 * a signal handler.
 */
export function createSynchronousWriter(fd = 2): (line: string) => void {
  return (line: string): void => {
    const text = line.endsWith('\n') ? line : `${line}\n`;
    try {
      // A blocking write(2): the bytes are in the kernel before this returns.
      writeSync(fd, text);
    } catch {
      try {
        process.stderr.write(text);
      } catch {
        /* A record that cannot be written must not itself become the failure. */
      }
    }
  };
}

/** Write one line to fd 2 synchronously. */
export function writeLineSynchronously(line: string): void {
  createSynchronousWriter(2)(line);
}
