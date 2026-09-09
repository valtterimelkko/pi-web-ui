import { useState, useEffect, useCallback } from 'react';
import {
  X,
  Terminal,
  RefreshCw,
  Folder,
  Check,
  Copy,
  AlertCircle,
  Play,
  Layers,
  ArrowRight,
} from 'lucide-react';
import { fetchNativeSessions, importNativeSession, type NativeSessionItem } from '../../lib/api';
import { useSessionStore } from '../../store/sessionStore';
import { useWebSocket } from '../../hooks/useWebSocket';

interface ResumeNativeSessionModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type RuntimeFilter = 'all' | 'claude' | 'antigravity' | 'commandcode' | 'opencode';

const RUNTIME_CONFIG: Record<
  string,
  { label: string; badgeClass: string; bgClass: string; borderClass: string }
> = {
  claude: {
    label: 'Claude Code',
    badgeClass: 'bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300',
    bgClass: 'hover:bg-purple-50/50 dark:hover:bg-purple-950/20',
    borderClass: 'border-purple-200 dark:border-purple-800/40',
  },
  antigravity: {
    label: 'Antigravity',
    badgeClass: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
    bgClass: 'hover:bg-blue-50/50 dark:hover:bg-blue-950/20',
    borderClass: 'border-blue-200 dark:border-blue-800/40',
  },
  commandcode: {
    label: 'Command Code',
    badgeClass: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
    bgClass: 'hover:bg-emerald-50/50 dark:hover:bg-emerald-950/20',
    borderClass: 'border-emerald-200 dark:border-emerald-800/40',
  },
  opencode: {
    label: 'OpenCode',
    badgeClass: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
    bgClass: 'hover:bg-amber-50/50 dark:hover:bg-amber-950/20',
    borderClass: 'border-amber-200 dark:border-amber-800/40',
  },
};

function extractNativeId(item: NativeSessionItem): string {
  const base = item.nativePath.split('/').pop() ?? '';
  return base.replace(/\.(jsonl|db|json)$/, '');
}

function formatRelativeTime(isoString: string): string {
  try {
    const diff = Date.now() - new Date(isoString).getTime();
    if (diff < 60_000) return 'just now';
    const mins = Math.floor(diff / 60_000);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  } catch {
    return isoString;
  }
}

