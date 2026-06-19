/**
 * Tests for OpenCode goal-engine integration in OpenCodeService.
 * Verifies that goal state files are read and widget/status events are emitted
 * after agent_end, and that goal is paused on abort.
 */
import { describe, it, expect, beforeEach, beforeAll, afterEach, afterAll, vi } from 'vitest';
import { OpenCodeService } from '../../../src/opencode/opencode-service.js';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeOcSession(id = 'oc-sess-goal-1') {
  return {
    id,
    slug: 'test',
    version: '1',
    projectID: 'proj',
    directory: '/tmp',
    title: 'Goal Test',
    time: { created: Date.now(), updated: Date.now() },
  };
}

/** URL-based fetch mock: returns providers for /config/providers, session for /session, ok for everything else. */
function mockFetchForSession(ocSessionId: string): void {
  mockFetch.mockImplementation((url: string) => {
    if ((url as string).includes('/config/providers')) {
      return Promise.resolve(jsonResponse({ providers: [] }));
    }
    if ((url as string).includes('/session')) {
      return Promise.resolve(jsonResponse(makeOcSession(ocSessionId)));
    }
    // health checks and other calls
    return Promise.resolve(jsonResponse({ ok: true }));
  });
}

const GOAL_DIR = path.join(os.homedir(), '.opencode', 'goal-engine');

async function writeGoalFile(ocSessionId: string, data: object): Promise<void> {
  await fs.mkdir(GOAL_DIR, { recursive: true });
  await fs.writeFile(
    path.join(GOAL_DIR, `${ocSessionId}.goal.json`),
    JSON.stringify(data),
    'utf-8',
  );
}

