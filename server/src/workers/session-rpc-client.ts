/**
 * Session RPC Client
 * High-level API for interacting with session workers.
 */

import { SessionWorker } from './session-worker.js';
import { RPCProtocolBridge } from './rpc-protocol-bridge.js';
import type { EventHandler, RPCEvent } from './types.js';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import type { ImageContent } from '@earendil-works/pi-ai';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('SessionRPCClient');


export interface CompactionResult {
  messageCount: number;
  removedCount: number;
}

export interface SessionState {
  model?: string;
  thinkingLevel?: string;
  isStreaming: boolean;
  isCompacting: boolean;
  sessionFile?: string;
  sessionId: string;
  messageCount: number;
}

export class SessionRPCClient {
  private worker: SessionWorker;
  private bridge: RPCProtocolBridge;
  private eventSubscribers: Set<(event: NormalizedEvent) => void> = new Set();

  constructor(worker: SessionWorker) {
    this.worker = worker;
    this.bridge = new RPCProtocolBridge();

    // Forward worker events to our subscribers
    worker.subscribe((event: RPCEvent) => {
      const normalized = this.bridge.normalizeEvent(event, worker.sessionPath);
      for (const subscriber of this.eventSubscribers) {
        try {
          subscriber(normalized);
        } catch (err) {
          logger.error('[SessionRPCClient] Subscriber error:', err);
        }
      }
    });
  }

  /**
   * Send a prompt to the session.
   */
  async prompt(message: string, images?: ImageContent[]): Promise<void> {
    await this.worker.sendCommand({
      type: 'prompt',
      message,
      images,
    });
  }

  /**
   * Send a steering message.
   */
  async steer(message: string, images?: ImageContent[]): Promise<void> {
    await this.worker.sendCommand({
      type: 'steer',
      message,
      images,
    });
  }

  /**
   * Abort current operation.
   */
  async abort(): Promise<void> {
    await this.worker.sendCommand({ type: 'abort' });
  }

  /**
   * Compact the session context.
   */
  async compact(customInstructions?: string): Promise<void> {
    await this.worker.sendCommand({
      type: 'compact',
      customInstructions,
    });
  }

  /**
   * Set the model.
   */
  async setModel(provider: string, modelId: string): Promise<void> {
    await this.worker.sendCommand({
      type: 'set_model',
      provider,
      modelId,
    });
  }

  /**
   * Set thinking level.
   */
  async setThinkingLevel(level: string): Promise<void> {
    await this.worker.sendCommand({
      type: 'set_thinking_level',
      level: level as 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh',
    });
  }

  /**
   * Subscribe to session events.
   */
  subscribe(handler: (event: NormalizedEvent) => void): () => void {
    this.eventSubscribers.add(handler);
    return () => this.eventSubscribers.delete(handler);
  }

  /**
   * Get the underlying worker.
   */
  getWorker(): SessionWorker {
    return this.worker;
  }

  /**
   * Get session path.
   */
  get sessionPath(): string {
    return this.worker.sessionPath;
  }

  /**
   * Get worker status.
   */
  get status() {
    return this.worker.status;
  }
}
