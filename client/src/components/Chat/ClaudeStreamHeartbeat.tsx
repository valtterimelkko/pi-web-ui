import { useState, useEffect } from 'react';
import { useSessionStore } from '../../store';

const STALE_THRESHOLD_MS = 5000;
const TICK_INTERVAL_MS = 1000;

interface ClaudeStreamHeartbeatProps {
  compact?: boolean;
}

export function ClaudeStreamHeartbeat({ compact = false }: ClaudeStreamHeartbeatProps) {
  const isStreaming = useSessionStore((s) => s.isStreaming);
  const sdkType = useSessionStore((s) => s.currentSessionSdkType);
  const [stale, setStale] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    if (!isStreaming || sdkType !== 'claude') {
      setStale(false);
      setElapsedSec(0);
      return;
    }

    const tick = () => {
      const now = Date.now();
      const last = useSessionStore.getState().lastStreamEventAt;
      if (!last) {
        setStale(false);
        setElapsedSec(0);
        return;
      }
      const elapsed = now - last;
      if (elapsed > STALE_THRESHOLD_MS) {
        setStale(true);
        setElapsedSec(Math.floor(elapsed / 1000));
      } else {
        setStale(false);
        setElapsedSec(0);
      }
    };

    tick();
    const id = setInterval(tick, TICK_INTERVAL_MS);
    return () => clearInterval(id);
  }, [isStreaming, sdkType]);

  if (!isStreaming || sdkType !== 'claude') {
    return null;
  }

  if (compact && !stale) {
    return null;
  }

  if (!stale) {
    return <span className="text-gray-500">Thinking...</span>;
  }

  const dots = '.'.repeat((Math.floor(elapsedSec / 2) % 3) + 1);

  return (
    <span className="inline-flex items-center gap-1 text-xs text-amber-500 animate-pulse">
      {!compact && <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />}
      Working{dots}
    </span>
  );
}
