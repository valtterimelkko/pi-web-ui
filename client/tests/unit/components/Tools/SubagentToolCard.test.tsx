import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SubagentToolCard } from '../../../../src/components/Tools/SubagentToolCard';
import type { SubagentToolSummary } from '@pi-web-ui/shared';

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

  // ── Enriched summary path (Pi SDK `subagent` / `evaluated_subagent`) ──
  // docs/SUBAGENT-CARD-ENRICHMENT-PLAN.md Phase 3.2–3.5. Real shapes derived
  // from the ground-truth session §2c (codescout / evaluated reviewer).
  describe('enriched summary (Pi SDK)', () => {
    const codescoutSummary: SubagentToolSummary = {
      mode: 'single',
      kind: 'subagent',
      agents: [
        {
          agent: 'codescout',
          model: 'github-copilot/gpt-5.4-mini',
          task: 'Scout code paths',
          exitCode: 0,
          turns: 13,
          toolCalls: 46,
          toolBreakdown: [
            { name: 'read', count: 26 },
            { name: 'grep', count: 16 },
            { name: 'find', count: 3 },
            { name: 'ls', count: 1 },
          ],
          inputTokens: 100770,
          outputTokens: 15350,
          cacheReadTokens: 812544,
          cacheWriteTokens: 0,
          costUsd: 0.2055933,
        },
      ],
      totals: {
        agentCount: 1,
        toolCalls: 46,
        turns: 13,
        inputTokens: 100770,
        outputTokens: 15350,
        cacheReadTokens: 812544,
        cacheWriteTokens: 0,
        costUsd: 0.2055933,
      },
    };

    const evaluatedSummary: SubagentToolSummary = {
      mode: 'evaluated',
      kind: 'evaluated_subagent',
      agents: [
        {
          agent: 'reviewer',
          turns: 19,
          toolCalls: 0,
          toolBreakdown: [],
          inputTokens: 203879,
          outputTokens: 7127,
          cacheReadTokens: 882176,
          costUsd: 1.674293,
          exitCode: 0,
          timedOut: false,
        },
      ],
      totals: {
        agentCount: 1,
        toolCalls: 0,
        turns: 19,
        inputTokens: 203879,
        outputTokens: 7127,
        cacheReadTokens: 882176,
        costUsd: 1.674293,
      },
    };

    it('3.2 collapsed: shows agent name, model string, one-line tool summary', () => {
      render(
        <SubagentToolCard
          name="subagent"
          args={{ agent: 'codescout', task: 'Scout' }}
          result={{ output: 'final markdown answer', isError: false, summary: codescoutSummary }}
        />
      );

      expect(screen.getByText('codescout')).toBeInTheDocument();
      expect(screen.getByText('github-copilot/gpt-5.4-mini')).toBeInTheDocument();
      expect(screen.getByText('46 tools · 13 turns · 116k tok')).toBeInTheDocument();
    });

    it('3.3 expanded: shows per-agent tool breakdown + model + tokens', () => {
      render(
        <SubagentToolCard
          name="subagent"
          args={{ agent: 'codescout', task: 'Scout' }}
          result={{ output: 'final answer', isError: false, summary: codescoutSummary }}
        />
      );

      fireEvent.click(screen.getByText('codescout').closest('button')!);

      // per-tool breakdown
      expect(screen.getByText('read ×26')).toBeInTheDocument();
      expect(screen.getByText('grep ×16')).toBeInTheDocument();
      expect(screen.getByText('find ×3')).toBeInTheDocument();
      expect(screen.getByText('ls ×1')).toBeInTheDocument();
      // model visible in expanded per-agent section too
      expect(screen.getAllByText('github-copilot/gpt-5.4-mini').length).toBeGreaterThan(0);
      // tokens (full numbers)
      expect(screen.getByText(/100,770/)).toBeInTheDocument();
      expect(screen.getByText(/15,350/)).toBeInTheDocument();
    });

    it('uses the summary agent name when evaluated_subagent arguments only carry a run id', () => {
      render(
        <SubagentToolCard
          name="evaluated_subagent"
          args={{ run_id: 'sa-1', questions: ['Review it'] }}
          result={{ output: '', isError: false, summary: evaluatedSummary }}
        />
      );

      expect(screen.getByText('reviewer')).toBeInTheDocument();
      expect(screen.queryByText('subagent')).not.toBeInTheDocument();
    });

    it('3.4 evaluated_subagent: omits model + breakdown, shows turns/tokens/cost, no crash', () => {
      render(
        <SubagentToolCard
          name="evaluated_subagent"
          args={{ agent: 'reviewer', task: 'Review' }}
          result={{ output: 'reviewer verdict', isError: false, summary: evaluatedSummary }}
        />
      );

      // no model, no per-tool breakdown chips
      expect(screen.queryByText(/×\d+/)).not.toBeInTheDocument();
      // turns + tokens + cost present (collapsed one-line)
      expect(screen.getByText(/19 turns/)).toBeInTheDocument();
      expect(screen.getByText(/\$1\.67/)).toBeInTheDocument();

      // expands without crashing; tokens visible
      fireEvent.click(screen.getByText('reviewer').closest('button')!);
      expect(screen.getByText(/203,879/)).toBeInTheDocument();
    });

    it('3.5 fallback: summary absent AND legacy JSON absent → plain header, no model, no crash', () => {
      render(
        <SubagentToolCard
          name="subagent"
          args={{ agent: 'worker', task: 'Do' }}
          result={{ output: 'just plain text, not JSON', isError: false }}
        />
      );

      expect(screen.getByText('worker')).toBeInTheDocument();
      // no enriched model/summary line
      expect(screen.queryByText(/tok$/)).not.toBeInTheDocument();
      // completed (no throw)
      const checkmarks = document.querySelectorAll('.lucide-check-circle');
      expect(checkmarks.length).toBeGreaterThan(0);
    });

    it('summary takes precedence over legacy JSON when both could apply', () => {
      // result with a summary AND legacy-shaped JSON output → summary wins
      render(
        <SubagentToolCard
          name="subagent"
          args={{ agent: 'codescout' }}
          result={{
            output: JSON.stringify({ mode: 'parallel', tasks: [], summary: 'legacy' }),
            isError: false,
            summary: codescoutSummary,
          }}
        />
      );
      // enriched one-line present (summary path), legacy "parallel" mode label not shown
      expect(screen.getByText('46 tools · 13 turns · 116k tok')).toBeInTheDocument();
    });
  });
});
