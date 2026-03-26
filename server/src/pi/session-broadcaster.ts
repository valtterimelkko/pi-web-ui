/**
 * Session Status Broadcaster
 *
 * Handles per-session WebSocket notifications with:
 * - Subscription management per session
 * - Status diff detection (only broadcasts when status changes)
 * - Heartbeat mechanism for dead connection detection
 * - Automatic cleanup on WebSocket disconnect
 */

import WebSocket from 'ws';

/**
 * Session status types
 */
export type SessionStatus = 'idle' | 'busy' | 'streaming' | 'error';

/**
 * Session status information for broadcasting
 */
export interface SessionStatusInfo {
  status: SessionStatus;
  messageCount: number;
  lastActivity: Date;
  currentStep: number;
  subscriberCount: number;
}

/**
 * JSON-RPC 2.0 Notification format
 */
export interface JSONRPCNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

/**
 * Status change notification params
 */
export interface StatusChangeParams {
  sessionId: string;
  previousStatus: SessionStatusInfo | null;
  currentStatus: SessionStatusInfo;
  timestamp: Date;
}

/**
 * Creates a JSON-RPC 2.0 notification
 */
export function createNotification(method: string, params?: unknown): JSONRPCNotification {
  return {
    jsonrpc: '2.0',
    method,
    params,
  };
}

/**
 * SessionBroadcaster manages WebSocket subscriptions for session events
 * and broadcasts status changes to subscribers.
 */
export class SessionBroadcaster {
  /** Map of session ID -> Set of subscribed WebSockets */
  private subscribers: Map<string, Set<WebSocket>> = new Map();

  /** Map of session ID -> current status info */
  private sessionStatus: Map<string, SessionStatusInfo> = new Map();

  /** Map of WebSocket -> Set of subscribed session IDs (for cleanup) */
  private wsToSessions: Map<WebSocket, Set<string>> = new Map();

  /** Heartbeat interval timer */
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  /** Whether the broadcaster has been disposed */
  private disposed = false;

  /**
   * Subscribe a WebSocket to a session's events.
   * After subscribing, the WebSocket will receive all broadcasts for that session.
   *
   * @param sessionId - The session ID to subscribe to
   * @param ws - The WebSocket connection to subscribe
   */
  subscribe(sessionId: string, ws: WebSocket): void {
    if (this.disposed) {
      throw new Error('SessionBroadcaster has been disposed');
    }

    // Add to session's subscriber set
    if (!this.subscribers.has(sessionId)) {
      this.subscribers.set(sessionId, new Set());
    }
    this.subscribers.get(sessionId)!.add(ws);

    // Track reverse mapping for cleanup
    if (!this.wsToSessions.has(ws)) {
      this.wsToSessions.set(ws, new Set());
    }
    this.wsToSessions.get(ws)!.add(sessionId);

    // Update subscriber count in status
    const status = this.sessionStatus.get(sessionId);
    if (status) {
      status.subscriberCount = this.subscribers.get(sessionId)!.size;
    }
  }

  /**
   * Unsubscribe a WebSocket from a session's events.
   *
   * @param sessionId - The session ID to unsubscribe from
   * @param ws - The WebSocket connection to unsubscribe
   */
  unsubscribe(sessionId: string, ws: WebSocket): void {
    const sessionSubscribers = this.subscribers.get(sessionId);
    if (!sessionSubscribers) {
      return;
    }

    sessionSubscribers.delete(ws);

    // Remove empty subscriber sets
    if (sessionSubscribers.size === 0) {
      this.subscribers.delete(sessionId);
    }

    // Update subscriber count in status
    const status = this.sessionStatus.get(sessionId);
    if (status) {
      status.subscriberCount = sessionSubscribers.size;
    }

    // Remove from reverse mapping
    const wsSessions = this.wsToSessions.get(ws);
    if (wsSessions) {
      wsSessions.delete(sessionId);
      if (wsSessions.size === 0) {
        this.wsToSessions.delete(ws);
      }
    }
  }

