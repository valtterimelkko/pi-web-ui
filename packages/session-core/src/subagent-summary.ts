/**
 * Pure, shared projection that turns a Pi SDK subagent / evaluated_subagent
 * `toolResult.details` object into a COMPACT {@link SubagentToolSummary}
 * (model, per-tool counts, turns, tokens, cost) — the only thing that should
 * cross the wire toward the client. It deliberately carries COUNTS/TOTALS only:
 * no inner-message text, no transcript, no final answer (those stay server-side).
 *
 * The rich data for the `subagent` shape lives entirely on the inner
 * `results[].messages[]` transcript (each assistant message carries
 * `provider`/`model`/`usage` and `toolCall` content blocks), so this derives
 * model / turns / tokens / per-tool counts / cost by summing those messages.
 * The `evaluated_subagent` shape has a flat `usage` (no inner messages) and
 * degrades: no model, no tool breakdown, but turns/tokens/cost are shown.
 *
 * Returns `null` for absent / unrecognized input so callers can fall back to the
 * legacy / plain rendering without try/catch.
 */

/** Max length (chars) of a delegated `task` string kept in the summary. */
const TASK_MAX_CHARS = 300;

/** Compact token count for one-line summaries: 116120 -> "116k". */
function formatTokenShort(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** Per-agent breakdown of one subagent result. */
export interface SubagentAgentSummary {
  /** Agent name, e.g. "codescout". */
  agent: string;
  /** Combined `provider/model`, e.g. "github-copilot/gpt-5.4-mini"; undefined if unknown. */
  model?: string;
  /** Delegated task text, truncated to <= TASK_MAX_CHARS chars. */
  task?: string;
  exitCode?: number;
  timedOut?: boolean;
  /** Count of inner assistant messages (subagent) or `usage.turns` (evaluated). */
  turns: number;
  /** Total inner tool calls. */
  toolCalls: number;
  /** Per-tool counts, sorted count desc then name asc. */
  toolBreakdown: Array<{ name: string; count: number }>;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

/** Compact, wire-safe summary of a subagent / evaluated_subagent tool result. */
export interface SubagentToolSummary {
  /** `details.mode`, or "evaluated" for evaluated_subagent. */
  mode: string;
  kind: 'subagent' | 'evaluated_subagent';
  agents: SubagentAgentSummary[];
  /** Aggregates across {@link agents}. */
  totals: {
    agentCount: number;
    toolCalls: number;
    turns: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    costUsd?: number;
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Combine separate provider + model into a single `provider/model` string. */
function combineModel(provider: string | undefined, model: string | undefined): string | undefined {
  const p = provider && provider.length > 0 ? provider : undefined;
  const m = model && model.length > 0 ? model : undefined;
  if (p && m) return `${p}/${m}`;
  return p ?? m;
}

/** Sort: count desc, then name asc. */
function sortBreakdown(items: Array<{ name: string; count: number }>): Array<{ name: string; count: number }> {
  return items.sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Summarize one `subagent` result (derives everything from `messages[]`). */
function summarizeResult(result: unknown): SubagentAgentSummary | null {
  const r = asRecord(result);
  if (!r) return null;

  const agent = typeof r.agent === 'string' && r.agent.length > 0 ? r.agent : 'agent';
  const messages = Array.isArray(r.messages) ? r.messages : [];

  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens: number | undefined;
  let cacheWriteTokens: number | undefined;
  let costUsd: number | undefined;
  let firstProvider: string | undefined;
  let firstModel: string | undefined;
  const toolCounts = new Map<string, number>();

  for (const raw of messages) {
    const msg = asRecord(raw);
    if (!msg || msg.role !== 'assistant') continue;
    turns++;

    const provider = typeof msg.provider === 'string' ? msg.provider : undefined;
    const model = typeof msg.model === 'string' ? msg.model : undefined;
    if (firstProvider === undefined && provider) firstProvider = provider;
    if (firstModel === undefined && model) firstModel = model;

    const usage = asRecord(msg.usage);
    if (usage) {
      const input = asFiniteNumber(usage.input);
      if (input !== undefined) inputTokens += input;
      const output = asFiniteNumber(usage.output);
      if (output !== undefined) outputTokens += output;
      const cacheRead = asFiniteNumber(usage.cacheRead);
      if (cacheRead !== undefined) cacheReadTokens = (cacheReadTokens ?? 0) + cacheRead;
      const cacheWrite = asFiniteNumber(usage.cacheWrite);
      if (cacheWrite !== undefined) cacheWriteTokens = (cacheWriteTokens ?? 0) + cacheWrite;
      // Per-message cost may be a number or { total } object; keep 0 as 0.
      const costTotal = typeof usage.cost === 'number'
        ? asFiniteNumber(usage.cost)
        : asFiniteNumber(asRecord(usage.cost)?.total);
      if (costTotal !== undefined) costUsd = (costUsd ?? 0) + costTotal;
    }

    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const blockRaw of content) {
      const block = asRecord(blockRaw);
      if (block && block.type === 'toolCall' && typeof block.name === 'string') {
        toolCounts.set(block.name, (toolCounts.get(block.name) ?? 0) + 1);
      }
    }
  }

  const toolBreakdown = sortBreakdown(
    Array.from(toolCounts.entries(), ([name, count]) => ({ name, count })),
  );
  const toolCalls = toolBreakdown.reduce((sum, t) => sum + t.count, 0);

  const taskRaw = typeof r.task === 'string' ? r.task : undefined;
  const task = taskRaw
    ? taskRaw.length > TASK_MAX_CHARS
      ? taskRaw.slice(0, TASK_MAX_CHARS)
      : taskRaw
    : undefined;

  const summary: SubagentAgentSummary = {
    agent,
    turns,
    toolCalls,
    toolBreakdown,
    inputTokens,
    outputTokens,
  };

  const model = combineModel(firstProvider, firstModel);
  if (model !== undefined) summary.model = model;
  if (task !== undefined) summary.task = task;
  const exitCode = asFiniteNumber(r.exitCode);
  if (exitCode !== undefined) summary.exitCode = exitCode;
  if (typeof r.timedOut === 'boolean') summary.timedOut = r.timedOut;
  if (cacheReadTokens !== undefined) summary.cacheReadTokens = cacheReadTokens;
  if (cacheWriteTokens !== undefined) summary.cacheWriteTokens = cacheWriteTokens;
  if (costUsd !== undefined) summary.costUsd = costUsd;

  return summary;
}

/** Summarize a flat `evaluated_subagent` details object. */
function summarizeEvaluated(details: Record<string, unknown>): SubagentAgentSummary {
  const usage = asRecord(details.usage) ?? {};
  const agent: SubagentAgentSummary = {
    agent: typeof details.agent === 'string' && details.agent.length > 0 ? details.agent : 'agent',
    // No inner messages → no model, no tool breakdown.
    turns: asFiniteNumber(usage.turns) ?? 0,
    toolCalls: 0,
    toolBreakdown: [],
    inputTokens: asFiniteNumber(usage.input) ?? 0,
    outputTokens: asFiniteNumber(usage.output) ?? 0,
  };

  const cacheRead = asFiniteNumber(usage.cacheRead);
  if (cacheRead !== undefined) agent.cacheReadTokens = cacheRead;
  const cacheWrite = asFiniteNumber(usage.cacheWrite);
  if (cacheWrite !== undefined) agent.cacheWriteTokens = cacheWrite;
  // evaluated `usage.cost` is a flat number; keep 0 as 0 (not dropped).
  const cost = asFiniteNumber(usage.cost);
  if (cost !== undefined) agent.costUsd = cost;

  const exitCode = asFiniteNumber(details.exitCode);
  if (exitCode !== undefined) agent.exitCode = exitCode;
  if (typeof details.timedOut === 'boolean') agent.timedOut = details.timedOut;

  return agent;
}

function aggregateTotals(agents: SubagentAgentSummary[]): SubagentToolSummary['totals'] {
  const totals: SubagentToolSummary['totals'] = {
    agentCount: agents.length,
    toolCalls: agents.reduce((sum, a) => sum + a.toolCalls, 0),
    turns: agents.reduce((sum, a) => sum + a.turns, 0),
    inputTokens: agents.reduce((sum, a) => sum + a.inputTokens, 0),
    outputTokens: agents.reduce((sum, a) => sum + a.outputTokens, 0),
  };

  const cacheReads = agents.map((a) => a.cacheReadTokens).filter((v): v is number => v !== undefined);
  const cacheWrites = agents.map((a) => a.cacheWriteTokens).filter((v): v is number => v !== undefined);
  const costs = agents.map((a) => a.costUsd).filter((v): v is number => v !== undefined);

  if (cacheReads.length > 0) totals.cacheReadTokens = cacheReads.reduce((a, b) => a + b, 0);
  if (cacheWrites.length > 0) totals.cacheWriteTokens = cacheWrites.reduce((a, b) => a + b, 0);
  if (costs.length > 0) totals.costUsd = costs.reduce((a, b) => a + b, 0);

  return totals;
}

/**
 * Pure. Returns `null` when `details` is absent/unrecognized (caller falls back
 * to legacy/plain rendering). Never throws.
 *
 * @param toolName The Pi tool name: `subagent`, `evaluated_subagent`, or other.
 * @param details  The raw `toolResult.details` object (untyped SDK data).
 */
export function summarizeSubagentDetails(toolName: string, details: unknown): SubagentToolSummary | null {
  const d = asRecord(details);
  if (!d) return null;

  if (toolName === 'evaluated_subagent') {
    // Require at least one recognized evaluated field, else treat as unrecognized.
    const hasUsage = asRecord(d.usage) !== null;
    const recognized = typeof d.agent === 'string' || hasUsage ||
      d.run_id !== undefined || d.exitCode !== undefined || d.round !== undefined ||
      d.timedOut !== undefined;
    if (!recognized) return null;
    const agent = summarizeEvaluated(d);
    return { mode: 'evaluated', kind: 'evaluated_subagent', agents: [agent], totals: aggregateTotals([agent]) };
  }

  if (toolName === 'subagent') {
    const results = Array.isArray(d.results) ? d.results : null;
    if (results === null) return null; // no `results` array → unrecognized
    const agents = results
      .map(summarizeResult)
      .filter((x): x is SubagentAgentSummary => x !== null);
    return {
      mode: typeof d.mode === 'string' ? d.mode : 'single',
      kind: 'subagent',
      agents,
      totals: aggregateTotals(agents),
    };
  }

  return null; // unknown toolName
}

/**
 * One-line, human-readable summary shared by the client card (collapsed) and
 * the screen-view projection, so the agent's `view=screen` text matches what
 * the user sees. e.g. `"46 tools · 13 turns · 116k tok"`; evaluated_subagent
 * (no tools) appends cost: `"19 turns · 211k tok · $1.67"`.
 */
export function formatSubagentOneLine(summary: SubagentToolSummary): string {
  const t = summary.totals;
  const totalTokens = t.inputTokens + t.outputTokens;
  const parts: string[] = [];
  if (t.toolCalls > 0) parts.push(`${t.toolCalls} tool${t.toolCalls !== 1 ? 's' : ''}`);
  parts.push(`${t.turns} turn${t.turns !== 1 ? 's' : ''}`);
  parts.push(`${formatTokenShort(totalTokens)} tok`);
  if (summary.kind === 'evaluated_subagent' && typeof t.costUsd === 'number') {
    parts.push(`$${t.costUsd.toFixed(2)}`);
  }
  return parts.join(' · ');
}
