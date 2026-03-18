import React, { useState, useMemo, useCallback, memo } from 'react';
import {
  Terminal,
  CheckCircle,
  XCircle,
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
}

// Map tool names to icons (following Kimi's approach)
const TOOL_ICONS: Record<string, React.ReactNode> = {
  bash: <Terminal className="w-3.5 h-3.5" />,
  read: <FileText className="w-3.5 h-3.5" />,
  write: <Edit3 className="w-3.5 h-3.5" />,
  edit: <Edit3 className="w-3.5 h-3.5" />,
  grep: <Search className="w-3.5 h-3.5" />,
  glob: <FolderSearch className="w-3.5 h-3.5" />,
  search: <Globe className="w-3.5 h-3.5" />,
  fetch: <Link2 className="w-3.5 h-3.5" />,
  web_search: <Globe className="w-3.5 h-3.5" />,
  web_fetch: <Link2 className="w-3.5 h-3.5" />,
  subagent: <Bot className="w-3.5 h-3.5" />,
  think: <Brain className="w-3.5 h-3.5" />,
  todo: <ListTodo className="w-3.5 h-3.5" />,
  mail: <Mail className="w-3.5 h-3.5" />,
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
};

// Get status icon based on tool state
function getStatusIcon(hasResult: boolean, isError: boolean, isPending: boolean): React.ReactNode {
  if (isPending) {
    return <Loader2 className="w-3 h-3 text-amber-500 animate-spin" />;
  }
  if (isError) {
    return <XCircle className="w-3 h-3 text-red-500" />;
  }
  if (hasResult) {
    return <CheckCircle className="w-3 h-3 text-emerald-500" />;
  }
  return null;
}

// Get primary parameter value for inline display (Kimi-style)
function getPrimaryParam(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0) return null;

  // Priority order: path, command, pattern, url, query, then first param
  const priorityKeys = ['path', 'command', 'pattern', 'url', 'query', 'file_path', 'target_path'];
  for (const key of priorityKeys) {
    const value = (args as Record<string, unknown>)[key];
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

// Truncate output for collapsed view
function truncateOutput(output: string, maxLength: number = 200): string {
  const cleaned = stripAnsi(output);
  if (cleaned.length <= maxLength) return cleaned;
  return cleaned.slice(0, maxLength) + '…';
}

// Check if output should be considered "long" and hidden by default
function isLongOutput(output: string): boolean {
  const cleaned = stripAnsi(output);
  return cleaned.length > 200 || cleaned.split('\n').length > 5;
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
      <span className="text-gray-500 shrink-0 select-none">{paramKey}</span>
      <span className="text-gray-700 truncate">
        <span className="text-gray-400">"</span>
        {value}
        <span className="text-gray-400">"</span>
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
        <span className="text-gray-500 shrink-0 select-none">{paramKey}</span>
        <ChevronRight className={`w-3 h-3 text-gray-400 transition-transform duration-200 shrink-0 ${expanded ? 'rotate-90' : ''}`} />
        {!expanded && (
          <span className="text-gray-400 truncate group-hover:text-gray-600">
            {preview}…
          </span>
        )}
      </button>
      {expanded && (
        <pre className="ml-4 bg-gray-50 border border-gray-200 rounded p-2 overflow-x-auto text-xs">
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
  if (entries.length === 1) return null;

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(formatArgs(args));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [args]);

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-gray-500 font-mono">Arguments</span>
        <button
          onClick={handleCopy}
          className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
          title="Copy arguments"
        >
          {copied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
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

// Tools that should hide their raw output and show only a brief summary
// These are "intermediate" tools where the assistant processes the output
const BRIEF_ONLY_TOOLS = ['read', 'web_search', 'web_fetch', 'fetch', 'search'];

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
  const truncatedOutput = useMemo(() => truncateOutput(output), [output]);
  const isLong = isLongOutput(output);
  
  // Parse todo output for special display
  const todoInfo = toolName === 'todo' ? parseTodoOutput(output) : null;
  
  // Parse read tool output for brief display (don't show file contents)
  const readInfo = toolName === 'read' ? parseReadOutput(output) : null;
  
  // Parse web search output for brief display
  const webSearchInfo = toolName === 'web_search' || toolName === 'search' 
    ? parseWebSearchOutput(output) : null;
  
  // Parse web fetch output for brief display
  const webFetchInfo = toolName === 'web_fetch' || toolName === 'fetch' 
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
        <div className={`ml-4 rounded-lg overflow-hidden ${
          isError
            ? 'bg-red-50 border border-red-200'
            : 'bg-gray-50 border border-gray-200'
        }`}>
          {/* Special display for todo tool results */}
          {todoInfo && (
            <div className={`px-3 py-2 text-sm border-b ${
              todoInfo.isToggle ? 'bg-emerald-50 border-emerald-200' : 'bg-gray-100 border-gray-200'
            }`}>
              <span className={todoInfo.isToggle ? 'text-emerald-700 font-medium' : 'text-gray-700'}>
                {todoInfo.isToggle && '✓ '}
                {todoInfo.message}
              </span>
            </div>
          )}
          
          {/* Special display for brief-only tools - summary only, no raw output */}
          {isBriefOnly && briefInfo && (
            <div className="px-3 py-2 text-sm bg-emerald-50 border-b border-emerald-200">
              <span className="text-emerald-700 font-medium">
                {getBriefSummary()}
              </span>
            </div>
          )}
          
          {/* Full output - hidden for brief-only tools to reduce verbosity */}
          {!(isBriefOnly && briefInfo) && (
            <pre className={`p-3 overflow-x-auto text-xs font-mono ${
              isError ? 'text-red-700' : 'text-gray-700'
            }`}>
              <code>{formattedOutput}</code>
            </pre>
          )}
        </div>
      )}
      
      {!isExpanded && isLong && !isBriefOnly && (
        <span className="ml-4 text-xs text-gray-400">
          {truncatedOutput}
          <button
            onClick={onToggle}
            className="ml-2 text-teal-600 hover:text-teal-700 underline"
          >
            Show more
          </button>
        </span>
      )}
      
      {/* Brief indicator for brief-only tools when collapsed */}
      {!isExpanded && isBriefOnly && briefInfo && (
        <span className="ml-4 text-xs text-emerald-600">
          {getBriefSummary()}
        </span>
      )}
    </div>
  );
});

