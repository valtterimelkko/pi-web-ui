import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useHistoryReplay,
  HistoryReplayManager,
  setupReplayIntegration,
  type ReplayEvent,
  type ReplayProgress,
} from '../../../src/lib/history-replay';

describe('useHistoryReplay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('should initialize with isReplaying false', () => {
      const { result } = renderHook(() => useHistoryReplay());
      expect(result.current.isReplaying).toBe(false);
    });

    it('should initialize with zero progress', () => {
      const { result } = renderHook(() => useHistoryReplay());
      expect(result.current.replayProgress).toEqual({
        total: 0,
        current: 0,
        percent: 0,
      });
    });

    it('should initialize with empty buffer', () => {
      const { result } = renderHook(() => useHistoryReplay());
      expect(result.current.getBufferSize()).toBe(0);
    });
  });

  describe('startReplay', () => {
    it('should set progress total to event count', async () => {
      const { result } = renderHook(() => useHistoryReplay({
        batchSize: 10,
        batchDelay: 10,
      }));
      
      const events: ReplayEvent[] = [
        { type: 'message', content: '1' },
        { type: 'message', content: '2' },
        { type: 'message', content: '3' },
      ];

      await act(async () => {
        const promise = result.current.startReplay(events);
        await vi.runAllTimersAsync();
        await promise;
      });

      expect(result.current.replayProgress.total).toBe(3);
    });

    it('should call onReplayStart callback', async () => {
      const onReplayStart = vi.fn();
      const { result } = renderHook(() => useHistoryReplay({ onReplayStart }));
      
      const events: ReplayEvent[] = [
        { type: 'message', content: 'Test' },
      ];

      await act(async () => {
        const promise = result.current.startReplay(events);
        await vi.runAllTimersAsync();
        await promise;
      });

      expect(onReplayStart).toHaveBeenCalledWith(1);
    });

    it('should handle empty events array', async () => {
      const onReplayComplete = vi.fn();
      const { result } = renderHook(() => useHistoryReplay({ onReplayComplete }));
      
      await act(async () => {
        await result.current.startReplay([]);
      });
      
      expect(result.current.isReplaying).toBe(false);
      expect(result.current.replayProgress.percent).toBe(100);
      expect(onReplayComplete).toHaveBeenCalledWith(0);
    });

    it('should not start if already replaying', async () => {
      const onReplayStart = vi.fn();
      const { result } = renderHook(() => useHistoryReplay({ 
        onReplayStart,
        batchSize: 1,
        batchDelay: 100,
      }));
      
      const events1: ReplayEvent[] = [{ type: 'message', content: '1' }];
      const events2: ReplayEvent[] = [{ type: 'message', content: '2' }];

      await act(async () => {
        // Start first replay
        result.current.startReplay(events1);
        await vi.advanceTimersByTimeAsync(10);
        
        // Try to start second replay while first is running
        result.current.startReplay(events2);
        
        await vi.runAllTimersAsync();
      });

      // Should only have called onReplayStart once (for first replay)
      expect(onReplayStart).toHaveBeenCalledTimes(1);
    });
  });

  describe('progress tracking', () => {
    it('should update progress as events are processed', async () => {
      const processEvent = vi.fn();
      const { result } = renderHook(() => useHistoryReplay({
        processEvent,
        batchSize: 2,
        batchDelay: 10,
      }));
      
      const events: ReplayEvent[] = [
        { type: 'message', content: '1' },
        { type: 'message', content: '2' },
        { type: 'message', content: '3' },
        { type: 'message', content: '4' },
      ];

      await act(async () => {
        const promise = result.current.startReplay(events);
        await vi.advanceTimersByTimeAsync(20);
        await promise;
      });

      // Progress should have increased
      expect(result.current.replayProgress.current).toBeGreaterThan(0);
    });

    it('should calculate percent correctly', async () => {
      const processEvent = vi.fn();
      const { result } = renderHook(() => useHistoryReplay({
        processEvent,
        batchSize: 1,
        batchDelay: 10,
      }));
      
      const events: ReplayEvent[] = [
        { type: 'message', content: '1' },
        { type: 'message', content: '2' },
        { type: 'message', content: '3' },
        { type: 'message', content: '4' },
      ];

      await act(async () => {
        const promise = result.current.startReplay(events);
        
        // Process first batch (25%)
        await vi.advanceTimersByTimeAsync(15);
        expect(result.current.replayProgress.percent).toBe(25);
        
        // Process second batch (50%)
        await vi.advanceTimersByTimeAsync(10);
        expect(result.current.replayProgress.percent).toBe(50);
        
        // Complete
        await vi.runAllTimersAsync();
        await promise;
      });
      
      expect(result.current.replayProgress.percent).toBe(100);
    });
  });

  describe('event buffering', () => {
    it('should buffer events during replay', async () => {
      const processEvent = vi.fn();
      const { result } = renderHook(() => useHistoryReplay({
        processEvent,
        batchSize: 1,
        batchDelay: 50,
      }));
      
      const events: ReplayEvent[] = [
        { type: 'message', content: '1' },
        { type: 'message', content: '2' },
      ];

      await act(async () => {
        result.current.startReplay(events);
        await vi.advanceTimersByTimeAsync(10);
        
        // Buffer a live event during replay
        const liveEvent: ReplayEvent = { type: 'live', content: 'live update' };
        const wasBuffered = result.current.bufferEvent(liveEvent);
        
        expect(wasBuffered).toBe(true);
        expect(result.current.getBufferSize()).toBe(1);
        
        await vi.runAllTimersAsync();
      });
    });

    it('should not buffer events when not replaying', () => {
      const { result } = renderHook(() => useHistoryReplay());
      
      const event: ReplayEvent = { type: 'message', content: 'test' };
      const wasBuffered = result.current.bufferEvent(event);
      
      expect(wasBuffered).toBe(false);
      expect(result.current.getBufferSize()).toBe(0);
    });

    it('should flush buffer and return events', async () => {
      const { result } = renderHook(() => useHistoryReplay({
        batchSize: 1,
        batchDelay: 50,
      }));
      
      const events: ReplayEvent[] = [{ type: 'message', content: '1' }];
      
      let flushed: ReplayEvent[] = [];
      
      await act(async () => {
        result.current.startReplay(events);
        await vi.advanceTimersByTimeAsync(10);
        
        // Buffer some events
        result.current.bufferEvent({ type: 'live1', content: '1' });
        result.current.bufferEvent({ type: 'live2', content: '2' });
        
        expect(result.current.getBufferSize()).toBe(2);
        
        await vi.runAllTimersAsync();
        
        // Flush the buffer
        flushed = result.current.flushBuffer();
      });
      
      expect(flushed).toHaveLength(2);
      expect(flushed[0]).toEqual({ type: 'live1', content: '1' });
      expect(flushed[1]).toEqual({ type: 'live2', content: '2' });
      
      // Buffer should be empty now
      expect(result.current.getBufferSize()).toBe(0);
    });

    it('should clear buffer without returning events', async () => {
      const { result } = renderHook(() => useHistoryReplay({
        batchSize: 1,
        batchDelay: 50,
      }));
      
      const events: ReplayEvent[] = [{ type: 'message', content: '1' }];
      
      await act(async () => {
        result.current.startReplay(events);
        await vi.advanceTimersByTimeAsync(10);
        
        result.current.bufferEvent({ type: 'live', content: 'test' });
        expect(result.current.getBufferSize()).toBe(1);
        
        result.current.clearBuffer();
        expect(result.current.getBufferSize()).toBe(0);
        
        await vi.runAllTimersAsync();
      });
    });
  });

  describe('batch processing', () => {
    it('should process events in batches', async () => {
      const processEvent = vi.fn();
      const onBatchProcessed = vi.fn();
      const { result } = renderHook(() => useHistoryReplay({
        processEvent,
        onBatchProcessed,
        batchSize: 3,
        batchDelay: 10,
      }));
      
      const events: ReplayEvent[] = [
        { type: 'message', content: '1' },
        { type: 'message', content: '2' },
        { type: 'message', content: '3' },
        { type: 'message', content: '4' },
        { type: 'message', content: '5' },
      ];

      await act(async () => {
        const promise = result.current.startReplay(events);
        await vi.advanceTimersByTimeAsync(15);
        expect(processEvent).toHaveBeenCalledTimes(3);
        expect(onBatchProcessed).toHaveBeenCalledTimes(1);
        
        await vi.runAllTimersAsync();
        await promise;
      });
      
      expect(processEvent).toHaveBeenCalledTimes(5);
    });

    it('should respect batchDelay between batches', async () => {
      const processEvent = vi.fn();
      const { result } = renderHook(() => useHistoryReplay({
        processEvent,
        batchSize: 2,
        batchDelay: 100,
      }));
      
      const events: ReplayEvent[] = [
        { type: 'message', content: '1' },
        { type: 'message', content: '2' },
        { type: 'message', content: '3' },
        { type: 'message', content: '4' },
      ];

      await act(async () => {
        const promise = result.current.startReplay(events);
        
        // After first batch + small delay, only first batch should be processed
        await vi.advanceTimersByTimeAsync(50);
        expect(processEvent).toHaveBeenCalledTimes(2);
        
        // After batch delay, second batch should be processed
        await vi.advanceTimersByTimeAsync(100);
        expect(processEvent).toHaveBeenCalledTimes(4);
        
        await promise;
      });
    });
  });

  describe('cancelReplay', () => {
    it('should cancel an ongoing replay', async () => {
      const processEvent = vi.fn();
      const { result } = renderHook(() => useHistoryReplay({
        processEvent,
        batchSize: 1,
        batchDelay: 50,
      }));
      
      const events: ReplayEvent[] = [
        { type: 'message', content: '1' },
        { type: 'message', content: '2' },
        { type: 'message', content: '3' },
      ];

      await act(async () => {
        result.current.startReplay(events);
        
        // Process first event
        await vi.advanceTimersByTimeAsync(10);
        
        // Cancel replay
        result.current.cancelReplay();
      });
      
      expect(result.current.isReplaying).toBe(false);
      expect(result.current.replayProgress).toEqual({
        total: 0,
        current: 0,
        percent: 0,
      });
    });
  });

  describe('completion', () => {
    it('should call onReplayComplete when finished', async () => {
      const onReplayComplete = vi.fn();
      const { result } = renderHook(() => useHistoryReplay({
        onReplayComplete,
        batchSize: 10,
        batchDelay: 10,
      }));
      
      const events: ReplayEvent[] = [
        { type: 'message', content: '1' },
        { type: 'message', content: '2' },
      ];

      await act(async () => {
        const promise = result.current.startReplay(events);
        await vi.runAllTimersAsync();
        await promise;
      });

      expect(onReplayComplete).toHaveBeenCalledWith(2);
    });

    it('should set isReplaying to false when finished', async () => {
      const { result } = renderHook(() => useHistoryReplay({
        batchSize: 10,
        batchDelay: 10,
      }));
      
      const events: ReplayEvent[] = [
        { type: 'message', content: '1' },
      ];

      await act(async () => {
        const promise = result.current.startReplay(events);
        await vi.runAllTimersAsync();
        await promise;
      });

      expect(result.current.isReplaying).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle events with no processEvent callback', async () => {
      const { result } = renderHook(() => useHistoryReplay({
        // No processEvent callback
        batchSize: 10,
        batchDelay: 10,
      }));
      
      const events: ReplayEvent[] = [
        { type: 'message', content: '1' },
        { type: 'message', content: '2' },
      ];

      // Should not throw
      await act(async () => {
        const promise = result.current.startReplay(events);
        await vi.runAllTimersAsync();
        await promise;
      });

      expect(result.current.isReplaying).toBe(false);
      expect(result.current.replayProgress.percent).toBe(100);
    });

    it('should handle large batches', async () => {
      const processEvent = vi.fn();
      const { result } = renderHook(() => useHistoryReplay({
        processEvent,
        batchSize: 100,
        batchDelay: 10,
      }));
      
      // Create 500 events
      const events: ReplayEvent[] = Array.from({ length: 500 }, (_, i) => ({
        type: 'message',
        content: `message-${i}`,
      }));

      await act(async () => {
        const promise = result.current.startReplay(events);
        await vi.runAllTimersAsync();
        await promise;
      });

      expect(processEvent).toHaveBeenCalledTimes(500);
      expect(result.current.replayProgress.percent).toBe(100);
    });

    it('should handle events with varying structures', async () => {
      const processedEvents: ReplayEvent[] = [];
      const { result } = renderHook(() => useHistoryReplay({
        processEvent: (e) => processedEvents.push(e),
        batchSize: 10,
        batchDelay: 10,
      }));
      
      const events: ReplayEvent[] = [
        { type: 'message', content: 'simple' },
        { type: 'tool_execution', toolName: 'bash', args: { cmd: 'ls' } },
        { type: 'thinking', thinking: 'Let me think...', tokens: 100 },
        { type: 'nested', data: { deep: { nested: { value: 42 } } } },
      ];

      await act(async () => {
        const promise = result.current.startReplay(events);
        await vi.runAllTimersAsync();
        await promise;
      });

      expect(processedEvents).toHaveLength(4);
      expect(processedEvents[1]).toEqual({
        type: 'tool_execution',
        toolName: 'bash',
        args: { cmd: 'ls' },
      });
    });
  });
});

