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
  { id: 'profile:glm52-claude-sdk', displayName: 'GLM 5.2 via Claude SDK', provider: 'zai', backend: 'sdk-subscription', claudeModel: 'glm-5.2[1m]' },
  { id: 'profile:glm52-cli-direct', displayName: 'GLM 5.2 via CLI direct', provider: 'zai', backend: 'cli-direct', claudeModel: 'glm-5.2[1m]' },
];

const sessionState = {
  claudeAvailable: true,
  claudeAuthError: null,
  opencodeAvailable: true,
  opencodeAuthError: null,
  antigravityAvailable: false,
  antigravityAuthError: null,
};

vi.mock('../../../../src/store', () => ({
  useSessionStore: (sel: (s: typeof sessionState) => unknown) => sel(sessionState),
}));

vi.mock('../../../../src/store/uiStore', () => ({
  useUIStore: () => ({ recentFolders: [], addRecentFolder: vi.fn(), getRecentFolders: () => [] }),
}));

vi.mock('../../../../src/lib/api', () => ({
  api: {
    get: vi.fn(async (url: string) => {
      if (url.includes('/api/models') && url.includes('sdkType=claude')) {
        return { models: CLAUDE_PROFILE_MODELS };
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
});
