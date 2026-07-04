/**
 * Tests for the shared subagent-summary projection.
 *
 * Pure function: turns the Pi SDK `toolResult.details` object (subagent /
 * evaluated_subagent tools) into a COMPACT `SubagentToolSummary` (model,
 * per-tool counts, turns, tokens, cost) — the only thing that crosses the wire.
 *
 * Correctness targets are the real numbers from the ground-truth session
 * (docs/SUBAGENT-CARD-ENRICHMENT-PLAN.md §2c), exercised against committed
 * fixtures extracted from that session (inner-message text trimmed — the
 * summarizer never reads text, only block types / usage / model).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  summarizeSubagentDetails,
  formatSubagentOneLine,
  type SubagentToolSummary,
  type SubagentAgentSummary,
} from './subagent-summary.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, '__fixtures__', 'subagent-details');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIX, name), 'utf-8'));
}

const codescoutDetails = loadFixture('subagent-codescout.json');
const reviewerDetails = loadFixture('subagent-reviewer.json');
const evaluatedDetails = loadFixture('evaluated-reviewer.json');

describe('summarizeSubagentDetails — subagent (real fixtures)', () => {
  it('1.1 codescout: exact model/counts/turns/tokens from §2c row 1', () => {
    const s = summarizeSubagentDetails('subagent', codescoutDetails);
    expect(s).not.toBeNull();
    expect(s!.kind).toBe('subagent');
    expect(s!.mode).toBe('single');
    expect(s!.agents).toHaveLength(1);

    const a = s!.agents[0];
    expect(a.agent).toBe('codescout');
    expect(a.model).toBe('github-copilot/gpt-5.4-mini');
    expect(a.toolCalls).toBe(46);
    expect(a.turns).toBe(13);
    expect(a.inputTokens).toBe(100770);
    expect(a.outputTokens).toBe(15350);
    // breakdown sorted count desc, then name asc
    expect(a.toolBreakdown).toEqual([
      { name: 'read', count: 26 },
      { name: 'grep', count: 16 },
      { name: 'find', count: 3 },
      { name: 'ls', count: 1 },
    ]);
  });

  it('1.2 reviewer: exact model/counts/turns/tokens from §2c row 2', () => {
    const s = summarizeSubagentDetails('subagent', reviewerDetails);
    expect(s).not.toBeNull();
    expect(s!.agents).toHaveLength(1);

    const a = s!.agents[0];
    expect(a.agent).toBe('reviewer');
    expect(a.model).toBe('openai-codex/gpt-5.5');
    expect(a.toolCalls).toBe(27);
    expect(a.turns).toBe(25);
    expect(a.inputTokens).toBe(91061);
    expect(a.outputTokens).toBe(6921);
    expect(a.toolBreakdown).toEqual([
      { name: 'read', count: 13 },
      { name: 'grep', count: 9 },
      { name: 'bash', count: 4 },
      { name: 'find', count: 1 },
    ]);
  });

  it('exposes task (truncated) + exitCode + cacheRead on agents', () => {
    const s = summarizeSubagentDetails('subagent', codescoutDetails);
    const a = s!.agents[0];
    expect(typeof a.task).toBe('string');
    expect(a.task!.length).toBeLessThanOrEqual(300);
    expect(a.exitCode).toBe(0);
    expect(a.cacheReadTokens).toBe(812544);
    expect(a.cacheWriteTokens).toBe(0);
  });
});

describe('summarizeSubagentDetails — evaluated_subagent (real fixture)', () => {
  it('1.3 evaluated reviewer: no model/breakdown, turns/tokens/cost from §2c row 3', () => {
    const s = summarizeSubagentDetails('evaluated_subagent', evaluatedDetails);
    expect(s).not.toBeNull();
    expect(s!.kind).toBe('evaluated_subagent');
    expect(s!.mode).toBe('evaluated');
    expect(s!.agents).toHaveLength(1);

    const a = s!.agents[0];
    expect(a.agent).toBe('reviewer');
    expect(a.model).toBeUndefined();
    expect(a.toolBreakdown).toEqual([]);
    expect(a.toolCalls).toBe(0);
    expect(a.turns).toBe(19);
    expect(a.inputTokens).toBe(203879);
    expect(a.outputTokens).toBe(7127);
    expect(a.cacheReadTokens).toBe(882176);
    expect(a.costUsd).toBeCloseTo(1.674293, 5);
    expect(a.exitCode).toBe(0);
    expect(a.timedOut).toBe(false);
  });
});

describe('summarizeSubagentDetails — totals aggregation', () => {
  it('1.4 aggregates across multiple results (parallel)', () => {
    const parallelDetails = {
      mode: 'parallel',
      agentScope: 'user',
      projectAgentsDir: null,
      results: [
        {
          agent: 'codescout',
          agentSource: 'user',
          task: 'scout',
          exitCode: 0,
          messages: [
            {
              role: 'assistant',
              provider: 'github-copilot',
              model: 'gpt-5.4-mini',
              usage: { input: 100, output: 10, cacheRead: 5, cacheWrite: 0, cost: { total: 0.1 } },
              content: [
                { type: 'toolCall', name: 'read' },
                { type: 'toolCall', name: 'read' },
                { type: 'toolCall', name: 'grep' },
              ],
            },
            {
              role: 'assistant',
              provider: 'github-copilot',
              model: 'gpt-5.4-mini',
              usage: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.05 } },
              content: [{ type: 'text' }],
            },
          ],
        },
        {
          agent: 'reviewer',
          agentSource: 'user',
          task: 'review',
          exitCode: 0,
          messages: [
            {
              role: 'assistant',
              provider: 'openai-codex',
              model: 'gpt-5.5',
              usage: { input: 200, output: 20, cacheRead: 7, cacheWrite: 1, cost: { total: 0.2 } },
              content: [{ type: 'toolCall', name: 'bash' }],
            },
          ],
        },
      ],
    };

    const s = summarizeSubagentDetails('subagent', parallelDetails);
    expect(s).not.toBeNull();
    expect(s!.mode).toBe('parallel');
    expect(s!.agents).toHaveLength(2);

    const t = s!.totals;
    expect(t.agentCount).toBe(2);
    expect(t.toolCalls).toBe(4); // 3 + 1
    expect(t.turns).toBe(3); // 2 + 1
    expect(t.inputTokens).toBe(350); // 100+50+200
    expect(t.outputTokens).toBe(35); // 10+5+20
    expect(t.cacheReadTokens).toBe(12); // 5+0+7
    expect(t.cacheWriteTokens).toBe(1); // 0+1
    expect(t.costUsd).toBeCloseTo(0.35, 5); // 0.1+0.05+0.2
  });

  it('totals match a real single-agent fixture', () => {
    const s = summarizeSubagentDetails('subagent', codescoutDetails)!;
    expect(s.totals.agentCount).toBe(1);
    expect(s.totals.toolCalls).toBe(46);
    expect(s.totals.turns).toBe(13);
    expect(s.totals.inputTokens).toBe(100770);
    expect(s.totals.outputTokens).toBe(15350);
    expect(s.totals.cacheReadTokens).toBe(812544);
  });
});

describe('summarizeSubagentDetails — edge cases (never throw)', () => {
  it('1.5a details undefined → null', () => {
    expect(summarizeSubagentDetails('subagent', undefined)).toBeNull();
  });
  it('1.5b details {} → null', () => {
    expect(summarizeSubagentDetails('subagent', {})).toBeNull();
  });
  it('1.5c subagent with results: [] → degrades to empty agents (no throw)', () => {
    const s = summarizeSubagentDetails('subagent', { mode: 'single', results: [] });
    expect(s).not.toBeNull();
    expect(s!.agents).toEqual([]);
    expect(s!.totals.agentCount).toBe(0);
    expect(s!.totals.toolCalls).toBe(0);
  });
  it('1.5d a result with messages: [] → zeroed agent, no throw', () => {
    const s = summarizeSubagentDetails('subagent', {
      mode: 'single',
      results: [{ agent: 'x', messages: [] }],
    });
    expect(s).not.toBeNull();
    expect(s!.agents[0].turns).toBe(0);
    expect(s!.agents[0].toolCalls).toBe(0);
    expect(s!.agents[0].toolBreakdown).toEqual([]);
    expect(s!.agents[0].model).toBeUndefined();
  });
  it('1.5e assistant message with no usage → contributes 0 tokens, no throw', () => {
    const s = summarizeSubagentDetails('subagent', {
      mode: 'single',
      results: [{
        agent: 'x',
        messages: [
          { role: 'assistant', model: 'm', content: [{ type: 'toolCall', name: 'read' }] },
        ],
      }],
    });
    expect(s!.agents[0].inputTokens).toBe(0);
    expect(s!.agents[0].outputTokens).toBe(0);
    expect(s!.agents[0].toolCalls).toBe(1);
    expect(s!.agents[0].turns).toBe(1);
    expect(s!.agents[0].model).toBe('m');
  });
  it('1.5f unknown toolName → null', () => {
    expect(summarizeSubagentDetails('read', codescoutDetails)).toBeNull();
    expect(summarizeSubagentDetails('bash', codescoutDetails)).toBeNull();
  });
  it('1.5g evaluated with cost: 0 → serializes as 0, NOT dropped', () => {
    const s = summarizeSubagentDetails('evaluated_subagent', {
      run_id: 'sa_x',
      agent: 'reviewer',
      round: 1,
      timedOut: false,
      hadFinalOutput: true,
      exitCode: 0,
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 2 },
    });
    expect(s!.agents[0].costUsd).toBe(0); // defined zero, not undefined
    expect(s!.totals.costUsd).toBe(0);
  });
  it('1.5h subagent task > 300 chars → truncated to <= 300', () => {
    const longTask = 'x'.repeat(500);
    const s = summarizeSubagentDetails('subagent', {
      mode: 'single',
      results: [{ agent: 'x', task: longTask, messages: [] }],
    });
    expect(s!.agents[0].task!.length).toBeLessThanOrEqual(300);
    expect(s!.agents[0].task!.length).toBe(300);
  });
  it('1.5i evaluated without usage → still returns summary (turns 0), no throw', () => {
    const s = summarizeSubagentDetails('evaluated_subagent', { agent: 'reviewer', exitCode: 0 });
    expect(s).not.toBeNull();
    expect(s!.agents[0].turns).toBe(0);
    expect(s!.agents[0].costUsd).toBeUndefined();
  });
  it('1.5j non-object details (string/number) → null', () => {
    expect(summarizeSubagentDetails('subagent', 'nope')).toBeNull();
    expect(summarizeSubagentDetails('subagent', 42)).toBeNull();
    expect(summarizeSubagentDetails('subagent', null)).toBeNull();
  });
});

describe('summarizeSubagentDetails — size discipline', () => {
  it('1.6 serialized summary for real codescout call is < 2 KB', () => {
    const s = summarizeSubagentDetails('subagent', codescoutDetails);
    const serialized = JSON.stringify(s);
    expect(serialized.length).toBeLessThan(2048);
  });

  it('summary carries NO inner-message text/transcript', () => {
    const s = summarizeSubagentDetails('subagent', codescoutDetails) as unknown as Record<string, unknown>;
    const json = JSON.stringify(s);
    // The codescout fixture task talks about "Agent OS"; ensure no stray inner
    // content leaked beyond the truncated task field.
    expect(json).not.toContain('"content"');
    expect(json).not.toContain('"messages"');
  });
});

describe('formatSubagentOneLine', () => {
  it('codescott: "46 tools · 13 turns · 116k tok"', () => {
    const s = summarizeSubagentDetails('subagent', codescoutDetails)!;
    expect(formatSubagentOneLine(s)).toBe('46 tools · 13 turns · 116k tok');
  });

  it('evaluated: appends cost, omits tools (no toolCalls)', () => {
    const s = summarizeSubagentDetails('evaluated_subagent', evaluatedDetails)!;
    expect(formatSubagentOneLine(s)).toBe('19 turns · 211k tok · $1.67');
  });
});

// Type-level smoke test (compile-time only): exported types are usable.
export type _T1 = SubagentToolSummary;
export type _T2 = SubagentAgentSummary;
