import { useEffect, useState } from 'react';
import { Bell, BellOff, Loader2 } from 'lucide-react';
import { canonicalOptInId } from '@pi-web-ui/shared';
import { useSessionStore, useUIStore } from '../../store';

/**
 * Per-session notification opt-in toggle.
 *
 * Calls the cookie-auth browser REST surface (`/api/sessions/:id/notifications`)
 * which proxies to the NotificationManager. Self-contained: owns its own state
 * via fetch (no global store sprawl). Reflects whether the session is opted in
 * to agent_end notifications.
 */
export function SessionNotifyToggle({
  sessionId,
  sdkType,
  sessionPath,
  label,
}: {
  sessionId: string;
  sdkType: 'pi' | 'claude' | 'opencode' | 'antigravity';
  sessionPath: string;
  /**
   * The session's current display name (renamed name → runtime name → first
   * message), sent as a snapshot label with the opt-in. The server live-resolves
   * the renamed name at notification time, so this snapshot is only a fallback
   * for un-renamed sessions (whose auto-name the server can't otherwise see).
   */
  label?: string;
}): React.JSX.Element {
  // Stable opt-in identity: Pi sessions are keyed by the bare uuid derived from
  // the path (canonicalOptInId), not the sidebar's session.id — which is the
  // basename while live and the bare uuid after reload. Keying on the canonical
  // id keeps GET/POST/DELETE consistent across a reload (the desync fix). The
  // POST body still carries the real sessionPath for the Pi observer's serviceKey.
  const optInId = canonicalOptInId(sdkType, sessionId, sessionPath);
  const [on, setOn] = useState(false);
  const [loading, setLoading] = useState(false);
  const [initializing, setInitializing] = useState(true);
  // Opt-in only reacts to LIVE agent_end events (no replay of past turns —
  // see docs/NOTIFICATIONS.md). If the session isn't actively generating right
  // now, opting in won't retroactively notify for a turn that already ended;
  // tell the operator so that isn't mistaken for a bug.
  const liveStatus = useSessionStore((state) => state.sessionData[sessionId]?.status);
  const addToast = useUIStore((state) => state.addToast);

  useEffect(() => {
    let cancelled = false;
    setInitializing(true);
    fetch(`/api/sessions/${encodeURIComponent(optInId)}/notifications`, { credentials: 'include' })
      .then((response) => {
        if (!response.ok) throw new Error(`notification state request failed (${response.status})`);
        return response.json();
      })
      .then((data) => {
        if (!cancelled) setOn(Boolean(data?.optIn));
      })
      .catch(() => {
        if (!cancelled) {
          addToast({ type: 'error', message: 'Could not load notification settings. Please try again.' });
        }
      })
      .finally(() => {
        if (!cancelled) setInitializing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [optInId, addToast]);

  const toggle = async (event: React.MouseEvent): Promise<void> => {
    event.stopPropagation();
    setLoading(true);
    try {
      const res = on
        ? await fetch(`/api/sessions/${encodeURIComponent(optInId)}/notifications/opt-in`, {
            method: 'DELETE',
            credentials: 'include',
          })
        : await fetch(`/api/sessions/${encodeURIComponent(optInId)}/notifications/opt-in`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ runtime: sdkType, sessionPath, label }),
          });
      if (!res.ok) throw new Error(`notification update failed (${res.status})`);
      const turningOn = !on;
      setOn(turningOn);
      const isActive = liveStatus === 'streaming' || liveStatus === 'busy';
      if (turningOn && !isActive) {
        addToast({
          type: 'info',
          message: "Notifications on — this session is idle, so you'll get notified starting with its next reply.",
        });
      }
    } catch {
      addToast({ type: 'error', message: 'Could not update notification settings. Please try again.' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={loading || initializing}
      title={on ? 'Notifications on — click to turn off' : 'Enable agent_end notifications'}
      aria-label={on ? 'Disable notifications' : 'Enable notifications'}
      className={`p-1 rounded transition-colors ${
        on ? 'text-blue-500 hover:bg-blue-100' : 'text-gray-400 hover:bg-gray-200 hover:text-gray-600'
      } ${loading || initializing ? 'opacity-50 cursor-wait' : ''}`}
    >
      {loading || initializing ? (
        <Loader2 size={14} className="animate-spin" />
      ) : on ? (
        <Bell size={14} />
      ) : (
        <BellOff size={14} />
      )}
    </button>
  );
}
