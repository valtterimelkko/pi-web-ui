import { describe, expect, it, vi } from 'vitest';
import { scenarioRegistry } from '../../../src/live-validation/scenarios.js';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import type { InternalApiClientLike, ValidationCapabilities } from '../../../src/live-validation/types.js';

function event(type: string, data: Record<string, unknown> = {}): NormalizedEvent {
  return { type, timestamp: 1, data } as NormalizedEvent;
}

describe('session-evidence live-validation scenario', () => {
  it('proves the endpoint resolves the created session by internal id and path alias', async () => {
    const evidence = {
      sessionId: 'canonical-id',
      runtime: 'pi',
      aliases: { internalId: 'canonical-id', path: '/tmp/pi-session.jsonl' },
      diagnostics: { processLocal: true, records: [] },
      warnings: ['diagnostics are process-local'],
    };
    const client = {
      createSession: vi.fn().mockResolvedValue({
        sessionId: 'canonical-id',
        sessionPath: '/tmp/pi-session.jsonl',
        runtime: 'pi',
        cwd: '/tmp/project',
        createdAt: '2026-07-18T12:00:00.000Z',
      }),
      promptStream: vi.fn().mockResolvedValue([
        event('agent_start'),
        event('message_end', { role: 'assistant', text: 'EVIDENCE-LIVE-OK' }),
        event('agent_end'),
      ]),
      getSessionEvidence: vi.fn().mockResolvedValue(evidence),
      getSessionInfo: vi.fn().mockResolvedValue({
        sessionId: 'canonical-id',
        runtime: 'pi',
        status: 'idle',
        executionInstanceId: 'pi-local-default',
        model: 'test/model',
        cwd: '/tmp/project',
        messageCount: 1,
        firstMessage: '',
        sessionPath: '/tmp/pi-session.jsonl',
        createdAt: '2026-07-18T12:00:00.000Z',
        lastActivity: '2026-07-18T12:00:01.000Z',
      }),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as InternalApiClientLike;

    const scenario = scenarioRegistry['session-evidence'];
    expect(scenario).toBeDefined();
    const result = await scenario.run({
      client,
      runtime: 'pi',
      cwd: '/tmp/project',
      capabilities: { runtimes: { pi: {} } } as unknown as ValidationCapabilities,
    });

    expect(result.passed).toBe(true);
    expect(client.getSessionEvidence).toHaveBeenNthCalledWith(1, 'canonical-id');
    expect(client.getSessionEvidence).toHaveBeenNthCalledWith(2, '/tmp/pi-session.jsonl');
    expect(result.assertions).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'canonical_id', passed: true }),
      expect.objectContaining({ name: 'path_alias', passed: true }),
      expect.objectContaining({ name: 'process_local_label', passed: true }),
    ]));
  });
});
