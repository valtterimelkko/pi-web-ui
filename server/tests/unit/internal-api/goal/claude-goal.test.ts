/**
 * Cross-runtime goal function (contract 1.27.0) — Claude transcript reader tests.
 *
 * Claude Code persists goals as `goal_status` attachments inside the session
 * transcript JSONL (`~/.claude/projects/<encoded-cwd>/<id>.jsonl`). The reader
 * must tail bounded amounts, tolerate malformed lines, and the projector must
 * map the attachment grammar into the canonical vocabulary honestly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  readClaudeGoalStatuses,
  projectClaudeGoal,
  composeClaudeGoalCommand,
  CLAUDE_GOAL_CONTINUATION_PROMPT,
} from '../../../../src/internal-api/goal/claude-goal.js';

type Status = Record<string, unknown>;

function line(obj: unknown): string {
  return JSON.stringify(obj);
}
function goalStatus(fields: Status): string {
  return line({ type: 'attachment', timestamp: Date.now(), attachment: { type: 'goal_status', ...fields } });
}

describe('readClaudeGoalStatuses', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'claude-goal-'));
    file = path.join(dir, 'session.jsonl');
  });
  afterEach(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

  it('returns [] when the transcript does not exist', async () => {
    expect(await readClaudeGoalStatuses(path.join(dir, 'missing.jsonl'))).toEqual([]);
  });

  it('extracts goal_status attachments in order from a mixed transcript', async () => {
    await fsp.writeFile(file, [
      line({ type: 'user', message: 'hi' }),
      goalStatus({ met: false, sentinel: true, condition: 'make marker' }),
      line({ type: 'assistant', message: 'working' }),
      goalStatus({ met: false, condition: 'make marker', reason: 'no marker yet' }),
      goalStatus({ met: true, condition: 'make marker', reason: 'marker exists' }),
    ].join('\n') + '\n');
    const statuses = await readClaudeGoalStatuses(file);
    expect(statuses).toHaveLength(3);
    expect((statuses[0] as any).sentinel).toBe(true);
    expect((statuses[2] as any).met).toBe(true);
  });

  it('skips malformed lines without failing', async () => {
    await fsp.writeFile(file, ['{broken json', goalStatus({ met: false, condition: 'x' }), ''].join('\n'));
    const statuses = await readClaudeGoalStatuses(file);
    expect(statuses).toHaveLength(1);
  });

  it('reads a bounded tail of a large transcript and still finds recent attachments', async () => {
    const filler = Array.from({ length: 20_000 }, (_, i) => line({ type: 'filler', i })).join('\n');
    await fsp.writeFile(file, filler + '\n' + goalStatus({ met: false, sentinel: true, condition: 'tail goal' }) + '\n');
    const statuses = await readClaudeGoalStatuses(file, { maxTailBytes: 512 * 1024 });
    expect(statuses).toHaveLength(1);
    expect((statuses[0] as any).condition).toBe('tail goal');
  });

  it('parses goal_status entries written at top level too (shape drift tolerance)', async () => {
    await fsp.writeFile(file, [line({ type: 'goal_status', met: true, condition: 'flat shape' })].join('\n'));
    expect(await readClaudeGoalStatuses(file)).toHaveLength(1);
  });
});

describe('projectClaudeGoal', () => {
  it('no attachments → idle, supported', () => {
    const p = projectClaudeGoal([]);
    expect(p.supported).toBe(true);
    expect(p.status).toBe('idle');
  });

  it('sentinel-only → running when auto-continue on', () => {
    const p = projectClaudeGoal([{ met: false, sentinel: true, condition: 'ship it' }]);
    expect(p.status).toBe('running');
    expect(p.objective).toBe('ship it');
    expect(p.autoContinue).toBe(true);
  });

  it('unmet verdict → running while auto-continue armed; paused(user) when disarmed', () => {
    const unmet: Status[] = [
      { met: false, sentinel: true, condition: 'g' },
      { met: false, condition: 'g', reason: 'not yet' },
    ];
    expect(projectClaudeGoal(unmet).status).toBe('running');
    const paused = projectClaudeGoal(unmet, { autoContinue: false });
    expect(paused.status).toBe('paused');
    expect(paused.pausedReason).toBe('user');
    expect(paused.lastReason).toBe('not yet');
  });

  it('met:true → achieved with reason + objective', () => {
    const p = projectClaudeGoal([
      { met: false, sentinel: true, condition: 'deploy' },
      { met: true, condition: 'deploy', reason: 'all checks green' },
    ]);
    expect(p.status).toBe('achieved');
    expect(p.objective).toBe('deploy');
    expect(p.lastReason).toBe('all checks green');
  });

  it('impossible verdict → failed honestly', () => {
    const p = projectClaudeGoal([
      { met: false, sentinel: true, condition: 'g' },
      { met: false, impossible: true, condition: 'g', reason: 'requires prod access we cannot grant' },
    ]);
    expect(p.status).toBe('failed');
    expect(p.lastReason).toContain('prod access');
  });

  it('keeps verbatim runtime state list', () => {
    const statuses: Status[] = [{ met: false, sentinel: true, condition: 'k' }];
    const p = projectClaudeGoal(statuses);
    expect(Array.isArray(p.runtimeState)).toBe(true);
    expect((p.runtimeState as Status[])[0].condition).toBe('k');
  });
});

describe('composeClaudeGoalCommand', () => {
  it('start composes /goal <condition>', () => {
    expect(composeClaudeGoalCommand({ action: 'start', objective: 'make the marker file' })).toEqual({
      ok: true, action: 'start', command: '/goal make the marker file',
    });
  });
  it('clear composes /goal clear; pause/resume are server-side (no upstream command)', () => {
    expect(composeClaudeGoalCommand({ action: 'clear' })!.ok).toBe(true);
    expect(composeClaudeGoalCommand({ action: 'pause' })!.ok).toBe(false);
    expect(composeClaudeGoalCommand({ action: 'resume' })!.ok).toBe(false);
  });
  it('rejects missing/multiline objectives', () => {
    expect(composeClaudeGoalCommand({ action: 'start' })!.ok).toBe(false);
    expect(composeClaudeGoalCommand({ action: 'start', objective: 'a\nb' })!.ok).toBe(false);
  });
  it('continuation prompt is stable text', () => {
    expect(CLAUDE_GOAL_CONTINUATION_PROMPT).toContain('Continue working');
  });
});
