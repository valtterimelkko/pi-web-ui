import { useSessionStore } from '../../store/sessionStore';

interface SessionStatusIndicatorProps {
  sessionId: string;
}

export function SessionStatusIndicator({ sessionId }: SessionStatusIndicatorProps) {
  // Look up session data from store
  const sessionData = useSessionStore((state) => state.sessionData[sessionId]);

  // Return null if session not found or sessionId is empty
  if (!sessionId || !sessionData) {
    return null;
  }

  const { status, currentStep } = sessionData;

  // Determine status dot color and animation
  const getStatusStyles = () => {
    switch (status) {
      case 'idle':
        return {
          dotClass: 'bg-emerald-400',
          animate: false,
        };
      case 'streaming':
        return {
          dotClass: 'bg-amber-400',
          animate: true,
        };
      case 'busy':
        return {
          dotClass: 'bg-blue-400',
          animate: true,
        };
      case 'error':
        return {
          dotClass: 'bg-red-400',
          animate: false,
        };
      default:
        return {
          dotClass: 'bg-gray-400',
          animate: false,
        };
    }
  };

  // Get status text
  const getStatusText = () => {
    switch (status) {
      case 'idle':
        return 'Ready';
      case 'streaming':
        return `Step ${currentStep}...`;
      case 'busy':
        return 'Working...';
      case 'error':
        return 'Error';
      default:
        return 'Unknown';
    }
  };

  const { dotClass, animate } = getStatusStyles();

  return (
    <div className="flex items-center gap-1.5">
      <div
        className={`w-1.5 h-1.5 rounded-full ${dotClass} ${animate ? 'animate-pulse' : ''}`}
      />
      <span className="text-xs text-gray-500">{getStatusText()}</span>
    </div>
  );
}
