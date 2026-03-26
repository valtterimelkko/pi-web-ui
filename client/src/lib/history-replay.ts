/**
 * History Replay Handler for Pi Web UI
 * 
 * Manages replay of historical session events with live event buffering.
 * During replay, live events are buffered and processed after replay completes.
 */

import { useState, useRef, useCallback, useEffect } from 'react';

/**
 * A single event to be replayed
 */
export interface ReplayEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * Progress information for a replay
 */
export interface ReplayProgress {
  /** Total number of events to replay */
  total: number;
  /** Current event index (0-based) */
  current: number;
  /** Percentage complete (0-100) */
  percent: number;
}

/**
 * Options for the history replay handler
 */
export interface HistoryReplayOptions {
  /** Batch size for processing events (default: 10) */
  batchSize?: number;
  /** Delay between batches in milliseconds (default: 50) */
  batchDelay?: number;
  /** Callback when a batch of events is processed */
  onBatchProcessed?: (events: ReplayEvent[], progress: ReplayProgress) => void;
  /** Callback when replay starts */
  onReplayStart?: (total: number) => void;
  /** Callback when replay completes */
  onReplayComplete?: (totalProcessed: number) => void;
  /** Callback for processing a single event */
  processEvent?: (event: ReplayEvent) => void;
}

/**
 * State for a replay operation
 */
interface ReplayState {
  isReplaying: boolean;
  progress: ReplayProgress;
  events: ReplayEvent[];
  processedCount: number;
}

/**
 * Hook for managing history replay with live event buffering.
 * 
 * Features:
 * - Buffers live events during replay
 * - Processes replay events in batches for smoother UI
 * - Tracks progress for UI feedback
 * - Flushes buffered events after replay completes
 * 
 * @example
 * ```typescript
 * const {
 *   isReplaying,
 *   replayProgress,
 *   startReplay,
 *   bufferEvent,
 *   flushBuffer,
 *   cancelReplay,
 * } = useHistoryReplay({
 *   processEvent: (event) => sessionStore.handleServerMessage(event),
 *   onReplayComplete: () => console.log('Replay done!'),
 * });
 * 
 * // Start replay
 * await startReplay(historicalEvents);
 * 
 * // During replay, live events are buffered
 * bufferEvent({ type: 'message', content: 'live update' });
 * 
 * // After replay, flush buffered events
 * const buffered = flushBuffer();
 * buffered.forEach(processEvent);
 * ```
 */
