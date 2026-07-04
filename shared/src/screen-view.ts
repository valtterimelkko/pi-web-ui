/**
 * Screen View — the single source of truth for "what the user sees by default
 * on screen" in a session.
 *
 * This module is intentionally PURE: it imports nothing from `server/` or
 * `client/`, uses no Node or DOM APIs, and performs no I/O. Both the server
 * (Internal API `view=screen`) and the client (the message list) consume it so
 * the agent's view of a session and the user's screen are defined by ONE body
 * of code.
 *
 * It operates on the common replay-event stream that every runtime produces
 * after normalization (`message_start` / `message_update` / `message_end` /
 * `tool_execution_start` / `tool_execution_end`, …). Because normalization
 * happens server-side before this point, the projection is runtime-agnostic by
 * construction.
 *
 * See SCREEN-VIEW-OBSERVABILITY-PLAN.md §3 for the contract.
 */

// ─── Public types ──────────────────────────────────────────────────────────────

import {
  summarizeSubagentDetails,
  formatSubagentOneLine,
  type SubagentToolSummary,
} from './subagent-summary.js';

export type ScreenItemKind = 'user' | 'assistant' | 'tool' | 'tool_group' | 'thinking';

export interface ScreenItem {
  kind: ScreenItemKind;
  /** Text shown by default (collapsed). For tools: the header line (name + primary arg). */
  text: string;
  /** True if this item hides content behind a collapsed card by default. */
  collapsedByDefault: boolean;
  /** Present only when the caller opts in via expand=… ; the hidden content. */
  expandedText?: string;
  toolName?: string;
  toolPrimaryArg?: string;
  /** For tool_group: how many tools are collapsed under the toggle. */
  groupSize?: number;
  /** Cheap rendered-size estimate (line count) — for card/virtualization tuning. */
  estimatedLines: number;
  timestamp?: number;
}

export interface ScreenView {
  items: ScreenItem[];
  itemCount: number;
  /** Total estimated default-rendered lines (sum of visible items). */
  estimatedTotalLines: number;
  /** Echo of which expansions were applied. */
  expanded: { tools: boolean; thinking: boolean };
}

export interface ProjectOptions {
  expand?: { tools?: boolean; thinking?: boolean };
}

// ─── Tunables ──────────────────────────────────────────────────────────────────

/**
 * Minimum consecutive visible-tool run that collapses into a single tool_group.
 * Mirrors the client `toolGroupMeta` threshold. Shared so it cannot drift.
 */
export const TOOL_GROUP_MIN_RUN = 3;

/** Tool cards are collapsed by default (output hidden). Shared rule. */
export const TOOL_COLLAPSED_BY_DEFAULT = true;

/** Thinking blocks are collapsed by default (summary shown, full text hidden). Shared rule. */
export const THINKING_COLLAPSED_BY_DEFAULT = true;

/**
 * Expanded tool output is truncated to this many characters — same semantics as
 * `MAX_TOOL_OUTPUT_LENGTH` in session-transfer/types.ts. Duplicated locally to
 * keep this module pure (no server import).
 */
export const MAX_TOOL_OUTPUT_LENGTH = 200;

/** Soft-wrap column used by the cheap line estimate. */
const ESTIMATE_WRAP_COLS = 80;

// ─── Rule primitive: visible-tool allowlist (unified superset) ─────────────────

/**
 * Tool names that render as cards in the default view. This is the unified
 * superset — Pi SDK lowercase names, Claude/OpenCode PascalCase equivalents,
 * the OpenCode `_tool`-suffixed names, plus subagent/todo/skill specials.
 *
 * Ported from the client list (the richer of the two previous divergent sets)
 * so the agent's view matches the screen exactly. Membership is exact and
 * case-sensitive: both `read` and `Read` are members, so each runtime's
 * spelling resolves without fuzzy matching (which would over-match arbitrary
 * MCP names).
 */
