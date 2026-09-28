/**
 * Session-watcher → Internal API event-broker bridge.
 *
 * Extracted from `index.ts` so the bridge is unit-testable without booting the
 * server. B1.1 correction 04: publish under the path alias **even when the
 * watcher could not determine a `sessionId`**, so an unlink for a genuinely
 * unknown id (no captured header, non-Pi file name) still reaches watch
 * consumers instead of being dropped. The id alias is published too when an id
 * exists, as before. Best-effort: a broker failure must never break the
 * watcher's own broadcast.
 */
import type { NormalizedEvent } from '@pi-web-ui/shared';
import type { SessionChangeEvent, SessionInfo } from './pi/session-watcher.js';

export interface SessionEventBroker {
  publish(key: string, event: NormalizedEvent): void;
}

export function publishSessionUpdateToBroker(
  broker: SessionEventBroker,
  event: SessionChangeEvent & { info?: SessionInfo },
): void {
  const base = {
    type: 'session_update',
    timestamp: Date.now(),
    data: {
      changeType: event.type,
      path: event.path,
      ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      ...(event.cwd ? { cwd: event.cwd } : {}),
      ...(event.info ? {
        messageCount: event.info.messageCount,
        lastActivity: event.info.lastActivity.toISOString(),
      } : {}),
    },
  } as NormalizedEvent;
  try {
    broker.publish(event.path, base);
    if (event.sessionId && event.sessionId !== event.path) {
      broker.publish(event.sessionId, { ...base });
    }
  } catch { /* bridging is best-effort */ }
}
