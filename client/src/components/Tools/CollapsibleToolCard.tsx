import React, { useState, useMemo, useCallback, useEffect, memo } from 'react';
import { normalizeToolName } from '../../lib/messageAdapter';
// Shared rules — same values the server-side screen-view projection uses:
// collapsed-by-default for tool cards, and the truncation length for output.
import { TOOL_COLLAPSED_BY_DEFAULT } from '@pi-web-ui/shared';
import {
  Terminal,
  ChevronRight,
  FileText,
  Edit3,
  Search,
  FolderSearch,
  Globe,
  Link2,
  Loader2,
  Bot,
  Brain,
  ListTodo,
  Mail,
  Copy,
  Check,
  Clock,
} from 'lucide-react';

/**
 * CollapsibleToolCard - Kimi-style verbosity strategy implementation
 * 
 * Verbosity Strategy:
 * - COLLAPSED BY DEFAULT: Shows only icon + name + primary param (truncated) + status
 * - EXPANDED: Shows arguments and full result
 * - HIDDEN: Long outputs are truncated and can be expanded
 * - BRIEF: Always visible summary for quick scanning
 */

interface ToolResult {
  output: string;
  isError: boolean;
}

interface CollapsibleToolCardProps {
  name: string;
  args: unknown;
  result?: ToolResult | null;
  startTime?: number; // Unix timestamp when tool started
  forceExpanded?: boolean; // externally controlled (e.g. "Expand all" toggle)
  embedded?: boolean; // true when rendered inside a ToolGroupContainer row
}

// Map tool names to icons (following Kimi's approach)
const TOOL_ICONS: Record<string, React.ReactNode> = {
  bash: <Terminal className="w-3.5 h-3.5" strokeWidth={1.75} />,
  read: <FileText className="w-3.5 h-3.5" strokeWidth={1.75} />,
  write: <Edit3 className="w-3.5 h-3.5" strokeWidth={1.75} />,
  edit: <Edit3 className="w-3.5 h-3.5" strokeWidth={1.75} />,
  grep: <Search className="w-3.5 h-3.5" strokeWidth={1.75} />,
  glob: <FolderSearch className="w-3.5 h-3.5" strokeWidth={1.75} />,
  search: <Globe className="w-3.5 h-3.5" strokeWidth={1.75} />,
  fetch: <Link2 className="w-3.5 h-3.5" strokeWidth={1.75} />,
  web_search: <Globe className="w-3.5 h-3.5" strokeWidth={1.75} />,
  web_fetch: <Link2 className="w-3.5 h-3.5" strokeWidth={1.75} />,
  subagent: <Bot className="w-3.5 h-3.5" strokeWidth={1.75} />,
  think: <Brain className="w-3.5 h-3.5" strokeWidth={1.75} />,
  todo: <ListTodo className="w-3.5 h-3.5" strokeWidth={1.75} />,
  mail: <Mail className="w-3.5 h-3.5" strokeWidth={1.75} />,
  command_status: <Terminal className="w-3.5 h-3.5" strokeWidth={1.75} />,
  send_command_input: <Terminal className="w-3.5 h-3.5" strokeWidth={1.75} />,
  wait: <Clock className="w-3.5 h-3.5" strokeWidth={1.75} />,
};

// Map tool names to display names
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  bash: 'Shell',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  grep: 'Search',
  glob: 'Find Files',
  search: 'Web Search',
  fetch: 'Fetch URL',
  web_search: 'Web Search',
  web_fetch: 'Fetch URL',
  subagent: 'Subagent',
  think: 'Think',
  todo: 'Todo',
  mail: 'Mail',
  // Antigravity background-command lifecycle (agy run_command --background)
  command_status: 'Background process',
  send_command_input: 'Background input',
  wait: 'Wait',
};

// Get primary parameter value for inline display (Kimi-style)
function getPrimaryParam(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0) return null;

  // Priority order: path, command, pattern, url, query, then first param.
  // Antigravity PascalCase keys (CommandLine / TargetFile / AbsolutePath) are
  // matched case-insensitively so agy cards get the same primary arg display.
  const priorityKeys = ['path', 'command', 'commandline', 'pattern', 'url', 'query', 'file_path', 'target_path', 'targetfile', 'absolutepath'];
  const lowerKeyToValue = new Map<string, unknown>(
    entries.map(([k, v]) => [k.toLowerCase(), v]),
  );
  for (const key of priorityKeys) {
    const value = lowerKeyToValue.get(key);
    if (typeof value === 'string' && value.length > 0) {
      // Truncate to 50 chars like Kimi
      return value.length > 50 ? `${value.slice(0, 50)}…` : value;
    }
  }

  // Fall back to first string param
  const firstString = entries.find(([, v]) => typeof v === 'string');
  if (firstString) {
    const value = firstString[1] as string;
    return value.length > 50 ? `${value.slice(0, 50)}…` : value;
  }

  return null;
}