export const VISIBLE_TOOL_NAMES = new Set<string>([
  // Pi SDK names
  'subagent', 'read', 'todo', 'bash', 'write', 'edit', 'grep', 'glob',
  'web_search', 'web_fetch', 'search', 'fetch',
  'think', 'skill', 'ask_user',
  // Claude SDK equivalents (PascalCase)
  'Agent', 'Task', 'Read', 'TodoWrite', 'TodoRead',
  'Bash', 'Write', 'Edit', 'Grep', 'Glob',
  'WebSearch', 'WebFetch',
  'EnterPlanMode', 'ExitPlanMode',
  'Skill', 'AskUserQuestion',
  // OpenCode tool names (PascalCase, _tool-suffixed)
  'Read_tool', 'Bash_tool', 'Write_tool', 'Edit_tool',
  'Grep_tool', 'Glob_tool', 'WebSearch_tool', 'WebFetch_tool',
  'TodoRead_tool', 'TodoWrite_tool',
]);

/** Whether a tool name renders as a visible card. Exact, case-sensitive match. */
export function isVisibleTool(name: string): boolean {
  return VISIBLE_TOOL_NAMES.has(name);
}

// ─── Rule primitive: special-card name families ────────────────────────────────

/** subagent / Agent / Task — rendered with a hierarchical summary card. */
export function isSubagentToolName(name: string): boolean {
  const n = name.toLowerCase();
  return n === 'subagent' || n === 'agent' || n === 'task';
}

/** todo / TodoWrite / TodoRead — rendered with a checklist card. */
export function isTodoToolName(name: string): boolean {
  const n = name.toLowerCase();
  return n === 'todo' || n === 'todowrite' || n === 'todoread';
}

// ─── Rule primitive: skill-content detection ───────────────────────────────────

function extractSkillName(content: string): string | null {
  const m = content.match(/<skill name="([^"]+)"/);
  return m ? m[1] : null;
}

/**
 * Detect whether a message's text is skill content (injected by /skill:name)
 * and, if so, extract the skill name. Mirrors the client `getSkillContentInfo`
 * logic exactly so the screen and the agent agree on what collapses to a
 * placeholder.
 */
export function detectSkillContent(text: string): { isSkill: boolean; skillName?: string } {
  const trimmed = (text ?? '').trim();

  // XML form from the SDK — require BOTH open and close tags to avoid false
  // positives (supports raw and HTML-escaped variants).
  const hasSkillOpenTag = trimmed.includes('<skill name="') || trimmed.includes('&lt;skill name="');
  const hasSkillCloseTag = trimmed.includes('</skill>') || trimmed.includes('&lt;/skill&gt;');
  const hasFullSkillStructure = hasSkillOpenTag && hasSkillCloseTag;

  // Markdown forms seen after processing.
  const hasLectureHeader = trimmed.startsWith('# Lecture Website Builder');
  const hasSkillHeader = trimmed.startsWith('# Skill:');
  const hasSkillStructure = trimmed.includes('### Skill Purpose') && trimmed.includes('### Workflow');

  const isSkill = hasFullSkillStructure || hasLectureHeader || hasSkillHeader || hasSkillStructure;
  if (!isSkill) return { isSkill: false };

  return { isSkill: true, skillName: extractSkillName(trimmed) ?? undefined };
}

/** The brief placeholder shown in place of verbose skill content. */
export function skillPlaceholder(name?: string): string {
  return name ? `📚 **Skill loaded: ${name}**` : '📚 **Skill loaded**';
}

// ─── Rule primitive: tool primary arg ──────────────────────────────────────────

/**
 * The single argument value shown inline in a tool card header (file path,
 * command, pattern, url, …). Mirrors the client `getPrimaryParam` priority
 * order and 50-char truncation exactly. `name` is accepted for a unified
 * signature; the selection is arg-key based (as on screen).
 */
