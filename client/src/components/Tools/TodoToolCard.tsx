import React, { useState, useMemo, useEffect, memo } from 'react';
import {
  ListTodo,
  CheckCircle,
  XCircle,
  ChevronRight,
  Loader2,
  Clock,
  Check,
  Circle,
} from 'lucide-react';

/**
 * TodoToolCard - CLI-style display of todo tool execution
 * 
 * Mimics the CLI view of todo tools with:
 * - Header showing action (list/add/toggle/clear)
 * - Visual list of todos with checkboxes
 * - Completion progress indicator
 * - Status for each operation
 */

interface TodoToolCardProps {
  name: string;
  args: unknown;
  result?: {
    output: string;
    isError: boolean;
  } | null;
  startTime?: number;
}

interface Todo {
  id: number;
  text: string;
  done: boolean;
}

interface TodoDetails {
  action: 'list' | 'add' | 'toggle' | 'clear';
  todos: Todo[];
  nextId: number;
  error?: string;
}

// Parse todo result from tool result
function parseTodoResult(result: { output: string; isError: boolean } | null | undefined): TodoDetails | null {
  if (!result) return null;
  
  try {
    // The details are stored in the result, not in output JSON
    // The todo extension stores state in details field
    return null;
  } catch {
    return null;
  }
}

