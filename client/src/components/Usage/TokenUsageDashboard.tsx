import { useEffect, useState } from 'react';
import { X, Coins, Activity, Cpu, FolderGit2, TrendingUp, Trash2, RefreshCw } from 'lucide-react';

interface UsageStats {
  totals: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
    cost: number;
    sessions: number;
    messages: number;
  };
  byModel: Record<string, { count: number; tokens: number; cost: number }>;
  byProject: Record<string, { tokens: number; cost: number; sessions: number }>;
  last7Days: Record<string, { tokens: number; cost: number; sessions: number }>;
  recentRecords: Array<{
    sessionId: string;
    cwd: string;
    model: string;
    tokens: { total: number };
    cost: number;
    timestamp: string;
  }>;
  lastUpdated: string;
}

interface TokenUsageDashboardProps {
  isOpen: boolean;
  onClose: () => void;
}

export function TokenUsageDashboard({ isOpen, onClose }: TokenUsageDashboardProps) {
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/usage', {
        credentials: 'include',
      });
      if (!response.ok) throw new Error('Failed to fetch usage stats');
      const data = await response.json();
      setStats(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load usage stats');
    } finally {
      setLoading(false);
    }
  };

  const clearHistory = async () => {
    if (!confirm('Are you sure you want to clear all usage history? This cannot be undone.')) {
      return;
    }
    try {
      const response = await fetch('/api/usage', {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!response.ok) throw new Error('Failed to clear history');
      await fetchStats();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear history');
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchStats();
    }
  }, [isOpen]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const formatNumber = (num: number) => num.toLocaleString();
  const formatCost = (cost: number) => `$${cost.toFixed(4)}`;
  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  return (
    <div
      className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 animate-in fade-in"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-white rounded-xl border border-gray-200 shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-hidden animate-in zoom-in-95">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <div className="flex items-center gap-3">
            <Coins className="w-5 h-5 text-blue-600" />
            <h2 className="text-lg font-semibold text-gray-900">Token Usage Dashboard</h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={fetchStats}
              disabled={loading}
              className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              title="Refresh"
            >
              <RefreshCw className={`w-4 h-4 text-gray-400 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={onClose}
              className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <X className="w-5 h-5 text-gray-400" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-4 overflow-y-auto max-h-[calc(90vh-140px)]">
          {loading && !stats && (
            <div className="text-center py-8 text-gray-400">
              <Activity className="w-8 h-8 mx-auto mb-2 animate-pulse" />
              Loading usage stats...
            </div>
          )}

          {error && (
            <div className="text-center py-8 text-red-500">
              <p>{error}</p>
              <button
                onClick={fetchStats}
                className="mt-2 text-sm text-blue-600 hover:underline"
              >
                Try again
              </button>
            </div>
          )}

          {stats && (
            <div className="space-y-6">
              {/* Totals */}
              <div className="bg-gradient-to-br from-blue-50 to-cyan-50 rounded-lg p-4">
                <h3 className="text-sm font-medium text-gray-500 mb-3 flex items-center gap-2">
                  <TrendingUp className="w-4 h-4" />
                  Overall Statistics
                </h3>
                <div className="grid grid-cols-3 gap-4">
                  <div className="text-center">
                    <p className="text-2xl font-bold text-gray-900">{formatNumber(stats.totals.total)}</p>
                    <p className="text-xs text-gray-500">Total Tokens</p>
                  </div>
                  <div className="text-center">
                    <p className="text-2xl font-bold text-blue-600">{formatCost(stats.totals.cost)}</p>
                    <p className="text-xs text-gray-500">Total Cost</p>
                  </div>
                  <div className="text-center">
                    <p className="text-2xl font-bold text-gray-900">{stats.totals.sessions}</p>
                    <p className="text-xs text-gray-500">Sessions</p>
                  </div>
                </div>
                <div className="grid grid-cols-4 gap-2 mt-4 text-sm">
                  <div className="text-center p-2 bg-white/50 rounded">
                    <p className="font-medium text-gray-700">{formatNumber(stats.totals.input)}</p>
                    <p className="text-xs text-gray-400">Input</p>
                  </div>
                  <div className="text-center p-2 bg-white/50 rounded">
                    <p className="font-medium text-gray-700">{formatNumber(stats.totals.output)}</p>
                    <p className="text-xs text-gray-400">Output</p>
                  </div>
                  <div className="text-center p-2 bg-white/50 rounded">
                    <p className="font-medium text-gray-700">{formatNumber(stats.totals.cacheRead)}</p>
                    <p className="text-xs text-gray-400">Cache Read</p>
                  </div>
                  <div className="text-center p-2 bg-white/50 rounded">
                    <p className="font-medium text-gray-700">{formatNumber(stats.totals.cacheWrite)}</p>
                    <p className="text-xs text-gray-400">Cache Write</p>
                  </div>
                </div>
              </div>

              {/* Last 7 Days */}
              {Object.keys(stats.last7Days).length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-gray-500 mb-3 flex items-center gap-2">
                    <Activity className="w-4 h-4" />
                    Last 7 Days
                  </h3>
                  <div className="grid grid-cols-7 gap-1">
                    {Object.entries(stats.last7Days)
                      .sort(([a], [b]) => a.localeCompare(b))
                      .map(([day, data]) => {
                        const maxTokens = Math.max(...Object.values(stats.last7Days).map(d => d.tokens), 1);
                        const height = (data.tokens / maxTokens) * 100;
                        return (
                          <div key={day} className="text-center">
                            <div className="h-16 flex items-end justify-center mb-1">
                              <div
                                className="w-6 bg-blue-400 rounded-t transition-all"
                                style={{ height: `${Math.max(height, 5)}%` }}
                                title={`${formatNumber(data.tokens)} tokens, ${formatCost(data.cost)}`}
                              />
                            </div>
                            <p className="text-xs text-gray-400">{formatDate(day)}</p>
                          </div>
                        );
                      })}
                  </div>
                </div>
              )}

              {/* By Model */}
              {Object.keys(stats.byModel).length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-gray-500 mb-3 flex items-center gap-2">
                    <Cpu className="w-4 h-4" />
                    By Model
                  </h3>
                  <div className="space-y-2">
                    {Object.entries(stats.byModel)
                      .sort(([, a], [, b]) => b.tokens - a.tokens)
                      .slice(0, 5)
                      .map(([model, data]) => (
                        <div key={model} className="flex items-center justify-between p-2 bg-gray-50 rounded">
                          <span className="text-sm text-gray-700 truncate flex-1" title={model}>
                            {model.split('/').pop()}
                          </span>
                          <span className="text-sm text-gray-500 ml-2">
                            {formatNumber(data.tokens)} tokens
                          </span>
                          <span className="text-sm text-blue-600 ml-2">
                            {formatCost(data.cost)}
                          </span>
                        </div>
                      ))}
                  </div>
                </div>
              )}

              {/* By Project */}
              {Object.keys(stats.byProject).length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-gray-500 mb-3 flex items-center gap-2">
                    <FolderGit2 className="w-4 h-4" />
                    By Project
                  </h3>
                  <div className="space-y-2">
                    {Object.entries(stats.byProject)
                      .sort(([, a], [, b]) => b.tokens - a.tokens)
                      .slice(0, 5)
                      .map(([project, data]) => (
                        <div key={project} className="flex items-center justify-between p-2 bg-gray-50 rounded">
                          <span className="text-sm text-gray-700 truncate flex-1" title={project}>
                            {project}
                          </span>
                          <span className="text-sm text-gray-500 ml-2">
                            {data.sessions} sessions
                          </span>
                          <span className="text-sm text-blue-600 ml-2">
                            {formatCost(data.cost)}
                          </span>
                        </div>
                      ))}
                  </div>
                </div>
              )}

              {/* Recent Sessions */}
              {stats.recentRecords.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-gray-500 mb-3 flex items-center gap-2">
                    <Activity className="w-4 h-4" />
                    Recent Sessions
                  </h3>
                  <div className="space-y-1 max-h-48 overflow-y-auto">
                    {stats.recentRecords.slice(0, 10).map((record, index) => (
                      <div key={index} className="flex items-center justify-between p-2 bg-gray-50 rounded text-sm">
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          <span className="text-gray-400 truncate" title={record.cwd}>
                            {record.cwd?.split('/').pop() || 'unknown'}
                          </span>
                          <span className="text-gray-300">•</span>
                          <span className="text-gray-500 truncate" title={record.model}>
                            {record.model?.split('/').pop()}
                          </span>
                        </div>
                        <span className="text-gray-400 ml-2">
                          {new Date(record.timestamp).toLocaleDateString()}
                        </span>
                        <span className="text-blue-600 ml-2 font-medium">
                          {formatCost(record.cost)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Empty State */}
              {stats.totals.sessions === 0 && (
                <div className="text-center py-8 text-gray-400">
                  <Coins className="w-8 h-8 mx-auto mb-2" />
                  <p>No usage data yet</p>
                  <p className="text-sm mt-1">Start a conversation to track token usage</p>
                </div>
              )}

              {/* Last Updated */}
              {stats.lastUpdated && (
                <p className="text-xs text-gray-400 text-center">
                  Last updated: {new Date(stats.lastUpdated).toLocaleString()}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-between p-4 border-t border-gray-200">
          <button
            onClick={clearHistory}
            disabled={!stats || stats.totals.sessions === 0}
            className="flex items-center gap-2 px-4 py-2 text-red-600 hover:bg-red-50 rounded-lg text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Trash2 className="w-4 h-4" />
            Clear History
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm text-gray-700 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