export function toolPrimaryArg(_name: string, args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const obj = args as Record<string, unknown>;
  const entries = Object.entries(obj);
  if (entries.length === 0) return undefined;

  const priorityKeys = ['path', 'command', 'pattern', 'url', 'query', 'file_path', 'target_path'];
  for (const key of priorityKeys) {
    const value = obj[key];
    if (typeof value === 'string' && value.length > 0) {
      return value.length > 50 ? `${value.slice(0, 50)}…` : value;
    }
  }

  const firstString = entries.find(([, v]) => typeof v === 'string');
  if (firstString) {
    const value = firstString[1] as string;
    return value.length > 50 ? `${value.slice(0, 50)}…` : value;
  }

  return undefined;
}

// ─── Rule primitive: line estimate ─────────────────────────────────────────────

/**
 * Cheap rendered-size estimate (in lines) for a single screen item. Monotonic
 * non-decreasing in the item's text length. Used for card/virtualization
 * tuning — not pixel-perfect (no fonts/wrapping/layout), a logical estimate.
 */
export function estimateItemLines(item: ScreenItem): number {
  if (item.kind === 'tool_group') return 1;
  const text = item.text ?? '';
  if (text.length === 0) return 0;
  const explicitLines = text.split('\n').length;
  const wrappedLines = Math.ceil(text.length / ESTIMATE_WRAP_COLS);
  return Math.max(explicitLines, wrappedLines);
}

/**
 * The shared tool-grouping RULE: find maximal runs of consecutive tool items of
 * length >= `minRun`. Both the server projection and the client message list
 * use this so the grouping decision is defined by one body of code. Returns the
 * runs as `{ start, size }` index ranges; callers map them to their own shapes.
 */
export function findConsecutiveToolRuns(
  length: number,
  isTool: (index: number) => boolean,
  minRun: number = TOOL_GROUP_MIN_RUN,
): Array<{ start: number; size: number }> {
  const runs: Array<{ start: number; size: number }> = [];
  let i = 0;
  while (i < length) {
    if (isTool(i)) {
      let j = i;
      while (j < length && isTool(j)) j++;
      const size = j - i;
      if (size >= minRun) runs.push({ start: i, size });
      i = j;
    } else {
      i++;
    }
  }
  return runs;
}

// ─── Internal: result-text extraction (mirrors visible-transcript) ─────────────

function extractToolResultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') return '';

  const record = result as Record<string, unknown>;

  if (Array.isArray(record.content)) {
    return record.content
      .filter((c: unknown) => c && typeof c === 'object' && (c as Record<string, unknown>).type === 'text')
      .map((c: Record<string, unknown>) => (c.text as string) ?? '')
      .join('');
  }

  if (typeof record.text === 'string') return record.text;

  return '';
}

function truncateForExpand(text: string): string {
  return text.length > MAX_TOOL_OUTPUT_LENGTH
    ? `${text.slice(0, MAX_TOOL_OUTPUT_LENGTH)}...`
    : text;
}

/**
 * Extract a compact subagent/evaluated_subagent summary from a tool_execution_end
 * event, if any. Prefers a pre-computed `resultSummary` (attached by the Pi
 * live forwarder) and falls back to computing one from raw `result.details`
 * (replay/raw events). Returns undefined for non-subagent tools or absent data.
 */
function subagentSummaryFromEvent(event: Record<string, unknown>): SubagentToolSummary | undefined {
  const direct = event.resultSummary;
  if (direct && typeof direct === 'object') return direct as SubagentToolSummary;
  const toolName = event.toolName;
  if (typeof toolName !== 'string') return undefined;
  const result = event.result;
  if (!result || typeof result !== 'object') return undefined;
  const details = (result as { details?: unknown }).details;
  if (details === undefined) return undefined;
  return summarizeSubagentDetails(toolName, details) ?? undefined;
}

