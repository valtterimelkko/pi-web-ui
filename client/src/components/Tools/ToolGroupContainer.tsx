import React, { memo, useMemo } from 'react';
import { ChevronDown } from 'lucide-react';
import type { LiveMessage } from '../../hooks/useSessionStream.js';
import { normalizeToolName } from '../../lib/messageAdapter';
import { CollapsibleToolCard } from './CollapsibleToolCard';
import { SubagentToolCard } from './SubagentToolCard';
import { TodoToolCard } from './TodoToolCard';

export interface ToolGroupContainerProps {
  groupId: string;
  messages: LiveMessage[];
  isExpanded: boolean;
  onToggle: () => void;
}

/**
 * Generates a natural language summary for consecutive tool calls
 * matching the Claude Code Web UI pattern:
 * e.g. "Ran 5 commands, read package.json, used a tool"
 */
export function generateGroupSummary(messages: LiveMessage[]): string {
  let commandsCount = 0;
  const readPaths: string[] = [];
  const editPaths: string[] = [];
  let searchesCount = 0;
  let skillsCount = 0;
  let subagentsCount = 0;
  let otherCount = 0;

  for (const m of messages) {
    if (!m.toolCall?.name) continue;
    const norm = normalizeToolName(m.toolCall.name).toLowerCase();
    const args = (m.toolCall.args && typeof m.toolCall.args === 'object') ? (m.toolCall.args as Record<string, unknown>) : {};

    if (norm === 'bash' || norm === 'run_command') {
      commandsCount++;
    } else if (norm === 'read' || norm === 'view_file') {
      const p = (args.path || args.AbsolutePath || args.file_path || '') as string;
      const basename = p.split('/').filter(Boolean).pop() || p;
      if (basename) readPaths.push(basename);
      else readPaths.push('file');
    } else if (norm === 'edit' || norm === 'write' || norm === 'replace_file_content' || norm === 'write_to_file' || norm === 'sed_file') {
      const p = (args.path || args.AbsolutePath || args.file_path || args.TargetFile || '') as string;
      const basename = p.split('/').filter(Boolean).pop() || p;
      if (basename) editPaths.push(basename);
      else editPaths.push('file');
    } else if (norm === 'grep' || norm === 'glob' || norm === 'grep_search' || norm === 'find_by_name' || norm === 'find' || norm === 'list_dir') {
      searchesCount++;
    } else if (norm === 'subagent' || norm === 'agent' || norm === 'invoke_subagent') {
      subagentsCount++;
    } else if (norm.includes('skill')) {
      skillsCount++;
    } else {
      otherCount++;
    }
  }

  const parts: string[] = [];
  if (commandsCount > 0) {
    parts.push(`Ran ${commandsCount} command${commandsCount === 1 ? '' : 's'}`);
  }
  if (readPaths.length > 0) {
    if (readPaths.length === 1) {
      parts.push(`read ${readPaths[0]}`);
    } else {
      parts.push(`read ${readPaths.length} files`);
    }
  }
  if (editPaths.length > 0) {
    if (editPaths.length === 1) {
      parts.push(`updated ${editPaths[0]}`);
    } else {
      parts.push(`updated ${editPaths.length} files`);
    }
  }
  if (searchesCount > 0) {
    parts.push(`searched codebase`);
  }
  if (subagentsCount > 0) {
    parts.push(`used ${subagentsCount === 1 ? 'a subagent' : `${subagentsCount} subagents`}`);
  }
  if (skillsCount > 0) {
    parts.push(`used ${skillsCount === 1 ? 'a skill' : `${skillsCount} skills`}`);
  }
  if (otherCount > 0) {
    parts.push(`used ${otherCount === 1 ? 'a tool' : `${otherCount} tools`}`);
  }

  if (parts.length === 0) {
    return `${messages.length} tools`;
  }

  return parts.join(', ');
}

export const ToolGroupContainer = memo(function ToolGroupContainer({
  groupId,
  messages,
  isExpanded,
  onToggle,
}: ToolGroupContainerProps) {
  const summary = useMemo(() => generateGroupSummary(messages), [messages]);

  return (
    <div className="w-full my-1" data-testid={`tool-group-${groupId}`}>
      {/* Group summary toggle button */}
      <button
        onClick={onToggle}
        className="flex items-center gap-1.5 text-xs text-content-secondary dark:text-content-secondary-dark hover:text-content-primary dark:hover:text-content-primary-dark transition-colors py-1 group text-left"
        type="button"
        aria-expanded={isExpanded}
      >
        <span className="font-normal">{summary}</span>
        <span className="text-content-muted dark:text-content-muted-dark font-normal">({messages.length} tools)</span>
        <ChevronDown
          className={`w-3.5 h-3.5 text-content-muted dark:text-content-muted-dark transition-transform duration-200 shrink-0 ${
            isExpanded ? 'rotate-180' : ''
          }`}
        />
      </button>

      {/* Unified container for expanded tools */}
      {isExpanded && (
        <div className="border border-outline-default dark:border-outline-default-dark rounded-lg bg-surface dark:bg-surface-dark overflow-hidden shadow-xs divide-y divide-outline-subtle dark:divide-outline-subtle-dark my-1.5 transition-colors">
          {messages.map((m) => {
            if (!m.toolCall) return null;
            const normalizedName = normalizeToolName(m.toolCall.name);

            if (normalizedName === 'subagent') {
              return (
                <div key={m.id} className="p-2">
                  <SubagentToolCard
                    name={m.toolCall.name}
                    args={m.toolCall.args}
                    result={m.toolResult}
                    startTime={m.timestamp}
                    background={m.toolResult?.background}
                  />
                </div>
              );
            }

            if (normalizedName === 'todo') {
              return (
                <div key={m.id} className="p-2">
                  <TodoToolCard
                    name={m.toolCall.name}
                    args={m.toolCall.args}
                    result={m.toolResult}
                    startTime={m.timestamp}
                  />
                </div>
              );
            }

            return (
              <CollapsibleToolCard
                key={m.id}
                name={m.toolCall.name}
                args={m.toolCall.args}
                result={m.toolResult}
                startTime={m.timestamp}
                embedded={true}
              />
            );
          })}
        </div>
      )}
    </div>
  );
});
