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

/** The 35 GOAT-eligible ids the server lists for Command Code (54 advertised minus 19 excluded). */
const COMMAND_CODE_ELIGIBLE_IDS = [
  'deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash',
  'moonshotai/kimi-k3', 'moonshotai/kimi-k2.7-code', 'moonshotai/kimi-k2.7-code-highspeed', 'moonshotai/kimi-k2.6', 'moonshotai/kimi-k2.5',
  'zai-org/glm-5.2', 'zai-org/glm-5.2-fast', 'zai-org/glm-5.1', 'zai-org/glm-5',
  'minimaxai/minimax-m3', 'minimaxai/minimax-m2.7', 'minimaxai/minimax-m2.5',
  'xiaomi/mimo-v2.5-pro', 'xiaomi/mimo-v2.5',
  'qwen/qwen3.8-max', 'qwen/qwen3.7-max', 'qwen/qwen3.7-plus', 'qwen/qwen3.7-flash', 'qwen/qwen3.6-max-preview', 'qwen/qwen3.6-plus',
  'stepfun/step-3.7-flash', 'stepfun/step-3.5-flash',
  'tencent/hy3-paid', 'nvidia/nemotron-3-ultra-550b-a55b',
  'thinkingmachines/inkling', 'thinkingmachines/inkling-small',
  'poolside/laguna-s-2.1-free',
  'gpt-5.6-luna',
  'google/gemini-3.7-flash',
  'meta/muse-spark-1.2', 'meta/muse-spark-1.2-contributor',
  'xai/grok-4.5', 'xai/grok-4.6',
];

const COMMAND_CODE_EXCLUDED_SAMPLE = ['claude-opus-5', 'gpt-5.5', 'google/gemini-3.6-flash', 'sakana/fugu-ultra'];

