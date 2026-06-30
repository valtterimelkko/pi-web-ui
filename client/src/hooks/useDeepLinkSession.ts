import { useEffect, useRef } from 'react';
import { useSessionStore } from '../store/sessionStore';
import { getWebSocketClient } from '../lib/websocket';

const SESSION_QUERY_PARAM = 'session';

/**
 * Deep-link auto-open.
 *
 * Telegram notifications (and any other external link) carry `?session=<id>`.
 * The server already produces these URLs; this hook is the reader that makes
 * them land in the right session: on load it captures the target id, waits for
 * the session list + WebSocket to be ready, then drives the same switch the
 * sidebar uses — a WS `switch_session` (by path) plus the switching UI flag.
 * The query param is then stripped from the URL so a refresh returns to the
 * normal default view instead of re-triggering the switch.
 *
 * Frontend-only and best-effort: an unknown id, or one not in the loaded list,
 * is silently ignored (no broken state). Switches at most once per page load.
 */
export function useDeepLinkSession(): void {
  const targetIdRef = useRef<string | null>(null);
  const firedRef = useRef(false);

  // Capture the target id once on mount, then strip the param so refresh (and
  // any in-app navigation) doesn't re-trigger the deep link.
  useEffect(() => {
    if (targetIdRef.current !== null) return;
    const id = new URLSearchParams(window.location.search).get(SESSION_QUERY_PARAM);
    if (!id) return;
    targetIdRef.current = id;
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete(SESSION_QUERY_PARAM);
      window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    } catch {
      /* history API unavailable — non-fatal */
    }
  }, []);

  const sessions = useSessionStore((s) => s.sessions);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const setSwitchingSession = useSessionStore((s) => s.setSwitchingSession);

  // Fire the switch once the target session is in the loaded list and the WS is
  // ready. Re-runs as the session list loads (and after WS reconnect delivers a
  // fresh list), so it needs no explicit WS-status subscription.
  useEffect(() => {
    if (firedRef.current) return;
    const targetId = targetIdRef.current;
    if (!targetId) return;
    if (currentSessionId === targetId) {
      firedRef.current = true;
      return;
    }
    const target = sessions.find((s) => s.id === targetId);
    if (!target) return; // not loaded yet, or unknown id → keep waiting silently
    const client = getWebSocketClient();
    if (!client || client.getStatus() !== 'connected') return;
    // Mirror SessionItem.handleClick: switch flag + WS switch by path.
    const sent = client.send({ type: 'switch_session', sessionPath: target.path });
    if (sent) {
      setSwitchingSession(true, target.id);
      firedRef.current = true;
    }
    // If send returned false (WS not OPEN), leave firedRef unset so the next
    // session-list update retries.
  }, [sessions, currentSessionId, setSwitchingSession]);
}
