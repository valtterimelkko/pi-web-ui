import { useState, useEffect, useRef } from 'react';
import { X, Folder, FolderOpen, ChevronRight, Loader2, Home, FolderCog, ArrowUp, History, ChevronDown, ChevronUp, Star, Mic, Lock } from 'lucide-react';
import { api } from '../../lib/api';
import { useUIStore } from '../../store/uiStore';
import { useSessionStore } from '../../store';

interface NewSessionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreateSession: (cwd?: string, sdkType?: 'pi' | 'claude' | 'opencode' | 'antigravity', model?: string, thinkingLevel?: string) => void;
  onOpenDriveMode?: () => void;
}

interface DirectoryItem {
  name: string;
  path: string;
}

// ─── Claude provider/backend/model selection ──────────────────────────────────

type ClaudeProvider = 'claude' | 'glm';

interface ClaudeModelEntry {
  id: string;            // 'sonnet' | 'opus' | 'haiku' | 'profile:<id>'
  displayName: string;
  provider: string;      // 'anthropic' | 'zai'
  backend?: 'sdk-subscription' | 'cli-direct' | 'channel';
  claudeModel?: string;  // sonnet/opus/haiku for profile entries
}

const PROVIDER_OF = (entry: ClaudeModelEntry): ClaudeProvider =>
  entry.provider === 'zai' ? 'glm' : 'claude';

const BACKEND_ORDER = ['sdk-subscription', 'cli-direct', 'channel'] as const;
const BACKEND_LABEL: Record<string, string> = {
  'sdk-subscription': 'SDK',
  'cli-direct': 'CLI direct',
  'channel': 'Channel',
};
const PROVIDER_LABEL: Record<ClaudeProvider, string> = { claude: 'Claude', glm: 'GLM' };
const MODEL_LABEL: Record<string, string> = { sonnet: 'Sonnet', opus: 'Opus', haiku: 'Haiku' };

/**
 * Backends that are present-but-locked in the selector. The Channel backend is
 * kept as an escape hatch but is not user-selectable from the browser: it must
 * be activated on the production server by an agent first. It still renders so
 * users can see it exists, but it is grayed out and non-clickable.
 */
const LOCKED_BACKENDS = new Set<string>(['channel']);
const isBackendLocked = (backend: string) => LOCKED_BACKENDS.has(backend);

/** Only profile-backed entries participate in the structured selector. */
const profileEntries = (models: ClaudeModelEntry[]) =>
  models.filter((m) => m.id.startsWith('profile:') && m.backend);

const providersOf = (models: ClaudeModelEntry[]): ClaudeProvider[] => {
  const set = new Set<ClaudeProvider>();
  for (const m of profileEntries(models)) set.add(PROVIDER_OF(m));
  return (['claude', 'glm'] as ClaudeProvider[]).filter((p) => set.has(p));
};

const backendsOf = (models: ClaudeModelEntry[], provider: ClaudeProvider): string[] => {
  const set = new Set<string>();
  for (const m of profileEntries(models)) if (PROVIDER_OF(m) === provider && m.backend) set.add(m.backend);
  return BACKEND_ORDER.filter((b) => set.has(b));
};

/** Selectable backends for a provider: configured backends minus locked ones.
 *  Locked backends still render (disabled) but are never auto-selected. */
const selectableBackendsOf = (models: ClaudeModelEntry[], provider: ClaudeProvider): string[] =>
  backendsOf(models, provider).filter((b) => !isBackendLocked(b));

const modelsOf = (models: ClaudeModelEntry[], provider: ClaudeProvider, backend: string): string[] => {
  const set = new Set<string>();
  for (const m of profileEntries(models))
    if (PROVIDER_OF(m) === provider && m.backend === backend && m.claudeModel) set.add(m.claudeModel);
  return ['sonnet', 'opus', 'haiku'].filter((mm) => set.has(mm));
};

/** Resolve a (provider, backend, model) selection to a `profile:<id>` model id. */
const resolveProfileId = (
  models: ClaudeModelEntry[],
  provider: ClaudeProvider,
  backend: string,
  model: string,
): string | undefined => {
  const match = profileEntries(models).find(
    (m) => PROVIDER_OF(m) === provider && m.backend === backend &&
      (provider === 'glm' || m.claudeModel === model),
  );
  return match?.id;
};

