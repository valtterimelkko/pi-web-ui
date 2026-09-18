/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * M8 (review R) — envelope-faithful rate refusals.
 *
 * The voice-frame budget's refusal must carry an envelope the client's own
 * `checkVoiceEnvelope('server-to-client')` accepts. Before the fix the frame
 * was sent with `laneId: ''` / `attachmentGeneration: 0` when the offending
 * frame lacked an envelope, so the client rejected the very notice meant to
 * tell it its frame had been dropped for rate — silently, exactly when the
 * client was most misbehaving.
 *
 * Drives the REAL WebSocketConnectionManager message path (JSON → auth → voice
 * rate limit) and exhausts the REAL exported limiter directly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { claudeMock, opencodeMock, antigravityMock, piMock } = vi.hoisted(() => {
  const noopRecursive: any = new Proxy(function noop() {}, {
    get: () => noopRecursive,
    apply: () => undefined,
  });
  return {
    claudeMock: { isAvailable: vi.fn().mockResolvedValue(true), isRunning: vi.fn().mockReturnValue(false), sendPrompt: vi.fn(), abort: vi.fn(), hasSession: vi.fn().mockReturnValue(false), getSessionState: vi.fn(), setThinkingLevel: vi.fn(), createSession: vi.fn(), listSessions: vi.fn().mockResolvedValue([]), validateAuth: vi.fn().mockResolvedValue({ ok: true }), stop: vi.fn().mockResolvedValue(undefined) },
    opencodeMock: { isAvailable: vi.fn().mockResolvedValue(true), isRunning: vi.fn().mockReturnValue(false), isSessionPinned: vi.fn().mockReturnValue(false), validateSetup: vi.fn().mockResolvedValue({ ok: true }), isPendingPermission: vi.fn().mockReturnValue(false), resolvePermission: vi.fn(), listSessions: vi.fn().mockResolvedValue([]), shutdown: vi.fn().mockResolvedValue(undefined) },
    antigravityMock: { isAvailable: vi.fn().mockResolvedValue(true), validateSetup: vi.fn().mockResolvedValue({ ok: true }), listSessions: vi.fn().mockResolvedValue([]), shutdown: vi.fn().mockResolvedValue(undefined) },
    piMock: noopRecursive,
  };
});

vi.mock('../../../src/claude/index.js', () => ({ getClaudeService: () => claudeMock }));
vi.mock('../../../src/opencode/index.js', () => ({ getOpenCodeService: () => opencodeMock }));
vi.mock('../../../src/antigravity/index.js', () => ({ getAntigravityService: () => antigravityMock }));
vi.mock('../../../src/pi/index.js', () => ({ getPiService: () => piMock }));
vi.mock('../../../src/pi/session-list-cache.js', () => ({
  getPiSessionListCache: () => ({ list: () => Promise.resolve([]) }),
}));

import { WebSocketConnectionManager } from '../../../src/websocket/connection.js';
import { wsVoiceFrameLimiter, VOICE_FRAMES_PER_WINDOW } from '../../../src/security/rate-limit.js';

describe('M8: voice rate-limit refusals are envelope-faithful', () => {
  let mgr: WebSocketConnectionManager;
  let sent: Record<string, unknown>[];

  beforeEach(() => {
    vi.clearAllMocks();
    mgr = new WebSocketConnectionManager();
    sent = [];
    (mgr as any).sendMessage = (_clientId: string, message: unknown) => {
      sent.push(message as Record<string, unknown>);
    };
    (mgr as any).clients.set('c1', { userId: 'u', isAuthenticated: true, ws: { close: () => {} } });
  });

  afterEach(async () => {
    await (mgr as unknown as { close?: () => Promise<void> }).close?.();
  });

  const exhaustVoiceBudget = (): void => {
    for (let i = 0; i < VOICE_FRAMES_PER_WINDOW; i++) wsVoiceFrameLimiter.check('c1');
  };

  const sendRaw = (message: unknown): Promise<void> =>
    (mgr as any).handleMessage('c1', Buffer.from(JSON.stringify(message)));

  it('echoes the offending frame lane/generation/requestId when they are present', async () => {
    exhaustVoiceBudget();
    await sendRaw({
      type: 'voice_activity_state',
      version: 1,
      laneId: 'lane-1',
      attachmentGeneration: 3,
      state: 'speech_start',
      atMs: 1,
      requestId: 'req-rate-1',
    });
    const frame = sent.at(-1) as Record<string, unknown>;
    expect(frame.type).toBe('voice_error');
    expect(frame.laneId).toBe('lane-1');
    expect(frame.attachmentGeneration).toBe(3);
    expect(frame.requestId).toBe('req-rate-1');
    // The client's own envelope check refuses an empty laneId: never send one.
    expect(frame.laneId).not.toBe('');
  });

  it('uses the generic error frame when the offending frame genuinely lacked an envelope', async () => {
    exhaustVoiceBudget();
    await sendRaw({ type: 'voice_activity_state' });
    const frame = sent.at(-1) as Record<string, unknown>;
    expect(frame.type).toBe('error');
    expect(frame.code).toBe('RATE_LIMIT');
    // No malformed voice frame was emitted for the envelope-less case.
    expect(sent.some((f) => f.type === 'voice_error' && f.laneId === '')).toBe(false);
  });
});