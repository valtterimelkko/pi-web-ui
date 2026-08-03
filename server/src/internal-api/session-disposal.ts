/**
 * Per-session lifecycle disposal registry.
 *
 * Phase 3 ownership: every per-session resource that must be torn down on
 * session delete (or process shutdown) registers a dispose handle here — timers,
 * grace timers, queue correlations, extension snapshots, watch/drain handles,
 * observers. `dispose(sessionId)` runs every registered handle idempotently and
 * tombstones the session so late callbacks/handles cannot repopulate state.
 *
 * This closes the "known leftover timers/correlations/snapshots outside delete
 * ownership" gap without Phase-4 epoch machinery or Phase-6 process isolation.
 */
export interface SessionDisposeHandle {
  ownerType: string;
  dispose: () => void;
}

export class SessionDisposalRegistry {
  private readonly owners = new Map<string, SessionDisposeHandle[]>();
  private readonly tombstones = new Set<string>();

  /** Register a per-session disposable. Returns an unregister function. If the
   * session is already disposed, the dispose runs immediately (late registration). */
  register(sessionId: string, ownerType: string, dispose: () => void): () => void {
    if (this.tombstones.has(sessionId)) {
      try { dispose(); } catch { /* a late-registration dispose must not throw */ }
      return () => { /* no-op once disposed */ };
    }
    const handle: SessionDisposeHandle = { ownerType, dispose };
    const list = this.owners.get(sessionId) ?? [];
    list.push(handle);
    this.owners.set(sessionId, list);
    return () => {
      const arr = this.owners.get(sessionId);
      if (!arr) return;
      const i = arr.indexOf(handle);
      if (i >= 0) arr.splice(i, 1);
    };
  }

  /** Dispose every handle for a session (idempotent; tombstones the session). */
  dispose(sessionId: string): void {
    if (this.tombstones.has(sessionId)) return;
    this.tombstones.add(sessionId);
    // Snapshot + detach BEFORE invoking handles: a handle may synchronously
    // call its own unregister() (which splices the live array), or trigger a
    // close/error cleanup that does. Iterating the live array would then skip
    // later handles. The snapshot is immutable and the map entry is already
    // gone, so any mid-disposal unregister becomes a harmless no-op.
    const list = [...(this.owners.get(sessionId) ?? [])];
    this.owners.delete(sessionId);
    for (const h of list) {
      try { h.dispose(); } catch { /* one owner failing must not skip the rest */ }
    }
  }

  /** Dispose all sessions (process shutdown). */
  disposeAll(): void {
    for (const sessionId of Array.from(this.owners.keys())) this.dispose(sessionId);
  }

  /** Whether the session has been disposed (late callbacks should check this). */
  isDisposed(sessionId: string): boolean {
    return this.tombstones.has(sessionId);
  }

  /** Per-session remaining owner counts (diagnostics). */
  getCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [sid, list] of this.owners) out[sid] = list.length;
    return out;
  }
}
