import rateLimit from 'express-rate-limit';
import { config } from '../config.js';

export const apiLimiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  max: config.rateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
  keyGenerator: (req) => {
    return req.user?.userId ?? req.ip ?? 'unknown';
  },
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later.' },
  skipSuccessfulRequests: true, // Don't count successful logins
});

export const wsMessageLimiter = (() => {
  const limits = new Map<string, { count: number; resetAt: number }>();
  const WINDOW_MS = 60 * 1000; // 1 minute
  const MAX_MESSAGES = 60; // 60 messages per minute

  setInterval(() => {
    const now = Date.now();
    for (const [key, data] of limits.entries()) {
      if (data.resetAt < now) {
        limits.delete(key);
      }
    }
  }, 60 * 1000);

  return {
    check: (userId: string): boolean => {
      const now = Date.now();
      const data = limits.get(userId);

      if (!data || data.resetAt < now) {
        limits.set(userId, { count: 1, resetAt: now + WINDOW_MS });
        return true;
      }

      if (data.count >= MAX_MESSAGES) {
        return false;
      }

      data.count++;
      return true;
    },
    getRemaining: (userId: string): number => {
      const data = limits.get(userId);
      if (!data) return MAX_MESSAGES;
      return Math.max(0, MAX_MESSAGES - data.count);
    },
  };
})();

/**
 * Voice-frame budget (finding F-2): a microphone stream is one frame per audio
 * chunk (~10-50/s), so the generic 60-per-minute `wsMessageLimiter` would drop
 * the operator's audio. Voice frames carry their own bounded per-client budget
 * instead — 1200 frames / 2 s = 600/s sustained, which is 12× a 20 ms
 * microphone cadence and 60× the contract's suggested chunk pace, far below a
 * flood. The generic limiter is unchanged for every non-voice message; the
 * transport asks THIS limiter for voice frames only, and surfaces a refusal as
 * `voice_error`.
 */
export const VOICE_FRAMES_PER_WINDOW = 1_200;
export const VOICE_FRAME_WINDOW_MS = 2_000;

export const wsVoiceFrameLimiter = (() => {
  const limits = new Map<string, { count: number; resetAt: number }>();

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, data] of limits.entries()) {
      if (data.resetAt < now) {
        limits.delete(key);
      }
    }
  }, VOICE_FRAME_WINDOW_MS);
  // Do not keep the Node process alive solely for voice-budget cleanup.
  cleanup.unref?.();

  return {
    check: (clientId: string): boolean => {
      const now = Date.now();
      const data = limits.get(clientId);

      if (!data || data.resetAt <= now) {
        limits.set(clientId, { count: 1, resetAt: now + VOICE_FRAME_WINDOW_MS });
        return true;
      }

      data.count += 1;
      return data.count <= VOICE_FRAMES_PER_WINDOW;
    },
    /** Drop a client's budget (socket close); the next frame starts a fresh window. */
    release: (clientId: string): void => {
      limits.delete(clientId);
    },
    getRemaining: (clientId: string): number => {
      const data = limits.get(clientId);
      if (!data || data.resetAt <= Date.now()) return VOICE_FRAMES_PER_WINDOW;
      return Math.max(0, VOICE_FRAMES_PER_WINDOW - data.count);
    },
  };
})();

/**
 * Upgrade rate limiter — bounds how many WebSocket upgrade attempts a single
 * client may make per minute. Applied by the central pre-upgrade guard
 * (`decideWsUpgrade`) to every accepted WebSocket path, so reconnect loops or
 * abuse cannot open unbounded sockets. Keyed by the authenticated userId.
 *
 * The cleanup interval is `unref`'d so it does not keep the process alive.
 */
export const wsUpgradeLimiter = (() => {
  const limits = new Map<string, { count: number; resetAt: number }>();
  const WINDOW_MS = 60 * 1000; // 1 minute
  const MAX_UPGRADES = 120; // upgrades per minute per authenticated client

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, data] of limits.entries()) {
      if (data.resetAt < now) {
        limits.delete(key);
      }
    }
  }, 60 * 1000);
  // Do not keep the Node process alive solely for upgrade-rate cleanup.
  cleanup.unref?.();

  return {
    max: MAX_UPGRADES,
    check(key: string): boolean {
      const now = Date.now();
      const data = limits.get(key);

      if (!data || data.resetAt < now) {
        limits.set(key, { count: 1, resetAt: now + WINDOW_MS });
        return true;
      }

      if (data.count >= MAX_UPGRADES) {
        return false;
      }

      data.count++;
      return true;
    },
    reset(): void {
      limits.clear();
    },
  };
})();