// Brief status display (always visible)
const BriefStatus = memo(function BriefStatus({ 
  result,
  isPending,
  toolName
}: { 
  result?: ToolResult | null;
  isPending: boolean;
  toolName: string;
}) {
  if (isPending) {
    return (
      <span className="text-xs text-amber-500 animate-pulse">
        Running…
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
  result 
}: CollapsibleToolCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [showResult, setShowResult] = useState(false);

  const hasResult = result !== undefined && result !== null;
  const isError = hasResult && result.isError;
  const isSuccess = hasResult && !result.isError;
  const isPending = !hasResult;

  const displayName = TOOL_DISPLAY_NAMES[name] || name;
  const icon = TOOL_ICONS[name] || <Terminal className="w-3.5 h-3.5" />;
  const primaryParam = getPrimaryParam(args);
  const statusIcon = getStatusIcon(hasResult, isError, isPending);

  const handleToggleExpand = useCallback(() => {
    setIsExpanded(!isExpanded);
  }, [isExpanded]);

  const handleToggleResult = useCallback(() => {
    setShowResult(!showResult);
  }, [showResult]);

  return (
    <div className="w-full border border-gray-200 rounded-md overflow-hidden bg-white text-xs group">
      {/* Header - always visible, clickable to expand */}
      <button
        onClick={handleToggleExpand}
        className={`flex items-center gap-1.5 w-full min-w-0 px-2.5 py-1.5 text-left transition-colors ${
          isExpanded ? 'bg-gray-50 border-b border-gray-200' : 'hover:bg-gray-50'
        }`}
        type="button"
      >
        {/* Expand indicator */}
        <ChevronRight className={`w-3 h-3 text-gray-400 transition-transform duration-200 shrink-0 ${isExpanded ? 'rotate-90' : ''}`} />

        {/* Tool icon */}
        <span className={`shrink-0 ${
          isError ? 'text-red-500' :
          isSuccess ? 'text-emerald-500' :
          'text-gray-400'
        }`}>
          {icon}
        </span>

        {/* Tool name */}
        <span className="font-medium text-gray-700 text-xs shrink-0">
          {displayName}
        </span>

        {/* Primary parameter - inline, subtle */}
        {primaryParam && !isExpanded && (
          <span className="text-gray-400 truncate flex-1 min-w-0 text-xs font-mono">
            {primaryParam}
          </span>
        )}

        {/* Brief status inline when collapsed */}
        {!isExpanded && (
          <span className="ml-auto shrink-0 flex items-center gap-1.5">
            <BriefStatus result={result} isPending={isPending} toolName={name} />
            {statusIcon}
          </span>
        )}

        {/* Status icon when expanded */}
        {isExpanded && (
          <span className="ml-auto shrink-0">
            {statusIcon}
          </span>
        )}
      </button>

      {/* Expanded content */}
      {isExpanded && (
        <div className="px-2.5 py-1.5 space-y-2">
          {/* Arguments section */}
          {args !== null && args !== undefined && (
            <ToolInputSection args={args} />
          )}

          {/* Brief status (always visible in expanded mode) */}
          <BriefStatus result={result} isPending={isPending} toolName={name} />

          {/* Result section */}
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
