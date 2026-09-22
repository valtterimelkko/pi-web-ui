/**
 * The live voice lane's worker source, as the WIRING uses it.
 *
 * The lane's brief is produced by a ~12-line closure in `connection.ts`. That
 * closure is where the 2026-09-18 field report was decided and it had no test:
 * the composition beneath it (registry → disk → policy) was covered, but the
 * mapping in between — which snapshot fields become the lane's brief, and which
 * runtime they are read as — was only visible by reading the code. After an
 * operator report that the talker "does not have access to the session", the last
 * unproven link should be the one thing that IS tested.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TalkerSessionRegistry } from '../../../src/talker/session-registry.js';
import { WORKER_BRIEF_SOURCE_TAIL, createWorkerBriefSource } from '../../../src/websocket/worker-brief-source.js';

function sessionFile(lines: Array<[string, string]>): string {
  const dir = mkdtempSync(join(tmpdir(), 'brief-source-'));
  const path = join(dir, 'session.jsonl');
  writeFileSync(
    path,
    lines
      .map(([role, text]) =>
        JSON.stringify({ type: 'message', message: { role, content: [{ type: 'text', text }], timestamp: 1 } })
      )
      .join('\n') + '\n'
  );
  return path;
}

/** A registry whose worker session exists on disk but is NOT loaded in memory. */
function unloadedHarness(sessionPath: string | null) {
  return new TalkerSessionRegistry({
    multiSessionManager: {
      getSessionStatus: () => ({ status: 'idle', messageCount: 2 }),
      getAgentSession: () => undefined,
    } as never,
    deliveries: undefined as never,
    resolveWorkerSession: async () => (sessionPath ? { path: sessionPath, cwd: '/root/si' } : undefined),
  });
}

describe('createWorkerBriefSource', () => {
  it('hands the lane the on-disk conversation of a session this server is NOT holding in memory', async () => {
    // The exact field: the operator's worker session was idle on disk while the
    // lane was told nothing about it.
    const path = sessionFile([
      ['user', 'build the workshop decks'],
      ['assistant', 'Draft 1 is ready for your review'],
    ]);
    const source = createWorkerBriefSource({ talkerSessionRegistry: unloadedHarness(path) });

    const brief = await source('01a0a575-7d40-7494-847d-2f42042c7759', 'pi');

    expect(brief.activity).toBe('worker status: idle');
    expect(brief.entries?.map((entry) => entry.text)).toEqual([
      'build the workshop decks',
      'Draft 1 is ready for your review',
    ]);
    expect(brief.total).toBe(2);
  });

  it('reads the LANE runtime and the deeper source tail, not the relay window', async () => {
    const calls: Array<{ id: string; runtime: string; historyTail?: number }> = [];
    const source = createWorkerBriefSource({
      talkerSessionRegistry: {
        workerStateSnapshot: async (id: string, runtime: string, options?: { historyTail?: number }) => {
          calls.push({ id, runtime, historyTail: options?.historyTail });
          return { activity: 'worker status: busy' };
        },
      } as never,
    });

    await source('worker-1', 'pi');
    // A Claude (or Antigravity) lane must be read as itself, not as pi: reading
    // a Claude session as pi is the 2026-09-22 "cannot access the work session".
    await source('worker-1', 'claude');

    expect(calls).toEqual([
      { id: 'worker-1', runtime: 'pi', historyTail: WORKER_BRIEF_SOURCE_TAIL },
      { id: 'worker-1', runtime: 'claude', historyTail: WORKER_BRIEF_SOURCE_TAIL },
    ]);
    expect(WORKER_BRIEF_SOURCE_TAIL).toBeGreaterThan(200);
  });

  it('carries the count with the entries, so the lane can disclose what it is not showing', async () => {
    const source = createWorkerBriefSource({
      talkerSessionRegistry: {
        workerStateSnapshot: async () => ({
          activity: 'worker status: idle',
          recentHistory: [{ role: 'assistant', text: 'the last thing said' }],
          historyTotal: 540,
        }),
      } as never,
    });

    const brief = await source('worker-2', 'pi');

    expect(brief.entries).toHaveLength(1);
    expect(brief.total).toBe(540);
  });

  it('adds no entries key when there is no conversation, so the mount cannot read an empty one as a session', async () => {
    // The shape matters: `entries: []` and "no entries" are different claims. The
    // mount injects a brief only when it holds lines, and reports
    // `worker_brief_empty` otherwise — which is how this defect is now visible.
    const source = createWorkerBriefSource({
      talkerSessionRegistry: { workerStateSnapshot: async () => ({ activity: 'worker status: idle' }) } as never,
    });

    const brief = await source('worker-3', 'pi');

    expect(brief).toEqual({ activity: 'worker status: idle' });
    expect('entries' in brief).toBe(false);
  });

  it('never invents a brief for a session this server cannot resolve at all', async () => {
    const source = createWorkerBriefSource({ talkerSessionRegistry: unloadedHarness(null) });

    const brief = await source('unknown-session', 'pi');

    expect(brief).toEqual({ activity: 'worker status: idle' });
  });

  it('lets a registry failure surface, so the mount can record worker_brief_unavailable', async () => {
    // Swallowing it here would hide the failure one layer below the evidence that
    // is supposed to record it.
    const source = createWorkerBriefSource({
      talkerSessionRegistry: {
        workerStateSnapshot: vi.fn(async () => {
          throw new Error('registry is down');
        }),
      } as never,
    });

    await expect(source('worker-4', 'pi')).rejects.toThrow('registry is down');
  });
});
