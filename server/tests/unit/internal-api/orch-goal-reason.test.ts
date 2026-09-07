import { describe, expect, it } from 'vitest';
import { projectPiGoalState } from '../../../src/internal-api/goal/pi-goal.js';

describe('Pi goal plain pause-reason projection', () => {
  it('projects the full persisted plain pause reason without changing status vocabulary', () => {
    const projection = projectPiGoalState({
      objective: 'Supervise child work',
      status: 'paused',
      pauseReason: 'waiting for child session child-123 to settle',
      pendingQuestion: null,
      lastRunReason: 'agent-paused',
    });

    expect(projection.status).toBe('paused');
    expect(projection.pausedReason).toBe('waiting for child session child-123 to settle');
    expect(projection.lastReason).toBe('waiting for child session child-123 to settle');
  });

  it('ignores an empty plain reason instead of hiding the meaningful run reason', () => {
    const projection = projectPiGoalState({
      objective: 'x', status: 'paused', pauseReason: '   ', lastRunReason: 'agent-paused',
    });
    expect(projection.status).toBe('paused');
    expect(projection.pausedReason).toBeNull();
    expect(projection.lastReason).toBe('agent-paused');
  });

  it('preserves question and error projections ahead of a plain pause reason', () => {
    const question = projectPiGoalState({
      objective: 'x', status: 'paused', pauseReason: 'plain', pendingQuestion: 'Which API?',
    });
    expect(question.status).toBe('paused');
    expect(question.pausedReason).toBe('question');
    expect(question.lastReason).toBe('Which API?');

    const error = projectPiGoalState({
      objective: 'x', status: 'paused', pauseReason: 'plain', lastErrorMessage: 'three failures',
    });
    expect(error.status).toBe('failed');
    expect(error.pausedReason).toBe('error');
  });
});