// Format natural action and target for Claude Code-like tool headers
function formatToolActionSummary(name: string, args: unknown): { action: string; target?: string } {
  const norm = normalizeToolName(name).toLowerCase();
  const record = (args && typeof args === 'object') ? (args as Record<string, unknown>) : {};

  if (norm === 'bash' || norm === 'run_command') {
    const cmd = (record.command || record.CommandLine || record.cmd || '') as string;
    return { action: 'Run', target: cmd ? (cmd.length > 60 ? `${cmd.slice(0, 60)}…` : cmd) : undefined };
  }
  if (norm === 'read' || norm === 'view_file') {
    const path = (record.path || record.AbsolutePath || record.file_path || '') as string;
    const basename = path.split('/').filter(Boolean).pop() || path;
    return { action: 'Read', target: basename || path };
  }
  if (norm === 'write' || norm === 'write_to_file') {
    const path = (record.path || record.TargetFile || record.file_path || '') as string;
    const basename = path.split('/').filter(Boolean).pop() || path;
    return { action: 'Write', target: basename || path };
  }
  if (norm === 'edit' || norm === 'replace_file_content') {
    const path = (record.path || record.TargetFile || record.file_path || '') as string;
    const basename = path.split('/').filter(Boolean).pop() || path;
    return { action: 'Edit', target: basename || path };
  }
  if (norm === 'glob' || norm === 'find_by_name') {
    const pat = (record.pattern || record.Pattern || '') as string;
    return { action: 'Find files', target: pat ? `"${pat}"` : undefined };
  }
  if (norm === 'grep' || norm === 'grep_search') {
    const q = (record.pattern || record.query || record.Query || '') as string;
    return { action: 'Search', target: q ? `"${q}"` : undefined };
  }
  if (norm.includes('skill')) {
    const skillName = (record.skill || record.name || '') as string;
    return { action: 'Ran skill', target: skillName ? `/${skillName}` : undefined };
  }

  const displayName = TOOL_DISPLAY_NAMES[normalizeToolName(name)] ?? TOOL_DISPLAY_NAMES[name] ?? name;
  const primary = getPrimaryParam(args);
  return { action: displayName, target: primary ?? undefined };
}

// Format args for display
function formatArgs(args: unknown): string {
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

// Format result for display
function formatResult(output: string): string {
  try {
    const parsed = JSON.parse(output);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return output;
  }
}

// Strip ANSI escape codes from output
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x1b\x9b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]/g, '');
}

// Short parameter display (inline)
const ShortParam = memo(function ShortParam({ 
  paramKey, 
  value 
}: { 
  paramKey: string; 
  value: string;
}) {
  return (
    <div className="flex items-baseline gap-2 text-xs font-mono">
      <span className="text-content-muted dark:text-content-muted-dark shrink-0 select-none">{paramKey}</span>
      <span className="text-content-secondary dark:text-content-secondary-dark truncate">
        <span className="text-content-muted dark:text-content-muted-dark">"</span>
        {value}
        <span className="text-content-muted dark:text-content-muted-dark">"</span>
      </span>
    </div>
  );
});

