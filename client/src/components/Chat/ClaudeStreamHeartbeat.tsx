import { useState, useEffect } from 'react';
import { useSessionStore } from '../../store';
import { useUIStore } from '../../store/uiStore';

const STALE_THRESHOLD_MS = 5000;
const TICK_INTERVAL_MS = 1000;
const SLOW_PROMPT_WARNING_MS = 60_000;

interface ClaudeStreamHeartbeatProps {
  compact?: boolean;
}

export function ClaudeStreamHeartbeat({ compact = false }: ClaudeStreamHeartbeatProps) {
  const isStreaming = useSessionStore((s) => s.isStreaming);
  const sdkType = useSessionStore((s) => s.currentSessionSdkType);
  const currentToolName = useSessionStore((s) => s.currentToolName);
  const promptStartedAt = useSessionStore((s) => s.promptStartedAt);
  const [stale, setStale] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [warnedSlow, setWarnedSlow] = useState(false);

  // Slow-prompt warning: if 60s pass after agent_start with no events, show a toast
  useEffect(() => {
    if (!isStreaming || sdkType !== 'claude' || !promptStartedAt) {
      setWarnedSlow(false);
      return;
    }
    const remaining = SLOW_PROMPT_WARNING_MS - (Date.now() - promptStartedAt);
    if (remaining <= 0) {
      if (!warnedSlow) {
        setWarnedSlow(true);
        useUIStore.getState().addToast({
          type: 'warning',
          message: 'Claude hasn\'t responded yet — may still be processing or the prompt could be stuck.',
        });
      }
      return;
    }
    const timer = setTimeout(() => {
      if (!warnedSlow) {
        setWarnedSlow(true);
        useUIStore.getState().addToast({
          type: 'warning',
          message: 'Claude hasn\'t responded yet — may still be processing or the prompt could be stuck.',
        });
      }
    }, remaining);
    return () => clearTimeout(timer);
  }, [isStreaming, sdkType, promptStartedAt, warnedSlow]);

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
    const label = currentToolName ? `Running ${currentToolName}...` : 'Thinking...';
    return <span className="text-gray-500">{label}</span>;
  }

  const dots = '.'.repeat((Math.floor(elapsedSec / 2) % 3) + 1);
  const label = currentToolName
    ? `Running ${currentToolName}${dots}`
    : `Working${dots}`;

  return (
    <span className="inline-flex items-center gap-1 text-xs text-amber-500 animate-pulse">
      {!compact && <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />}
      {label}
    </span>
  );
}
