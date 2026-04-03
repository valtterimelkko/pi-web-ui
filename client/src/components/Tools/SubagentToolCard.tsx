import React, { useState, useMemo, useEffect, memo } from 'react';
import {
  Bot,
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
  Terminal,
  Brain,
  ListTodo,
  ChevronDown,
  Clock,
} from 'lucide-react';

/**
 * SubagentToolCard - Hierarchical display of subagent execution
 * 
 * Mimics the CLI view of subagents with:
 * - Header showing subagent name and role
 * - Collapsible list of internal operations
 * - Line numbers for edits
 * - Summary of earlier items
 */

interface SubagentToolCardProps {
  name: string;
  args: unknown;
  result?: {
    output: string;
    isError: boolean;
  } | null;
  startTime?: number; // Unix timestamp when tool started
}

interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

interface ToolResult {
  toolCall: ToolCall;
  result: {
    content: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
}

interface SubagentResult {
  mode?: 'single' | 'parallel' | 'chain';
  tasks?: Array<{
    agent: string;
    task: string;
    result?: string;
    usage?: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
    toolCalls?: ToolResult[];
  }>;
  chain?: Array<{
    agent: string;
    task: string;
    result?: string;
    usage?: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
    toolCalls?: ToolResult[];
  }>;
  summary?: string;
  totalUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

// Map tool names to icons
const TOOL_ICONS: Record<string, React.ReactNode> = {
  bash: <Terminal className="w-3 h-3" />,
  read: <FileText className="w-3 h-3" />,
  write: <Edit3 className="w-3 h-3" />,
  edit: <Edit3 className="w-3 h-3" />,
  grep: <Search className="w-3 h-3" />,
  glob: <FolderSearch className="w-3 h-3" />,
  search: <Globe className="w-3 h-3" />,
  fetch: <Link2 className="w-3 h-3" />,
  web_search: <Globe className="w-3 h-3" />,
  web_fetch: <Link2 className="w-3 h-3" />,
  subagent: <Bot className="w-3 h-3" />,
  think: <Brain className="w-3 h-3" />,
  todo: <ListTodo className="w-3 h-3" />,
};

// Parse subagent result from JSON string
function parseSubagentResult(output: string): SubagentResult | null {
  try {
    const parsed = JSON.parse(output);
    // Validate it looks like a subagent result
    if (parsed && (parsed.tasks || parsed.chain || parsed.summary)) {
      return parsed as SubagentResult;
    }
  } catch {
    // Not valid JSON or not a subagent result
  }
  return null;
}

// Extract primary parameter for display
function getPrimaryParam(toolName: string, args: Record<string, unknown>): string | null {
  const priorityKeys: Record<string, string[]> = {
    read: ['path'],
    write: ['path'],
    edit: ['path'],
    bash: ['command'],
    grep: ['pattern', 'path'],
    glob: ['pattern'],
    search: ['query'],
    web_search: ['query'],
    fetch: ['url'],
    web_fetch: ['url'],
  };

  const keys = priorityKeys[toolName] || ['path', 'command', 'pattern', 'url', 'query'];
  
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) {
      // Truncate long paths
      if (value.length > 60) {
        return '...' + value.slice(-57);
      }
      return value;
    }
  }

  // Fall back to first string param
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && value.length > 0) {
      return value.length > 60 ? '...' + value.slice(-57) : value;
    }
  }

  return null;
}

// Extract line numbers from edit tool arguments
function getEditLines(args: Record<string, unknown>): string | null {
  if (args.oldString && typeof args.oldString === 'string') {
    // Try to infer from the content
    const lines = args.oldString.split('\n').length;
    if (lines > 1) {
      return `${lines} lines`;
    }
  }
  return null;
}

// Format file size/line count
function formatOutputStats(output: string): string {
  const lines = output.split('\n').length;
  const chars = output.length;
  if (lines > 1) {
    return `${lines} lines, ${chars.toLocaleString()} chars`;
  }
  return `${chars.toLocaleString()} chars`;
}

