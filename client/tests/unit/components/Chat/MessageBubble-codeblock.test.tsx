import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MessageBubble } from '../../../../src/components/Chat/MessageBubble';
import type { LiveMessage } from '../../../../src/hooks/useSessionStream';

// --- Mocks: keep the test focused on the markdown/code-block render path ---

const storeState = { isStreaming: false, currentSessionSdkType: 'pi' };
vi.mock('../../../../src/store', () => ({
  useSessionStore: Object.assign(
    vi.fn((selector?: (s: typeof storeState) => unknown) =>
      selector ? selector(storeState) : storeState,
    ),
    { getState: () => storeState },
  ),
}));

vi.mock('../../../../src/hooks/useReadAloud', () => ({
  useReadAloud: vi.fn(() => ({
    state: 'idle',
    play: vi.fn(),
    stop: vi.fn(),
    toggleSpeed: vi.fn(),
    speedEnabled: false,
  })),
}));

vi.mock('../../../../src/components/Chat/ReadAloudButton', () => ({
  ReadAloudButton: () => <div data-testid="read-aloud" />,
}));

const copyToClipboardMock = vi.fn();
vi.mock('../../../../src/lib/clipboard', () => ({
  copyToClipboard: (...args: unknown[]) => copyToClipboardMock(...args),
}));

// --- Helpers ---

function makeMessage(text: string): LiveMessage {
  return {
    id: 'msg-1',
    role: 'assistant',
    content: [{ type: 'text', text }],
    timestamp: 1_700_000_000_000,
    isComplete: true,
  } as LiveMessage;
}

const MD_WITH_BLOCK_AND_INLINE = [
  'Here is the packet to paste into your runtime:',
  '',
  '```markdown',
  '# Agent OS Context Packet',
  '',
  '## Identity',
  '',
  '- point one',
  '- point two',
  '```',
  '',
  'Paste the packet above. Use `pi run` to start.',
].join('\n');

describe('MessageBubble — code-block copy button wiring', () => {
  beforeEach(() => {
    copyToClipboardMock.mockReset();
    copyToClipboardMock.mockResolvedValue(true);
  });

  it('renders exactly one code-block copy button for a fenced block', () => {
    render(<MessageBubble message={makeMessage(MD_WITH_BLOCK_AND_INLINE)} />);
    expect(
      screen.getAllByRole('button', { name: /copy code block/i }),
    ).toHaveLength(1);
  });

  it('does not put a code-block copy button on inline code', () => {
    render(<MessageBubble message={makeMessage(MD_WITH_BLOCK_AND_INLINE)} />);
    // Inline `pi run` renders as a bare <code> with no copy button — the only
    // code-block button is the one for the fenced block.
    expect(
      screen.getAllByRole('button', { name: /copy code block/i }),
    ).toHaveLength(1);
  });

  it('still renders the two whole-message copy buttons', () => {
    render(<MessageBubble message={makeMessage(MD_WITH_BLOCK_AND_INLINE)} />);
    expect(
      screen.getAllByRole('button', { name: /copy message/i }),
    ).toHaveLength(2);
  });

  it('clicking the code-block button copies only the block, not the intro/outro', async () => {
    render(<MessageBubble message={makeMessage(MD_WITH_BLOCK_AND_INLINE)} />);

    const btn = screen.getByRole('button', { name: /copy code block/i });
    fireEvent.click(btn);
    await waitFor(() => expect(copyToClipboardMock).toHaveBeenCalled());

    expect(copyToClipboardMock).toHaveBeenCalledTimes(1);
    const copied = copyToClipboardMock.mock.calls[0][0] as string;
    expect(copied).toContain('# Agent OS Context Packet');
    expect(copied).toContain('- point one');
    // Surrounding message chatter must NOT be included.
    expect(copied).not.toContain('paste into your runtime');
    expect(copied).not.toContain('Paste the packet above');
  });

  it('renders a code-block copy button for a 4-backtick markdown fence (real packet shape)', () => {
    // Mirrors the actual session: the agent used a 4-backtick ````markdown fence.
    const md =
      'Window is now open. Here is the packet:\n\n' +
      '````markdown\n' +
      '---\nid: packet-test-shape\n---\n\n# Agent OS Context Packet\n- point one\n' +
      '\n````\n\nPaste the packet above.';
    render(<MessageBubble message={makeMessage(md)} />);
    expect(
      screen.getAllByRole('button', { name: /copy code block/i }),
    ).toHaveLength(1);
  });
});
