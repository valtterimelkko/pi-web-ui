import { describe, it, expect } from 'vitest';
import { parseGoalCommand } from '../../../src/opencode/goal-command.js';

describe('parseGoalCommand', () => {
  it('returns null for non-goal prompts', () => {
    expect(parseGoalCommand('hello world')).toBeNull();
    expect(parseGoalCommand('please clear the goal')).toBeNull();
    expect(parseGoalCommand('/goalkeeper')).toBeNull(); // unknown verb "keeper"
  });

  it('treats bare /goal as status', () => {
    expect(parseGoalCommand('/goal')).toBe('status');
    expect(parseGoalCommand('  /goal  ')).toBe('status');
    expect(parseGoalCommand('/goal status')).toBe('status');
    expect(parseGoalCommand('/goal-status')).toBe('status');
  });

  it('parses pause (spaced, hyphenated, and pause-now) as pause', () => {
    expect(parseGoalCommand('/goal pause')).toBe('pause');
    expect(parseGoalCommand('/goal-pause')).toBe('pause');
    expect(parseGoalCommand('/goal pause-now')).toBe('pause');
    expect(parseGoalCommand('/goal-pause-now')).toBe('pause');
    expect(parseGoalCommand('/GOAL PAUSE')).toBe('pause');
  });

  it('parses resume/continue', () => {
    expect(parseGoalCommand('/goal resume')).toBe('resume');
    expect(parseGoalCommand('/goal-resume')).toBe('resume');
    expect(parseGoalCommand('/goal continue')).toBe('resume');
  });

  it('parses clear/stop', () => {
    expect(parseGoalCommand('/goal clear')).toBe('clear');
    expect(parseGoalCommand('/goal-clear')).toBe('clear');
    expect(parseGoalCommand('/goal stop')).toBe('clear');
  });

  it('returns null for an unknown verb so it falls through to the model', () => {
    expect(parseGoalCommand('/goal frobnicate')).toBeNull();
  });
});
