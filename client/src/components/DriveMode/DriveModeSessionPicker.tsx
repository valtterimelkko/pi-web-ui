import { useSessionStore } from '../../store/sessionStore';

export interface DriveModeSessionPickerProps {
  onBack: () => void;
  onSelectSession: (sessionId: string, sessionPath: string) => void;
}

export function DriveModeSessionPicker({ onBack, onSelectSession }: DriveModeSessionPickerProps) {
  const sessions = useSessionStore((s) => s.sessions);
  const archivedSessionPaths = useSessionStore((s) => s.archivedSessionPaths);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);

  const activeSessions = sessions.filter(
    (session) => session.path && !archivedSessionPaths.includes(session.path)
  );

  return (
    <div className="flex flex-col items-center h-full w-full px-4 py-6">
      <h2 className="text-xl font-semibold text-center text-gray-900 dark:text-gray-100 mb-6">
        Continue a Session
      </h2>

      {activeSessions.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-gray-500 dark:text-gray-400 text-center">
          No active sessions. Create a new one instead.
        </div>
      ) : (
        <div className="w-full max-w-[90%] flex flex-col gap-2 max-h-[70vh] overflow-y-auto">
          {activeSessions.map((session) => {
            const isCurrent = session.id === currentSessionId;
            const displayName = session.name || session.firstMessage?.slice(0, 50) || 'New session';
            return (
              <button
                key={session.id}
                onClick={() => onSelectSession(session.id, session.path)}
                className={`w-full rounded-lg border border-gray-200 dark:border-gray-700 p-4 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors text-left ${
                  isCurrent ? 'border-l-4 border-l-blue-500' : ''
                }`}
                type="button"
              >
                <div className="font-medium text-gray-900 dark:text-gray-100">
                  {displayName}
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-sm text-gray-500 dark:text-gray-400">
                    {session.model || 'Default model'}
                  </span>
                  {session.sdkType && (
                    <span
                      className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                        session.sdkType === 'pi'
                          ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300'
                          : session.sdkType === 'opencode'
                          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300'
                          : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
                      }`}
                    >
                      {session.sdkType === 'pi' ? 'Pi' : session.sdkType === 'opencode' ? 'OC' : 'Claude'}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}

      <div className="mt-auto pt-6 w-full max-w-[90%] flex items-center justify-start">
        <button
          onClick={onBack}
          className="px-4 py-2 rounded-lg text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          type="button"
        >
          Back
        </button>
      </div>
    </div>
  );
}