export function ResumeNativeSessionModal({ isOpen, onClose }: ResumeNativeSessionModalProps) {
  const [sessions, setSessions] = useState<NativeSessionItem[]>([]);
  const [filter, setFilter] = useState<RuntimeFilter>('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importingId, setImportingId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Manual entry toggle & state
  const [showManual, setShowManual] = useState(false);
  const [manualRuntime, setManualRuntime] = useState<'claude' | 'antigravity' | 'commandcode' | 'opencode'>('claude');
  const [manualNativeId, setManualNativeId] = useState('');
  const [manualCwd, setManualCwd] = useState('/root/pi-web-ui');

  const { switchSession } = useWebSocket();
  const localSwitchSession = useSessionStore((state) => state.switchSession);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchNativeSessions(undefined, 50);
      setSessions(res.sessions || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to scan CLI sessions');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      loadSessions();
    }
  }, [isOpen, loadSessions]);

  const handleCopy = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(id);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const handleResume = async (item: NativeSessionItem) => {
    const nativeId = extractNativeId(item);
    setImportingId(nativeId);
    setError(null);
    try {
      if (item.knownInRegistry && item.registrySessionId) {
        // Already registered — just select it
        localSwitchSession(item.registrySessionId);
        switchSession(item.registrySessionId);
        onClose();
        return;
      }

      const res = await importNativeSession({
        runtime: item.runtime,
        nativeId,
        cwd: item.cwd,
      });

      if (res.success && res.sessionId) {
        localSwitchSession(res.sessionId);
        switchSession(res.sessionId);
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resume session');
    } finally {
      setImportingId(null);
    }
  };

  const handleManualImport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualNativeId.trim()) return;
    setImportingId('manual');
    setError(null);
    try {
      const res = await importNativeSession({
        runtime: manualRuntime,
        nativeId: manualNativeId.trim(),
        cwd: manualCwd.trim() || undefined,
      });
      if (res.success && res.sessionId) {
        localSwitchSession(res.sessionId);
        switchSession(res.sessionId);
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to import session');
    } finally {
      setImportingId(null);
    }
  };

  if (!isOpen) return null;

  const filteredSessions = sessions.filter(
    (s) => filter === 'all' || s.runtime === filter
  );

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4 animate-in fade-in duration-200">
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl w-full max-w-2xl max-h-[85vh] shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400">
              <Terminal className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                Resume CLI Session
              </h2>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Take control of sessions previously run in terminal CLIs
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={loadSessions}
              disabled={loading}
              className="p-1.5 hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500 rounded-lg transition-colors disabled:opacity-50"
              title="Refresh sessions"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500 rounded-lg transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Runtime filter tabs */}
        <div className="flex items-center gap-1.5 px-6 py-2.5 bg-gray-50/70 dark:bg-gray-950/40 border-b border-gray-100 dark:border-gray-800 text-xs overflow-x-auto">
          {(['all', 'claude', 'antigravity', 'commandcode', 'opencode'] as const).map((r) => {
            const count = r === 'all' ? sessions.length : sessions.filter((s) => s.runtime === r).length;
            return (
              <button
                key={r}
                onClick={() => setFilter(r)}
                className={`px-2.5 py-1 rounded-lg font-medium transition-colors flex items-center gap-1.5 ${
                  filter === r
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'text-gray-600 dark:text-gray-400 hover:bg-gray-200/60 dark:hover:bg-gray-800'
                }`}
              >
                <span>{r === 'all' ? 'All' : RUNTIME_CONFIG[r]?.label || r}</span>
                <span className={`text-[10px] px-1 rounded-full ${
                  filter === r ? 'bg-blue-700 text-white' : 'bg-gray-200 dark:bg-gray-800 text-gray-500'
                }`}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        {/* Error banner */}
        {error && (
          <div className="mx-6 mt-3 p-3 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-xl flex items-center gap-2 text-xs text-red-700 dark:text-red-300">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Sessions list */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-2.5">
          {loading && sessions.length === 0 ? (
            <div className="py-12 text-center text-gray-400 dark:text-gray-500 text-sm flex flex-col items-center gap-2">
              <RefreshCw className="w-6 h-6 animate-spin text-blue-500" />
              <span>Scanning on-disk CLI stores...</span>
            </div>
          ) : filteredSessions.length === 0 ? (
            <div className="py-12 text-center text-gray-500 dark:text-gray-400 text-sm space-y-2">
              <Layers className="w-8 h-8 mx-auto text-gray-400 dark:text-gray-600" />
              <p className="font-medium">No {filter === 'all' ? 'CLI' : RUNTIME_CONFIG[filter]?.label} sessions discovered on disk</p>
              <p className="text-xs text-gray-400 max-w-sm mx-auto">
                CLI sessions started outside Pi Web UI appear here after you exit them. You can also import by ID below.
              </p>
            </div>
          ) : (
            filteredSessions.map((item) => {
              const nativeId = extractNativeId(item);
              const conf = RUNTIME_CONFIG[item.runtime] || {
                label: item.runtime,
                badgeClass: 'bg-gray-100 text-gray-800',
                bgClass: 'hover:bg-gray-50',
                borderClass: 'border-gray-200',
              };
              const isWorking = importingId === nativeId;

              return (
                <div
                  key={item.nativePath}
                  className={`p-3.5 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900/60 transition-all ${conf.bgClass} flex flex-col gap-2`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-md ${conf.badgeClass}`}>
                        {conf.label}
                      </span>
                      <span className="font-mono text-xs text-gray-600 dark:text-gray-300 truncate" title={nativeId}>
                        {nativeId.slice(0, 12)}…
                      </span>
                      <button
                        onClick={(e) => handleCopy(nativeId, e)}
                        className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 rounded transition-colors"
                        title="Copy CLI Session ID"
                      >
                        {copiedId === nativeId ? (
                          <Check className="w-3.5 h-3.5 text-green-500" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>

                    <span className="text-[11px] text-gray-400 flex-shrink-0">
                      {formatRelativeTime(item.mtime)}
                    </span>
                  </div>

                  {item.cwd && (
                    <div className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                      <Folder className="w-3.5 h-3.5 flex-shrink-0 text-gray-400" />
                      <span className="truncate font-mono">{item.cwd}</span>
                    </div>
                  )}

                  {item.preview && (
                    <p className="text-xs text-gray-700 dark:text-gray-300 line-clamp-2 bg-gray-50/80 dark:bg-gray-950/40 p-2 rounded-lg border border-gray-100 dark:border-gray-800">
                      {item.preview}
                    </p>
                  )}

                  <div className="flex items-center justify-between pt-1 mt-1 border-t border-gray-100 dark:border-gray-800">
                    <div className="text-[11px]">
                      {item.knownInRegistry ? (
                        <span className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400">
                          <Check className="w-3 h-3" /> Already in Web UI
                        </span>
                      ) : (
                        <span className="text-gray-400">Ready to resume</span>
                      )}
                    </div>

                    <button
                      onClick={() => handleResume(item)}
                      disabled={isWorking}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 shadow-sm ${
                        item.knownInRegistry
                          ? 'border border-blue-500 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/50'
                          : 'bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50'
                      }`}
                    >
                      {isWorking ? (
                        <>
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                          <span>Resuming...</span>
                        </>
                      ) : item.knownInRegistry ? (
                        <>
                          <ArrowRight className="w-3.5 h-3.5" />
                          <span>Open in Web UI</span>
                        </>
                      ) : (
                        <>
                          <Play className="w-3.5 h-3.5 fill-current" />
                          <span>Resume in Web UI</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Manual import section toggle */}
        <div className="border-t border-gray-200 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-950/30 px-6 py-3">
          {!showManual ? (
            <button
              onClick={() => setShowManual(true)}
              className="text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1"
            >
              <span>Or import a session by ID manually</span>
            </button>
          ) : (
            <form onSubmit={handleManualImport} className="space-y-3 pt-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">
                  Manual CLI Import
                </span>
                <button
                  type="button"
                  onClick={() => setShowManual(false)}
                  className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                >
                  Cancel
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div>
                  <label className="block text-[11px] text-gray-500 mb-1">Runtime</label>
                  <select
                    value={manualRuntime}
                    onChange={(e) => setManualRuntime(e.target.value as any)}
                    className="w-full text-xs rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2.5 py-1.5 text-gray-800 dark:text-gray-200"
                  >
                    <option value="claude">Claude Code</option>
                    <option value="antigravity">Antigravity</option>
                    <option value="commandcode">Command Code</option>
                    <option value="opencode">OpenCode</option>
                  </select>
                </div>

                <div className="sm:col-span-2">
                  <label className="block text-[11px] text-gray-500 mb-1">Native Session ID (UUID)</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. 78f804c6-eb38-4c01-b776-81c44aa2e607"
                    value={manualNativeId}
                    onChange={(e) => setManualNativeId(e.target.value)}
                    className="w-full text-xs rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2.5 py-1.5 font-mono text-gray-800 dark:text-gray-200"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2">
                <div className="flex-1">
                  <input
                    type="text"
                    placeholder="Working Directory (optional, defaults to current)"
                    value={manualCwd}
                    onChange={(e) => setManualCwd(e.target.value)}
                    className="w-full text-xs rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2.5 py-1.5 font-mono text-gray-800 dark:text-gray-200"
                  />
                </div>
                <button
                  type="submit"
                  disabled={importingId === 'manual' || !manualNativeId.trim()}
                  className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded-lg transition-colors disabled:opacity-50 flex items-center gap-1"
                >
                  {importingId === 'manual' ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      <span>Importing...</span>
                    </>
                  ) : (
                    <span>Import & Resume</span>
                  )}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
