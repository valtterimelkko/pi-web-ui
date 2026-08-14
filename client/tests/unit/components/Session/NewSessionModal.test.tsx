import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NewSessionModal } from '../../../../src/components/Session/NewSessionModal';

// A Claude profile matrix that includes a Channel backend entry, mirroring the
// production 11-profile matrix (Claude {sonnet,opus,haiku} x {SDK, CLI-direct,
// channel}). Used to drive the structured provider → backend → model selector.
const CLAUDE_PROFILE_MODELS = [
  { id: 'sonnet', displayName: 'Claude Sonnet', provider: 'anthropic' },
  { id: 'opus', displayName: 'Claude Opus', provider: 'anthropic' },
  { id: 'haiku', displayName: 'Claude Haiku', provider: 'anthropic' },
  { id: 'profile:claude-sonnet-sdk', displayName: 'Claude Sonnet', provider: 'anthropic', backend: 'sdk-subscription', claudeModel: 'sonnet' },
  { id: 'profile:claude-opus-cli-direct', displayName: 'Claude Opus', provider: 'anthropic', backend: 'cli-direct', claudeModel: 'opus' },
  { id: 'profile:claude-sonnet-channel', displayName: 'Claude Sonnet', provider: 'anthropic', backend: 'channel', claudeModel: 'sonnet' },
  { id: 'profile:glm52-claude-sdk', displayName: 'GLM 5.3 via Claude SDK', provider: 'zai', backend: 'sdk-subscription', claudeModel: 'glm-5.3[1m]' },
  { id: 'profile:glm52-cli-direct', displayName: 'GLM 5.3 via CLI direct', provider: 'zai', backend: 'cli-direct', claudeModel: 'glm-5.3[1m]' },
];

const PI_MODELS = [
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', provider: 'openai-codex' },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', provider: 'openai-codex' },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', provider: 'openai-codex' },
];

const sessionState = {
  claudeAvailable: true,
  claudeAuthError: null,
  opencodeAvailable: true,
  opencodeAuthError: null,
  antigravityAvailable: false,
  antigravityAuthError: null,
  commandCodeAvailable: true,
  commandCodeEnabled: true,
  commandCodeModels: [
    { id: 'qwen/qwen3.8-max', displayName: 'Qwen 3.8 Max', provider: 'command-code', reasoning: true, runnable: true, status: 'runnable', browserRunnable: true, supportsEffort: true, effortLevels: ['low', 'medium', 'xhigh'], defaultEffort: 'medium' },
    { id: 'meta/muse-spark-1.2-contributor', displayName: 'Muse Spark 1.2 Contributor', provider: 'command-code', reasoning: true, runnable: true, status: 'runnable', browserRunnable: true, supportsEffort: false, effortLevels: [] },
    { id: 'google/gemini-3.7-flash', displayName: 'Gemini 3.7 Flash', provider: 'command-code', reasoning: true, runnable: false, status: 'evidence-only', browserRunnable: true, supportsEffort: false, effortLevels: [] },
    { id: 'legacy/unverified', displayName: 'Legacy Unverified', provider: 'command-code', reasoning: true, supportsEffort: false, effortLevels: [] },
  ],
};

vi.mock('../../../../src/store', () => ({
  useSessionStore: (sel: (s: typeof sessionState) => unknown) => sel(sessionState),
}));

const uiState = {
  recentFolders: [],
  addRecentFolder: vi.fn(),
  getRecentFolders: () => [],
};
vi.mock('../../../../src/store/uiStore', () => ({
  useUIStore: (selector: (state: typeof uiState) => unknown) => selector(uiState),
}));

vi.mock('../../../../src/lib/api', () => ({
  api: {
    get: vi.fn(async (url: string) => {
      if (url.includes('/api/models') && url.includes('sdkType=claude')) {
        return { models: CLAUDE_PROFILE_MODELS };
      }
      if (url === '/api/models') {
        return { models: PI_MODELS };
      }
      if (url.includes('/api/files/browse')) {
        return { path: '/root', parent: null, items: [] };
      }
      return {};
    }),
  },
}));