// Long parameter display (expandable)
const LongParam = memo(function LongParam({ 
  paramKey, 
  value,
  preview 
}: { 
  paramKey: string; 
  value: string;
  preview: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const cleanValue = stripAnsi(value);

  return (
    <div className="space-y-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-baseline gap-2 text-xs font-mono w-full text-left group"
        type="button"
      >
        <span className="text-content-muted dark:text-content-muted-dark shrink-0 select-none">{paramKey}</span>
        <ChevronRight strokeWidth={1.75} className={`w-3 h-3 text-content-muted dark:text-content-muted-dark transition-transform duration-200 shrink-0 ${expanded ? 'rotate-90' : ''}`} />
        {!expanded && (
          <span className="text-content-muted dark:text-content-muted-dark truncate group-hover:text-content-secondary dark:group-hover:text-content-secondary-dark">
            {preview}…
          </span>
        )}
      </button>
      {expanded && (
        <pre className="ml-4 bg-surface-subtle dark:bg-surface-dark-subtle border border-outline-subtle dark:border-outline-subtle-dark rounded p-2 overflow-x-auto text-xs font-mono text-content-secondary dark:text-content-secondary-dark">
          <code>{cleanValue}</code>
        </pre>
      )}
    </div>
  );
});

// Tool input section (parameters)
const ToolInputSection = memo(function ToolInputSection({ args }: { args: unknown }) {
  const [copied, setCopied] = useState(false);
  
  if (!args || typeof args !== 'object') return null;

  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0) return null;

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(formatArgs(args));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [args]);

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-content-muted dark:text-content-muted-dark font-mono">Arguments</span>
        <button
          onClick={handleCopy}
          className="p-1 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800 text-content-muted dark:text-content-muted-dark hover:text-content-primary dark:hover:text-content-primary-dark transition-colors"
          title="Copy arguments"
        >
          {copied ? <Check className="w-3 h-3 text-emerald-500" strokeWidth={1.75} /> : <Copy className="w-3 h-3" strokeWidth={1.75} />}
        </button>
      </div>
      {entries.map(([key, value]) => {
        const strValue = typeof value === 'string' ? value : JSON.stringify(value);
        const cleanValue = stripAnsi(strValue);
        const isShort = cleanValue.length <= 120 && !cleanValue.includes('\n');
        const preview = cleanValue.split('\n')[0].slice(0, 80);

        if (isShort) {
          return <ShortParam key={key} paramKey={key} value={strValue} />;
        }
        return <LongParam key={key} paramKey={key} value={strValue} preview={preview} />;
      })}
    </div>
  );
});

// Parse todo tool output to extract status message
function parseTodoOutput(output: string): { message: string; isToggle: boolean } | null {
  try {
    const parsed = JSON.parse(output);
    // Check if this is a todo tool result
    if (parsed && typeof parsed === 'object') {
      // Handle toggle response: { success: true, message: "Todo #2 completed", id: 2 }
      if (parsed.message && typeof parsed.message === 'string') {
        return {
          message: parsed.message,
          isToggle: parsed.message.includes('completed') || parsed.message.includes('uncompleted'),
        };
      }
      // Handle list response: { todos: [...] }
      if (parsed.todos && Array.isArray(parsed.todos)) {
        const completed = parsed.todos.filter((t: { completed?: boolean }) => t.completed).length;
        const total = parsed.todos.length;
        return {
          message: `${completed}/${total} todos completed`,
          isToggle: false,
        };
      }
    }
  } catch {
    // Not JSON, return null to use default formatting
  }
  return null;
}

// Extract file info from read tool output for brief display
function parseReadOutput(output: string): { lines: number; chars: number; truncated: boolean } | null {
  // Read tool output is just the file content as text
  const lines = output.split('\n').length;
  const chars = output.length;
  // Check if output appears truncated (Pi truncates at 2000 lines or 50KB)
  const truncated = output.endsWith('…') || output.includes('[Output truncated');
  return { lines, chars, truncated };
}

// Extract web search info for brief display
function parseWebSearchOutput(output: string): { results: number; chars: number } | null {
  // Web search returns JSON with search results
  try {
    const parsed = JSON.parse(output);
    if (parsed && typeof parsed === 'object') {
      // DuckDuckGo results format: { results: [...] }
      const resultsCount = Array.isArray(parsed.results) ? parsed.results.length : 
                           Array.isArray(parsed) ? parsed.length : 1;
      return { results: resultsCount, chars: output.length };
    }
  } catch {
    // Not JSON, count as text
    if (output.length > 0) {
      return { results: 1, chars: output.length };
    }
  }
  return null;
}

// Extract web fetch info for brief display
function parseWebFetchOutput(output: string): { chars: number; truncated: boolean } | null {
  // Web fetch returns markdown/text content from a web page
  const chars = output.length;
  const truncated = output.includes('[Content truncated') || output.length > 50000;
  if (chars > 0) {
    return { chars, truncated };
  }
  return null;
}

