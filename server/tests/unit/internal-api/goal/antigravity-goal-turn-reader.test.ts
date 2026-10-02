/**
 * Contract 1.58.3 — the antigravity turn reader the goal sweeper consumes.
 *
 * The sweeper classifies a completed turn as a provider-error strike from the
 * reader's truth (`status: 'error'` and the recorded `error`), never by
 * scanning response text. Fixture lines mirror the real H2s session
 * `cefdf34a-abf7-441f-b075-5af3d980c1b1` (2026-10-01, read-only), every turn of
 * which was finalized `status: "error"` with `INTERNAL (code 500)`,
 * `UNAVAILABLE (code 503)` or `timeout`.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The service reads config.antigravitySessionDir at module load; point it at an
// isolated temp dir and import the modules after the stub.
const sessionDir = await mkdtemp(path.join(tmpdir(), 'agy-goal-turn-reader-'));
const previousSessionDir = process.env.ANTIGRAVITY_SESSION_DIR;
process.env.ANTIGRAVITY_SESSION_DIR = sessionDir;
const { AntigravityService } = await import('../../../../src/antigravity/antigravity-service.js');

afterAll(async () => {
  if (previousSessionDir === undefined) delete process.env.ANTIGRAVITY_SESSION_DIR;
  else process.env.ANTIGRAVITY_SESSION_DIR = previousSessionDir;
  await rm(sessionDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
});

const service = new AntigravityService({ registryPath: path.join(sessionDir, 'registry.json') });

const H2S_500 = 'INTERNAL (code 500): Internal error encountered.';
const H2S_503 =
  'Our servers are experiencing high traffic right now, please try again in a minute. (UNAVAILABLE (code 503): No capacity available for model gemini-3.8-flash-high on the server)';

async function writeSession(sessionId: string, turns: Array<Record<string, unknown>>): Promise<void> {
  const lines = turns.map((turn) =>
    JSON.stringify({
      turnId: `turn-${sessionId}-${turn.timestamp}`,
      prompt: 'Continue working toward your active goal',
      response: '',
      model: 'gemini-3.8-flash-high',
      conversationId: 'ddd1bb30-439a-4b07-830f-03a73d4a5e94',
      status: 'done',
      turnDurationMs: 1000,
      tools: [],
      ...turn,
    }),
  );
  await writeFile(path.join(sessionDir, `${sessionId}.jsonl`), lines.join('\n') + '\n', 'utf8');
}

describe('getLastCompletedTurn — provider-error truth (contract 1.58.3)', () => {
  it('surfaces the recorded error of a finalized error turn (real H2s 500 shape)', async () => {
    await writeSession('s-error-500', [
      {
        timestamp: 1790878558562,
        status: 'error',
        response: H2S_500,
        error: H2S_500,
        agyStatus: 'ERROR',
        turnDurationMs: 61815,
      },
    ]);

    await expect(service.getLastCompletedTurn('s-error-500')).resolves.toEqual({
      completedAt: 1790878620377,
      response: H2S_500,
      status: 'error',
      error: H2S_500,
    });
  });

  it('surfaces the 503 capacity error and the timeout shape', async () => {
    await writeSession('s-error-503', [
      { timestamp: 1790879398633, status: 'error', response: H2S_503, error: H2S_503, agyStatus: 'ERROR', turnDurationMs: 14599 },
    ]);
    await writeSession('s-timeout', [
      { timestamp: 1790877955869, status: 'error', response: 'timeout', error: 'timeout', turnDurationMs: 600012 },
    ]);

    await expect(service.getLastCompletedTurn('s-error-503')).resolves.toMatchObject({
      response: H2S_503,
      status: 'error',
      error: H2S_503,
    });
    await expect(service.getLastCompletedTurn('s-timeout')).resolves.toMatchObject({
      response: 'timeout',
      status: 'error',
      error: 'timeout',
    });
  });

  it('reports a done turn as successful, with no error text', async () => {
    await writeSession('s-done', [
      { timestamp: 1000, status: 'done', response: 'Goal progress: still working.' },
    ]);

    await expect(service.getLastCompletedTurn('s-done')).resolves.toEqual({
      completedAt: 2000,
      response: 'Goal progress: still working.',
      status: 'done',
    });
  });

  it('treats a legacy turn without a status field as done (back-compat)', async () => {
    await writeSession('s-legacy', [
      { timestamp: 1000, response: 'Legacy reply', turnDurationMs: undefined },
    ]);

    await expect(service.getLastCompletedTurn('s-legacy')).resolves.toEqual({
      completedAt: 1000,
      response: 'Legacy reply',
      status: 'done',
    });
  });

  it('reads the LAST finalized turn, skips a trailing running turn, and keeps derived completion monotonic', async () => {
    await writeSession('s-mixed', [
      { timestamp: 1000, status: 'done', response: 'first', turnDurationMs: 500 },
      { timestamp: 1500, status: 'error', response: H2S_500, error: H2S_500, agyStatus: 'ERROR', turnDurationMs: 10 },
      { timestamp: 2000, status: 'running', response: '' },
    ]);

    await expect(service.getLastCompletedTurn('s-mixed')).resolves.toEqual({
      completedAt: 1510,
      response: H2S_500,
      status: 'error',
      error: H2S_500,
    });
  });

  it('answers null when no turn has finalized', async () => {
    await writeSession('s-running-only', [{ timestamp: 1000, status: 'running', response: '' }]);

    await expect(service.getLastCompletedTurn('s-running-only')).resolves.toBeNull();
    await expect(service.getLastCompletedTurn('s-missing-file')).resolves.toBeNull();
  });
});