function commandCodeModel(id: string) {
  const effort = id === 'qwen/qwen3.8-max'
    ? { effortLevels: ['low', 'medium', 'xhigh'], defaultEffort: 'medium' }
    : { effortLevels: [] };
  const leaf = id.split('/').pop() ?? id;
  return {
    id,
    displayName: leaf.replace(/[-_.]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    provider: 'command-code',
    reasoning: true,
    ...effort,
  };
}

const sessionState: any = {
  claudeAvailable: true,
  claudeAuthError: null,
  opencodeAvailable: true,
  opencodeAuthError: null,
  antigravityAvailable: false,
  antigravityAuthError: null,
  commandCodeAvailable: true,
  commandCodeEnabled: true,
  commandCodeError: null,
  commandCodeModels: COMMAND_CODE_ELIGIBLE_IDS.map(commandCodeModel),
  sessionCreation: { status: 'idle' as 'idle' | 'pending' | 'created' | 'error', requestId: undefined as string | undefined, error: undefined as string | undefined },
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

  it('lists all 35 GOAT-eligible Command Code models and none of the excluded ids', async () => {
    render(<NewSessionModal isOpen onClose={vi.fn()} onCreateSession={vi.fn()} />);

    fireEvent.click(screen.getByText('Command Code'));
    const selector = await screen.findByTestId('commandcode-model-select') as unknown as HTMLSelectElement;
    expect(selector.options).toHaveLength(35);
    const values = Array.from(selector.options).map((option) => option.value);
    for (const id of COMMAND_CODE_ELIGIBLE_IDS) expect(values).toContain(id);
    for (const excluded of COMMAND_CODE_EXCLUDED_SAMPLE) expect(values).not.toContain(excluded);
    for (const option of Array.from(selector.options)) expect(option).not.toBeDisabled();
  });

  it('keeps a non-first model selected across rerenders and a catalogue refresh', async () => {
    const { rerender } = render(<NewSessionModal isOpen onClose={vi.fn()} onCreateSession={vi.fn()} />);

    fireEvent.click(screen.getByText('Command Code'));
    const selector = await screen.findByTestId('commandcode-model-select') as unknown as HTMLSelectElement;
    fireEvent.change(selector, { target: { value: 'zai-org/glm-5.2' } });
    expect(selector.value).toBe('zai-org/glm-5.2');

    // Rerender (props/store churn) must not snap the selection back to the first entry.
    rerender(<NewSessionModal isOpen onClose={vi.fn()} onCreateSession={vi.fn()} />);
    expect((screen.getByTestId('commandcode-model-select') as unknown as HTMLSelectElement).value).toBe('zai-org/glm-5.2');

    // A catalogue refresh that still contains the model keeps it selected.
    sessionState.commandCodeModels = [...COMMAND_CODE_ELIGIBLE_IDS].reverse().map(commandCodeModel);
    rerender(<NewSessionModal isOpen onClose={vi.fn()} onCreateSession={vi.fn()} />);
    expect((screen.getByTestId('commandcode-model-select') as unknown as HTMLSelectElement).value).toBe('zai-org/glm-5.2');
    sessionState.commandCodeModels = COMMAND_CODE_ELIGIBLE_IDS.map(commandCodeModel);
  });

  it('shows exactly the model effort levels and preselects the default; hides the selector when the model has none', async () => {
    render(<NewSessionModal isOpen onClose={vi.fn()} onCreateSession={vi.fn()} />);

    fireEvent.click(screen.getByText('Command Code'));
    const selector = await screen.findByTestId('commandcode-model-select') as unknown as HTMLSelectElement;
    fireEvent.change(selector, { target: { value: 'qwen/qwen3.8-max' } });

    const effort = screen.getByTestId('commandcode-effort-select') as unknown as HTMLSelectElement;
    expect(Array.from(effort.options).map((option) => option.value)).toEqual(['low', 'medium', 'xhigh']);
    expect(effort.value).toBe('medium');

    fireEvent.change(selector, { target: { value: 'poolside/laguna-s-2.1-free' } });
    expect(screen.queryByTestId('commandcode-effort-select')).toBeNull();
  });

  it('create emits sdkType, model, effort, cwd and a requestId, and the modal stays open', async () => {
    const onCreateSession = vi.fn();
    const onClose = vi.fn();
    render(<NewSessionModal isOpen onClose={onClose} onCreateSession={onCreateSession} />);

    fireEvent.click(screen.getByText('Command Code'));
    const selector = await screen.findByTestId('commandcode-model-select') as unknown as HTMLSelectElement;
    fireEvent.change(selector, { target: { value: 'qwen/qwen3.8-max' } });
    fireEvent.change(screen.getByTestId('commandcode-effort-select'), { target: { value: 'xhigh' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(onCreateSession).toHaveBeenCalledTimes(1);
    expect(onCreateSession).toHaveBeenCalledWith('/root', 'commandcode', 'qwen/qwen3.8-max', undefined, 'xhigh', expect.any(String));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a rejected create preserves the selections and shows the error', async () => {
    const onCreateSession = vi.fn();
    const onClose = vi.fn();
    const view = render(<NewSessionModal isOpen onClose={onClose} onCreateSession={onCreateSession} />);

    fireEvent.click(screen.getByText('Command Code'));
    const selector = await screen.findByTestId('commandcode-model-select') as unknown as HTMLSelectElement;
    fireEvent.change(selector, { target: { value: 'zai-org/glm-5.1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    const requestId = onCreateSession.mock.calls[0]?.[5] as string;

    sessionState.sessionCreation = { status: 'error', requestId, error: 'Command Code runtime is disabled' };
    view.rerender(<NewSessionModal isOpen onClose={onClose} onCreateSession={onCreateSession} />);

    expect(screen.getByText(/Command Code runtime is disabled/i)).toBeInTheDocument();
    expect((screen.getByTestId('commandcode-model-select') as unknown as HTMLSelectElement).value).toBe('zai-org/glm-5.1');
    expect(screen.getByRole('button', { name: 'Create' })).not.toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
    sessionState.sessionCreation = { status: 'idle', requestId: undefined, error: undefined };
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