// Tools that should show expanded output by default (previously "brief-only").
// Removed read, grep, glob from the brief list so users can see full tool output.
// Only web_search/web_fetch remain brief since those are typically very large responses.
const BRIEF_ONLY_TOOLS = ['web_search', 'web_fetch', 'fetch', 'search', 'WebSearch', 'WebFetch'];

// Tool output section (result)
const ToolOutput = memo(function ToolOutput({ 
  result, 
  toolName,
  isExpanded,
  onToggle 
}: { 
  result: ToolResult;
  toolName: string;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const { output, isError } = result;
  const formattedOutput = useMemo(() => formatResult(output), [output]);
  // Parse todo output for special display
  const todoInfo = toolName === 'todo' ? parseTodoOutput(output) : null;
  
  // Parse read tool output for brief display (don't show file contents)
  const readInfo = toolName === 'read' || toolName === 'Read' ? parseReadOutput(output) : null;
  
  // Parse web search output for brief display
  const webSearchInfo = toolName === 'web_search' || toolName === 'search' || toolName === 'WebSearch' || toolName === 'Grep' || toolName === 'Glob'
    ? parseWebSearchOutput(output) : null;
  
  // Parse web fetch output for brief display
  const webFetchInfo = toolName === 'web_fetch' || toolName === 'fetch' || toolName === 'WebFetch'
    ? parseWebFetchOutput(output) : null;
  
  // Check if this tool should only show brief summary (hide raw output)
  const isBriefOnly = BRIEF_ONLY_TOOLS.includes(toolName) && !isError;
  const briefInfo = readInfo || webSearchInfo || webFetchInfo;

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(formattedOutput);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [formattedOutput]);

  // Generate brief summary based on tool type
  const getBriefSummary = () => {
    if (readInfo) {
      return `✓ File loaded • ${readInfo.lines} lines • ${readInfo.chars.toLocaleString()} chars${readInfo.truncated ? ' (truncated)' : ''}`;
    }
    if (webSearchInfo) {
      return `✓ Found ${webSearchInfo.results} result${webSearchInfo.results !== 1 ? 's' : ''} • ${webSearchInfo.chars.toLocaleString()} chars`;
    }
    if (webFetchInfo) {
      return `✓ Page fetched • ${webFetchInfo.chars.toLocaleString()} chars${webFetchInfo.truncated ? ' (truncated)' : ''}`;
    }
    return null;
  };

  return (
    <div className="space-y-1">
      <button
        onClick={onToggle}
        className="flex items-center justify-between w-full text-xs font-mono group"
        type="button"
      >
        <span className={`flex items-center gap-1 ${isError ? 'text-red-500' : 'text-emerald-600'}`}>
          <ChevronRight className={`w-3 h-3 transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`} />
          {isError ? 'Error' : 'Result'}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            handleCopy();
          }}
          className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
          title="Copy result"
        >
          {copied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
        </button>
      </button>
      
      {isExpanded && (
        <div className={`ml-4 rounded-lg overflow-hidden border ${
          isError
            ? 'bg-red-50/50 dark:bg-red-950/20 border-red-200 dark:border-red-900/40'
            : 'bg-surface-subtle dark:bg-surface-dark-subtle border-outline-subtle dark:border-outline-subtle-dark'
        }`}>
          {/* Special display for todo tool results */}
          {todoInfo && (
            <div className={`px-3 py-2 text-sm border-b ${
              todoInfo.isToggle ? 'bg-emerald-50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-900/40' : 'bg-surface dark:bg-surface-dark border-outline-subtle dark:border-outline-subtle-dark'
            }`}>
              <span className={todoInfo.isToggle ? 'text-emerald-700 dark:text-emerald-400 font-medium' : 'text-content-secondary dark:text-content-secondary-dark'}>
                {todoInfo.isToggle && '✓ '}
                {todoInfo.message}
              </span>
            </div>
          )}
          
          {/* Special display for brief-only tools - summary only, no raw output */}
          {isBriefOnly && briefInfo && (
            <div className="px-3 py-2 text-sm bg-emerald-50 dark:bg-emerald-950/20 border-b border-emerald-200 dark:border-emerald-900/40">
              <span className="text-emerald-700 dark:text-emerald-400 font-medium">
                {getBriefSummary()}
              </span>
            </div>
          )}
          
          {/* Full output - hidden for brief-only tools to reduce verbosity */}
          {!(isBriefOnly && briefInfo) && (
            <pre className={`p-3 overflow-x-auto text-xs font-mono max-h-80 leading-relaxed ${
              isError ? 'text-red-700 dark:text-red-400' : 'text-content-secondary dark:text-content-secondary-dark'
            }`}>
              <code>{formattedOutput}</code>
            </pre>
          )}
        </div>
      )}
      
      {/* Collapsed tool cards intentionally hide result output. The header's
          brief status is the only default result signal; full output is shown
          only after the card/result is explicitly expanded. */}
    </div>
  );
});