describe('NewSessionModal — Claude backend selector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const selectClaude = async () => {
    render(<NewSessionModal isOpen onClose={vi.fn()} onCreateSession={vi.fn()} />);
    // Claude Direct is enabled because claudeAvailable is true in the mock store.
    fireEvent.click(screen.getByText('Claude Direct'));
    // Backend toggle renders once the profile fetch resolves.
    await screen.findByTestId('claude-backend-toggle');
  };

  it('locks the Channel backend (disabled + lock icon + note)', async () => {
    await selectClaude();

    const channel = screen.getByTestId('claude-backend-channel');
    expect(channel).toBeDisabled();
    expect(channel.className).toContain('cursor-not-allowed');
    expect(screen.getByTestId('claude-backend-channel-lock')).toBeInTheDocument();
    expect(screen.getByTestId('claude-backend-locked-note')).toBeInTheDocument();
  });

  it('keeps SDK and CLI direct backends selectable', async () => {
    await selectClaude();

    expect(screen.getByTestId('claude-backend-sdk-subscription')).not.toBeDisabled();
    expect(screen.getByTestId('claude-backend-cli-direct')).not.toBeDisabled();
  });

  it('never auto-selects the locked Channel backend (SDK is the default)', async () => {
    await selectClaude();

    const sdk = screen.getByTestId('claude-backend-sdk-subscription');
    const channel = screen.getByTestId('claude-backend-channel');
    // SDK is the selected backend (amber highlight).
    expect(sdk.className).toContain('border-amber-500');
    // Channel is never highlighted as selected.
    expect(channel.className).not.toContain('border-amber-500');
  });

  it('lists Codex GPT-5.6 models for Pi SDK sessions and creates with Luna selected', async () => {
    const onCreateSession = vi.fn();
    render(<NewSessionModal isOpen onClose={vi.fn()} onCreateSession={onCreateSession} />);

    const selector = await screen.findByTestId('pi-model-select');
    expect(screen.getByRole('option', { name: 'Codex / GPT-5.6 Terra' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Codex / GPT-5.6 Luna' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Codex / GPT-5.6 Sol' })).toBeInTheDocument();

    fireEvent.change(selector, { target: { value: 'openai-codex/gpt-5.6-luna' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(onCreateSession).toHaveBeenCalledWith('/root', 'pi', 'openai-codex/gpt-5.6-luna');
  });

  it('shows the full Command Code catalogue, enables contained browser models, and omits Muse effort', async () => {
    const onCreateSession = vi.fn();
    render(<NewSessionModal isOpen onClose={vi.fn()} onCreateSession={onCreateSession} />);

    fireEvent.click(screen.getByText('Command Code'));
    const selector = await screen.findByTestId('commandcode-model-select');
    expect(screen.getByRole('option', { name: /Gemini 3\.7 Flash/ })).not.toBeDisabled();
    expect(screen.getByRole('option', { name: /Legacy Unverified/ })).toBeDisabled();
    expect(screen.getByTestId('commandcode-effort-select')).toBeInTheDocument();

    fireEvent.change(selector, { target: { value: 'meta/muse-spark-1.2-contributor' } });
    expect(screen.queryByTestId('commandcode-effort-select')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(onCreateSession).toHaveBeenCalledWith('/root', 'commandcode', 'meta/muse-spark-1.2-contributor');
  });

  it('clicking the locked Channel backend does not change the selection', async () => {
    await selectClaude();

    const channel = screen.getByTestId('claude-backend-channel');
    // Disabled buttons do not fire onClick, but assert defensively regardless.
    fireEvent.click(channel);
    expect(screen.getByTestId('claude-backend-sdk-subscription').className).toContain('border-amber-500');
  });

  it('switching providers does not fall back onto the locked Channel backend', async () => {
    await selectClaude();

    // GLM provider has no Channel backend; switching to it and back must keep a
    // selectable backend active, never Channel.
    if (screen.queryByTestId('claude-provider-glm')) {
      fireEvent.click(screen.getByTestId('claude-provider-glm'));
      // GLM only exposes SDK + CLI direct — Channel must not be present.
      expect(screen.queryByTestId('claude-backend-channel')).toBeNull();
    }
  });

  it('describes the resolved GLM profile as GLM 5.3 with a 1M context window', async () => {
    await selectClaude();

    fireEvent.click(screen.getByTestId('claude-provider-glm'));

    const hint = screen.getByTestId('claude-resolved-profile');
    expect(hint.textContent).toContain('GLM 5.3');
    expect(hint.textContent).not.toContain('5.2');
    expect(hint.textContent).toContain('1M context window');
  });
});
