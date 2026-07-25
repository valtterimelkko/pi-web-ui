import { Bell, X, Info, AlertCircle, CheckCircle } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';

/**
 * Notification history.
 *
 * Extension notifications are one-shot: a `/goal report`, a budget warning, or
 * a "goal achieved" line appears as a toast and is then gone. The tray keeps
 * the recent ones so an operator who was on another tab (or on their phone in a
 * pocket) can still read what happened.
 */

const icons = {
  info: Info,
  success: CheckCircle,
  warning: AlertCircle,
  error: AlertCircle,
};

const tones = {
  info: 'text-blue-600',
  success: 'text-green-600',
  warning: 'text-amber-600',
  error: 'text-red-600',
};

function relativeTime(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(at).toLocaleString();
}

export function NotificationBell() {
  const entries = useUIStore((state) => state.notificationLog);
  const openTray = useUIStore((state) => state.openNotificationTray);
  const unread = entries.filter((entry) => !entry.read).length;

  if (entries.length === 0) return null;

  return (
    <button
      onClick={openTray}
      className="relative p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
      title="Notifications"
      data-testid="notification-bell"
    >
      <Bell className="w-4 h-4 text-gray-500 dark:text-gray-400" />
      {unread > 0 && (
        <span
          className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-blue-600 text-white text-[10px] font-semibold flex items-center justify-center"
          data-testid="notification-unread-badge"
        >
          {unread > 9 ? '9+' : unread}
        </span>
      )}
    </button>
  );
}

export function NotificationTray() {
  const open = useUIStore((state) => state.notificationTrayOpen);
  const entries = useUIStore((state) => state.notificationLog);
  const close = useUIStore((state) => state.closeNotificationTray);
  const clear = useUIStore((state) => state.clearNotificationLog);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-start sm:justify-end bg-black/30 sm:bg-transparent"
      onClick={(event) => event.target === event.currentTarget && close()}
      data-testid="notification-tray"
    >
      <div className="w-full sm:w-96 sm:mt-14 sm:mr-4 max-h-[70vh] flex flex-col rounded-t-xl sm:rounded-xl border border-gray-200 bg-white shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <h3 className="text-sm font-semibold text-gray-900">Notifications</h3>
          <div className="flex items-center gap-1">
            <button
              onClick={clear}
              className="px-2 py-1 text-xs text-gray-500 hover:text-gray-700 rounded"
              data-testid="notification-clear"
            >
              Clear
            </button>
            <button
              onClick={close}
              className="p-1.5 hover:bg-gray-100 rounded-lg"
              title="Close"
              data-testid="notification-close"
            >
              <X className="w-4 h-4 text-gray-400" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto overscroll-contain divide-y divide-gray-100">
          {entries.length === 0 ? (
            <p className="px-4 py-6 text-sm text-gray-400 text-center">Nothing yet.</p>
          ) : (
            entries.map((entry) => {
              const Icon = icons[entry.type];
              return (
                <div key={entry.id} className="flex gap-3 px-4 py-3" data-testid="notification-entry">
                  <Icon className={`w-4 h-4 flex-shrink-0 mt-0.5 ${tones[entry.type]}`} />
                  <div className="min-w-0 flex-1">
                    <div
                      className="text-xs text-gray-800 whitespace-pre-wrap break-words"
                      data-testid="notification-message"
                    >
                      {entry.message}
                    </div>
                    <div className="mt-1 text-[10px] uppercase tracking-wide text-gray-400">
                      {relativeTime(entry.at)}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