async function readGoalFile(ocSessionId: string): Promise<object | null> {
  try {
    const raw = await fs.readFile(path.join(GOAL_DIR, `${ocSessionId}.goal.json`), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function removeGoalFile(ocSessionId: string): Promise<void> {
  try {
    await fs.unlink(path.join(GOAL_DIR, `${ocSessionId}.goal.json`));
  } catch { /* already gone */ }
}

describe('OpenCodeService — goal engine events', () => {
  let tmpDir: string;
  const ocSessionId = 'oc-goal-test-session-abc123';

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-goal-test-'));
  });

  beforeEach(async () => {
    mockFetch.mockReset();
    await removeGoalFile(ocSessionId);
  });

  afterEach(async () => {
    await removeGoalFile(ocSessionId);
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('getGoalEngineEvents returns empty array when no goal file exists', async () => {
    const svc = new OpenCodeService({ registryPath: path.join(tmpDir, 'r1.json') });
    const events = await svc.getGoalEngineEvents('unknown-session-id');
    expect(events).toEqual([]);
    await svc.shutdown().catch(() => {});
  });

  it('getGoalEngineEvents returns extension_status and widget_content for running goal', async () => {
    await writeGoalFile(ocSessionId, {
      objective: 'Refactor the auth module',
      status: 'running',
      turnCount: 3,
      startedAt: Date.now(),
      completedAt: null,
      planItems: ['Plan step 1', 'Plan step 2'],
      planDone: [true, false],
      maxTurns: 100,
      progressCurrent: null,
      progressTotal: null,
      progressLabel: null,
      consecutiveErrors: 0,
      lastErrorMessage: null,
      lastErrorAt: null,
      compactionCount: 0,
      lastCompactedAt: null,
      verifyCommand: null,
    });

    const svc = new OpenCodeService({ registryPath: path.join(tmpDir, 'r2.json') });
    mockFetchForSession(ocSessionId);
    const { sessionId } = await svc.createSession('/tmp');

    const events = await svc.getGoalEngineEvents(sessionId);

    expect(events.length).toBeGreaterThanOrEqual(2);

    const statusEvent = events.find(e => e.type === 'extension_status');
    expect(statusEvent).toBeDefined();
    const statusData = statusEvent!.data as Record<string, unknown>;
    expect((statusData.status as Record<string, unknown>).key).toBe('goal-engine');
    expect((statusData.status as Record<string, unknown>).text).toContain('Running');

    const widgetEvent = events.find(e => e.type === 'widget_content');
    expect(widgetEvent).toBeDefined();
    const widgetData = widgetEvent!.data as Record<string, unknown>;
    expect(widgetData.key).toBe('goal-engine-status');
    expect(Array.isArray(widgetData.content)).toBe(true);
    const lines = widgetData.content as string[];
    expect(lines.some(l => l.includes('Refactor the auth module'))).toBe(true);
    expect(lines.some(l => l.includes('Plan step 1'))).toBe(true);

    await svc.shutdown().catch(() => {});
  });

  it('getGoalEngineEvents returns widget_cleared for idle/completed goal', async () => {
    await writeGoalFile(ocSessionId, {
      objective: 'Done goal',
      status: 'idle',
      turnCount: 5,
      startedAt: Date.now() - 10000,
      completedAt: Date.now(),
      planItems: [],
      planDone: [],
      maxTurns: 100,
      progressCurrent: null,
      progressTotal: null,
      progressLabel: null,
      consecutiveErrors: 0,
      lastErrorMessage: null,
      lastErrorAt: null,
      compactionCount: 0,
      lastCompactedAt: null,
      verifyCommand: null,
    });

    const svc = new OpenCodeService({ registryPath: path.join(tmpDir, 'r3.json') });
    mockFetchForSession(ocSessionId);
    const { sessionId } = await svc.createSession('/tmp');

    const events = await svc.getGoalEngineEvents(sessionId);

    const cleared = events.find(e => e.type === 'widget_cleared');
    expect(cleared).toBeDefined();

    await svc.shutdown().catch(() => {});
  });

  it('notifies API observers for OpenCode events that are not tied to an Internal API prompt callback', async () => {
    const svc = new OpenCodeService({ registryPath: path.join(tmpDir, 'r-observer.json') });
    mockFetchForSession(ocSessionId);
    const { sessionId } = await svc.createSession('/tmp');

    const seen: NormalizedEvent[] = [];
    const observer = (event: NormalizedEvent) => seen.push(event);
    svc.addApiObserver(sessionId, observer);

    await (svc as unknown as {
      forwardSSEToSession: (event: { type: string; properties?: Record<string, unknown> }, sessionId: string) => Promise<void>;
    }).forwardSSEToSession({ type: 'session.compacted', properties: { sessionID: ocSessionId } }, sessionId);

    expect(seen.some(e => e.type === 'session_compaction')).toBe(true);

    svc.removeApiObserver(sessionId, observer);
    await svc.shutdown().catch(() => {});
  });

  const runningGoalFixture = {
    objective: 'Keep going',
    status: 'running',
    turnCount: 2,
    startedAt: Date.now(),
    completedAt: null,
    planItems: [],
    planDone: [],
    maxTurns: 100,
    progressCurrent: null,
    progressTotal: null,
    progressLabel: null,
    consecutiveErrors: 0,
    lastErrorMessage: null,
    lastErrorAt: null,
    compactionCount: 0,
    lastCompactedAt: null,
    verifyCommand: null,
  };

  it('pauseGoal sets the goal state file to paused', async () => {
    await writeGoalFile(ocSessionId, runningGoalFixture);
    const svc = new OpenCodeService({ registryPath: path.join(tmpDir, 'r-pause.json') });
    mockFetchForSession(ocSessionId);
    const { sessionId } = await svc.createSession('/tmp');

    const result = await svc.pauseGoal(sessionId);
    expect(result?.status).toBe('paused');
    const updated = await readGoalFile(ocSessionId) as Record<string, unknown>;
    expect(updated.status).toBe('paused');

    await svc.shutdown().catch(() => {});
  });

  it('pauseGoal returns null when there is no active goal', async () => {
    const svc = new OpenCodeService({ registryPath: path.join(tmpDir, 'r-pause-none.json') });
    mockFetchForSession(ocSessionId);
    const { sessionId } = await svc.createSession('/tmp');
    expect(await svc.pauseGoal(sessionId)).toBeNull();
    await svc.shutdown().catch(() => {});
  });

  it('resumeGoal flips a paused goal back to running', async () => {
    await writeGoalFile(ocSessionId, { ...runningGoalFixture, status: 'paused' });
    const svc = new OpenCodeService({ registryPath: path.join(tmpDir, 'r-resume.json') });
    mockFetchForSession(ocSessionId);
    const { sessionId } = await svc.createSession('/tmp');

    const result = await svc.resumeGoal(sessionId);
    expect(result?.status).toBe('running');
    const updated = await readGoalFile(ocSessionId) as Record<string, unknown>;
    expect(updated.status).toBe('running');

    await svc.shutdown().catch(() => {});
  });

  it('resumeGoal returns null when the goal is not paused', async () => {
    await writeGoalFile(ocSessionId, runningGoalFixture);
    const svc = new OpenCodeService({ registryPath: path.join(tmpDir, 'r-resume-running.json') });
    mockFetchForSession(ocSessionId);
    const { sessionId } = await svc.createSession('/tmp');
    expect(await svc.resumeGoal(sessionId)).toBeNull();
    await svc.shutdown().catch(() => {});
  });

  it('clearGoal removes the goal state file', async () => {
    await writeGoalFile(ocSessionId, runningGoalFixture);
    const svc = new OpenCodeService({ registryPath: path.join(tmpDir, 'r-clear.json') });
    mockFetchForSession(ocSessionId);
    const { sessionId } = await svc.createSession('/tmp');

    const cleared = await svc.clearGoal(sessionId);
    expect(cleared).toBe(true);
    // Allow the async abort path (if any) to settle, then confirm the file is gone.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(await readGoalFile(ocSessionId)).toBeNull();

    await svc.shutdown().catch(() => {});
  });

  it('abort pauses an active goal state file', async () => {
    const runningGoal = {
      objective: 'Keep going',
      status: 'running',
      turnCount: 2,
      startedAt: Date.now(),
      completedAt: null,
      planItems: [],
      planDone: [],
      maxTurns: 100,
      progressCurrent: null,
      progressTotal: null,
      progressLabel: null,
      consecutiveErrors: 0,
      lastErrorMessage: null,
      lastErrorAt: null,
      compactionCount: 0,
      lastCompactedAt: null,
      verifyCommand: null,
    };
    await writeGoalFile(ocSessionId, runningGoal);

    const svc = new OpenCodeService({ registryPath: path.join(tmpDir, 'r4.json') });
    mockFetchForSession(ocSessionId);
    const { sessionId } = await svc.createSession('/tmp');

    // After createSession, set mock back to simple ok for the abort DELETE call
    mockFetch.mockResolvedValue(jsonResponse({ ok: true }));

    svc.abort(sessionId);

    // Allow the async abort logic to execute
    await new Promise(resolve => setTimeout(resolve, 150));

    const updated = await readGoalFile(ocSessionId) as Record<string, unknown> | null;
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('paused');

    await svc.shutdown().catch(() => {});
  });
});
