import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CodeBlock } from '../../../../src/components/Chat/CodeBlock';

// Mock copyToClipboard so tests don't depend on jsdom's clipboard/execCommand.
const copyToClipboardMock = vi.fn();
vi.mock('../../../../src/lib/clipboard', () => ({
  copyToClipboard: (...args: unknown[]) => copyToClipboardMock(...args),
}));

async function clickCopyButton() {
  fireEvent.click(screen.getByRole('button', { name: /copy code block/i }));
  // Handler is async (awaits the mocked copyToClipboard); flush microtasks +
  // the resulting state update.
  await waitFor(() => expect(copyToClipboardMock).toHaveBeenCalled());
}

describe('CodeBlock', () => {
  beforeEach(() => {
    copyToClipboardMock.mockReset();
  });

  it('renders a copy button with an accessible label', () => {
    render(
      <CodeBlock>
        <code>{'let x = 1'}</code>
      </CodeBlock>,
    );
    expect(
      screen.getByRole('button', { name: /copy code block/i }),
    ).toBeInTheDocument();
  });

  it('copies the raw block text (and nothing else) when clicked', async () => {
    copyToClipboardMock.mockResolvedValue(true);
    const code = 'line one\nline two\nline three';
    render(
      <CodeBlock>
        <code>{code}</code>
      </CodeBlock>,
    );

    await clickCopyButton();

    expect(copyToClipboardMock).toHaveBeenCalledTimes(1);
    // First arg is the text; it must equal the code text exactly — the
    // icon-only copy button contributes no text to the <pre>.
    expect(copyToClipboardMock.mock.calls[0][0]).toBe(code);
  });

  it('shows a copied state after a successful copy', async () => {
    copyToClipboardMock.mockResolvedValue(true);
    render(
      <CodeBlock>
        <code>{'hello'}</code>
      </CodeBlock>,
    );

    await clickCopyButton();

    expect(
      await screen.findByRole('button', { name: /copied code block/i }),
    ).toBeInTheDocument();
  });

  it('does not flip to copied state when copy fails', async () => {
    copyToClipboardMock.mockResolvedValue(false);
    render(
      <CodeBlock>
        <code>{'hello'}</code>
      </CodeBlock>,
    );

    await clickCopyButton();

    expect(copyToClipboardMock).toHaveBeenCalled();
    // Stays in the (not-yet-copied) label.
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /copy code block/i }),
      ).toBeInTheDocument();
    });
  });

  it('handles a markdown block that starts with a heading (packet #11 shape)', async () => {
    copyToClipboardMock.mockResolvedValue(true);
    const md = '# Agent OS Context Packet\n\n## Identity\n\n- point one\n- point two';
    render(
      <CodeBlock>
        <code className="language-markdown">{md}</code>
      </CodeBlock>,
    );

    await clickCopyButton();

    expect(copyToClipboardMock.mock.calls[0][0]).toBe(md);
  });

  it('handles a markdown block that starts with YAML front-matter (packet #15 shape)', async () => {
    copyToClipboardMock.mockResolvedValue(true);
    const md =
      '---\nid: packet-xyz\ntaskIntent: "do the thing"\n---\n\n# Agent OS Context Packet\n\n- point one';
    render(
      <CodeBlock>
        <code className="language-markdown">{md}</code>
      </CodeBlock>,
    );

    await clickCopyButton();

    const copied = copyToClipboardMock.mock.calls[0][0] as string;
    // Front-matter and body are both preserved verbatim — this is the case
    // that looked different in the UI but must copy just as cleanly.
    expect(copied.startsWith('---\nid: packet-xyz')).toBe(true);
    expect(copied).toContain('# Agent OS Context Packet');
    expect(copied).toBe(md);
  });

  it('renders multiple independent blocks with independent copy state', async () => {
    copyToClipboardMock.mockResolvedValue(true);
    render(
      <div>
        <CodeBlock>
          <code>{'block A'}</code>
        </CodeBlock>
        <CodeBlock>
          <code>{'block B'}</code>
        </CodeBlock>
      </div>,
    );

    const buttons = screen.getAllByRole('button', { name: /copy code block/i });
    expect(buttons).toHaveLength(2);

    fireEvent.click(buttons[0]);
    await waitFor(() => expect(copyToClipboardMock).toHaveBeenCalled());

    // Only the first block flips to copied.
    expect(
      screen.getAllByRole('button', { name: /copied code block/i }),
    ).toHaveLength(1);
    expect(copyToClipboardMock.mock.calls[0][0]).toBe('block A');
  });
});
