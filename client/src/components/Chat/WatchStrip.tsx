import { memo } from 'react';
import { Bell } from 'lucide-react';
import { useWatchSurfacingStore } from '../../store/watchSurfacingStore';
import type { WatchCardProjection } from '@pi-web-ui/shared';

/**
 * WatchStrip (contract 1.34.0 watch surfacing) — the live "watches armed"
 * line beside the children strip, mirroring the goal-panel pattern's
 * ephemeral surface. Shows each watch's condition and fired state.
 */
export const WatchStrip = memo(function WatchStrip({ sessionId }: { sessionId: string | null }) {
  const watches = useWatchSurfacingStore((state) => (sessionId ? state.bySession[sessionId] : undefined));
  if (!sessionId || !watches || watches.length === 0) return null;

  return (
    <div
      className="mb-2 rounded-xl border border-sky-300/70 dark:border-sky-800/50 bg-sky-50/70 dark:bg-sky-950/20 px-3.5 py-2 text-xs text-sky-950 dark:text-sky-200 shadow-xs transition-colors"
      data-testid="watch-strip"
    >
      <div className="flex items-center gap-1.5 font-medium">
        <Bell className="w-3.5 h-3.5" strokeWidth={1.75} />
        {watches.length} {watches.length === 1 ? 'watch' : 'watches'} armed
      </div>
      <div className="mt-1 space-y-0.5">
        {watches.map((w: WatchCardProjection) => (
          <div key={w.watchId} className="flex items-center gap-2 truncate" title={w.watchId}>
            <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${w.status === 'fired' ? 'bg-emerald-500' : 'bg-sky-400 animate-pulse'}`} />
            <span className="font-medium truncate">{w.label ?? w.watchId}</span>
            <span className="font-mono text-[10px] text-sky-700/80 dark:text-sky-300/80 truncate">{w.conditions[0]?.description ?? 'watch'}</span>
            <span className="text-[10px] text-sky-700/60 dark:text-sky-400/60 shrink-0">
              {w.status === 'fired' ? `fired${w.deliveryKind ? ` → ${w.deliveryKind}` : ''}` : w.status}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
});
