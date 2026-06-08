export class AntigravitySessionSubscribers {
  private subscribers: Map<string, Set<string>> = new Map();

  subscribe(clientId: string, sessionId: string): void {
    let set = this.subscribers.get(sessionId);
    if (!set) {
      set = new Set();
      this.subscribers.set(sessionId, set);
    }
    set.add(clientId);
  }

  unsubscribe(clientId: string, sessionId: string): void {
    const set = this.subscribers.get(sessionId);
    if (set) {
      set.delete(clientId);
      if (set.size === 0) {
        this.subscribers.delete(sessionId);
      }
    }
  }

  unsubscribeAll(clientId: string): void {
    for (const [sessionId, set] of this.subscribers) {
      set.delete(clientId);
      if (set.size === 0) {
        this.subscribers.delete(sessionId);
      }
    }
  }

  getSubscribers(sessionId: string): ReadonlySet<string> {
    return this.subscribers.get(sessionId) ?? new Set<string>();
  }

  getSubscriberCount(sessionId: string): number {
    return this.subscribers.get(sessionId)?.size ?? 0;
  }

  isSubscribed(clientId: string, sessionId: string): boolean {
    return this.subscribers.get(sessionId)?.has(clientId) ?? false;
  }

  get sessionCount(): number {
    return this.subscribers.size;
  }
}
