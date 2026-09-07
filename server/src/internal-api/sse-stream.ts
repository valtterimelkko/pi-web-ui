/**
 * SSE Stream Helper
 *
 * Provides a helper to write Server-Sent Events to an HTTP response.
 */

import type { ServerResponse } from 'http';
import { ErrorCode } from './error-codes.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('SSEStream');
/** Bound Node's outgoing queue without adding another application queue. */
const MAX_PENDING_BYTES = 4 * 1024 * 1024;

export interface SSEController {
  /** Write an event with a named event type. */
  write: (eventType: string, data: unknown) => void;
  /** Send a completion marker and close the stream. */
  complete: (data?: unknown) => void;
  /** Send an error and close the stream. */
  error: (message: string, code?: string) => void;
  /** Whether the connection is still alive. */
  closed: boolean;
  /** Raw response for heartbeat management. */
  res: ServerResponse;
}

/**
 * Initialize an SSE stream on an HTTP response.
 * Writes headers and provides a writer for events.
 */
export function createSSEStream(res: ServerResponse): SSEController {
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  function closeTransport(reason: string): void {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    logger.warn(`Closing SSE connection: ${reason}; pendingBytes=${res.writableLength} maxPendingBytes=${MAX_PENDING_BYTES}`);
    // A graceful end would keep the blocked queue alive. Existing route close
    // handlers decide observer cleanup versus attached-prompt cancellation.
    res.destroy();
  }

  function writeFrame(frame: string): boolean {
    if (closed || res.destroyed) return false;
    if (res.writableLength + Buffer.byteLength(frame, 'utf8') > MAX_PENDING_BYTES) {
      closeTransport('outbound buffer limit exceeded');
      return false;
    }
    try {
      // false means temporary backpressure, not failed delivery. Node owns the
      // bounded FIFO; subsequent frames/heartbeats recheck its actual length.
      res.write(frame);
      return true;
    } catch {
      closeTransport('write failed');
      return false;
    }
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable nginx buffering
  });

  // Initial comment and heartbeats obey the same bound as event payloads.
  if (writeFrame(':ok\n\n')) {
    heartbeat = setInterval(() => { writeFrame(':heartbeat\n\n'); }, 15000);
    heartbeat.unref?.();
  }

  res.on('close', () => {
    closed = true;
    clearInterval(heartbeat);
  });

  res.on('error', () => {
    closed = true;
    clearInterval(heartbeat);
  });

  function write(eventType: string, data: unknown): void {
    if (closed) return;
    try {
      const payload = JSON.stringify(data);
      writeFrame(`event: ${eventType}\ndata: ${payload}\n\n`);
    } catch {
      closeTransport('event serialization failed');
    }
  }

  function complete(data?: unknown): void {
    if (closed) return;
    if (data) {
      write('complete', data);
    }
    if (!writeFrame('event: done\ndata: {}\n\n')) return;
    res.end();
    closed = true;
    clearInterval(heartbeat);
  }

  function error(message: string, code?: string): void {
    if (closed) return;
    write('error', { error: message, code: code || ErrorCode.INTERNAL_ERROR });
    if (closed) return;
    res.end();
    closed = true;
    clearInterval(heartbeat);
  }

  return { write, complete, error, get closed() { return closed; }, res };
}
