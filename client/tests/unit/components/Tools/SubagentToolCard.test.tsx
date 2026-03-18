import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SubagentToolCard } from '../../../../src/components/Tools/SubagentToolCard';

describe('SubagentToolCard', () => {
  const mockSubagentResult = {
    output: JSON.stringify({
      mode: 'parallel',
      tasks: [
        {
          agent: 'coder',
          task: 'Refactor auth module',
          result: 'Successfully refactored auth module',
          usage: { inputTokens: 100, outputTokens: 50 },
          toolCalls: [
            {
              toolCall: { name: 'read', arguments: { path: '/src/auth.ts' } },
              result: { content: [{ type: 'text', text: 'const auth = ...' }] },
            },
            {
              toolCall: { name: 'edit', arguments: { path: '/src/auth.ts', oldString: 'old', newString: 'new' } },
              result: { content: [{ type: 'text', text: 'Edited successfully' }] },
            },
          ],
        },
        {
          agent: 'analyst',
          task: 'Analyze codebase',
          result: 'Analysis complete',
          usage: { inputTokens: 80, outputTokens: 40 },
          toolCalls: [
            {
              toolCall: { name: 'glob', arguments: { pattern: '**/*.ts' } },
              result: { content: [{ type: 'text', text: 'Found 10 files' }] },
            },
          ],
        },
      ],
      summary: 'All tasks completed successfully',
      totalUsage: { inputTokens: 180, outputTokens: 90 },
    }),
    isError: false,
  };

  const mockChainResult = {
    output: JSON.stringify({
      mode: 'chain',
      chain: [
        {
          agent: 'researcher',
          task: 'Research topic',
          result: 'Research findings',
          toolCalls: [
            {
              toolCall: { name: 'web_search', arguments: { query: 'typescript best practices' } },
              result: { content: [{ type: 'text', text: 'Search results...' }] },
            },
          ],
        },
      ],
      summary: 'Chain completed',
    }),
    isError: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders subagent header with name and role', () => {
    render(
      <SubagentToolCard
        name="subagent"
        args={{ agent: 'coder', task: 'Refactor auth', context: 'user' }}
        result={null}
      />
    );

    expect(screen.getByText('coder')).toBeInTheDocument();
    expect(screen.getByText('[user]')).toBeInTheDocument();
  });

  it('shows running state when no result', () => {
    render(
      <SubagentToolCard
        name="subagent"
        args={{ agent: 'coder', task: 'Refactor auth' }}
        result={null}
      />
    );

    expect(screen.getByText('Running...')).toBeInTheDocument();
  });

  it('shows completed state with checkmark', () => {
    render(
      <SubagentToolCard
        name="subagent"
        args={{ tasks: [{ agent: 'coder', task: 'Refactor' }] }}
        result={mockSubagentResult}
      />
    );

    // Should show the completed status (checkmark icon uses lucide-check-circle class)
    const checkmarks = document.querySelectorAll('.lucide-check-circle');
    expect(checkmarks.length).toBeGreaterThan(0);
  });

  it('expands to show tasks when clicked', () => {
    render(
      <SubagentToolCard
        name="subagent"
        args={{ tasks: [{ agent: 'coder', task: 'Refactor' }] }}
        result={mockSubagentResult}
      />
    );

    // Initially collapsed - click to expand
    const header = screen.getByText('coder').closest('button');
    fireEvent.click(header!);

    // Should show task agents
    expect(screen.getAllByText('coder')[0]).toBeInTheDocument();
    expect(screen.getByText('analyst')).toBeInTheDocument();
  });

  it('shows parallel mode info when expanded', () => {
    render(
      <SubagentToolCard
        name="subagent"
        args={{ tasks: [{ agent: 'coder', task: 'Refactor' }] }}
        result={mockSubagentResult}
      />
    );

    // Expand
    const header = screen.getByText('coder').closest('button');
    fireEvent.click(header!);

    // Should show mode
    expect(screen.getByText(/parallel/i)).toBeInTheDocument();
    expect(screen.getByText(/2 tasks/i)).toBeInTheDocument();
  });

  it('shows chain mode correctly', () => {
    render(
      <SubagentToolCard
        name="subagent"
        args={{ chain: [{ agent: 'researcher', task: 'Research' }] }}
        result={mockChainResult}
      />
    );

    // Expand
    const header = screen.getByText('researcher').closest('button');
    fireEvent.click(header!);

    // Should show chain mode in the mode label
    expect(screen.getByText('Mode:')).toBeInTheDocument();
    // Mode value is in a span with font-mono class
    const modeValue = document.querySelector('.font-mono.text-gray-700');
    expect(modeValue?.textContent).toBe('chain');
  });

  it('shows summary when available', () => {
    render(
      <SubagentToolCard
        name="subagent"
        args={{ tasks: [{ agent: 'coder', task: 'Refactor' }] }}
        result={mockSubagentResult}
      />
    );

    // Expand
    const header = screen.getByText('coder').closest('button');
    fireEvent.click(header!);

    expect(screen.getByText('Summary')).toBeInTheDocument();
    expect(screen.getByText('All tasks completed successfully')).toBeInTheDocument();
  });

  it('shows stats in collapsed view', () => {
    render(
      <SubagentToolCard
        name="subagent"
        args={{ tasks: [{ agent: 'coder', task: 'Refactor' }] }}
        result={mockSubagentResult}
      />
    );

    // Should show summary stats in collapsed footer
    expect(screen.getByText(/2 tasks/i)).toBeInTheDocument();
    expect(screen.getByText(/3 operations/i)).toBeInTheDocument();
  });

  it('handles error state correctly', () => {
    const errorResult = {
      output: JSON.stringify({ error: 'Subagent failed' }),
      isError: true,
    };

    render(
      <SubagentToolCard
        name="subagent"
        args={{ agent: 'coder', task: 'Refactor' }}
        result={errorResult}
      />
    );

    // Should show error state (red styling)
    const container = document.querySelector('.text-red-500, .text-red-600');
    expect(container).toBeInTheDocument();
  });

  it('toggles raw output display', () => {
    render(
      <SubagentToolCard
        name="subagent"
        args={{ tasks: [{ agent: 'coder', task: 'Refactor' }] }}
        result={mockSubagentResult}
      />
    );

    // Expand
    const header = screen.getByText('coder').closest('button');
    fireEvent.click(header!);

    // Toggle raw output
    const rawToggle = screen.getByText('Show raw output');
    fireEvent.click(rawToggle);

    // Should show raw JSON
    expect(screen.getByText(/"mode":/)).toBeInTheDocument();

    // Toggle again to hide
    const hideRaw = screen.getByText('Hide raw output');
    fireEvent.click(hideRaw);

    expect(screen.queryByText(/"mode":/)).not.toBeInTheDocument();
  });

  it('shows default [user] role when no context provided', () => {
    render(
      <SubagentToolCard
        name="subagent"
        args={{ agent: 'worker', task: 'Do something' }}
        result={null}
      />
    );

    expect(screen.getByText('[user]')).toBeInTheDocument();
  });

  it('extracts agent name from tasks array', () => {
    render(
      <SubagentToolCard
        name="subagent"
        args={{ tasks: [{ agent: 'analyzer', task: 'Analyze' }] }}
        result={mockSubagentResult}
      />
    );

    // Should show 'analyzer' as the subagent name (from first task)
    expect(screen.getByText('analyzer')).toBeInTheDocument();
  });

  it('handles single task mode', () => {
    const singleResult = {
      output: JSON.stringify({
        mode: 'single',
        tasks: [
          {
            agent: 'helper',
            task: 'Help with something',
            result: 'Done',
            toolCalls: [],
          },
        ],
      }),
      isError: false,
    };

    render(
      <SubagentToolCard
        name="subagent"
        args={{ agent: 'helper', task: 'Help' }}
        result={singleResult}
      />
    );

    // Expand and check
    const header = screen.getByText('helper').closest('button');
    fireEvent.click(header!);

    expect(screen.getByText(/single/i)).toBeInTheDocument();
  });
});
