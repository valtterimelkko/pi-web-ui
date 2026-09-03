import { describe, it, expect } from 'vitest';
import {
  isPiSlashCommandAllowedWhileStreaming,
  shouldPauseGoalOnStop,
  deriveGoalTag,
  getGoalControlCommand,
  canSteerWhileStreaming,
  canSendStreamingText,
} from '../../../src/lib/piExtensionControls';

describe('Pi extension controls', () => {
  it('allows slash commands while streaming only for Pi SDK sessions', () => {
    expect(isPiSlashCommandAllowedWhileStreaming('/goal pause', true, 'pi')).toBe(true);
    expect(isPiSlashCommandAllowedWhileStreaming(' /goal pause ', true, 'pi')).toBe(true);
    expect(isPiSlashCommandAllowedWhileStreaming('normal prompt', true, 'pi')).toBe(false);
    expect(isPiSlashCommandAllowedWhileStreaming('/goal pause', true, 'claude')).toBe(false);
    expect(isPiSlashCommandAllowedWhileStreaming('/goal pause', false, 'pi')).toBe(false);
  });

  it('maps Pi goal controls to extension slash commands while leaving OpenCode server-driven', () => {
    expect(getGoalControlCommand('pi', 'pause')).toBe('/goal pause-now');
    expect(getGoalControlCommand('pi', 'resume')).toBe('/goal resume');
    expect(getGoalControlCommand('pi', 'clear')).toBe('/goal clear');
    expect(getGoalControlCommand('opencode', 'pause')).toBeNull();
    expect(getGoalControlCommand('claude', 'resume')).toBeNull();
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
    // Contract 1.27.0: Claude + Command Code goals are server-disarmed on stop
    // (Claude auto-continue would otherwise re-launch an aborted goal; the
    // Command Code goal-runner mod honors the server pause control file).
    expect(shouldPauseGoalOnStop('claude', 'running')).toBe(true);
    expect(shouldPauseGoalOnStop('claude', 'wrapping-up')).toBe(true);
    expect(shouldPauseGoalOnStop('claude', 'paused')).toBe(false);
    expect(shouldPauseGoalOnStop('commandcode', 'running')).toBe(true);
    expect(shouldPauseGoalOnStop('commandcode', 'paused')).toBe(false);
    expect(shouldPauseGoalOnStop('commandcode', undefined)).toBe(false);
  });
});

describe('Pi streaming steer composer', () => {
  it('enables free-text composing while streaming only for Pi SDK sessions', () => {
    expect(canSteerWhileStreaming(true, 'pi')).toBe(true);
    expect(canSteerWhileStreaming(false, 'pi')).toBe(false);
    expect(canSteerWhileStreaming(true, 'claude')).toBe(true);
    expect(canSteerWhileStreaming(true, 'opencode')).toBe(false);
    expect(canSteerWhileStreaming(true, 'antigravity')).toBe(false);
    expect(canSteerWhileStreaming(true, 'commandcode')).toBe(true);
    expect(canSteerWhileStreaming(true, null)).toBe(false);
  });

  it('allows sending streaming text only on runtimes with a steer path and no uploads', () => {
    expect(canSendStreamingText(true, 'pi', false)).toBe(true);
    expect(canSendStreamingText(true, 'claude', false)).toBe(true);
    expect(canSendStreamingText(true, 'commandcode', false)).toBe(true);
    // attachments are not part of the steer/follow_up wire frames yet
    expect(canSendStreamingText(true, 'pi', true)).toBe(false);
    expect(canSendStreamingText(false, 'pi', false)).toBe(false);
    expect(canSendStreamingText(true, 'opencode', false)).toBe(false);
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

  // ── Status-grammar mislabels (2026-09-03 defect batch) ──────────────────
  // The extension/bridge status grammars include states that must never
  // render as an actionable running goal: a pending suggestion (pause/clear
  // would answer "no goal"), a terminal failure, an awaiting-input pause, and
  // anything unrecognised. Default-closed: only known live states show a tag.
  it('treats a pending goal suggestion as inactive — pause/clear do not apply', () => {
    const suggestion = '💡 Goal suggested — awaiting owner approval: "Next big thing"';
    expect(deriveGoalTag(suggestion, false).active).toBe(false);
    expect(deriveGoalTag(suggestion, true).active).toBe(false);
  });

  it('treats a failed goal as inactive (terminal — no actionable controls)', () => {
    expect(deriveGoalTag('🎯 ✖ Failed — Run 3', false).active).toBe(false);
    expect(deriveGoalTag('🎯 ✖ Failed', true).active).toBe(false);
  });

  it('treats awaiting-user-input as a paused-style state, not running', () => {
    const tag = deriveGoalTag('🎯 ⏸ Awaiting user input', true);
    expect(tag.active).toBe(true);
    expect(tag.paused).toBe(true);
    expect(tag.pulsing).toBe(false);
    expect(tag.label).toBe('paused');
  });

  it('never renders unrecognised status text as running', () => {
    expect(deriveGoalTag('🎯 Mystery status', false).active).toBe(false);
    expect(deriveGoalTag('💎 Goal suggested — awaiting owner approval: "x"', true).active).toBe(false);
    expect(deriveGoalTag('🎯 ▶ Sprinting — Run 2', true).active).toBe(false);
  });

  it('still recognises the real running grammar every runtime emits', () => {
    expect(deriveGoalTag('🎯 ▶ Running — Run 4', false).active).toBe(true);
    expect(deriveGoalTag('running', true).active).toBe(true);
  });

  it('keeps pause-on-stop willing for the full status text runtimes actually emit', () => {
    // Latent inverse bug: the real grammar ("🎯 ▶ Running — Run N") never
    // matched startsWith('running'), so mid-run stop did not pause the goal.
    expect(shouldPauseGoalOnStop('pi', '🎯 ▶ Running — Run 4')).toBe(true);
    expect(shouldPauseGoalOnStop('claude', '🎯 ⏸ Wrapping up… — Run 2')).toBe(true);
    expect(shouldPauseGoalOnStop('pi', '💡 Goal suggested — awaiting owner approval: "x"')).toBe(false);
    expect(shouldPauseGoalOnStop('claude', '🎯 ✖ Failed')).toBe(false);
    expect(shouldPauseGoalOnStop('opencode', '🎯 ⏸ Awaiting user input')).toBe(false);
  });
});
