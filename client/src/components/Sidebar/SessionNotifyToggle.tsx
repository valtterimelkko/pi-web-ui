import { useEffect, useState } from 'react';
import { Bell, BellOff, Loader2 } from 'lucide-react';
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
  const [on, setOn] = useState(false);
  const [loading, setLoading] = useState(false);
  // Opt-in only reacts to LIVE agent_end events (no replay of past turns —
  // see docs/NOTIFICATIONS.md). If the session isn't actively generating right
  // now, opting in won't retroactively notify for a turn that already ended;
  // tell the operator so that isn't mistaken for a bug.
  const liveStatus = useSessionStore((state) => state.sessionData[sessionId]?.status);
  const addToast = useUIStore((state) => state.addToast);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/notifications`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled) setOn(Boolean(data?.optIn));
      })
      .catch(() => {
        /* notifications are best-effort; never break the session list */
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const toggle = async (event: React.MouseEvent): Promise<void> => {
    event.stopPropagation();
    setLoading(true);
    try {
      const res = on
        ? await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/notifications/opt-in`, {
            method: 'DELETE',
            credentials: 'include',
          })
        : await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/notifications/opt-in`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ runtime: sdkType, sessionPath, label }),
          });
      if (res.ok) {
        const turningOn = !on;
        setOn(turningOn);
        const isActive = liveStatus === 'streaming' || liveStatus === 'busy';
        if (turningOn && !isActive) {
          addToast({
            type: 'info',
            message: "Notifications on — this session is idle, so you'll get notified starting with its next reply.",
          });
        }
      }
    } catch {
      /* non-fatal */
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={loading}
      title={on ? 'Notifications on — click to turn off' : 'Enable agent_end notifications'}
      aria-label={on ? 'Disable notifications' : 'Enable notifications'}
      className={`p-1 rounded transition-colors ${
        on ? 'text-blue-500 hover:bg-blue-100' : 'text-gray-400 hover:bg-gray-200 hover:text-gray-600'
      } ${loading ? 'opacity-50 cursor-wait' : ''}`}
    >
      {loading ? (
        <Loader2 size={14} className="animate-spin" />
      ) : on ? (
        <Bell size={14} />
      ) : (
        <BellOff size={14} />
      )}
    </button>
  );
}
