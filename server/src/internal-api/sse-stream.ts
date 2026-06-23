/**
 * SSE Stream Helper
 *
 * Provides a helper to write Server-Sent Events to an HTTP response.
 */

import type { ServerResponse } from 'http';
import { ErrorCode } from './error-codes.js';

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

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable nginx buffering
  });

  // Send an initial comment to flush headers
  res.write(':ok\n\n');

  // Heartbeat every 15 seconds to keep connection alive
  const heartbeat = setInterval(() => {
    if (!closed) {
      res.write(':heartbeat\n\n');
    }
  }, 15000);

  if (heartbeat.unref) heartbeat.unref();

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
      res.write(`event: ${eventType}\ndata: ${payload}\n\n`);
    } catch {
      // If write fails, connection is dead
      closed = true;
      clearInterval(heartbeat);
    }
  }

  function complete(data?: unknown): void {
    if (closed) return;
    if (data) {
      write('complete', data);
    }
    res.write('event: done\ndata: {}\n\n');
    res.end();
    closed = true;
    clearInterval(heartbeat);
  }

  function error(message: string, code?: string): void {
    if (closed) return;
    write('error', { error: message, code: code || ErrorCode.INTERNAL_ERROR });
    res.end();
    closed = true;
    clearInterval(heartbeat);
  }

  return { write, complete, error, get closed() { return closed; }, res };
}