/** Build the default (header) text for a tool item, incl. special cards. */
function buildToolHeaderText(
  toolName: string,
  args: unknown,
  summary?: SubagentToolSummary,
): { text: string; primaryArg?: string } {
  const primaryArg = toolPrimaryArg(toolName, args);
  const argsRecord = (args && typeof args === 'object') ? args as Record<string, unknown> : undefined;

  if (isSubagentToolName(toolName)) {
    // Enriched Pi SDK summary (model + tool-usage one-line), faithful to the
    // client card. Preferred over the legacy args-only task-count summary.
    if (summary) {
      const agent = summary.agents[0]?.agent ?? 'agent';
      const model = summary.agents[0]?.model;
      let text = `${toolName}: ${summary.mode} · ${agent}`;
      if (model) text += ` · ${model}`;
      text += ` · ${formatSubagentOneLine(summary)}`;
      return { text, primaryArg };
    }
    const mode = typeof argsRecord?.mode === 'string' ? argsRecord.mode : 'delegated';
    const tasks = argsRecord?.tasks;
    const count = Array.isArray(tasks) ? tasks.length : 0;
    if (count > 0) {
      return { text: `${toolName}: ${mode} · ${count} task${count === 1 ? '' : 's'}`, primaryArg };
    }
  }

  if (isTodoToolName(toolName)) {
    const todos = argsRecord?.todos;
    if (Array.isArray(todos) && todos.length > 0) {
      // Serialize as a short checklist (first 5 items; ☑ done / ☐ pending).
      const items = todos.slice(0, 5).map((t: unknown) => {
        const obj = t && typeof t === 'object' ? (t as Record<string, unknown>) : {};
        const done =
          obj.status === 'completed' || obj.done === true || obj.completed === true;
        const label =
          typeof obj.content === 'string' ? obj.content
          : typeof obj.text === 'string' ? obj.text
          : '';
        return `${done ? '☑' : '☐'} ${label}`.trimEnd();
      });
      const more = todos.length > 5 ? `\n… (+${todos.length - 5} more)` : '';
      return { text: `${toolName}:\n${items.join('\n')}${more}`, primaryArg };
    }
  }

  return { text: primaryArg ? `${toolName}: ${primaryArg}` : toolName, primaryArg };
}

/** First-sentence / ~60-char summary of a thinking block (matches the client). */
export function summarizeThinking(thinking: string): string {
  const firstSentence = thinking.split(/[.!?]\s/)[0] ?? '';
  return firstSentence.length > 60 ? `${firstSentence.slice(0, 60)}…` : firstSentence;
}

// ─── Accumulators ──────────────────────────────────────────────────────────────

interface AccumulatedMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  thinking: string;
  timestamp: number;
}

interface PendingTool {
  toolCallId: string;
  toolName: string;
  args: unknown;
  startTimestamp: number;
  result?: string;
  isError?: boolean;
  /** Compact Pi subagent/evaluated_subagent summary, when the event carried one. */
  summary?: SubagentToolSummary;
}

// ─── Event projection ──────────────────────────────────────────────────────────

/**
 * Project the common replay-event stream into the default screen view.
 *
 * Pure: given the same events + options it always returns the same view. The
 * `expand` opt-in surfaces content that is collapsed by default (tool output,
 * thinking).
 */
