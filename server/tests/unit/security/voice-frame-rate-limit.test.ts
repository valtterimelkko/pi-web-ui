import { describe, expect, it } from 'vitest';

import {
  VOICE_FRAME_WINDOW_MS,
  VOICE_FRAMES_PER_WINDOW,
  wsMessageLimiter,
  wsVoiceFrameLimiter,
} from '../../../src/security/rate-limit.js';

/**
 * F-2 durable fix: the voice frame budget lives with the other WebSocket rate
 * limits (plan Phase 8 / Phase-5 finding F-2). The policy is unchanged — 1200
 * frames per 2 s per client, far above a real microphone and far below a flood —
 * and the generic 60-per-minute limiter is untouched for non-voice messages.
 */
describe('wsVoiceFrameLimiter (F-2)', () => {
  it('is the documented voice budget: 1200 frames / 2 s per client', () => {
    expect(VOICE_FRAMES_PER_WINDOW).toBe(1200);
    expect(VOICE_FRAME_WINDOW_MS).toBe(2_000);
  });

  it('allows a full window of voice frames and refuses the next one', () => {
    const client = `voice-budget-${Math.random()}`;
    wsVoiceFrameLimiter.release(client);
    for (let index = 0; index < VOICE_FRAMES_PER_WINDOW; index += 1) {
      expect(wsVoiceFrameLimiter.check(client)).toBe(true);
    }
    expect(wsVoiceFrameLimiter.check(client)).toBe(false);
    expect(wsVoiceFrameLimiter.getRemaining(client)).toBe(0);
    wsVoiceFrameLimiter.release(client);
  });

  it('keys the budget per client', () => {
    const a = `voice-a-${Math.random()}`;
    const b = `voice-b-${Math.random()}`;
    wsVoiceFrameLimiter.release(a);
    wsVoiceFrameLimiter.release(b);
    for (let index = 0; index < VOICE_FRAMES_PER_WINDOW; index += 1) wsVoiceFrameLimiter.check(a);
    expect(wsVoiceFrameLimiter.check(a)).toBe(false);
    expect(wsVoiceFrameLimiter.check(b)).toBe(true);
    wsVoiceFrameLimiter.release(a);
    wsVoiceFrameLimiter.release(b);
  });

  it('release() clears a client’s budget (disconnect cleanup)', () => {
    const client = `voice-release-${Math.random()}`;
    wsVoiceFrameLimiter.release(client);
    for (let index = 0; index < VOICE_FRAMES_PER_WINDOW; index += 1) wsVoiceFrameLimiter.check(client);
    expect(wsVoiceFrameLimiter.check(client)).toBe(false);
    wsVoiceFrameLimiter.release(client);
    expect(wsVoiceFrameLimiter.check(client)).toBe(true);
    expect(wsVoiceFrameLimiter.getRemaining(client)).toBe(VOICE_FRAMES_PER_WINDOW - 1);
    wsVoiceFrameLimiter.release(client);
  });

  it('does not change the generic wsMessageLimiter policy for non-voice messages', () => {
    const client = `generic-${Math.random()}`;
    for (let index = 0; index < 60; index += 1) {
      expect(wsMessageLimiter.check(client)).toBe(true);
    }
    expect(wsMessageLimiter.check(client)).toBe(false);
    expect(wsMessageLimiter.getRemaining(client)).toBe(0);
  });
});
