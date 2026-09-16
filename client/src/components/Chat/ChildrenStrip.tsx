import { memo } from 'react';
import { Bot } from 'lucide-react';
import { useBackgroundChildrenStore } from '../../store/backgroundChildrenStore';
import type { ChildCardProjection } from '@pi-web-ui/shared';

/**
 * ChildrenStrip (contract 1.34.0 child surfacing) — the live "children
 * running" line above the composer, mirroring the goal-panel pattern's
 * ephemeral surface. Shows only non-settled children; settled children keep
 * their durable transcript card.
 */
export const ChildrenStrip = memo(function ChildrenStrip({ sessionId }: { sessionId: string | null }) {
  const children = useBackgroundChildrenStore((state) => (sessionId ? state.bySession[sessionId] : undefined));
  if (!sessionId || !children || children.length === 0) return null;
  const running = children.filter((c) => c.status === 'running' || c.status === 'dispatched');
  if (running.length === 0) return null;
  // Antigravity native background tasks and pi background shell tasks read as
  // "background task" (their own rail), not as orchestrated child agents.
  const allBackgroundTasks = running.every((c) => c.kind === 'antigravity_task' || c.kind === 'background_shell');
  const noun = allBackgroundTasks ? (running.length === 1 ? 'background task' : 'background tasks') : running.length === 1 ? 'child' : 'children';

  return (
    <div
      className="mb-2 rounded-xl border border-amber-300/70 dark:border-amber-800/50 bg-amber-50/70 dark:bg-amber-950/20 px-3.5 py-2 text-xs text-amber-950 dark:text-amber-200 shadow-xs transition-colors"
      data-testid="children-strip"
    >
      <div className="flex items-center gap-1.5 font-medium">
        <Bot className="w-3.5 h-3.5" strokeWidth={1.75} />
        {running.length} {noun} running
      </div>
      <div className="mt-1 space-y-0.5">
        {running.map((c: ChildCardProjection) => (
          <div key={c.id} className="flex items-center gap-2 truncate" title={c.task ?? c.id}>
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" />
            <span className="font-medium truncate">{c.label}</span>
            {c.model && <span className="font-mono text-[10px] text-amber-700/80 dark:text-amber-300/80 truncate">{c.model}</span>}
            <span className="text-[10px] text-amber-700/60 dark:text-amber-400/60 shrink-0">
              {c.kind === 'internal_api_child'
                ? `dispatched via API${c.runtime ? ` · ${c.runtime}` : ''}`
                : c.kind === 'antigravity_task'
                  ? 'background task'
                  : c.kind === 'background_shell'
                    ? 'shell task'
                    : 'background subagent'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
});