export function projectDefaultViewFromEvents(
  events: Array<Record<string, unknown>>,
  opts?: ProjectOptions,
): ScreenView {
  const expandTools = !!opts?.expand?.tools;
  const expandThinking = !!opts?.expand?.thinking;

  const rawItems: ScreenItem[] = [];
  const messages = new Map<string, AccumulatedMessage>();
  const pendingTools = new Map<string, PendingTool>();

  const emitTool = (p: PendingTool): void => {
    if (!isVisibleTool(p.toolName)) return;
    const { text, primaryArg } = buildToolHeaderText(p.toolName, p.args, p.summary);
    const item: ScreenItem = {
      kind: 'tool',
      text,
      collapsedByDefault: true,
      toolName: p.toolName,
      toolPrimaryArg: primaryArg,
      estimatedLines: 0,
      timestamp: p.startTimestamp,
    };
    if (expandTools) {
      item.expandedText = truncateForExpand(p.result ?? '');
    }
    rawItems.push(item);
  };

  const emitAssistantMessage = (acc: AccumulatedMessage): void => {
    // Thinking is rendered above the text bubble.
    if (acc.thinking) {
      const thinkingItem: ScreenItem = {
        kind: 'thinking',
        text: summarizeThinking(acc.thinking),
        collapsedByDefault: true,
        estimatedLines: 0,
        timestamp: acc.timestamp,
      };
      if (expandThinking) {
        thinkingItem.expandedText = acc.thinking;
      }
      rawItems.push(thinkingItem);
    }
    if (acc.text.trim()) {
      const det = detectSkillContent(acc.text);
      const text = det.isSkill ? skillPlaceholder(det.skillName) : acc.text;
      rawItems.push({
        kind: 'assistant',
        text,
        collapsedByDefault: false,
        estimatedLines: 0,
        timestamp: acc.timestamp,
      });
    }
    // An assistant message with neither text nor thinking contributes nothing
    // visible in a completed-session snapshot (its live "Processed" affordance
    // is streaming-only and does not apply here).
  };

  for (const event of events) {
    const type = event.type as string;

    if (type === 'message_start') {
      const msg = event.message as Record<string, unknown> | undefined;
      if (!msg) continue;
      const id = msg.id as string;
      const role = msg.role as string;
      if (role !== 'user' && role !== 'assistant') continue;

      const content = msg.content;
      const initialText = typeof content === 'string' ? content : '';
      messages.set(id, {
        id,
        role: role as 'user' | 'assistant',
        text: initialText,
        thinking: '',
        timestamp: (event.timestamp as number) ?? 0,
      });
    } else if (type === 'message_update') {
      const msg = event.message as Record<string, unknown> | undefined;
      if (!msg) continue;
      const id = msg.id as string;
      const acc = messages.get(id);
      if (!acc) continue;

      const ae = event.assistantMessageEvent as Record<string, unknown> | undefined;
      if (ae) {
        if (ae.type === 'text_delta' && typeof ae.delta === 'string') {
          acc.text += ae.delta;
        } else if (ae.type === 'thinking' && typeof ae.thinking === 'string') {
          acc.thinking = acc.thinking ? `${acc.thinking}\n\n${ae.thinking}` : ae.thinking;
        } else if (ae.type === 'thinking_delta' && typeof ae.delta === 'string') {
          acc.thinking += ae.delta;
        }
      }
    } else if (type === 'message_end') {
      const msg = event.message as Record<string, unknown> | undefined;
      if (!msg) continue;
      const id = msg.id as string;
      const acc = messages.get(id);
      if (!acc) continue;
      messages.delete(id);

      if (acc.role === 'user') {
        const det = detectSkillContent(acc.text);
        const text = det.isSkill ? skillPlaceholder(det.skillName) : acc.text;
        rawItems.push({
          kind: 'user',
          text,
          collapsedByDefault: false,
          estimatedLines: 0,
          timestamp: acc.timestamp,
        });
      } else {
        emitAssistantMessage(acc);
      }
    } else if (type === 'tool_execution_start') {
      const toolCallId = event.toolCallId as string;
      const toolName = event.toolName as string;
      if (!toolCallId || !toolName) continue;
      pendingTools.set(toolCallId, {
        toolCallId,
        toolName,
        args: event.args,
        startTimestamp: (event.timestamp as number) ?? 0,
      });
    } else if (type === 'tool_execution_end') {
      const toolCallId = event.toolCallId as string;
      if (!toolCallId) continue;
      const pending = pendingTools.get(toolCallId);
      if (!pending) continue; // no matching start → not emitted (matches existing projection)
      pendingTools.delete(toolCallId);
      pending.result = extractToolResultText(event.result);
      pending.isError = !!event.isError;
      const summary = subagentSummaryFromEvent(event);
      if (summary) pending.summary = summary;
      emitTool(pending);
    }
  }

  const grouped = applyToolGrouping(rawItems, expandTools);

  // Finalize per-item estimates and the total (sum of visible items).
  let estimatedTotalLines = 0;
  for (const item of grouped) {
    item.estimatedLines = estimateItemLines(item);
    estimatedTotalLines += item.estimatedLines;
  }

  return {
    items: grouped,
    itemCount: grouped.length,
    estimatedTotalLines,
    expanded: { tools: expandTools, thinking: expandThinking },
  };
}