describe('HistoryReplayManager', () => {
  let manager: HistoryReplayManager;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    manager?.destroy();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('should initialize with isReplaying false', () => {
      manager = new HistoryReplayManager();
      expect(manager.getIsReplaying()).toBe(false);
    });

    it('should initialize with zero progress', () => {
      manager = new HistoryReplayManager();
      expect(manager.getProgress()).toEqual({
        total: 0,
        current: 0,
        percent: 0,
      });
    });
  });

  describe('startReplay', () => {
    it('should process events and update progress', async () => {
      const processedEvents: ReplayEvent[] = [];
      manager = new HistoryReplayManager({
        processEvent: (e) => processedEvents.push(e),
        batchSize: 10,
        batchDelay: 10,
      });

      const events: ReplayEvent[] = [
        { type: 'message', content: '1' },
        { type: 'message', content: '2' },
      ];

      const promise = manager.startReplay(events);
      await vi.runAllTimersAsync();
      await promise;

      expect(processedEvents).toHaveLength(2);
      expect(manager.getProgress().percent).toBe(100);
    });

    it('should call onReplayStart callback', async () => {
      const onReplayStart = vi.fn();
      manager = new HistoryReplayManager({ onReplayStart });

      const events: ReplayEvent[] = [{ type: 'message', content: 'test' }];
      
      const promise = manager.startReplay(events);
      await vi.runAllTimersAsync();
      await promise;

      expect(onReplayStart).toHaveBeenCalledWith(1);
    });

    it('should call onReplayComplete callback', async () => {
      const onReplayComplete = vi.fn();
      manager = new HistoryReplayManager({
        onReplayComplete,
        batchSize: 10,
        batchDelay: 10,
      });

      const events: ReplayEvent[] = [
        { type: 'message', content: '1' },
        { type: 'message', content: '2' },
      ];
      
      const promise = manager.startReplay(events);
      await vi.runAllTimersAsync();
      await promise;

      expect(onReplayComplete).toHaveBeenCalledWith(2);
    });
  });

  describe('buffering', () => {
    it('should buffer events during replay', async () => {
      manager = new HistoryReplayManager({
        batchSize: 1,
        batchDelay: 50,
      });

      const events: ReplayEvent[] = [
        { type: 'message', content: '1' },
        { type: 'message', content: '2' },
      ];

      const promise = manager.startReplay(events);
      
      // Buffer events during replay
      expect(manager.bufferEvent({ type: 'live', content: '1' })).toBe(true);
      expect(manager.bufferEvent({ type: 'live', content: '2' })).toBe(true);
      expect(manager.getBufferSize()).toBe(2);

      await vi.runAllTimersAsync();
      await promise;
    });

    it('should not buffer events when not replaying', () => {
      manager = new HistoryReplayManager();
      
      expect(manager.bufferEvent({ type: 'live', content: '1' })).toBe(false);
      expect(manager.getBufferSize()).toBe(0);
    });

    it('should flush buffer and return events', async () => {
      manager = new HistoryReplayManager({
        batchSize: 1,
        batchDelay: 50,
      });

      const events: ReplayEvent[] = [{ type: 'message', content: '1' }];
      
      const promise = manager.startReplay(events);
      
      manager.bufferEvent({ type: 'live', content: 'buffered' });
      
      await vi.runAllTimersAsync();
      await promise;

      const flushed = manager.flushBuffer();
      expect(flushed).toHaveLength(1);
      expect(flushed[0]).toEqual({ type: 'live', content: 'buffered' });
      expect(manager.getBufferSize()).toBe(0);
    });

    it('should clear buffer', async () => {
      manager = new HistoryReplayManager({
        batchSize: 1,
        batchDelay: 50,
      });

      const events: ReplayEvent[] = [{ type: 'message', content: '1' }];
      
      manager.startReplay(events);
      manager.bufferEvent({ type: 'live', content: 'test' });
      expect(manager.getBufferSize()).toBe(1);
      
      manager.clearBuffer();
      expect(manager.getBufferSize()).toBe(0);

      await vi.runAllTimersAsync();
    });
  });

  describe('cancelReplay', () => {
    it('should cancel ongoing replay', async () => {
      const processEvent = vi.fn();
      manager = new HistoryReplayManager({
        processEvent,
        batchSize: 1,
        batchDelay: 50,
      });

      const events: ReplayEvent[] = [
        { type: 'message', content: '1' },
        { type: 'message', content: '2' },
        { type: 'message', content: '3' },
      ];

      manager.startReplay(events);
      
      await vi.advanceTimersByTimeAsync(10);
      
      manager.cancelReplay();
      
      expect(manager.getIsReplaying()).toBe(false);
      expect(manager.getProgress()).toEqual({
        total: 0,
        current: 0,
        percent: 0,
      });

      await vi.runAllTimersAsync();
    });
  });

  describe('batch processing', () => {
    it('should process events in batches', async () => {
      const processEvent = vi.fn();
      manager = new HistoryReplayManager({
        processEvent,
        batchSize: 3,
        batchDelay: 10,
      });

      const events: ReplayEvent[] = [
        { type: 'message', content: '1' },
        { type: 'message', content: '2' },
        { type: 'message', content: '3' },
        { type: 'message', content: '4' },
        { type: 'message', content: '5' },
      ];

      manager.startReplay(events);
      
      // Process first batch
      await vi.advanceTimersByTimeAsync(15);
      expect(processEvent).toHaveBeenCalledTimes(3);
      
      // Complete remaining batches
      await vi.runAllTimersAsync();
      
      expect(processEvent).toHaveBeenCalledTimes(5);
    });

    it('should respect batchDelay between batches', async () => {
      const processEvent = vi.fn();
      manager = new HistoryReplayManager({
        processEvent,
        batchSize: 2,
        batchDelay: 100,
      });

      const events: ReplayEvent[] = [
        { type: 'message', content: '1' },
        { type: 'message', content: '2' },
        { type: 'message', content: '3' },
        { type: 'message', content: '4' },
      ];

      manager.startReplay(events);
      
      // After first batch + small delay
      await vi.advanceTimersByTimeAsync(50);
      expect(processEvent).toHaveBeenCalledTimes(2);
      
      // After batch delay
      await vi.advanceTimersByTimeAsync(100);
      expect(processEvent).toHaveBeenCalledTimes(4);
    });
  });

  describe('progress tracking', () => {
    it('should update progress as events are processed', async () => {
      manager = new HistoryReplayManager({
        batchSize: 2,
        batchDelay: 10,
      });

      const events: ReplayEvent[] = [
        { type: 'message', content: '1' },
        { type: 'message', content: '2' },
        { type: 'message', content: '3' },
        { type: 'message', content: '4' },
      ];

      manager.startReplay(events);
      
      await vi.advanceTimersByTimeAsync(15);
      const progress = manager.getProgress();
      expect(progress.current).toBeGreaterThan(0);
      expect(progress.percent).toBeGreaterThan(0);
      
      await vi.runAllTimersAsync();
      
      expect(manager.getProgress().percent).toBe(100);
    });
  });

  describe('destroy', () => {
    it('should cleanup resources', async () => {
      manager = new HistoryReplayManager({
        batchSize: 1,
        batchDelay: 50,
      });

      const events: ReplayEvent[] = [{ type: 'message', content: '1' }];
      
      manager.startReplay(events);
      manager.bufferEvent({ type: 'live', content: 'buffered' });
      
      manager.destroy();
      
      expect(manager.getBufferSize()).toBe(0);
      expect(manager.getIsReplaying()).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle empty events array', async () => {
      const onReplayComplete = vi.fn();
      manager = new HistoryReplayManager({ onReplayComplete });

      await manager.startReplay([]);
      
      expect(manager.getIsReplaying()).toBe(false);
      expect(manager.getProgress().percent).toBe(100);
      expect(onReplayComplete).toHaveBeenCalledWith(0);
    });

    it('should not start if already replaying', async () => {
      const onReplayStart = vi.fn();
      manager = new HistoryReplayManager({ 
        onReplayStart,
        batchSize: 1,
        batchDelay: 100,
      });

      const events1: ReplayEvent[] = [{ type: 'message', content: '1' }];
      const events2: ReplayEvent[] = [{ type: 'message', content: '2' }];

      manager.startReplay(events1);
      await vi.advanceTimersByTimeAsync(10);
      
      manager.startReplay(events2);
      
      await vi.runAllTimersAsync();

      expect(onReplayStart).toHaveBeenCalledTimes(1);
    });

    it('should handle events with no processEvent callback', async () => {
      manager = new HistoryReplayManager({
        // No processEvent callback
        batchSize: 10,
        batchDelay: 10,
      });

      const events: ReplayEvent[] = [
        { type: 'message', content: '1' },
        { type: 'message', content: '2' },
      ];

      await manager.startReplay(events);
      await vi.runAllTimersAsync();

      expect(manager.getIsReplaying()).toBe(false);
      expect(manager.getProgress().percent).toBe(100);
    });

    it('should handle large batches', async () => {
      const processEvent = vi.fn();
      manager = new HistoryReplayManager({
        processEvent,
        batchSize: 100,
        batchDelay: 10,
      });

      const events: ReplayEvent[] = Array.from({ length: 500 }, (_, i) => ({
        type: 'message',
        content: `message-${i}`,
      }));

      await manager.startReplay(events);
      await vi.runAllTimersAsync();

      expect(processEvent).toHaveBeenCalledTimes(500);
      expect(manager.getProgress().percent).toBe(100);
    });
  });
});

