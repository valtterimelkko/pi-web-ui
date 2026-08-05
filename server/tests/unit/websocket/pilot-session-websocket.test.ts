import { describe, expect, it, vi } from 'vitest';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import type { PilotExecutorAdapter } from '../../../src/workers/pilot-executor-adapter.js';
import { PilotSessionWebSocketAdapter } from '../../../src/websocket/pilot-session-websocket.js';

const receipt = { status: 'completed', runId: 'run-1' };

describe('PilotSessionWebSocketAdapter', () => {
  it('projects the pilot normalized stream into session_event envelopes exactly once', async () => {
    const enqueue = vi.fn(async (input: { onEvent?: (event: NormalizedEvent) => void }) => {
      input.onEvent?.({ type: 'agent_start', sessionId: 'session-1', timestamp: 1, data: {} });
      input.onEvent?.({ type: 'agent_end', sessionId: 'session-1', timestamp: 2, data: {} });
      return receipt;
    });
    const send = vi.fn();
    const notificationSink = vi.fn();
    const adapter = new PilotSessionWebSocketAdapter({
      executor: { enqueue } as unknown as PilotExecutorAdapter,
      clientId: 'client-1',
      send,
      notificationSink,
    });

    const result = await adapter.prompt({
      sessionId: 'session-1', sessionPath: '/tmp/session-1.jsonl', message: 'normal-turn',
    });

    expect(result).toBe(receipt);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(2, 'client-1', expect.objectContaining({
      type: 'session_event', sessionId: 'session-1', event: expect.objectContaining({ type: 'agent_end' }),
    }));
    expect(notificationSink).toHaveBeenCalledTimes(2);
    expect(adapter.activeProjectionCount).toBe(0);
  });

  it('routes abort through receipt-aware pilot cancellation', async () => {
    const cancel = vi.fn(async () => receipt);
    const adapter = new PilotSessionWebSocketAdapter({
      executor: { cancel } as unknown as PilotExecutorAdapter,
      clientId: 'client-1',
      send: vi.fn(),
    });
    await adapter.abort('session-1', 'browser-abort');
    expect(cancel).toHaveBeenCalledWith('session-1', 'browser-abort');
  });
});
