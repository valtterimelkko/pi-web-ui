/**
 * Claude Session Subscriber Tracker
 *
 * Tracks which WebSocket clients are currently viewing which Claude sessions,
 * enabling event broadcasting to all active viewers.
 *
 * Extracted from WebSocketConnectionManager for testability.
 */
export class ClaudeSessionSubscribers {
  private subscribers: Map<string, Set<string>> = new Map();

  /** Register a client as subscribed to a Claude session's events. */
  subscribe(clientId: string, sessionId: string): void {
    let set = this.subscribers.get(sessionId);
    if (!set) {
      set = new Set();
      this.subscribers.set(sessionId, set);
    }
    set.add(clientId);
  }

  /** Remove a client from a specific Claude session. */
  unsubscribe(clientId: string, sessionId: string): void {
    const set = this.subscribers.get(sessionId);
    if (set) {
      set.delete(clientId);
      if (set.size === 0) {
        this.subscribers.delete(sessionId);
      }
    }
  }

  /** Remove a client from ALL Claude sessions (e.g. on disconnect). */
  unsubscribeAll(clientId: string): void {
    for (const [sessionId, set] of this.subscribers) {
      set.delete(clientId);
      if (set.size === 0) {
        this.subscribers.delete(sessionId);
      }
    }
  }

  /** Get all subscriber clientIds for a session. Returns empty set if none. */
  getSubscribers(sessionId: string): ReadonlySet<string> {
    return this.subscribers.get(sessionId) ?? new Set<string>();
  }

  /**
   * Every session a client is currently subscribed to. Used by the disconnect
   * grace path to find sessions whose subscriber count may have dropped to zero
   * when a client goes away.
   */
  getSubscribedSessions(clientId: string): string[] {
    const sessions: string[] = [];
    for (const [sessionId, set] of this.subscribers) {
      if (set.has(clientId)) sessions.push(sessionId);
    }
    return sessions;
  }

  /** Number of subscribers for a session. */
  getSubscriberCount(sessionId: string): number {
    return this.subscribers.get(sessionId)?.size ?? 0;
  }

  /** Check if a client is subscribed to a session. */
  isSubscribed(clientId: string, sessionId: string): boolean {
    return this.subscribers.get(sessionId)?.has(clientId) ?? false;
  }

  /** Number of sessions with active subscribers. */
  get sessionCount(): number {
    return this.subscribers.size;
  }
}
