/**
 * §8.1 Deterministic server proof — the anti-regression backbone.
 *
 * Reads the GROUND-TRUTH Pi session file (real bytes on this box) and runs every
 * `subagent` / `evaluated_subagent` toolResult.details through the EXACT
 * enrichment used by BOTH live forward paths to the browser — the shared
 * `enrichSubagentEvent` helper (called by `EventForwarder.mapEventToMessage` for
 * the single-client path AND by `MultiSessionManager.handleAgentEvent` for the
 * multi-session browser path). Asserts the resulting `resultSummary` matches
 * docs/SUBAGENT-CARD-ENRICHMENT-PLAN.md §2c EXACTLY (model strings, tool counts,
 * turns, tokens, cost) and that the heavy inner `messages` transcript is stripped
 * (bloat guard).
 *
 * Source of truth: the live file at
 *   ~/.pi/agent/sessions/--root-agent-os--/2026-07-03T21-59-33-537Z_019f29fe-….jsonl
 * When that file is absent (CI / other hosts), the test falls back to the
 * committed real fixtures (same bytes, text-trimmed) so it always exercises the
 * enrichment with real data and never skips.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { enrichSubagentEvent } from '../../src/pi/event-forwarder.js';
import type { SubagentToolSummary } from '@pi-web-ui/shared';

const GROUND_TRUTH = path.join(
  os.homedir(),
  '.pi/agent/sessions/--root-agent-os--/2026-07-03T21-59-33-537Z_019f29fe-83a1-7bf2-a21d-fe10363ccce5.jsonl',
);

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', '..', '..', 'shared', 'src', '__fixtures__', 'subagent-details');

interface DetailsEntry {
  toolName: string;
  details: unknown;
}

/** Read every subagent/evaluated_subagent details object from the live file. */
function loadFromLiveFile(): DetailsEntry[] | null {
  if (!fs.existsSync(GROUND_TRUTH)) return null;
  const entries: DetailsEntry[] = [];
  for (const line of fs.readFileSync(GROUND_TRUTH, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let entry: { message?: Record<string, unknown>; toolName?: string; details?: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = entry.message ?? entry;
    const toolName = msg.toolName as string | undefined;
    if ((toolName === 'subagent' || toolName === 'evaluated_subagent') && msg.details !== undefined) {
      entries.push({ toolName, details: msg.details });
    }
  }
  return entries.length > 0 ? entries : null;
}

/** Fallback: the committed real fixtures (same bytes, inner text trimmed). */
function loadFromFixtures(): DetailsEntry[] {
  return [
    { toolName: 'subagent', details: JSON.parse(fs.readFileSync(join(FIXTURES, 'subagent-codescout.json'), 'utf8')) },
    { toolName: 'subagent', details: JSON.parse(fs.readFileSync(join(FIXTURES, 'subagent-reviewer.json'), 'utf8')) },
    { toolName: 'evaluated_subagent', details: JSON.parse(fs.readFileSync(join(FIXTURES, 'evaluated-reviewer.json'), 'utf8')) },
  ];
}

const SOURCE = fs.existsSync(GROUND_TRUTH) ? 'live ~/.pi session file' : 'committed real fixtures';
const ENTRIES = loadFromLiveFile() ?? loadFromFixtures();

/** Run each details object through the shared enrichment used by both live paths. */
function enrichAll(entries: DetailsEntry[]): Array<{ toolName: string; event: ReturnType<typeof enrichSubagentEvent> }> {
  return entries.map(({ toolName, details }) => {
    const event = {
      type: 'tool_execution_end',
      toolCallId: 'tc-1',
      toolName,
      result: { content: [{ type: 'text', text: 'final answer' }], details },
      isError: false,
    } as unknown as AgentSessionEvent;
    return { toolName, event: enrichSubagentEvent(event) };
  });
}

const RESULTS = enrichAll(ENTRIES);
const SUMMARIES = RESULTS.map((r) => r.event.resultSummary).filter((s): s is SubagentToolSummary => s !== undefined);
const ALL_AGENTS = SUMMARIES.flatMap((s) => s.agents.map((a) => ({ agent: a, kind: s.kind })));

describe('Pi subagent summary — deterministic server proof (source: ' + SOURCE + ')', () => {
  it('enriches every subagent/evaluated call with a summary', () => {
    // The real file has 6 calls (4 subagent + 2 evaluated); fixtures fallback has 3.
    expect(SUMMARIES.length).toBeGreaterThanOrEqual(3);
    expect(SUMMARIES.every((s) => s.kind === 'subagent' || s.kind === 'evaluated_subagent')).toBe(true);
  });

  it('strips inner details.results[].messages from every enriched event (bloat guard)', () => {
    for (const r of RESULTS) {
      const details = (r.event.result as { details?: { results?: Array<Record<string, unknown>> } }).details;
      if (details?.results) {
        for (const res of details.results) {
          expect(res.messages).toBeUndefined();
        }
      }
      // No inner transcript leaks at all.
      expect(JSON.stringify(r.event)).not.toContain('"messages"');
    }
  });

  it('§2c row 1 — codescout: exact model/counts/turns/tokens', () => {
    const hit = ALL_AGENTS.find((x) => x.agent.agent === 'codescout');
    expect(hit, 'codescout agent present').toBeDefined();
    const a = hit!.agent;
    expect(a.model).toBe('github-copilot/gpt-5.4-mini');
    expect(a.toolCalls).toBe(46);
    expect(a.turns).toBe(13);
    expect(a.inputTokens).toBe(100770);
    expect(a.outputTokens).toBe(15350);
    expect(a.toolBreakdown).toEqual([
      { name: 'read', count: 26 },
      { name: 'grep', count: 16 },
      { name: 'find', count: 3 },
      { name: 'ls', count: 1 },
    ]);
  });

  it('§2c row 2 — reviewer (gpt-5.5): exact model/counts/turns/tokens', () => {
    const hit = ALL_AGENTS.find((x) => x.agent.model === 'openai-codex/gpt-5.5' && x.agent.toolCalls === 27);
    expect(hit, 'reviewer gpt-5.5 / 27-tool agent present').toBeDefined();
    const a = hit!.agent;
    expect(a.agent).toBe('reviewer');
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

  it('§2c row 3 — evaluated reviewer: no model/breakdown, exact turns/tokens/cost', () => {
    const hit = SUMMARIES.find((s) => s.kind === 'evaluated_subagent' && s.agents[0]?.turns === 19);
    expect(hit, 'evaluated 19-turn summary present').toBeDefined();
    const a = hit!.agents[0];
    expect(a.agent).toBe('reviewer');
    expect(a.model).toBeUndefined();
    expect(a.toolBreakdown).toEqual([]);
    expect(a.toolCalls).toBe(0);
    expect(a.inputTokens).toBe(203879);
    expect(a.outputTokens).toBe(7127);
    expect(a.cacheReadTokens).toBe(882176);
    expect(a.costUsd).toBeCloseTo(1.674293, 5);
  });

  it('non-subagent tool events are returned unchanged (no resultSummary added)', () => {
    const readEvent = { type: 'tool_execution_end', toolCallId: 'tc', toolName: 'read', result: { content: [{ type: 'text', text: 'ok' }] }, isError: false } as unknown as AgentSessionEvent;
    const out = enrichSubagentEvent(readEvent);
    expect(out.resultSummary).toBeUndefined();
    expect((out as AgentSessionEvent & { result: unknown }).result).toBe(readEvent.result);
  });

  it('§2.3 regression — Claude/OpenCode subagent-family names (Task/Agent) are NOT enriched', () => {
    // Enrichment is scoped to the Pi tool names `subagent`/`evaluated_subagent`
    // only, so the Claude `Task` / OpenCode `Agent` paths are forwarded
    // unchanged even if they happen to share the "subagent family" label.
    for (const toolName of ['Task', 'Agent', 'task', 'agent']) {
      const event = {
        type: 'tool_execution_end',
        toolCallId: 'tc',
        toolName,
        result: { content: [{ type: 'text', text: 'claude task output' }] },
        isError: false,
      } as unknown as AgentSessionEvent;
      const out = enrichSubagentEvent(event);
      expect(out.resultSummary, `${toolName} must not be enriched`).toBeUndefined();
      expect((out as AgentSessionEvent & { result: unknown }).result).toBe(event.result);
    }
  });
});
