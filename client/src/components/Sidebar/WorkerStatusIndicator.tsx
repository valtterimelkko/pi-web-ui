import { useSessionStore } from '../../store/sessionStore';

interface WorkerStatusIndicatorProps {
  sessionId: string;
}

export function WorkerStatusIndicator({ sessionId }: WorkerStatusIndicatorProps) {
  // Look up worker status from store
  const workerStatus = useSessionStore((state) => state.workerStatus[sessionId]);

  // Return null if no worker status or sessionId is empty
  if (!sessionId || !workerStatus) {
    return null;
  }

  // Determine status styling based on worker status
  const getStatusConfig = () => {
    switch (workerStatus) {
      case 'streaming':
        return {
          animate: true,
          label: 'Active',
          dotClass: 'bg-amber-500',
          textClass: 'text-amber-600',
        };
      case 'ready':
      case 'idle':
        return {
          animate: false,
          label: 'Idle',
          dotClass: 'bg-emerald-500',
          textClass: 'text-emerald-600',
        };
      case 'error':
        return {
          animate: false,
          label: 'Error',
          dotClass: 'bg-red-500',
          textClass: 'text-red-600',
        };
      case 'spawning':
        return {
          animate: true,
          label: 'Starting...',
          dotClass: 'bg-blue-500',
          textClass: 'text-blue-600',
        };
      case 'terminated':
        return {
          animate: false,
          label: 'Ended',
          dotClass: 'bg-gray-400',
          textClass: 'text-gray-500',
        };
      case 'disconnected':
        return {
          animate: false,
          label: 'Offline',
          dotClass: 'bg-gray-400',
          textClass: 'text-gray-500',
        };
      default:
        return {
          animate: false,
          label: 'Unknown',
          dotClass: 'bg-gray-400',
          textClass: 'text-gray-500',
        };
    }
  };

  const { animate, label, dotClass, textClass } = getStatusConfig();

  return (
    <div className="flex items-center gap-1.5">
      <div
        className={`w-1.5 h-1.5 rounded-full ${dotClass} ${animate ? 'animate-pulse' : ''}`}
      />
      <span className={`text-[11px] ${textClass}`}>{label}</span>
    </div>
  );
}
