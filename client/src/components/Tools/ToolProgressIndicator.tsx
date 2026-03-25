import React, { useState, useEffect, useMemo } from 'react';
import { Loader2, Bot, Terminal, FileText, Search, Globe } from 'lucide-react';

/**
 * ToolProgressIndicator - Shows progress for long-running tool calls
 *
 * Features:
 * - Animated spinner with elapsed time
 * - Tool-specific icons
 * - Auto-warning for long-running operations (>30s)
 * - Timeout warning (>2 minutes)
 */

interface ToolProgressIndicatorProps {
  toolName: string;
  args?: unknown;
  startTime?: number;
  className?: string;
}

// Map tool names to icons
const TOOL_ICONS: Record<string, React.ReactNode> = {
  subagent: <Bot className="w-4 h-4" />,
  bash: <Terminal className="w-4 h-4" />,
  read: <FileText className="w-4 h-4" />,
  write: <FileText className="w-4 h-4" />,
  edit: <FileText className="w-4 h-4" />,
  web_search: <Globe className="w-4 h-4" />,
  web_fetch: <Globe className="w-4 h-4" />,
  grep: <Search className="w-4 h-4" />,
};

// Format elapsed time
function formatElapsed(seconds: number): string {
  if (seconds < 60) {
    return `${Math.floor(seconds)}s`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}m ${secs}s`;
}

// Get a brief description of what the tool is doing
function getToolDescription(toolName: string, args: unknown): string {
  if (!args || typeof args !== 'object') return 'Executing...';
  
  const argsRecord = args as Record<string, unknown>;
  
  switch (toolName) {
    case 'subagent': {
      const agent = argsRecord.agent as string | undefined;
      const task = argsRecord.task as string | undefined;
      if (agent) {
        const taskPreview = task ? task.slice(0, 40) + (task.length > 40 ? '...' : '') : '';
        return `Running ${agent} subagent${taskPreview ? `: ${taskPreview}` : ''}`;
      }
      return 'Running subagent...';
    }
    case 'bash': {
      const cmd = argsRecord.command as string | undefined;
      if (cmd) {
        const preview = cmd.slice(0, 50);
        return `Executing: ${preview}${cmd.length > 50 ? '...' : ''}`;
      }
      return 'Running command...';
    }
    case 'read': {
      const path = argsRecord.path as string | undefined;
      if (path) {
        const filename = path.split('/').pop() || path;
        return `Reading ${filename}...`;
      }
      return 'Reading file...';
    }
    case 'web_search': {
      const query = argsRecord.query as string | undefined;
      if (query) {
        return `Searching: "${query.slice(0, 30)}${query.length > 30 ? '...' : ''}"`;
      }
      return 'Searching web...';
    }
    case 'web_fetch': {
      const url = argsRecord.url as string | undefined;
      if (url) {
        try {
          const urlObj = new URL(url);
          return `Fetching from ${urlObj.hostname}...`;
        } catch {
          return 'Fetching URL...';
        }
      }
      return 'Fetching URL...';
    }
    default:
      return 'Executing...';
  }
}

export const ToolProgressIndicator: React.FC<ToolProgressIndicatorProps> = ({
  toolName,
  args,
  startTime,
  className = '',
}) => {
  const [elapsed, setElapsed] = useState(0);
  
  // Update elapsed time every second
  useEffect(() => {
    if (!startTime) return;
    
    const updateElapsed = () => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    };
    
    updateElapsed();
    const interval = setInterval(updateElapsed, 1000);
    
    return () => clearInterval(interval);
  }, [startTime]);
  
  // Determine warning level
  const warningLevel = useMemo(() => {
    if (elapsed > 120) return 'timeout'; // 2+ minutes
    if (elapsed > 30) return 'slow'; // 30+ seconds
    return 'normal';
  }, [elapsed]);
  
  // Get icon for tool
  const icon = TOOL_ICONS[toolName] || <Terminal className="w-4 h-4" />;
  
  // Get description
  const description = getToolDescription(toolName, args);
  
  // Colors based on warning level
  const colors = {
    normal: {
      bg: 'bg-amber-50',
      border: 'border-amber-200',
      text: 'text-amber-700',
      icon: 'text-amber-500',
      timer: 'text-amber-600',
    },
    slow: {
      bg: 'bg-orange-50',
      border: 'border-orange-200',
      text: 'text-orange-700',
      icon: 'text-orange-500',
      timer: 'text-orange-600',
    },
    timeout: {
      bg: 'bg-red-50',
      border: 'border-red-200',
      text: 'text-red-700',
      icon: 'text-red-500',
      timer: 'text-red-600',
    },
  };
  
  const colorSet = colors[warningLevel];
  
  return (
    <div className={`rounded-lg border ${colorSet.bg} ${colorSet.border} p-3 ${className}`}>
      <div className="flex items-start gap-3">
        {/* Icon with spinner */}
        <div className={`relative ${colorSet.icon}`}>
          {icon}
          <Loader2 className="w-3 h-3 absolute -bottom-0.5 -right-0.5 animate-spin" />
        </div>
        
        {/* Content */}
        <div className="flex-1 min-w-0">
          {/* Tool name */}
          <div className="flex items-center gap-2">
            <span className={`font-mono text-sm font-medium ${colorSet.text}`}>
              {toolName}
            </span>
            <span className={`text-xs font-mono ${colorSet.timer}`}>
              {formatElapsed(elapsed)}
            </span>
          </div>
          
          {/* Description */}
          <div className={`text-xs mt-0.5 truncate ${colorSet.text} opacity-80`}>
            {description}
          </div>
          
          {/* Warning message */}
          {warningLevel === 'slow' && (
            <div className={`text-xs mt-1 ${colorSet.text} opacity-70`}>
              Taking longer than usual...
            </div>
          )}
          {warningLevel === 'timeout' && (
            <div className={`text-xs mt-1 ${colorSet.text}`}>
              ⚠️ Operation taking very long. May need timeout.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ToolProgressIndicator;