// Format elapsed seconds to human readable
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}m ${secs}s`;
}

// Brief status display (always visible)
const BriefStatus = memo(function BriefStatus({ 
  result,
  isPending,
  toolName,
  elapsedSeconds
}: { 
  result?: ToolResult | null;
  isPending: boolean;
  toolName: string;
  elapsedSeconds?: number;
}) {
  if (isPending) {
    return (
      <span className="text-xs text-amber-500 flex items-center gap-1">
        <Clock className="w-3 h-3" strokeWidth={1.75} />
        Running
        {elapsedSeconds !== undefined && elapsedSeconds > 0 && (
          <span className="font-mono">({formatElapsed(elapsedSeconds)})</span>
        )}
        …
      </span>
    );
  }
  
  if (!result) return null;

  const { output, isError } = result;
  const lines = stripAnsi(output).split('\n').length;
  const chars = stripAnsi(output).length;

  if (isError) {
    return (
      <span className="text-xs text-red-500">
        Error • {lines} lines
      </span>
    );
  }

  // Special brief status for read tool - just show file was loaded
  if (toolName === 'read') {
    const truncated = output.endsWith('…') || output.includes('[Output truncated');
    return (
      <span className="text-xs text-emerald-600">
        ✓ Loaded • {lines} lines • {chars.toLocaleString()} chars
        {truncated && ' (truncated)'}
      </span>
    );
  }

  // Special brief status for web search - show result count
  if (toolName === 'web_search' || toolName === 'search') {
    const searchInfo = parseWebSearchOutput(output);
    if (searchInfo) {
      return (
        <span className="text-xs text-emerald-600">
          ✓ Found {searchInfo.results} result{searchInfo.results !== 1 ? 's' : ''}
        </span>
      );
    }
  }

  // Special brief status for web fetch - show chars fetched
  if (toolName === 'web_fetch' || toolName === 'fetch') {
    const fetchInfo = parseWebFetchOutput(output);
    if (fetchInfo) {
      return (
        <span className="text-xs text-emerald-600">
          ✓ Fetched • {fetchInfo.chars.toLocaleString()} chars
          {fetchInfo.truncated && ' (truncated)'}
        </span>
      );
    }
  }

  return (
    <span className="text-xs text-gray-400">
      {lines} lines • {chars} chars
    </span>
  );
});

export const CollapsibleToolCard = memo(function CollapsibleToolCard({ 
  name, 
  args, 
  result,
  startTime,
  forceExpanded,
  embedded = false,
}: CollapsibleToolCardProps) {
  // Collapsed by default (shared rule — matches the screen-view projection).
  const [isExpanded, setIsExpanded] = useState(!TOOL_COLLAPSED_BY_DEFAULT);
  const [showResult, setShowResult] = useState(false);
  const [showInputs, setShowInputs] = useState(true);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const hasResult = result !== undefined && result !== null;
  const isError = hasResult && result.isError;
  const isPending = !hasResult;

  // Sync with external forceExpanded prop (e.g. "Expand all" group toggle).
  // Default/resting tool cards stay collapsed so the browser view matches the
  // shared screen-view projection; expanding a group opts into full output.
  useEffect(() => {
    if (forceExpanded !== undefined) {
      setIsExpanded(forceExpanded);
      setShowResult(forceExpanded);
    }
  }, [forceExpanded]);

  // A newly completed tool should not auto-expand in the resting screen view.
  useEffect(() => {
    if (hasResult && forceExpanded === undefined) {
      setShowResult(false);
    }
  }, [hasResult, forceExpanded]);

  // Track elapsed time for pending operations
  useEffect(() => {
    if (!isPending || !startTime) return;
    
    const updateElapsed = () => {
      setElapsedSeconds(Math.floor((Date.now() - startTime) / 1000));
    };
    
    updateElapsed();
    const interval = setInterval(updateElapsed, 1000);
    
    return () => clearInterval(interval);
  }, [isPending, startTime]);

  const displayName = TOOL_DISPLAY_NAMES[normalizeToolName(name)] ?? TOOL_DISPLAY_NAMES[name] ?? name;
  const icon = TOOL_ICONS[normalizeToolName(name)] ?? TOOL_ICONS[name] ?? <Terminal className="w-3.5 h-3.5" />;
  const primaryParam = getPrimaryParam(args);

  const handleToggleExpand = useCallback(() => {
    setIsExpanded(!isExpanded);
  }, [isExpanded]);

  const handleToggleResult = useCallback(() => {
    setShowResult(!showResult);
  }, [showResult]);

  return (
    <div className={embedded
      ? "w-full text-xs group transition-colors"
      : "w-full border border-outline-default dark:border-outline-default-dark rounded-lg overflow-hidden bg-surface dark:bg-surface-dark text-xs group my-1.5 shadow-xs transition-colors"
    }>
      {/* Header - always visible, clickable to expand */}
      <button
        onClick={handleToggleExpand}
        className={`flex items-center gap-2 w-full min-w-0 px-3.5 py-2.5 text-left transition-colors ${
          isExpanded
            ? 'bg-surface-subtle dark:bg-surface-dark-subtle border-b border-outline-subtle dark:border-outline-subtle-dark'
            : 'hover:bg-surface-subtle dark:hover:bg-surface-dark-subtle'
        }`}
        type="button"
      >
        {/* Tool icon – spinner (blue) when pending, red on error */}
        <span className={`shrink-0 ${
          isPending ? 'text-blue-500' :
          isError   ? 'text-red-500' :
          'text-content-muted dark:text-content-muted-dark group-hover:text-content-primary dark:group-hover:text-content-primary-dark transition-colors'
        }`}>
          {isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : icon}
        </span>

        {/* Action / Tool name + Primary parameter */}
        <div className="flex items-center gap-1.5 min-w-0 flex-1 overflow-hidden">
          <span className="font-medium text-content-primary dark:text-content-primary-dark text-xs shrink-0">
            Using {displayName}
          </span>
          {primaryParam && !isExpanded && (
            <span className="text-content-secondary dark:text-content-secondary-dark truncate flex-1 min-w-0 text-xs font-mono">
              {primaryParam}
            </span>
          )}
        </div>

        {/* Brief status inline when collapsed */}
        {!isExpanded && (
          <span className="ml-auto shrink-0 flex items-center gap-1.5">
            <BriefStatus result={result} isPending={isPending} toolName={name} elapsedSeconds={elapsedSeconds} />
          </span>
        )}

        {/* Chevron toggle – moved to RIGHT side */}
        <ChevronRight strokeWidth={1.75} className={`w-3.5 h-3.5 text-content-muted dark:text-content-muted-dark transition-transform duration-200 shrink-0 ${isExpanded ? 'rotate-90' : ''}`} />
      </button>

      {/* Expanded content */}
      {isExpanded && (
        <div className="px-3.5 py-2.5 space-y-2 bg-surface-subtle/40 dark:bg-surface-dark-subtle/40">
          {/* Brief status at top of expanded card */}
          <BriefStatus result={result} isPending={isPending} toolName={name} elapsedSeconds={elapsedSeconds} />

          {/* Section 1: Input parameters – collapsed by default */}
          {args !== null && args !== undefined && (
            <div>
              <button
                onClick={() => setShowInputs(prev => !prev)}
                className="flex items-center gap-1.5 text-xs text-content-muted dark:text-content-muted-dark font-mono hover:text-content-primary dark:hover:text-content-primary-dark py-0.5 w-full text-left"
                type="button"
              >
                <ChevronRight strokeWidth={1.75} className={`w-3 h-3 transition-transform duration-200 ${showInputs ? 'rotate-90' : ''}`} />
                Input parameters
              </button>
              {showInputs && (
                <div className="mt-1 pl-3 border-l border-outline-subtle dark:border-outline-subtle-dark">
                  <ToolInputSection args={args} />
                </div>
              )}
            </div>
          )}

          {/* Section 2: Tool Result – collapsed by default, auto-expanded on error */}
          {hasResult && (
            <ToolOutput
              result={result}
              toolName={name}
              isExpanded={showResult}
              onToggle={handleToggleResult}
            />
          )}
        </div>
      )}
    </div>
  );
});
