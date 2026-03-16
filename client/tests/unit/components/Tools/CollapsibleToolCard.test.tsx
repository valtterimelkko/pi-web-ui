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

  it('renders collapsed by default with tool name and status', () => {
    render(
      <CollapsibleToolCard
        name="read"
        args={{ path: '/test/file.txt' }}
      />
    );
    
    // Should show tool display name
    expect(screen.getByText('Read')).toBeInTheDocument();
    
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
    
    // Should show error brief status
    expect(screen.getByText(/Error/)).toBeInTheDocument();
  });

  it('expands when header is clicked', () => {
    render(
      <CollapsibleToolCard
        name="read"
        args={{ path: '/test/file.txt', extra: 'value' }}
        result={{ output: 'File content', isError: false }}
      />
    );
    
    // Click the header button
    const headerButton = screen.getByRole('button', { name: /Read/i });
    fireEvent.click(headerButton);
    
    // Should now show expanded content - look for Arguments text in section
    const argumentsLabels = screen.getAllByText('Arguments');
    expect(argumentsLabels.length).toBeGreaterThan(0);
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
    // Look for the truncated path text specifically
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

  it('maps tool names to display names correctly', () => {
    const toolNames = [
      { name: 'bash', displayName: 'Shell' },
      { name: 'read', displayName: 'Read' },
      { name: 'write', displayName: 'Write' },
      { name: 'edit', displayName: 'Edit' },
      { name: 'grep', displayName: 'Search' },
      { name: 'glob', displayName: 'Find Files' },
    ];

    toolNames.forEach(({ name, displayName }) => {
      const { unmount } = render(
        <CollapsibleToolCard name={name} args={{}} />
      );
      expect(screen.getByText(displayName)).toBeInTheDocument();
      unmount();
    });
  });

  it('falls back to original name for unknown tools', () => {
    render(
      <CollapsibleToolCard
        name="custom_tool"
        args={{}}
      />
    );
    
    expect(screen.getByText('custom_tool')).toBeInTheDocument();
  });

  it('handles array arguments correctly', () => {
    render(
      <CollapsibleToolCard
        name="glob"
        args={{ patterns: ['*.ts', '*.tsx'] }}
      />
    );
    
    // Should render without error
    expect(screen.getByText('Find Files')).toBeInTheDocument();
  });

  it('handles empty args gracefully', () => {
    render(
      <CollapsibleToolCard
        name="read"
        args={{}}
      />
    );
    
    // Should render without error
    expect(screen.getByText('Read')).toBeInTheDocument();
  });

  it('handles null args gracefully', () => {
    render(
      <CollapsibleToolCard
        name="read"
        args={null}
      />
    );
    
    // Should render without error
    expect(screen.getByText('Read')).toBeInTheDocument();
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
    render(
      <CollapsibleToolCard
        name="read"
        args={{ path: '/test', extra: 'value' }}
        result={{ output: 'content', isError: false }}
      />
    );
    
    // Expand
    const headerButton = screen.getByRole('button', { name: /Read/i });
    fireEvent.click(headerButton);
    
    // Should show Arguments section
    const argumentsLabels = screen.getAllByText('Arguments');
    expect(argumentsLabels.length).toBeGreaterThan(0);
    
    // Collapse
    fireEvent.click(headerButton);
    
    // The card should still be visible but without expanded content
    expect(screen.getByText('Read')).toBeInTheDocument();
  });
});