export function NewSessionModal({ isOpen, onClose, onCreateSession, onOpenDriveMode }: NewSessionModalProps) {
  const [currentPath, setCurrentPath] = useState<string>('/root');
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [directories, setDirectories] = useState<DirectoryItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRecentFolders, setShowRecentFolders] = useState(true);
  const [pathInput, setPathInput] = useState('/root');
  const [sdkType, setSdkType] = useState<'pi' | 'claude' | 'opencode' | 'antigravity'>('pi');
  const [claudeModels, setClaudeModels] = useState<ClaudeModelEntry[]>([]);
  const [claudeModelsLoading, setClaudeModelsLoading] = useState(false);
  // Structured Claude selection: provider → backend → model.
  const [claudeProvider, setClaudeProvider] = useState<ClaudeProvider>('claude');
  const [claudeBackend, setClaudeBackend] = useState<string>('sdk-subscription');
  const [claudeModel, setClaudeModel] = useState<string>('sonnet');
  const recentDropdownRef = useRef<HTMLDivElement>(null);

  const { recentFolders, addRecentFolder, getRecentFolders } = useUIStore();
  const claudeAvailable = useSessionStore(s => s.claudeAvailable);
  const claudeAuthError = useSessionStore(s => s.claudeAuthError);
  const opencodeAvailable = useSessionStore(s => s.opencodeAvailable);
  const opencodeAuthError = useSessionStore(s => s.opencodeAuthError);
  const antigravityAvailable = useSessionStore(s => s.antigravityAvailable);
  const antigravityAuthError = useSessionStore(s => s.antigravityAuthError);
  const topRecentFolders = getRecentFolders(8);

  const fetchDirectories = async (path: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.get(`/api/files/browse?path=${encodeURIComponent(path)}`) as {
        path: string;
        parent: string | null;
        items: Array<{ name: string; type: string; path: string }>;
      };

      const dirs = (response.items || [])
        .filter((entry) => entry.type === 'directory')
        .map((entry) => ({
          name: entry.name,
          path: entry.path,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      setDirectories(dirs);
      setCurrentPath(response.path || path);
      setPathInput(response.path || path);
      setParentPath(response.parent);
    } catch (err) {
      console.error('Failed to fetch directories:', err);
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      setError(`Access denied or path not found. (${errorMsg})`);
      setDirectories([]);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchDirectories('/root');
      setShowRecentFolders(true);
      setIsCreating(false);
    }
  }, [isOpen]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (recentDropdownRef.current && !recentDropdownRef.current.contains(event.target as Node)) {
        // Don't close - let user toggle manually
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Fetch Claude models/profiles when the Claude session type is chosen so the
  // user can pick a backend/provider profile (e.g. GLM 5.2 via SDK) before the
  // session opens. Profiles surface as `profile:<id>` model entries.
  useEffect(() => {
    if (!isOpen || sdkType !== 'claude' || claudeModels.length > 0) return;
    let cancelled = false;
    setClaudeModelsLoading(true);
    api.get('/api/models?sdkType=claude')
      .then((resp) => {
        if (cancelled) return;
        const models = (resp as { models?: ClaudeModelEntry[] }).models || [];
        setClaudeModels(models);
        // Default to the first available provider/backend/model in priority order.
        const provs = providersOf(models);
        const prov = provs.includes('claude') ? 'claude' : (provs[0] || 'claude');
        const backends = selectableBackendsOf(models, prov);
        const backend = backends[0] || 'sdk-subscription';
        const ms = modelsOf(models, prov, backend);
        setClaudeProvider(prov);
        setClaudeBackend(backend);
        setClaudeModel(ms.includes('sonnet') ? 'sonnet' : (ms[0] || 'sonnet'));
      })
      .catch((err) => console.error('Failed to fetch Claude models:', err))
      // Always clear the loading spinner when the request ends. The `cancelled`
      // flag still guards the *data* writes above (so a superseded request
      // can't overwrite newer state), but the loading flag is pure UI and must
      // never get stuck true if this effect was cleaned up mid-flight.
      .finally(() => setClaudeModelsLoading(false));
    return () => { cancelled = true; };
  }, [isOpen, sdkType, claudeModels.length]);

  // Switch provider: reset backend + model to the first available for it.
  const selectProvider = (prov: ClaudeProvider) => {
    setClaudeProvider(prov);
    const backends = selectableBackendsOf(claudeModels, prov);
    const backend = backends[0] || 'sdk-subscription';
    setClaudeBackend(backend);
    const ms = modelsOf(claudeModels, prov, backend);
    setClaudeModel(ms.includes('sonnet') ? 'sonnet' : (ms[0] || 'sonnet'));
  };

  // Switch backend: reset model to the first available for provider+backend.
  // Locked backends (e.g. Channel) are never selectable here — the button is
  // disabled in the UI — but we guard defensively regardless.
  const selectBackend = (backend: string) => {
    if (isBackendLocked(backend)) return;
    setClaudeBackend(backend);
    const ms = modelsOf(claudeModels, claudeProvider, backend);
    setClaudeModel(ms.includes('sonnet') ? 'sonnet' : (ms[0] || 'sonnet'));
  };

  // The model arg passed to onCreateSession — only Claude sessions carry one.
  // Resolves the structured selection to `profile:<id>`; falls back to the bare
  // model alias if profiles are unavailable.
  const claudeModelArg = () => {
    if (sdkType !== 'claude') return undefined;
    if (profileEntries(claudeModels).length === 0) return claudeModel;
    return resolveProfileId(claudeModels, claudeProvider, claudeBackend, claudeModel) || claudeModel;
  };

  // Derived lists for the structured Claude selector.
  const providerList = providersOf(claudeModels);
  const backendList = backendsOf(claudeModels, claudeProvider);
  const modelList = modelsOf(claudeModels, claudeProvider, claudeBackend);

  const handleNavigate = (dir: DirectoryItem) => {
    fetchDirectories(dir.path);
  };

  const handleNavigateUp = () => {
    if (parentPath) {
      fetchDirectories(parentPath);
    }
  };

  const handlePathSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pathInput.trim()) {
      fetchDirectories(pathInput.trim());
    }
  };

  const handleSelectAndCreate = () => {
    if (isCreating) return;
    setIsCreating(true);
    addRecentFolder(currentPath);
    onCreateSession(currentPath, sdkType, claudeModelArg());
    onClose(); // Close modal immediately - creation happens in background
  };

  const handleQuickSelect = (path: string) => {
    if (isCreating) return;
    setIsCreating(true);
    addRecentFolder(path);
    onCreateSession(path, sdkType, claudeModelArg());
    onClose(); // Close modal immediately - creation happens in background
  };

  const handleRecentFolderSelect = (path: string) => {
    if (isCreating) return;
    addRecentFolder(path);
    fetchDirectories(path);
  };

  const handleCreateInRecentFolder = (e: React.MouseEvent, path: string) => {
    if (isCreating) return;
    e.stopPropagation();
    setIsCreating(true);
    addRecentFolder(path);
    onCreateSession(path, sdkType, claudeModelArg());
    onClose(); // Close modal immediately - creation happens in background
  };

  // Close on Escape
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50" data-testid="new-session-modal" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bg-white rounded-t-xl sm:rounded-xl border border-gray-200 shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-3 sm:p-4 border-b border-gray-200 flex-shrink-0">
          <div>
            <h2 className="text-base sm:text-lg font-semibold text-gray-900">Create New Session</h2>
            <p className="text-xs sm:text-sm text-gray-500">Select a workspace folder</p>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <X className="w-5 h-5 text-gray-400" />
          </button>
        </div>

        {/* SDK Type Selector */}
        <div className="px-3 sm:px-4 pt-2 pb-2 border-b border-gray-200 flex-shrink-0">
          <p className="text-xs font-medium text-gray-500 mb-1.5">Session Type</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {/* Pi SDK option */}
            <button
              onClick={() => setSdkType('pi')}
              className={`flex flex-col items-start p-2 sm:p-3 rounded-lg border text-left transition-colors ${
                sdkType === 'pi'
                  ? 'border-blue-500 bg-blue-50 text-gray-900'
                  : 'border-gray-200 bg-gray-50 text-gray-600 hover:border-gray-300'
              }`}
            >
              <span className="text-sm font-medium">Pi SDK</span>
              <span className="text-xs text-gray-500 mt-0.5 hidden sm:inline">All providers • Extensions</span>
              <span className="text-xs text-gray-500 mt-0.5 sm:hidden">All providers</span>
            </button>

            {/* Claude Direct option */}
            <button
              onClick={() => claudeAvailable && setSdkType('claude')}
              disabled={!claudeAvailable}
              title={claudeAuthError || undefined}
              className={`flex flex-col items-start p-2 sm:p-3 rounded-lg border text-left transition-colors ${
                !claudeAvailable
                  ? 'border-gray-200 bg-gray-100 text-gray-400 cursor-not-allowed'
                  : sdkType === 'claude'
                  ? 'border-amber-500 bg-amber-50 text-gray-900'
                  : 'border-gray-200 bg-gray-50 text-gray-600 hover:border-gray-300'
              }`}
            >
              <span className="text-sm font-medium">Claude Direct</span>
              <span className="text-xs text-gray-500 mt-0.5 hidden sm:inline">
                {claudeAvailable ? 'Subscription quota • CC tools' : (claudeAuthError || 'Not available')}
              </span>
              <span className="text-xs text-gray-500 mt-0.5 sm:hidden">
                {claudeAvailable ? 'Subscription' : (claudeAuthError || 'Not available')}
              </span>
            </button>

            {/* OpenCode Direct option — mirrors Claude Direct pattern exactly */}
            <button
              onClick={() => opencodeAvailable && setSdkType('opencode')}
              disabled={!opencodeAvailable}
              title={opencodeAuthError || undefined}
              className={`flex flex-col items-start p-2 sm:p-3 rounded-lg border text-left transition-colors ${
                !opencodeAvailable
                  ? 'border-gray-200 bg-gray-100 text-gray-400 cursor-not-allowed'
                  : sdkType === 'opencode'
                  ? 'border-emerald-500 bg-emerald-50 text-gray-900'
                  : 'border-gray-200 bg-gray-50 text-gray-600 hover:border-gray-300'
              }`}
            >
              <span className="text-sm font-medium">OpenCode Direct</span>
              <span className="text-xs text-gray-500 mt-0.5 hidden sm:inline">
                {opencodeAvailable ? 'Z.AI GLM • OpenCode runtime' : (opencodeAuthError || 'Not available')}
              </span>
              <span className="text-xs text-gray-500 mt-0.5 sm:hidden">
                {opencodeAvailable ? 'Z.AI GLM' : (opencodeAuthError || 'Not available')}
              </span>
            </button>

            {/* Antigravity option */}
            <button
              onClick={() => antigravityAvailable && setSdkType('antigravity')}
              disabled={!antigravityAvailable}
              title={antigravityAuthError || undefined}
              className={`flex flex-col items-start p-2 sm:p-3 rounded-lg border text-left transition-colors ${
                !antigravityAvailable
                  ? 'border-gray-200 bg-gray-100 text-gray-400 cursor-not-allowed'
                  : sdkType === 'antigravity'
                  ? 'border-violet-500 bg-violet-50 text-gray-900'
                  : 'border-gray-200 bg-gray-50 text-gray-600 hover:border-gray-300'
              }`}
            >
              <span className="text-sm font-medium">Antigravity</span>
              <span className="text-xs text-gray-500 mt-0.5 hidden sm:inline">
                {antigravityAvailable ? 'Gemini Flash • Google' : (antigravityAuthError || 'Not available')}
              </span>
              <span className="text-xs text-gray-500 mt-0.5 sm:hidden">
                {antigravityAvailable ? 'Gemini Flash' : (antigravityAuthError || 'Not available')}
              </span>
            </button>
          </div>

          {/* Claude provider / backend / model selector */}
          {sdkType === 'claude' && (
            <div className="mt-2 space-y-2" data-testid="claude-model-selector">
              {claudeModelsLoading ? (
                <div className="flex items-center gap-2 text-xs text-gray-400 py-2">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading profiles…
                </div>
              ) : providerList.length === 0 ? (
                // No profiles configured — fall back to a simple model dropdown.
                <div>
                  <p className="text-xs font-medium text-gray-500 mb-1.5">Model</p>
                  <select
                    value={claudeModel}
                    onChange={(e) => setClaudeModel(e.target.value)}
                    data-testid="claude-model-select"
                    className="w-full px-3 py-2 bg-gray-50 rounded-lg text-sm text-gray-900 border border-gray-200 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-500/20"
                  >
                    <option value="sonnet">Claude Sonnet</option>
                    <option value="opus">Claude Opus</option>
                    <option value="haiku">Claude Haiku</option>
                  </select>
                </div>
              ) : (
                <>
                  {/* Provider */}
                  <div>
                    <p className="text-xs font-medium text-gray-500 mb-1.5">Provider</p>
                    <div className="flex gap-2" data-testid="claude-provider-toggle">
                      {providerList.map((p) => (
                        <button
                          key={p}
                          onClick={() => selectProvider(p)}
                          data-testid={`claude-provider-${p}`}
                          className={`px-3 py-1.5 rounded-lg border text-sm transition-colors ${
                            claudeProvider === p
                              ? 'border-amber-500 bg-amber-50 text-gray-900 font-medium'
                              : 'border-gray-200 bg-gray-50 text-gray-600 hover:border-gray-300'
                          }`}
                        >
                          {PROVIDER_LABEL[p]}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Backend */}
                  <div>
                    <p className="text-xs font-medium text-gray-500 mb-1.5">Backend</p>
                    <div className="flex flex-wrap gap-2" data-testid="claude-backend-toggle">
                      {backendList.map((b) => {
                        const locked = isBackendLocked(b);
                        return (
                          <button
                            key={b}
                            onClick={() => !locked && selectBackend(b)}
                            disabled={locked}
                            data-testid={`claude-backend-${b}`}
                            aria-disabled={locked || undefined}
                            title={
                              locked
                                ? 'Locked — an agent must activate this backend on the production server first.'
                                : undefined
                            }
                            className={`px-3 py-1.5 rounded-lg border text-sm transition-colors inline-flex items-center gap-1 ${
                              locked
                                ? 'border-gray-200 bg-gray-100 text-gray-400 cursor-not-allowed'
                                : claudeBackend === b
                                  ? 'border-amber-500 bg-amber-50 text-gray-900 font-medium'
                                  : 'border-gray-200 bg-gray-50 text-gray-600 hover:border-gray-300'
                            }`}
                          >
                            {BACKEND_LABEL[b] || b}
                            {locked && <Lock className="w-3 h-3" data-testid={`claude-backend-${b}-lock`} />}
                          </button>
                        );
                      })}
                    </div>
                    {backendList.some(isBackendLocked) && (
                      <p className="text-[11px] text-gray-400 mt-1" data-testid="claude-backend-locked-note">
                        The Channel backend is locked — an agent must activate it on the production server first.
                      </p>
                    )}
                  </div>

                  {/* Model (Claude only) */}
                  {claudeProvider === 'claude' && modelList.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-gray-500 mb-1.5">Model</p>
                      <select
                        value={claudeModel}
                        onChange={(e) => setClaudeModel(e.target.value)}
                        data-testid="claude-model-select"
                        className="w-full px-3 py-2 bg-gray-50 rounded-lg text-sm text-gray-900 border border-gray-200 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-500/20"
                      >
                        {modelList.map((m) => (
                          <option key={m} value={m}>{MODEL_LABEL[m] || m}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  <p className="text-[11px] text-gray-400" data-testid="claude-resolved-profile">
                    {claudeProvider === 'glm'
                      ? 'GLM 5.2 · 1M context window, via the selected backend. Reasoning effort follows the Thinking Level in Settings.'
                      : 'Native Claude subscription via the selected backend.'}
                  </p>
                </>
              )}
            </div>
          )}
        </div>

        {/* Scrollable Content Area */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {/* Recent Folders Section */}
          {recentFolders.length > 0 && (
            <div className="border-b border-gray-200" ref={recentDropdownRef}>
              <button
                onClick={() => setShowRecentFolders(!showRecentFolders)}
                className="w-full flex items-center justify-between px-3 sm:px-4 py-2 hover:bg-gray-50 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <History className="w-4 h-4 text-blue-600" />
                  <span className="text-sm font-medium text-gray-700">Recent Projects</span>
                  <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                    {recentFolders.length}
                  </span>
                </div>
                {showRecentFolders ? (
                  <ChevronUp className="w-4 h-4 text-gray-400" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-gray-400" />
                )}
              </button>
              
              {showRecentFolders && (
                <div className="px-3 sm:px-4 pb-3">
                  <div className="grid grid-cols-1 gap-1.5">
                    {topRecentFolders.map((folder, index) => (
                      <div
                        key={folder.path}
                        className="group flex items-center gap-2 p-2 bg-gray-50 hover:bg-gray-100 border border-gray-200 rounded-lg cursor-pointer transition-all"
                        onClick={() => handleRecentFolderSelect(folder.path)}
                      >
                        <div className="flex-shrink-0 w-7 h-7 sm:w-8 sm:h-8 bg-blue-100 rounded-lg flex items-center justify-center">
                          {index === 0 ? (
                            <Star className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-blue-600 fill-blue-600" />
                          ) : (
                            <Folder className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-blue-600" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-700 truncate" title={folder.label}>
                            {folder.label}
                          </p>
                          <p className="text-xs text-gray-400 truncate" title={folder.path}>
                            {folder.path}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                          <span className="text-xs text-gray-400 bg-gray-200 px-1.5 py-0.5 rounded hidden sm:inline">
                            {folder.count}
                          </span>
                          <button
                            onClick={(e) => handleCreateInRecentFolder(e, folder.path)}
                            disabled={isCreating}
                            className="px-2 py-1 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed text-white text-xs rounded transition-colors"
                          >
                            {isCreating ? '...' : 'Create'}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Path Input */}
          <div className="px-3 sm:px-4 py-3 border-b border-gray-200">
            <form onSubmit={handlePathSubmit} className="flex gap-2">
              <input
                type="text"
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                placeholder="Enter path..."
                className="flex-1 px-3 py-2 bg-gray-50 rounded-lg text-sm text-gray-900 placeholder-gray-400 border border-gray-200 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
              <button
                type="submit"
                className="px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm text-gray-700 transition-colors border border-gray-200"
              >
                Go
              </button>
            </form>
          </div>

          {/* Directory Browser */}
          <div className="flex flex-col min-h-[100px] sm:min-h-[150px]">
            {/* Breadcrumb */}
            <div className="px-3 sm:px-4 py-2 bg-gray-50 border-b border-gray-200 flex items-center gap-2 sticky top-0">
              <Folder className="w-4 h-4 text-blue-600 flex-shrink-0" />
              {parentPath && (
                <button
                  onClick={handleNavigateUp}
                  className="p-1 hover:bg-gray-200 rounded transition-colors flex-shrink-0"
                  title="Go up"
                >
                  <ArrowUp className="w-4 h-4 text-gray-400" />
                </button>
              )}
              <ChevronRight className="w-4 h-4 text-gray-300 flex-shrink-0" />
              <span className="text-sm text-gray-700 truncate">{currentPath}</span>
            </div>

            {/* Directory List */}
            <div className="p-2">
              {isLoading ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="w-6 h-6 text-blue-600 animate-spin" />
                </div>
              ) : error ? (
                <div className="text-center py-6">
                  <p className="text-red-500 text-sm mb-3">{error}</p>
                  <button
                    onClick={() => fetchDirectories('/root')}
                    className="text-blue-600 text-sm hover:underline"
                  >
                    Reset to /root
                  </button>
                </div>
              ) : directories.length === 0 ? (
                <div className="text-center py-6 text-gray-400 text-sm">
                  No subdirectories. Use this folder or enter a custom path.
                </div>
              ) : (
                <div className="space-y-0.5">
                  {directories.map((dir) => (
                    <div
                      key={dir.path}
                      role="button"
                      tabIndex={0}
                      onClick={() => handleNavigate(dir)}
                      onKeyDown={(e) => e.key === 'Enter' && handleNavigate(dir)}
                      className="w-full flex items-center gap-3 px-3 py-2 hover:bg-gray-100 active:bg-gray-200 rounded-lg transition-colors cursor-pointer select-none"
                    >
                      <FolderOpen className="w-5 h-5 text-blue-600 flex-shrink-0" />
                      <span className="text-sm text-gray-700 truncate flex-1">{dir.name}</span>
                      <ChevronRight className="w-4 h-4 text-gray-300 flex-shrink-0" />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer - Always visible */}
        <div className="flex items-center justify-between gap-3 p-3 sm:p-4 border-t border-gray-200 bg-white flex-shrink-0">
          <p className="text-xs text-gray-400 truncate flex-1 min-w-0">
            <span className="hidden sm:inline">Selected: </span>
            <span className="text-gray-600 font-mono">{currentPath}</span>
          </p>
          <div className="flex gap-2 sm:gap-3 flex-shrink-0">
            <button
              onClick={onClose}
              disabled={isCreating}
              className="px-3 sm:px-4 py-2 text-gray-500 hover:text-gray-700 disabled:opacity-50 transition-colors text-sm"
            >
              Cancel
            </button>
            {onOpenDriveMode && (
              <button
                onClick={() => {
                  onClose();
                  onOpenDriveMode();
                }}
                disabled={isCreating}
                className="px-3 sm:px-4 py-2 border border-blue-500 text-blue-600 hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors flex items-center gap-1.5 text-sm"
              >
                <Mic className="w-3.5 h-3.5" />
                Drive Mode
              </button>
            )}
            <button
              onClick={handleSelectAndCreate}
              disabled={isCreating}
              className="px-3 sm:px-4 py-2 bg-gray-900 hover:bg-gray-800 disabled:bg-gray-400 disabled:cursor-not-allowed rounded-lg text-white transition-colors flex items-center gap-2 text-sm"
            >
              {isCreating && <Loader2 className="w-4 h-4 animate-spin" />}
              {isCreating ? 'Creating...' : 'Create'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