export function useHistoryReplay(options: HistoryReplayOptions = {}) {
  const {
    batchSize = 10,
    batchDelay = 50,
    onBatchProcessed,
    onReplayStart,
    onReplayComplete,
    processEvent,
  } = options;

  const [isReplaying, setIsReplaying] = useState(false);
  const [replayProgress, setReplayProgress] = useState<ReplayProgress>({
    total: 0,
    current: 0,
    percent: 0,
  });

  // Buffer for live events that arrive during replay
  const eventBufferRef = useRef<ReplayEvent[]>([]);
  
  // State for the current replay operation
  const replayStateRef = useRef<ReplayState>({
    isReplaying: false,
    progress: { total: 0, current: 0, percent: 0 },
    events: [],
    processedCount: 0,
  });

  // Animation frame/timer reference for cleanup
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Process a batch of events
   */
  const processBatch = useCallback(() => {
    const state = replayStateRef.current;
    if (!state.isReplaying) return;

    const { events, processedCount } = state;
    const nextBatch = events.slice(processedCount, processedCount + batchSize);
    
    if (nextBatch.length === 0) {
      // Replay complete
      state.isReplaying = false;
      setIsReplaying(false);
      
      if (onReplayComplete) {
        onReplayComplete(processedCount);
      }
      return;
    }

    // Process the batch
    nextBatch.forEach((event) => {
      if (processEvent) {
        processEvent(event);
      }
    });

    state.processedCount += nextBatch.length;
    const newProgress: ReplayProgress = {
      total: events.length,
      current: state.processedCount,
      percent: Math.round((state.processedCount / events.length) * 100),
    };
    
    state.progress = newProgress;
    setReplayProgress(newProgress);

    if (onBatchProcessed) {
      onBatchProcessed(nextBatch, newProgress);
    }

    // Schedule next batch
    if (state.processedCount < events.length) {
      batchTimerRef.current = setTimeout(processBatch, batchDelay);
    } else {
      // Replay complete
      state.isReplaying = false;
      setIsReplaying(false);
      
      if (onReplayComplete) {
        onReplayComplete(processedCount);
      }
    }
  }, [batchSize, batchDelay, onBatchProcessed, onReplayComplete, processEvent]);

  /**
   * Start replaying a list of historical events
   */
  const startReplay = useCallback(async (events: ReplayEvent[]): Promise<void> => {
    // Don't start if already replaying or no events
    if (replayStateRef.current.isReplaying) {
      console.warn('[HistoryReplay] Already replaying, ignoring start request');
      return;
    }

    if (events.length === 0) {
      // Nothing to replay
      setReplayProgress({ total: 0, current: 0, percent: 100 });
      if (onReplayComplete) {
        onReplayComplete(0);
      }
      return;
    }

    // Initialize replay state
    replayStateRef.current = {
      isReplaying: true,
      progress: { total: events.length, current: 0, percent: 0 },
      events: [...events], // Copy to avoid mutations
      processedCount: 0,
    };

    setIsReplaying(true);
    setReplayProgress({
      total: events.length,
      current: 0,
      percent: 0,
    });

    if (onReplayStart) {
      onReplayStart(events.length);
    }

    // Start processing batches
    return new Promise((resolve) => {
      // Use setTimeout to allow UI to update before processing
      batchTimerRef.current = setTimeout(() => {
        processBatch();
        resolve();
      }, 0);
    });
  }, [onReplayStart, processBatch]);

  /**
   * Cancel an ongoing replay
   */
  const cancelReplay = useCallback((): void => {
    if (batchTimerRef.current) {
      clearTimeout(batchTimerRef.current);
      batchTimerRef.current = null;
    }

    replayStateRef.current.isReplaying = false;
    replayStateRef.current.events = [];
    replayStateRef.current.processedCount = 0;
    
    setIsReplaying(false);
    setReplayProgress({ total: 0, current: 0, percent: 0 });
  }, []);

  /**
   * Buffer a live event that arrived during replay
   * Returns true if the event was buffered, false if it should be processed immediately
   */
  const bufferEvent = useCallback((event: ReplayEvent): boolean => {
    if (replayStateRef.current.isReplaying) {
      eventBufferRef.current.push(event);
      return true;
    }
    return false;
  }, []);

  /**
   * Flush all buffered events and return them
   */
  const flushBuffer = useCallback((): ReplayEvent[] => {
    const events = [...eventBufferRef.current];
    eventBufferRef.current = [];
    return events;
  }, []);

  /**
   * Get the current buffer size without flushing
   */
  const getBufferSize = useCallback((): number => {
    return eventBufferRef.current.length;
  }, []);

  /**
   * Clear the buffer without returning the events
   */
  const clearBuffer = useCallback((): void => {
    eventBufferRef.current = [];
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (batchTimerRef.current) {
        clearTimeout(batchTimerRef.current);
      }
    };
  }, []);

  return {
    /** Whether a replay is currently in progress */
    isReplaying,
    /** Current replay progress */
    replayProgress,
    /** Start replaying a list of events */
    startReplay,
    /** Cancel the current replay */
    cancelReplay,
    /** Buffer a live event during replay */
    bufferEvent,
    /** Flush and return all buffered events */
    flushBuffer,
    /** Get the current buffer size */
    getBufferSize,
    /** Clear the buffer without processing */
    clearBuffer,
  };
}

/**
 * Non-hook class for managing history replay outside of React components.
 * Useful for integration with JSONRPCClient event handlers.
 */
export class HistoryReplayManager {
  private isReplaying = false;
  private progress: ReplayProgress = { total: 0, current: 0, percent: 0 };
  private eventBuffer: ReplayEvent[] = [];
  private replayQueue: ReplayEvent[] = [];
  private processedCount = 0;
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  
  private readonly batchSize: number;
  private readonly batchDelay: number;
  private readonly onBatchProcessed?: (events: ReplayEvent[], progress: ReplayProgress) => void;
  private readonly onReplayStart?: (total: number) => void;
  private readonly onReplayComplete?: (totalProcessed: number) => void;
  private readonly processEvent?: (event: ReplayEvent) => void;

  constructor(options: HistoryReplayOptions = {}) {
    this.batchSize = options.batchSize ?? 10;
    this.batchDelay = options.batchDelay ?? 50;
    this.onBatchProcessed = options.onBatchProcessed;
    this.onReplayStart = options.onReplayStart;
    this.onReplayComplete = options.onReplayComplete;
    this.processEvent = options.processEvent;
  }