/**
 * Collapse consecutive runs of `TOOL_GROUP_MIN_RUN`+ visible tool items into a
 * single tool_group. Run-finding is delegated to the shared
 * `findConsecutiveToolRuns` primitive (same one the client uses). Skipped
 * (un-grouped) when tools are expanded.
 */
function applyToolGrouping(items: ScreenItem[], expandTools: boolean): ScreenItem[] {
  if (expandTools) return items;

  const runs = findConsecutiveToolRuns(items.length, (idx) => items[idx].kind === 'tool');
  if (runs.length === 0) return items;

  const runByStart = new Map(runs.map((r) => [r.start, r]));
  const out: ScreenItem[] = [];
  let i = 0;
  while (i < items.length) {
    const run = runByStart.get(i);
    if (run) {
      out.push({
        kind: 'tool_group',
        text: `(${run.size} tools)`,
        collapsedByDefault: true,
        groupSize: run.size,
        estimatedLines: 1,
        timestamp: items[i].timestamp,
      });
      i += run.size;
    } else {
      out.push(items[i]);
      i++;
    }
  }
  return out;
}

// ─── Markdown renderer (the "text screenshot") ─────────────────────────────────

/**
 * Render a screen view as a stable markdown "text screenshot." Deterministic
 * for a fixed input. Intended for an agent consumer that wants to read what the
 * user sees without driving a browser.
 */
export function renderScreenViewMarkdown(view: ScreenView): string {
  const lines: string[] = [];
  lines.push('# Screen view');
  lines.push('');
  lines.push(`Items: ${view.itemCount}`);
  lines.push(`Estimated lines: ${view.estimatedTotalLines}`);
  lines.push(`Expanded: tools=${view.expanded.tools}, thinking=${view.expanded.thinking}`);
  lines.push('');
  lines.push('---');

  for (const item of view.items) {
    lines.push('');
    switch (item.kind) {
      case 'user':
        lines.push('## 👤 User');
        break;
      case 'assistant':
        lines.push('## 🤖 Assistant');
        break;
      case 'thinking':
        lines.push(`### 💭 Thinking${item.collapsedByDefault ? ' (collapsed)' : ''}`);
        break;
      case 'tool': {
        // Special cards (e.g. todo checklist) may carry multi-line text; render
        // the first line as the header and the rest as a body block.
        const [firstLine, ...rest] = item.text.split('\n');
        lines.push(`### 🔧 ${firstLine}${item.collapsedByDefault ? ' (collapsed)' : ''}`);
        if (rest.length) {
          lines.push('');
          lines.push(rest.join('\n'));
        }
        break;
      }
      case 'tool_group':
        lines.push(`### 🗂 ${item.text} (collapsed)`);
        break;
    }

    if ((item.kind === 'user' || item.kind === 'assistant' || item.kind === 'thinking') && item.text) {
      lines.push('');
      lines.push(item.text);
    }

    if (item.expandedText !== undefined && item.expandedText !== '') {
      lines.push('');
      lines.push('<details>');
      lines.push('');
      lines.push(item.expandedText);
      lines.push('');
      lines.push('</details>');
    }
  }

  return lines.join('\n');
}
