import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CollapsibleToolCard } from '../../../../src/components/Tools/CollapsibleToolCard';

describe('CollapsibleToolCard', () => {
  // Mock clipboard API
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it('renders collapsed by default with "Using {name}" prefix', () => {
    render(
      <CollapsibleToolCard
        name="read"
        args={{ path: '/test/file.txt' }}
      />
    );

    // Should show "Using Read" in the header
    expect(screen.getByText('Using Read')).toBeInTheDocument();

    // Should show pending status
    expect(screen.getByText('Running…')).toBeInTheDocument();
  });

  it('shows success status when result is successful', () => {
    render(
      <CollapsibleToolCard
        name="read"
        args={{ path: '/test/file.txt' }}
        result={{ output: 'File content', isError: false }}
      />
    );

    // Should show brief status with line count
    expect(screen.getByText(/lines?/i)).toBeInTheDocument();
  });

  it('shows error status when result is error', () => {
    render(
      <CollapsibleToolCard
        name="bash"
        args={{ command: 'invalid-command' }}
        result={{ output: 'Command not found', isError: true }}
      />
    );

    // Should show error brief status. "Error" appears both in the brief status
    // and in the auto-expanded result toggle, so match all occurrences.
    expect(screen.getAllByText(/Error/).length).toBeGreaterThan(0);
  });

  it('expands when header is clicked', () => {
    // Pending (no result) → card starts collapsed, so clicking the header expands it.
    render(
      <CollapsibleToolCard
        name="read"
        args={{ path: '/test/file.txt', extra: 'value' }}
      />
    );

    // Collapsed: the "Input parameters" section is not yet rendered
    expect(screen.queryByText('Input parameters')).not.toBeInTheDocument();

    // Click the header button (contains "Using Read")
    const headerButton = screen.getByRole('button', { name: /Using Read/i });
    fireEvent.click(headerButton);

    // Should now show the "Input parameters" section toggle
    expect(screen.getByText('Input parameters')).toBeInTheDocument();
  });

  it('Input parameters section is expanded by default once the card is open', () => {
    // A completed tool auto-expands the card; inputs are shown by default (verbosity increase).
    render(
      <CollapsibleToolCard
        name="bash"
        args={{ command: 'ls -la', extra: 'value' }}
        result={{ output: 'total 8', isError: false }}
      />
    );

    // "Input parameters" section header should be visible
    expect(screen.getByText('Input parameters')).toBeInTheDocument();

    // Args content (the "Arguments" label inside ToolInputSection) is visible by default
    expect(screen.getByText('Arguments')).toBeInTheDocument();
  });

  it('Tool Result section is expanded by default on completion', () => {
    render(
      <CollapsibleToolCard
        name="bash"
        args={{ command: 'ls' }}
        result={{ output: 'total 8\nfile.txt', isError: false }}
      />
    );

    // Card auto-expands on completion; the Result section toggle is visible
    expect(screen.getByText('Result')).toBeInTheDocument();

    // And the result content is shown (auto-expanded on completion)
    expect(screen.getByText(/total 8/)).toBeInTheDocument();
  });

  it('auto-expands Tool Result section on error', () => {
    render(
      <CollapsibleToolCard
        name="bash"
        args={{ command: 'bad-cmd' }}
        result={{ output: 'bash: bad-cmd: command not found', isError: true }}
      />
    );

    // Card and result section auto-expand on completion; error text is visible without any click
    expect(screen.getByText('bash: bad-cmd: command not found')).toBeInTheDocument();
  });

  it('expands card when forceExpanded prop is true', () => {
    render(
      <CollapsibleToolCard
        name="read"
        args={{ path: '/test' }}
        result={{ output: 'content', isError: false }}
        forceExpanded={true}
      />
    );

    // Card should be expanded – "Input parameters" section toggle visible
    expect(screen.getByText('Input parameters')).toBeInTheDocument();
  });

  it('collapses card when forceExpanded changes to false', () => {
    const { rerender } = render(
      <CollapsibleToolCard
        name="read"
        args={{ path: '/test' }}
        result={{ output: 'content', isError: false }}
        forceExpanded={true}
      />
    );

    expect(screen.getByText('Input parameters')).toBeInTheDocument();

    rerender(
      <CollapsibleToolCard
        name="read"
        args={{ path: '/test' }}
        result={{ output: 'content', isError: false }}
        forceExpanded={false}
      />
    );

    // Card should now be collapsed
    expect(screen.queryByText('Input parameters')).not.toBeInTheDocument();
  });

  it('truncates long parameters in collapsed view', () => {
    const longPath = '/very/long/path/that/exceeds/fifty/characters/and/should/be/truncated';
    render(
      <CollapsibleToolCard
        name="read"
        args={{ path: longPath }}
      />
    );

    // Should show truncated path with ellipsis in collapsed state
    const truncatedElements = screen.getAllByText(/\/very\/long\/path.*…/);
    expect(truncatedElements.length).toBeGreaterThan(0);
  });

  it('shows brief status with line and character count', () => {
    const output = 'Line 1\nLine 2\nLine 3';
    render(
      <CollapsibleToolCard
        name="bash"
        args={{ command: 'test' }}
        result={{ output, isError: false }}
      />
    );

    // Should show line count
    expect(screen.getByText(/3 lines/)).toBeInTheDocument();
  });

  it('maps tool names to display names with "Using" prefix', () => {
    const toolNames = [
      { name: 'bash', displayName: 'Using Shell' },
      { name: 'read', displayName: 'Using Read' },
      { name: 'write', displayName: 'Using Write' },
      { name: 'edit', displayName: 'Using Edit' },
      { name: 'grep', displayName: 'Using Search' },
      { name: 'glob', displayName: 'Using Find Files' },
    ];

    toolNames.forEach(({ name, displayName }) => {
      const { unmount } = render(
        <CollapsibleToolCard name={name} args={{}} />
      );
      expect(screen.getByText(displayName)).toBeInTheDocument();
      unmount();
    });
  });

  it('falls back to original name with "Using" prefix for unknown tools', () => {
    render(
      <CollapsibleToolCard
        name="custom_tool"
        args={{}}
      />
    );

    expect(screen.getByText('Using custom_tool')).toBeInTheDocument();
  });

  it('handles array arguments correctly', () => {
    render(
      <CollapsibleToolCard
        name="glob"
        args={{ patterns: ['*.ts', '*.tsx'] }}
      />
    );

    // Should render without error
    expect(screen.getByText('Using Find Files')).toBeInTheDocument();
  });

  it('handles empty args gracefully', () => {
    render(
      <CollapsibleToolCard
        name="read"
        args={{}}
      />
    );

    expect(screen.getByText('Using Read')).toBeInTheDocument();
  });

  it('handles null args gracefully', () => {
    render(
      <CollapsibleToolCard
        name="read"
        args={null}
      />
    );

    expect(screen.getByText('Using Read')).toBeInTheDocument();
  });

  it('handles JSON result output', () => {
    const jsonOutput = JSON.stringify({ key: 'value', nested: { a: 1 } });
    render(
      <CollapsibleToolCard
        name="bash"
        args={{ command: 'test' }}
        result={{ output: jsonOutput, isError: false }}
      />
    );

    // Should show brief status with line count
    expect(screen.getByText(/lines/)).toBeInTheDocument();
  });

  it('collapses when header is clicked again', () => {
    // Pending (no result) → starts collapsed, so the toggle goes collapsed → expand → collapse.
    render(
      <CollapsibleToolCard
        name="read"
        args={{ path: '/test', extra: 'value' }}
      />
    );

    const headerButton = screen.getByRole('button', { name: /Using Read/i });

    // Starts collapsed
    expect(screen.queryByText('Input parameters')).not.toBeInTheDocument();

    // Expand
    fireEvent.click(headerButton);
    expect(screen.getByText('Input parameters')).toBeInTheDocument();

    // Collapse
    fireEvent.click(headerButton);
    expect(screen.queryByText('Input parameters')).not.toBeInTheDocument();
    expect(screen.getByText('Using Read')).toBeInTheDocument();
  });

  it('Input parameters section collapses and re-expands when its toggle is clicked', () => {
    render(
      <CollapsibleToolCard
        name="bash"
        args={{ command: 'ls -la', extra: 'value' }}
        result={{ output: 'total 8', isError: false }}
      />
    );

    // Card auto-expands; the Arguments content is visible by default
    expect(screen.getByText('Arguments')).toBeInTheDocument();

    // Click the Input parameters toggle → collapses the args content
    const inputsToggle = screen.getByRole('button', { name: /Input parameters/i });
    fireEvent.click(inputsToggle);
    expect(screen.queryByText('Arguments')).not.toBeInTheDocument();

    // Click again → re-expands
    fireEvent.click(inputsToggle);
    expect(screen.getByText('Arguments')).toBeInTheDocument();
  });
});