// Individual tool execution item
const ToolExecutionItem = memo(function ToolExecutionItem({ 
  toolResult, 
  index,
  isLast 
}: { 
  toolResult: ToolResult; 
  index: number;
  isLast: boolean;
}) {
  const { toolCall, result } = toolResult;
  const { name, arguments: args } = toolCall;
  const icon = TOOL_ICONS[name] || <Terminal className="w-3 h-3" />;
  const primaryParam = getPrimaryParam(name, args);
  const editLines = name === 'edit' ? getEditLines(args) : null;
  const outputText = result.content?.[0]?.text || '';
  const isError = result.isError;
  
  // Parse read output for line count
  let lineInfo = '';
  if (name === 'read' && outputText) {
    const lines = outputText.split('\n').length;
    const truncated = outputText.endsWith('…') || outputText.includes('[Output truncated');
    lineInfo = `${lines} lines${truncated ? ' (truncated)' : ''}`;
  }

  return (
    <div className={`flex items-start gap-1.5 py-0.5 ${isLast ? '' : ''}`}>
      {/* Tree connector */}
      <div className="flex flex-col items-center self-stretch">
        <div className="w-px h-full bg-gray-200" />
      </div>
      
      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 text-xs">
          {/* Arrow */}
          <span className="text-gray-400">→</span>
          
          {/* Icon */}
          <span className={`shrink-0 ${isError ? 'text-red-500' : 'text-gray-500'}`}>
            {icon}
          </span>
          
          {/* Tool name */}
          <span className={`font-mono ${isError ? 'text-red-600' : 'text-gray-600'}`}>
            {name}
          </span>
          
          {/* Primary parameter */}
          {primaryParam && (
            <span className="text-gray-400 truncate font-mono" title={primaryParam}>
              {primaryParam}
            </span>
          )}
          
          {/* Edit line count */}
          {editLines && (
            <span className="text-gray-400 text-[10px]">
              ({editLines})
            </span>
          )}
          
          {/* Status indicator */}
          {isError ? (
            <XCircle className="w-3 h-3 text-red-500 shrink-0" />
          ) : (
            <CheckCircle className="w-3 h-3 text-emerald-500 shrink-0" />
          )}
        </div>
        
        {/* Read tool line info */}
        {name === 'read' && lineInfo && (
          <div className="ml-4 text-[10px] text-gray-400">
            {lineInfo}
          </div>
        )}
      </div>
    </div>
  );
});