  /**
   * Broadcast a notification to all subscribers of a session.
   *
   * @param sessionId - The session ID to broadcast to
   * @param notification - The JSON-RPC notification to send
   */
  broadcast(sessionId: string, notification: JSONRPCNotification): void {
    if (this.disposed) {
      return;
    }

    const sessionSubscribers = this.subscribers.get(sessionId);
    if (!sessionSubscribers || sessionSubscribers.size === 0) {
      return;
    }

    const message = JSON.stringify(notification);
    const deadSockets: WebSocket[] = [];

    for (const ws of sessionSubscribers) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(message);
        } catch (error) {
          // Mark for removal if send fails
          deadSockets.push(ws);
        }
      } else if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        // Mark for removal if socket is closed/closing
        deadSockets.push(ws);
      }
    }

    // Clean up dead sockets
    for (const ws of deadSockets) {
      this.unsubscribe(sessionId, ws);
    }
  }

  /**
   * Update session status. Only broadcasts if the status has actually changed.
   *
   * @param sessionId - The session ID to update
   * @param status - The new status information
   * @returns true if status changed and was broadcast, false otherwise
   */
  updateStatus(sessionId: string, status: Partial<SessionStatusInfo>): boolean {
    if (this.disposed) {
      return false;
    }

    const previousStatus = this.sessionStatus.get(sessionId) || null;
    const subscriberCount = this.subscribers.get(sessionId)?.size ?? 0;

    // Create new status with defaults from previous
    const newStatus: SessionStatusInfo = {
      status: status.status ?? previousStatus?.status ?? 'idle',
      messageCount: status.messageCount ?? previousStatus?.messageCount ?? 0,
      lastActivity: status.lastActivity ?? previousStatus?.lastActivity ?? new Date(),
      currentStep: status.currentStep ?? previousStatus?.currentStep ?? 0,
      subscriberCount,
    };

    // Check if status has changed
    const hasChanged = this.hasStatusChanged(sessionId, newStatus);

    // Store new status
    this.sessionStatus.set(sessionId, newStatus);

    // Broadcast if changed
    if (hasChanged) {
      const notification = createNotification('session_status_changed', {
        sessionId,
        previousStatus,
        currentStatus: newStatus,
        timestamp: new Date(),
      } as StatusChangeParams);

      this.broadcast(sessionId, notification);
    }

    return hasChanged;
  }

  /**
   * Get the current status for a session.
   * Returns a copy to prevent external mutation of internal state.
   *
   * @param sessionId - The session ID to get status for
   * @returns A copy of the current status or undefined if session has no status
   */
  getStatus(sessionId: string): SessionStatusInfo | undefined {
    const status = this.sessionStatus.get(sessionId);
    if (!status) {
      return undefined;
    }
    // Return a copy to prevent external mutation
    return {
      status: status.status,
      messageCount: status.messageCount,
      lastActivity: status.lastActivity,
      currentStep: status.currentStep,
      subscriberCount: status.subscriberCount,
    };
  }

  /**
   * Clean up a session and all its subscribers.
   *
   * @param sessionId - The session ID to clean up
   */
  cleanup(sessionId: string): void {
    const sessionSubscribers = this.subscribers.get(sessionId);
    if (sessionSubscribers) {
      // Remove from reverse mapping for each WebSocket
      for (const ws of sessionSubscribers) {
        const wsSessions = this.wsToSessions.get(ws);
        if (wsSessions) {
          wsSessions.delete(sessionId);
          if (wsSessions.size === 0) {
            this.wsToSessions.delete(ws);
          }
        }
      }

      // Clear subscribers for this session
      this.subscribers.delete(sessionId);
    }

    // Remove status
    this.sessionStatus.delete(sessionId);
  }

  /**
   * Handle WebSocket close event - removes the WebSocket from all sessions.
   * Call this when a WebSocket connection closes.
   *
   * @param ws - The WebSocket that closed
   */
  handleWebSocketClose(ws: WebSocket): void {
    const wsSessions = this.wsToSessions.get(ws);
    if (!wsSessions) {
      return;
    }

    // Remove from all sessions this WebSocket was subscribed to
    for (const sessionId of wsSessions) {
      const sessionSubscribers = this.subscribers.get(sessionId);
      if (sessionSubscribers) {
        sessionSubscribers.delete(ws);

        // Update subscriber count
        const status = this.sessionStatus.get(sessionId);
        if (status) {
          status.subscriberCount = sessionSubscribers.size;
        }

        // Remove empty subscriber sets
        if (sessionSubscribers.size === 0) {
          this.subscribers.delete(sessionId);
        }
      }
    }

    // Clear reverse mapping
    this.wsToSessions.delete(ws);
  }

  /**
   * Start the heartbeat mechanism.
   * Sends heartbeat messages to all connected WebSockets periodically.
   *
   * @param intervalMs - Interval in milliseconds (default: 30000)
   */
  startHeartbeat(intervalMs: number = 30000): void {
    if (this.heartbeatInterval) {
      this.stopHeartbeat();
    }

    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, intervalMs);

    // Unref so it doesn't keep the process alive
    if (this.heartbeatInterval.unref) {
      this.heartbeatInterval.unref();
    }
  }

  /**
   * Stop the heartbeat mechanism.
   */
  stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Send heartbeat to all subscribed WebSockets.
   * This helps detect dead connections.
   */
  private sendHeartbeat(): void {
    if (this.disposed) {
      return;
    }

    const deadSockets: WebSocket[] = [];

    for (const [sessionId, sockets] of this.subscribers) {
      for (const ws of sockets) {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'heartbeat' }));
          } catch {
            deadSockets.push(ws);
          }
        } else if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
          deadSockets.push(ws);
        }
      }
    }

    // Clean up dead sockets
    for (const ws of deadSockets) {
      this.handleWebSocketClose(ws);
    }
  }

  /**
   * Check if the status has changed from the previous status.
   *
   * @param sessionId - The session ID to check
   * @param newStatus - The new status to compare
   * @returns true if status has changed, false otherwise
   */
  private hasStatusChanged(sessionId: string, newStatus: SessionStatusInfo): boolean {
    const previousStatus = this.sessionStatus.get(sessionId);

    if (!previousStatus) {
      return true; // New session = status changed
    }

    return (
      previousStatus.status !== newStatus.status ||
      previousStatus.messageCount !== newStatus.messageCount ||
      previousStatus.currentStep !== newStatus.currentStep
      // Note: We don't compare lastActivity or subscriberCount for change detection
      // as they change frequently and don't require broadcast
    );
  }

  /**
   * Get the number of subscribers for a session.
   *
   * @param sessionId - The session ID to get subscriber count for
   * @returns The number of subscribers
   */
  getSubscriberCount(sessionId: string): number {
    return this.subscribers.get(sessionId)?.size ?? 0;
  }

  /**
   * Get all session IDs that have subscribers.
   *
   * @returns Array of session IDs with active subscribers
   */
  getActiveSessions(): string[] {
    return Array.from(this.subscribers.keys()).filter(
      sessionId => this.subscribers.get(sessionId)!.size > 0
    );
  }

  /**
   * Get the total number of WebSocket connections being managed.
   *
   * @returns Total WebSocket count
   */
  getTotalWebSocketCount(): number {
    return this.wsToSessions.size;
  }

  /**
   * Dispose the broadcaster and clean up all resources.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.stopHeartbeat();
    this.subscribers.clear();
    this.sessionStatus.clear();
    this.wsToSessions.clear();
  }

  /**
   * Check if the broadcaster has been disposed.
   */
  isDisposed(): boolean {
    return this.disposed;
  }
}

/**
 * Global session broadcaster instance.
 * Use this for session status broadcasting across the application.
 */
export const globalBroadcaster = new SessionBroadcaster();
