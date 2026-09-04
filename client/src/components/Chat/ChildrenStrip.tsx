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

  return (
    <div
      className="mb-2 rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-950 shadow-sm"
      data-testid="children-strip"
    >
      <div className="flex items-center gap-1.5 font-medium">
        <Bot className="w-3.5 h-3.5" />
        {running.length} {running.length === 1 ? 'child' : 'children'} running
      </div>
      <div className="mt-1 space-y-0.5">
        {running.map((c: ChildCardProjection) => (
          <div key={c.id} className="flex items-center gap-2 truncate" title={c.task ?? c.id}>
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" />
            <span className="font-medium truncate">{c.label}</span>
            {c.model && <span className="font-mono text-[10px] text-amber-700/70 truncate">{c.model}</span>}
            <span className="text-[10px] text-amber-700/60 shrink-0">
              {c.kind === 'internal_api_child' ? `dispatched via API${c.runtime ? ` · ${c.runtime}` : ''}` : 'background subagent'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
});
