import type { LaneEvent } from './types.js';

/**
 * Orphan detection reuses the same lane-events log the driver already writes
 * (child_created / child_deleted), rather than a second bookkeeping ledger:
 * a session id with a `child_created` event but no later `child_deleted`
 * event for that same session id is still open and should be swept.
 */
export function computeOpenSessionIds(events: readonly LaneEvent[]): string[] {
  const createdOrder: string[] = [];
  const created = new Set<string>();
  const deleted = new Set<string>();
  for (const e of events) {
    if (!e.sessionId) continue;
    if (e.kind === 'child_created') {
      if (!created.has(e.sessionId)) createdOrder.push(e.sessionId);
      created.add(e.sessionId);
    } else if (e.kind === 'child_deleted') {
      deleted.add(e.sessionId);
    }
  }
  return createdOrder.filter((id) => !deleted.has(id));
}