describe('setupReplayIntegration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('should set up event listeners on client', () => {
    const eventHandlers = new Map<string, (params: unknown) => void>();
    const mockClient = {
      on: vi.fn((event: string, handler: (params: unknown) => void) => {
        eventHandlers.set(event, handler);
        return () => eventHandlers.delete(event);
      }),
    };

    const manager = new HistoryReplayManager();
    const processEvent = vi.fn();

    const cleanup = setupReplayIntegration(mockClient, manager, processEvent);

    // Should have registered for replay events
    expect(mockClient.on).toHaveBeenCalledWith('replay_start', expect.any(Function));
    expect(mockClient.on).toHaveBeenCalledWith('replay_event', expect.any(Function));
    expect(mockClient.on).toHaveBeenCalledWith('replay_complete', expect.any(Function));

    cleanup();
    manager.destroy();
  });

  it('should handle replay_start event', async () => {
    const eventHandlers = new Map<string, (params: unknown) => void>();
    const mockClient = {
      on: vi.fn((event: string, handler: (params: unknown) => void) => {
        eventHandlers.set(event, handler);
        return () => eventHandlers.delete(event);
      }),
    };

    const processedEvents: ReplayEvent[] = [];
    const manager = new HistoryReplayManager({
      processEvent: (e) => processedEvents.push(e),
      batchSize: 10,
      batchDelay: 10,
    });
    const processEvent = vi.fn((e) => processedEvents.push(e));

    setupReplayIntegration(mockClient, manager, processEvent);

    // Simulate replay_start
    const replayStartHandler = eventHandlers.get('replay_start');
    expect(replayStartHandler).toBeDefined();
    
    replayStartHandler!({
      events: [
        { type: 'message', content: '1' },
        { type: 'message', content: '2' },
      ],
    });

    await vi.runAllTimersAsync();

    expect(manager.getProgress().total).toBe(2);
    // Both manager.processEvent and integration processEvent are called
    expect(processedEvents.length).toBeGreaterThanOrEqual(2);

    manager.destroy();
  });

  it('should handle replay_event by processing immediately', () => {
    const eventHandlers = new Map<string, (params: unknown) => void>();
    const mockClient = {
      on: vi.fn((event: string, handler: (params: unknown) => void) => {
        eventHandlers.set(event, handler);
        return () => eventHandlers.delete(event);
      }),
    };

    const manager = new HistoryReplayManager();
    const processEvent = vi.fn();

    setupReplayIntegration(mockClient, manager, processEvent);

    // Simulate replay_event
    const replayEventHandler = eventHandlers.get('replay_event');
    expect(replayEventHandler).toBeDefined();
    
    replayEventHandler!({ type: 'message', content: 'test' });

    expect(processEvent).toHaveBeenCalledWith({ type: 'message', content: 'test' });

    manager.destroy();
  });

  it('should handle replay_complete by flushing buffer', async () => {
    const eventHandlers = new Map<string, (params: unknown) => void>();
    const mockClient = {
      on: vi.fn((event: string, handler: (params: unknown) => void) => {
        eventHandlers.set(event, handler);
        return () => eventHandlers.delete(event);
      }),
    };

    const manager = new HistoryReplayManager({
      batchSize: 1,
      batchDelay: 50,
    });
    const processEvent = vi.fn();

    setupReplayIntegration(mockClient, manager, processEvent);

    // Start a replay and buffer events
    manager.startReplay([{ type: 'message', content: '1' }]);
    manager.bufferEvent({ type: 'live', content: 'buffered1' });
    manager.bufferEvent({ type: 'live', content: 'buffered2' });
    
    await vi.runAllTimersAsync();

    // Simulate replay_complete
    const replayCompleteHandler = eventHandlers.get('replay_complete');
    expect(replayCompleteHandler).toBeDefined();
    
    replayCompleteHandler!({});

    // Buffered events should be processed (check for the event data)
    expect(processEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'live', content: 'buffered1' })
    );
    expect(processEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'live', content: 'buffered2' })
    );
    
    // Buffer should be empty
    expect(manager.getBufferSize()).toBe(0);

    manager.destroy();
  });

  it('should return cleanup function that removes all listeners', () => {
    const unsubscribers: string[] = [];
    const mockClient = {
      on: vi.fn(() => {
        const id = `unsub-${unsubscribers.length}`;
        unsubscribers.push(id);
        return () => {
          const idx = unsubscribers.indexOf(id);
          if (idx >= 0) unsubscribers.splice(idx, 1);
        };
      }),
    };

    const manager = new HistoryReplayManager();
    const processEvent = vi.fn();

    const cleanup = setupReplayIntegration(mockClient, manager, processEvent);

    expect(unsubscribers.length).toBe(3); // 3 event listeners

    cleanup();

    expect(unsubscribers.length).toBe(0);

    manager.destroy();
  });
});