// Extract todo details from args for display
function extractTodoDetails(args: unknown, result?: { output: string; isError: boolean } | null): TodoDetails | null {
  if (!args || typeof args !== 'object') return null;
  
  const argsRecord = args as Record<string, unknown>;
  const action = argsRecord.action as 'list' | 'add' | 'toggle' | 'clear' | undefined;
  
  if (!action) return null;
  
  // Try to parse todos from result output if available
  let todos: Todo[] = [];
  let nextId = 1;
  
  if (result?.output) {
    // Parse the text output format: "[x] #1: task text" or "[ ] #1: task text"
    const lines = result.output.split('\n');
    for (const line of lines) {
      const match = line.match(/^\[(x| )\] #(\d+): (.+)$/);
      if (match) {
        todos.push({
          id: parseInt(match[2], 10),
          done: match[1] === 'x',
          text: match[3],
        });
        nextId = Math.max(nextId, parseInt(match[2], 10) + 1);
      }
    }
  }
  
  // If we couldn't parse todos from output, try to infer from args
  if (todos.length === 0) {
    if (action === 'add' && argsRecord.text) {
      // For add action, show what we're adding
      return {
        action,
        todos: [{ id: 0, text: String(argsRecord.text), done: false }],
        nextId: 1,
      };
    }
    if (action === 'toggle' && argsRecord.id !== undefined) {
      // For toggle action, we don't know the text without context
      return {
        action,
        todos: [{ id: Number(argsRecord.id), text: `Todo #${argsRecord.id}`, done: true }],
        nextId: Number(argsRecord.id) + 1,
      };
    }
  }
  
  return {
    action,
    todos,
    nextId,
  };
}

// Get action display text
function getActionText(action: string): string {
  switch (action) {
    case 'list': return 'Viewing todos';
    case 'add': return 'Adding todo';
    case 'toggle': return 'Toggling todo';
    case 'clear': return 'Clearing completed';
    default: return action;
  }
}

// Format elapsed seconds to human readable
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}m ${secs}s`;
}

export const TodoToolCard = memo(function TodoToolCard({ 
  name, 
  args, 
  result,
  startTime
}: TodoToolCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
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

  // Parse todo details
  const todoDetails = useMemo(() => {
    return extractTodoDetails(args, result);
  }, [args, result]);

  const action = todoDetails?.action || 'list';
  const todos = todoDetails?.todos || [];
  const completedCount = todos.filter(t => t.done).length;
  const totalCount = todos.length;

  // Get specific action info from args
  const argsRecord = (args as Record<string, unknown>) || {};
  const todoText = action === 'add' ? String(argsRecord.text || '') : '';
  const todoId = action === 'toggle' ? Number(argsRecord.id) : null;

  return (
    <div className="w-full border border-gray-200 rounded-lg overflow-hidden bg-white">
      {/* Header - CLI-style todo header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={`flex items-center gap-2 w-full px-3 py-2 text-left transition-colors ${
          isExpanded ? 'bg-gray-50 border-b border-gray-200' : 'hover:bg-gray-50'
        }`}
        type="button"
      >
        {/* Expand indicator */}
        <ChevronRight className={`w-4 h-4 text-gray-400 transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`} />

        {/* Todo icon */}
        <div className={`p-1 rounded ${isError ? 'bg-red-50' : isPending ? 'bg-amber-50' : 'bg-emerald-50'}`}>
          <ListTodo className={`w-4 h-4 ${isError ? 'text-red-500' : isPending ? 'text-amber-500' : 'text-emerald-500'}`} />
        </div>

        {/* Action description */}
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-sm font-medium text-gray-900">
            todo
          </span>
          <span className="text-xs text-gray-500 font-mono">
            {action}
          </span>
          {action === 'add' && todoText && (
            <span className="text-xs text-gray-400 truncate max-w-[200px]">
              "{todoText}"
            </span>
          )}
          {action === 'toggle' && todoId !== null && (
            <span className="text-xs text-emerald-600">
              #{todoId}
            </span>
          )}
        </div>

        {/* Status */}
        <div className="ml-auto flex items-center gap-2">
          {!isExpanded && totalCount > 0 && (
            <span className="text-xs text-gray-400">
              {completedCount}/{totalCount}
            </span>
          )}
          {isPending ? (
            <span className="text-xs text-amber-500 flex items-center gap-1">
              <Clock className="w-3 h-3" />
              Running
              {elapsedSeconds > 0 && (
                <span className="font-mono">({formatElapsed(elapsedSeconds)})</span>
              )}
              …
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
          {/* Action indicator */}
          <div className="text-xs text-gray-500">
            {getActionText(action)}
          </div>

          {/* Todo list */}
          {todos.length > 0 && (
            <div className="space-y-1">
              {todos.map((todo) => (
                <div 
                  key={todo.id}
                  className={`flex items-center gap-2 py-1 px-2 rounded ${
                    todo.done ? 'bg-gray-50' : 'bg-white'
                  }`}
                >
                  {/* Checkbox */}
                  <span className="shrink-0">
                    {todo.done ? (
                      <Check className="w-4 h-4 text-emerald-500" />
                    ) : (
                      <Circle className="w-4 h-4 text-gray-300" />
                    )}
                  </span>
                  
                  {/* Todo ID */}
                  <span className={`text-xs font-mono shrink-0 ${
                    todo.done ? 'text-gray-400' : 'text-emerald-600'
                  }`}>
                    #{todo.id}
                  </span>
                  
                  {/* Todo text */}
                  <span className={`text-sm ${
                    todo.done ? 'text-gray-400 line-through' : 'text-gray-700'
                  }`}>
                    {todo.text}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Empty state */}
          {todos.length === 0 && hasResult && !isError && (
            <div className="text-sm text-gray-400 italic py-2">
              No todos
            </div>
          )}

          {/* Progress footer */}
          {totalCount > 0 && (
            <div className="flex items-center gap-3 text-[10px] text-gray-400 pt-1 border-t border-gray-100">
              <span>{completedCount} of {totalCount} completed</span>
              {totalCount > 0 && (
                <div className="flex-1 h-1 bg-gray-100 rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-emerald-500 rounded-full"
                    style={{ width: `${(completedCount / totalCount) * 100}%` }}
                  />
                </div>
              )}
            </div>
          )}

          {/* Raw output toggle */}
          {result?.output && (
            <div className="pt-1">
              <details className="text-[10px]">
                <summary className="text-gray-400 hover:text-gray-600 cursor-pointer">
                  Show raw output
                </summary>
                <pre className="mt-1 p-2 bg-gray-50 rounded text-[10px] font-mono text-gray-600 overflow-x-auto max-h-40 overflow-y-auto">
                  {result.output}
                </pre>
              </details>
            </div>
          )}
        </div>
      )}

      {/* Collapsed summary */}
      {!isExpanded && hasResult && todos.length > 0 && (
        <div className="px-3 py-1.5 bg-gray-50 border-t border-gray-100">
          <div className="flex items-center gap-3 text-xs text-gray-500">
            <span>{completedCount}/{totalCount} completed</span>
            {totalCount > 0 && (
              <div className="flex-1 h-1 bg-gray-200 rounded-full overflow-hidden max-w-[100px]">
                <div 
                  className="h-full bg-emerald-500 rounded-full"
                  style={{ width: `${(completedCount / totalCount) * 100}%` }}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});
