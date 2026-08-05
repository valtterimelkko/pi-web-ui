import type { NormalizedEvent } from '@pi-web-ui/shared';
import type { RunReceipt } from '../internal-api/types.js';
import type { PilotExecutorAdapter } from '../workers/pilot-executor-adapter.js';

export type PilotWebSocketSender = (clientId: string, message: unknown) => void;

export interface PilotSessionWebSocketAdapterOptions {
  executor: PilotExecutorAdapter;
  clientId: string;
  send: PilotWebSocketSender;
  notificationSink?: (event: NormalizedEvent) => void;
}

export interface PilotWebSocketPrompt {
  sessionId: string;
  sessionPath: string;
  message: string;
}

/**
 * Contained-pilot WebSocket projection. Unlike the legacy worker handler, this
 * never talks to a worker directly: receipt/admission/epoch ownership remains
 * authoritative in PilotExecutorAdapter.
 */
export class PilotSessionWebSocketAdapter {
  private readonly executor: PilotExecutorAdapter;
  private readonly clientId: string;
  private readonly send: PilotWebSocketSender;
  private readonly notificationSink?: (event: NormalizedEvent) => void;
  private activeProjections = 0;

  constructor(options: PilotSessionWebSocketAdapterOptions) {
    this.executor = options.executor;
    this.clientId = options.clientId;
    this.send = options.send;
    this.notificationSink = options.notificationSink;
  }

  async prompt(input: PilotWebSocketPrompt): Promise<RunReceipt> {
    this.activeProjections += 1;
    try {
      return await this.executor.enqueue({
        ...input,
        onEvent: (event) => {
          this.send(this.clientId, {
            type: 'session_event',
            sessionId: input.sessionId,
            event,
          });
          this.notificationSink?.(event);
        },
      });
    } finally {
      this.activeProjections -= 1;
    }
  }

  get activeProjectionCount(): number {
    return this.activeProjections;
  }

  abort(sessionId: string, reason = 'pilot-websocket-abort'): Promise<RunReceipt | undefined> {
    return this.executor.cancel(sessionId, reason);
  }
}
