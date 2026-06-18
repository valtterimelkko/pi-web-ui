import { describe, it, expect } from 'vitest';
import {
  isPiSlashCommandAllowedWhileStreaming,
  shouldPauseGoalOnStop,
  deriveGoalTag,
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

describe('deriveGoalTag', () => {
  it('is inactive when there is no goal status', () => {
    expect(deriveGoalTag(undefined, false).active).toBe(false);
    expect(deriveGoalTag('', true).active).toBe(false);
    expect(deriveGoalTag('   ', true).active).toBe(false);
  });

  it('is inactive for idle goals', () => {
    expect(deriveGoalTag('Idle', false).active).toBe(false);
    expect(deriveGoalTag('🎯 Idle — Run 2', true).active).toBe(false);
  });

  it('parses the OpenCode running status and run number', () => {
    const tag = deriveGoalTag('🎯 ▶ Running — Run 4', false);
    expect(tag.active).toBe(true);
    expect(tag.paused).toBe(false);
    expect(tag.run).toBe(4);
    expect(tag.label).toBe('running');
  });

  it('pulses with "running…" while the session is streaming', () => {
    const tag = deriveGoalTag('🎯 ▶ Running — Run 4', true);
    expect(tag.pulsing).toBe(true);
    expect(tag.label).toBe('running…');
  });

  it('shows paused state and never pulses while paused, even if streaming', () => {
    const tag = deriveGoalTag('🎯 ⏸ Paused — Run 7', true);
    expect(tag.active).toBe(true);
    expect(tag.paused).toBe(true);
    expect(tag.pulsing).toBe(false);
    expect(tag.label).toBe('paused');
    expect(tag.run).toBe(7);
  });

  it('treats wrapping-up as a paused-style state', () => {
    const tag = deriveGoalTag('🎯 ⏸ Wrapping up… — Run 3', true);
    expect(tag.paused).toBe(true);
    expect(tag.pulsing).toBe(false);
    expect(tag.label).toBe('wrapping up…');
  });

  it('handles plain Pi-style status strings without a run number', () => {
    const tag = deriveGoalTag('running', true);
    expect(tag.active).toBe(true);
    expect(tag.pulsing).toBe(true);
    expect(tag.run).toBeNull();
  });
});
