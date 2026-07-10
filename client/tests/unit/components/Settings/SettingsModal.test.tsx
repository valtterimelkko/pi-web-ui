import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SettingsModal } from '../../../../src/components/Settings/SettingsModal';

// Profile entries returned by GET /api/models?sdkType=claude (profile-backed).
const CLAUDE_PROFILES = [
  { id: 'profile:claude-sonnet-sdk', displayName: 'Claude Sonnet', provider: 'anthropic', backend: 'sdk-subscription', claudeModel: 'sonnet' },
  { id: 'profile:glm52-claude-sdk', displayName: 'GLM 5.2 via Claude SDK', provider: 'zai', backend: 'sdk-subscription', claudeModel: 'glm-5.2[1m]' },
  { id: 'profile:claude-haiku-sdk', displayName: 'Claude Haiku', provider: 'anthropic', backend: 'sdk-subscription', claudeModel: 'haiku' },
];

const OPENCODE_MODELS = [
  { id: 'glm-5.2', name: 'GLM 5.2', provider: 'zai', contextWindow: 200000 },
];

const PI_MODELS = [
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    provider: 'openai-codex',
    thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  },
];

// Mutable per-test store state so each test can set the active runtime.
let sessionState: Record<string, unknown> = {};

vi.mock('../../../../src/store', () => ({
  useSessionStore: (sel: (s: Record<string, unknown>) => unknown) => sel(sessionState),
}));

const wsMocks = {
  setModel: vi.fn(),
  setThinkingLevel: vi.fn(),
};
vi.mock('../../../../src/hooks/useWebSocket', () => ({
  useWebSocket: () => wsMocks,
}));

vi.mock('../../../../src/lib/api', () => ({
  api: {
    get: vi.fn(async (url: string) => {
      if (url.includes('sdkType=claude')) return { models: CLAUDE_PROFILES };
      if (url.includes('sdkType=opencode')) return { models: OPENCODE_MODELS };
      if (url.includes('sdkType=antigravity')) return { models: [] };
      if (url.includes('sdkType=pi')) return { models: PI_MODELS };
      return { models: [] };
    }),
  },
}));

describe('SettingsModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState = {
      currentSessionSdkType: 'claude',
      currentModel: 'profile:claude-sonnet-sdk',
      currentThinkingLevel: 'medium',
      error: null as string | null,
    };
  });

  describe('Claude runtime — model is locked', () => {
    it('renders a locked model panel instead of an interactive selector', async () => {
      render(<SettingsModal isOpen onClose={vi.fn()} />);

      // Locked panel replaces the interactive ModelSelector.
      const locked = await screen.findByTestId('claude-model-locked');
      expect(locked).toBeInTheDocument();
      expect(screen.queryByTestId('model-selector')).not.toBeInTheDocument();
      expect(screen.queryByTestId('model-selector-trigger')).not.toBeInTheDocument();
    });

    it('shows the resolved profile as a read-only label', async () => {
      render(<SettingsModal isOpen onClose={vi.fn()} />);
      const label = await screen.findByTestId('claude-model-locked-label');
      // Resolves profile:claude-sonnet-sdk → "Claude Sonnet · SDK".
      expect(label.textContent).toContain('Claude Sonnet');
    });

    it('keeps the thinking-level selector interactive', async () => {
      render(<SettingsModal isOpen onClose={vi.fn()} />);
      await screen.findByTestId('claude-model-locked');
      expect(screen.getByText('Thinking Level')).toBeInTheDocument();
      // Changing the thinking level is allowed.
      fireEvent.click(screen.getByText('High'));
      expect(screen.getByText('High').closest('button')?.className).toContain('border-blue-500');
    });

    it('saves only the thinking level (never sends a mid-session model change)', async () => {
      render(<SettingsModal isOpen onClose={vi.fn()} />);
      await screen.findByTestId('claude-model-locked');

      fireEvent.click(screen.getByText('High'));
      fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

      expect(wsMocks.setThinkingLevel).toHaveBeenCalledWith('high');
      expect(wsMocks.setModel).not.toHaveBeenCalled();
    });

    it('does not expose Max for a Claude Haiku profile', async () => {
      sessionState = {
        currentSessionSdkType: 'claude',
        currentModel: 'profile:claude-haiku-sdk',
        currentThinkingLevel: 'high',
        error: null,
      };
      render(<SettingsModal isOpen onClose={vi.fn()} />);

      await screen.findByTestId('claude-model-locked');
      expect(screen.queryByText('Max')).not.toBeInTheDocument();
      expect(screen.getByText('Extra High')).toBeInTheDocument();
    });

    it('shows the Claude Direct badge', async () => {
      render(<SettingsModal isOpen onClose={vi.fn()} />);
      await screen.findByTestId('claude-model-locked');
      expect(screen.getByText('Claude Direct')).toBeInTheDocument();
    });
  });

  describe('Pi runtime — model-specific thinking limits', () => {
    it('does not expose Max when the selected Pi SDK model does not support it', async () => {
      sessionState = {
        currentSessionSdkType: 'pi',
        currentModel: 'openai-codex/gpt-5.4',
        currentThinkingLevel: 'high',
        error: null,
      };
      render(<SettingsModal isOpen onClose={vi.fn()} />);

      await screen.findByTestId('model-selector-trigger');
      expect(screen.queryByText('Max')).not.toBeInTheDocument();
      expect(screen.getByText('Extra High')).toBeInTheDocument();
    });
  });

  describe('OpenCode runtime — model selector stays interactive', () => {
    it('renders the interactive model selector', async () => {
      sessionState = {
        currentSessionSdkType: 'opencode',
        currentModel: 'zai/glm-5.2',
        currentThinkingLevel: 'medium',
        error: null,
      };
      render(<SettingsModal isOpen onClose={vi.fn()} />);
      const trigger = await screen.findByTestId('model-selector-trigger');
      expect(trigger).toBeInTheDocument();
      expect(screen.queryByTestId('claude-model-locked')).not.toBeInTheDocument();
    });
  });
});
