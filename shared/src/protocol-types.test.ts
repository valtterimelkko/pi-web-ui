import { describe, it, expect } from 'vitest';
import type { WorkerStatus, WorkerOptions, WorkerInfo, InternalCommand, NormalizedEvent } from '../src/protocol-types.js';

describe('protocol-types', () => {
  it('should define valid worker statuses', () => {
    const statuses: WorkerStatus[] = ['spawning', 'ready', 'streaming', 'idle', 'terminated', 'error'];
    expect(statuses).toHaveLength(6);
  });

  it('should define worker options', () => {
    const options: WorkerOptions = {
      sessionPath: '/tmp/test.jsonl',
      model: 'claude-3-sonnet',
      thinkingLevel: 'medium',
      maxOldSpaceSize: 512,
    };
    expect(options.sessionPath).toBe('/tmp/test.jsonl');
  });

  it('should define internal commands', () => {
    const promptCmd: InternalCommand = { type: 'prompt', message: 'Hello' };
    const steerCmd: InternalCommand = { type: 'steer', message: 'Continue' };
    const abortCmd: InternalCommand = { type: 'abort' };
    
    expect(promptCmd.type).toBe('prompt');
    expect(steerCmd.type).toBe('steer');
    expect(abortCmd.type).toBe('abort');
  });

  it('should define normalized events', () => {
    const event: NormalizedEvent = {
      type: 'message_start',
      sessionId: 'test-session',
      timestamp: Date.now(),
      data: { id: 'msg-1', role: 'assistant' },
    };
    expect(event.type).toBe('message_start');
  });
});