  /**
   * Whether a replay is currently in progress
   */
  getIsReplaying(): boolean {
    return this.isReplaying;
  }

  /**
   * Get current progress
   */
  getProgress(): ReplayProgress {
    return { ...this.progress };
  }

  /**
   * Start replaying events
   */
  async startReplay(events: ReplayEvent[]): Promise<void> {
    if (this.isReplaying) {
      console.warn('[HistoryReplayManager] Already replaying, ignoring start request');
      return;
    }

    if (events.length === 0) {
      this.progress = { total: 0, current: 0, percent: 100 };
      if (this.onReplayComplete) {
        this.onReplayComplete(0);
      }
      return;
    }

    this.isReplaying = true;
    this.replayQueue = [...events];
    this.processedCount = 0;
    this.progress = { total: events.length, current: 0, percent: 0 };

    if (this.onReplayStart) {
      this.onReplayStart(events.length);
    }

    return new Promise((resolve) => {
      this.batchTimer = setTimeout(() => {
        this.processBatch();
        resolve();
      }, 0);
    });
  }

  /**
   * Cancel the current replay
   */
  cancelReplay(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    this.isReplaying = false;
    this.replayQueue = [];
    this.processedCount = 0;
    this.progress = { total: 0, current: 0, percent: 0 };
  }

  /**
   * Buffer a live event during replay
   */
  bufferEvent(event: ReplayEvent): boolean {
    if (this.isReplaying) {
      this.eventBuffer.push(event);
      return true;
    }
    return false;
  }

  /**
   * Flush and return buffered events
   */
  flushBuffer(): ReplayEvent[] {
    const events = [...this.eventBuffer];
    this.eventBuffer = [];
    return events;
  }

  /**
   * Get buffer size
   */
  getBufferSize(): number {
    return this.eventBuffer.length;
  }

  /**
   * Clear the buffer
   */
  clearBuffer(): void {
    this.eventBuffer = [];
  }

  /**
   * Process a batch of events
   */
  private processBatch(): void {
    if (!this.isReplaying) return;

    const nextBatch = this.replayQueue.slice(
      this.processedCount,
      this.processedCount + this.batchSize
    );

    if (nextBatch.length === 0) {
      this.completeReplay();
      return;
    }

    // Process the batch
    nextBatch.forEach((event) => {
      if (this.processEvent) {
        this.processEvent(event);
      }
    });

    this.processedCount += nextBatch.length;
    this.progress = {
      total: this.replayQueue.length,
      current: this.processedCount,
      percent: Math.round((this.processedCount / this.replayQueue.length) * 100),
    };

    if (this.onBatchProcessed) {
      this.onBatchProcessed(nextBatch, this.progress);
    }

    // Schedule next batch or complete
    if (this.processedCount < this.replayQueue.length) {
      this.batchTimer = setTimeout(() => this.processBatch(), this.batchDelay);
    } else {
      this.completeReplay();
    }
  }

  /**
   * Complete the replay
   */
  private completeReplay(): void {
    this.isReplaying = false;
    
    if (this.onReplayComplete) {
      this.onReplayComplete(this.processedCount);
    }
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    this.cancelReplay();
    this.clearBuffer();
  }
}

/**
 * Integration helper for JSONRPCClient
 * Sets up event listeners for replay events and handles buffering
 */
export function setupReplayIntegration(
  client: {
    on: (event: string, handler: (params: unknown) => void) => () => void;
  },
  manager: HistoryReplayManager,
  processEvent: (event: ReplayEvent) => void
): () => void {
  const unsubscribers: (() => void)[] = [];

  // Handle replay_start
  const handleReplayStart = (params: unknown) => {
    const { events } = params as { events: ReplayEvent[] };
    manager.startReplay(events);
  };
  unsubscribers.push(client.on('replay_start', handleReplayStart));

  // Handle replay_event - process immediately during replay
  const handleReplayEvent = (params: unknown) => {
    const event = params as ReplayEvent;
    // During replay, events come from the server - process them
    processEvent(event);
  };
  unsubscribers.push(client.on('replay_event', handleReplayEvent));

  // Handle replay_complete
  const handleReplayComplete = (params: unknown) => {
    manager.cancelReplay(); // Reset replay state
    
    // Flush and process any buffered live events
    const buffered = manager.flushBuffer();
    buffered.forEach(processEvent);
  };
  unsubscribers.push(client.on('replay_complete', handleReplayComplete));

  // Return cleanup function
  return () => {
    unsubscribers.forEach((unsub) => unsub());
  };
}

export default useHistoryReplay;
