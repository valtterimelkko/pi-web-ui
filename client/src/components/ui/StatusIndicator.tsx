import React from 'react';

export interface StatusIndicatorProps {
  status: 'spawning' | 'ready' | 'streaming' | 'idle' | 'error' | 'disconnected';
  message?: string;
}

export function StatusIndicator({ status, message }: StatusIndicatorProps) {
  const renderStatus = () => {
    switch (status) {
      case 'spawning':
        return (
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 border-2 border-yellow-400 border-t-transparent rounded-full animate-spin" />
            <span className="text-xs text-yellow-400">{message || 'Spawning...'}</span>
          </div>
        );

      case 'ready':
        return (
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-green-400" />
            <span className="text-xs text-green-400">{message || 'Ready'}</span>
          </div>
        );

      case 'streaming':
        return (
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            <span className="text-xs text-green-400">{message || 'Streaming...'}</span>
          </div>
        );

      case 'idle':
        return (
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-gray-400" />
            <span className="text-xs text-gray-400">{message || 'Idle'}</span>
          </div>
        );

      case 'error':
        return (
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-red-400" />
            <span className="text-xs text-red-400">{message || 'Error'}</span>
          </div>
        );

      case 'disconnected':
        return (
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-gray-400" />
            <span className="text-xs text-gray-400">{message || 'Disconnected'}</span>
          </div>
        );

      default:
        return (
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-gray-400" />
            <span className="text-xs text-gray-400">{message || 'Unknown'}</span>
          </div>
        );
    }
  };

  return (
    <div className="inline-flex items-center">
      {renderStatus()}
    </div>
  );
}
