import { describe, it, expect } from 'vitest';
import {
  isPiSlashCommandAllowedWhileStreaming,
  shouldPauseGoalOnStop,
} from '../../../src/lib/piExtensionControls';

describe('Pi extension controls', () => {
  it('allows slash commands while streaming only for Pi SDK sessions', () => {
    expect(isPiSlashCommandAllowedWhileStreaming('/goal pause', true, 'pi')).toBe(true);
    expect(isPiSlashCommandAllowedWhileStreaming(' /goal pause ', true, 'pi')).toBe(true);
    expect(isPiSlashCommandAllowedWhileStreaming('normal prompt', true, 'pi')).toBe(false);
    expect(isPiSlashCommandAllowedWhileStreaming('/goal pause', true, 'claude')).toBe(false);
    expect(isPiSlashCommandAllowedWhileStreaming('/goal pause', false, 'pi')).toBe(false);
  });

  it('returns true for pause-on-stop when Pi or OpenCode goal is running', () => {
    // Pi: send /goal pause-now slash command
    expect(shouldPauseGoalOnStop('pi', 'running')).toBe(true);
    expect(shouldPauseGoalOnStop('pi', 'running: Build 200 plants')).toBe(true);
    expect(shouldPauseGoalOnStop('pi', 'wrapping-up')).toBe(true);
    expect(shouldPauseGoalOnStop('pi', 'paused')).toBe(false);
    expect(shouldPauseGoalOnStop('pi', undefined)).toBe(false);
    // OpenCode: server handles pause automatically on abort
    expect(shouldPauseGoalOnStop('opencode', 'running')).toBe(true);
    expect(shouldPauseGoalOnStop('opencode', 'wrapping-up')).toBe(true);
    expect(shouldPauseGoalOnStop('opencode', 'paused')).toBe(false);
    expect(shouldPauseGoalOnStop('opencode', undefined)).toBe(false);
    // Claude: no goal engine support
    expect(shouldPauseGoalOnStop('claude', 'running')).toBe(false);
  });
});