// Task result section (for parallel/chain modes)
const TaskSection = memo(function TaskSection({
  task,
  index,
  isExpanded,
  onToggle,
}: {
  task: {
    agent: string;
    task: string;
    result?: string;
    usage?: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
    toolCalls?: ToolResult[];
  };
  index: number;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const hasToolCalls = task.toolCalls && task.toolCalls.length > 0;
  const toolCount = hasToolCalls ? task.toolCalls!.length : 0;
  const isComplete = !!task.result;

  return (
    <div className="border-l-2 border-gray-200 ml-1 pl-2 py-1">
      {/* Task header */}
      <button
        onClick={onToggle}
        className="flex items-center gap-1.5 w-full text-left group"
        type="button"
      >
        <ChevronRight className={`w-3 h-3 text-gray-400 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
        <Bot className="w-3 h-3 text-gray-500" />
        <span className="text-xs font-medium text-gray-700">{task.agent}</span>
        <span className="text-xs text-gray-400 truncate flex-1">{task.task}</span>
        {isComplete ? (
          <CheckCircle className="w-3 h-3 text-emerald-500 shrink-0" />
        ) : (
          <Loader2 className="w-3 h-3 text-amber-500 animate-spin shrink-0" />
        )}
      </button>

      {/* Expanded tool calls */}
      {isExpanded && hasToolCalls && (
        <div className="mt-1 ml-3 space-y-0.5">
          {task.toolCalls!.map((toolResult, idx) => (
            <ToolExecutionItem
              key={idx}
              toolResult={toolResult}
              index={idx}
              isLast={idx === task.toolCalls!.length - 1}
            />
          ))}
        </div>
      )}

      {/* Collapsed summary */}
      {!isExpanded && toolCount > 0 && (
        <div className="ml-5 text-[10px] text-gray-400">
          {toolCount} operation{toolCount !== 1 ? 's' : ''}
        </div>
      )}
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

export const SubagentToolCard = memo(function SubagentToolCard({ 
  name, 
  args, 
  result,
  startTime
}: SubagentToolCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [expandedTasks, setExpandedTasks] = useState<Set<number>>(new Set());
  const [showRawOutput, setShowRawOutput] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const hasResult = result !== undefined && result !== null;
  const isError = hasResult && result.isError;
  const isPending = !hasResult;

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

  // Parse subagent result
  const subagentData = useMemo(() => {
    if (!result?.output) return null;
    return parseSubagentResult(result.output);
  }, [result]);

  // Get tasks to display
  const tasks = subagentData?.tasks || subagentData?.chain || [];
  const mode = subagentData?.mode || (subagentData?.chain ? 'chain' : 'parallel');

  // Calculate stats
  const totalToolCalls = tasks.reduce((sum, task) => sum + (task.toolCalls?.length || 0), 0);
  const totalTokens = subagentData?.totalUsage ? 
    subagentData.totalUsage.inputTokens + subagentData.totalUsage.outputTokens : 
    tasks.reduce((sum, task) => sum + (task.usage ? task.usage.inputTokens + task.usage.outputTokens : 0), 0);

  // Toggle task expansion
  const toggleTask = (index: number) => {
    setExpandedTasks(prev => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  // Get subagent name from args
  const subagentName = useMemo(() => {
    if (!args || typeof args !== 'object') return 'subagent';
    const argsRecord = args as Record<string, unknown>;
    
    // Try to determine the subagent type
    if (argsRecord.tasks && Array.isArray(argsRecord.tasks) && argsRecord.tasks.length > 0) {
      const firstTask = argsRecord.tasks[0] as { agent?: string };
      if (firstTask?.agent) return firstTask.agent;
    }
    if (argsRecord.chain && Array.isArray(argsRecord.chain) && argsRecord.chain.length > 0) {
      const firstTask = argsRecord.chain[0] as { agent?: string };
      if (firstTask?.agent) return firstTask.agent;
    }
    if (argsRecord.agent) return String(argsRecord.agent);
    
    return 'subagent';
  }, [args]);

  // Get role from args (e.g., [user], [system])
  const role = useMemo(() => {
    if (!args || typeof args !== 'object') return '';
    const argsRecord = args as Record<string, unknown>;
    
    // Check for context or role info
    if (argsRecord.context) return `[${String(argsRecord.context)}]`;
    if (argsRecord.role) return `[${String(argsRecord.role)}]`;
    
    return '[user]';
  }, [args]);

  return (
    <div className="w-full border border-gray-200 rounded-lg overflow-hidden bg-white">
      {/* Header - CLI-style subagent header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={`flex items-center gap-2 w-full px-3 py-2 text-left transition-colors ${
          isExpanded ? 'bg-gray-50 border-b border-gray-200' : 'hover:bg-gray-50'
        }`}
        type="button"
      >
        {/* Expand indicator */}
        <ChevronRight className={`w-4 h-4 text-gray-400 transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`} />

        {/* Subagent icon */}
        <div className={`p-1 rounded ${isError ? 'bg-red-50' : isPending ? 'bg-amber-50' : 'bg-blue-50'}`}>
          <Bot className={`w-4 h-4 ${isError ? 'text-red-500' : isPending ? 'text-amber-500' : 'text-blue-500'}`} />
        </div>

        {/* Subagent name and role */}
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-sm font-medium text-gray-900">
            {subagentName}
          </span>
          <span className="text-xs text-gray-500 font-mono">
            {role}
          </span>
        </div>

        {/* Status */}
        <div className="ml-auto flex items-center gap-2">
          {isPending ? (
            <span className="text-xs text-amber-500 flex items-center gap-1">
              <Clock className="w-3 h-3" />
              Running
              {elapsedSeconds > 0 && (
                <span className="font-mono">({formatElapsed(elapsedSeconds)})</span>
              )}
              ...
            </span>
          ) : isError ? (
            <XCircle className="w-4 h-4 text-red-500" />
          ) : (
            <CheckCircle className="w-4 h-4 text-emerald-500" />
          )}
        </div>
      </button>

      {/* Expanded content */}
      {isExpanded && (
        <div className="px-3 py-2 space-y-2">
          {/* Mode indicator */}
          {mode && (
            <div className="text-xs text-gray-500">
              Mode: <span className="font-mono text-gray-700">{mode}</span>
              {tasks.length > 0 && (
                <span className="ml-2">• {tasks.length} task{tasks.length !== 1 ? 's' : ''}</span>
              )}
            </div>
          )}

          {/* Task sections */}
          {tasks.length > 0 && (
            <div className="space-y-1">
              {tasks.map((task, index) => (
                <TaskSection
                  key={index}
                  task={task}
                  index={index}
                  isExpanded={expandedTasks.has(index)}
                  onToggle={() => toggleTask(index)}
                />
              ))}
            </div>
          )}

          {/* Summary from subagent */}
          {subagentData?.summary && (
            <div className="mt-2 p-2 bg-blue-50 rounded border border-blue-100">
              <div className="text-xs font-medium text-blue-700 mb-1">Summary</div>
              <div className="text-xs text-blue-600 whitespace-pre-wrap">
                {subagentData.summary}
              </div>
            </div>
          )}

          {/* Stats footer */}
          <div className="flex items-center gap-3 text-[10px] text-gray-400 pt-1 border-t border-gray-100">
            {totalToolCalls > 0 && (
              <span>{totalToolCalls} tool call{totalToolCalls !== 1 ? 's' : ''}</span>
            )}
            {totalTokens > 0 && (
              <span>{totalTokens.toLocaleString()} tokens</span>
            )}
          </div>

          {/* Raw output toggle */}
          {result?.output && (
            <div className="pt-1">
              <button
                onClick={() => setShowRawOutput(!showRawOutput)}
                className="text-[10px] text-gray-400 hover:text-gray-600 underline"
                type="button"
              >
                {showRawOutput ? 'Hide raw output' : 'Show raw output'}
              </button>
              
              {showRawOutput && (
                <pre className="mt-1 p-2 bg-gray-50 rounded text-[10px] font-mono text-gray-600 overflow-x-auto max-h-40 overflow-y-auto">
                  {result.output}
                </pre>
              )}
            </div>
          )}
        </div>
      )}

      {/* Collapsed summary */}
      {!isExpanded && hasResult && subagentData && (
        <div className="px-3 py-1.5 bg-gray-50 border-t border-gray-100">
          <div className="flex items-center gap-3 text-xs text-gray-500">
            {tasks.length > 0 && (
              <span>{tasks.length} task{tasks.length !== 1 ? 's' : ''}</span>
            )}
            {totalToolCalls > 0 && (
              <span>{totalToolCalls} operation{totalToolCalls !== 1 ? 's' : ''}</span>
            )}
            {subagentData.summary && (
              <span className="truncate flex-1">{subagentData.summary.slice(0, 60)}...</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
});
