import { describe, expect, it, vi } from 'vitest';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import { measureAndSlim } from '../../../src/internal-api/event-payload-budget.js';

function event(type: string, data: Record<string, unknown>): NormalizedEvent {
  return { type, timestamp: 1, data };
}

describe('measureAndSlim', () => {
  it('deep-truncates an oversized tool result while retaining its event shape and marker', () => {
    const original = event('tool_execution_end', {
      toolCallId: 'call-1',
      toolName: 'bash',
      result: { output: 'x'.repeat(100_000), exitCode: 0 },
    });

    const measured = measureAndSlim(original, 32 * 1024);
    const data = measured.event.data as {
      toolCallId: string;
      result: { output: string; exitCode: number };
      payloadTruncated: { originalBytes: number; budgetBytes: number };
    };

    expect(measured.bytes).toBeLessThanOrEqual(32 * 1024);
    expect(data.toolCallId).toBe('call-1');
    expect(data.result.exitCode).toBe(0);
    expect(data.result.output).toMatch(/…\[truncated\]$/);
    expect(data.payloadTruncated).toEqual({
      originalBytes: measured.originalBytes,
      budgetBytes: 32 * 1024,
    });
  });

  it('does not materialize the original JSON before slimming an oversized message update', () => {
    const original = event('message_update', {
      message: {
        id: 'm1',
        role: 'assistant',
        content: [{ type: 'text', text: 'x"\\\n😀'.repeat(500_000) }],
      },
      assistantMessageEvent: { type: 'text_delta', delta: 'ok' },
    });
    const expectedOriginalBytes = Buffer.byteLength(JSON.stringify(original));
    const stringify = vi.spyOn(JSON, 'stringify');

    try {
      const measured = measureAndSlim(original, 32 * 1024);
      expect(measured.originalBytes).toBe(expectedOriginalBytes);
      expect(stringify).toHaveBeenCalledTimes(1);
      expect(stringify.mock.calls[0]?.[0]).not.toBe(original);
    } finally {
      stringify.mockRestore();
    }
  });

  it('passes a small event through byte-identical', () => {
    const original = event('agent_end', { reason: 'complete' });
    const measured = measureAndSlim(original, 1024);

    expect(measured.event).toBe(original);
    expect(measured.serialized).toBe(JSON.stringify(original));
    expect(measured.truncated).toBe(false);
  });

  it('allows zero to disable the payload budget', () => {
    const original = event('tool_execution_end', { result: 'x'.repeat(10_000) });
    const measured = measureAndSlim(original, 0);

    expect(measured.event).toBe(original);
    expect(measured.truncated).toBe(false);
    expect(measured.bytes).toBeGreaterThan(10_000);
  });
});
