import { describe, it, expect } from 'vitest';
import type { SdkType, SessionInfo, ClaudeSessionInfo } from './types';

describe('Dual-SDK type guards and structure', () => {
  // ─── SdkType ──────────────────────────────────────────────────────────────

  describe('SdkType', () => {
    it('SdkType can be "pi"', () => {
      const sdkType: SdkType = 'pi';
      expect(sdkType).toBe('pi');
    });

    it('SdkType can be "claude"', () => {
      const sdkType: SdkType = 'claude';
      expect(sdkType).toBe('claude');
    });

    it('SdkType can be "opencode"', () => {
      const sdkType: SdkType = 'opencode';
      expect(sdkType).toBe('opencode');
    });
  });

  // ─── SessionInfo ─────────────────────────────────────────────────────────

  describe('SessionInfo', () => {
    it('SessionInfo with sdkType: pi is valid', () => {
      const session: SessionInfo = {
        id: 'session-001',
        path: '/home/user/.pi/sessions/abc',
        cwd: '/home/user',
        sdkType: 'pi',
        createdAt: new Date(),
        lastActivity: new Date(),
        messageCount: 5,
        firstMessage: 'Hello',
      };

      expect(session.sdkType).toBe('pi');
      expect(session.id).toBe('session-001');
    });

    it('SessionInfo with sdkType: claude is valid', () => {
      const session: SessionInfo = {
        id: 'session-002',
        path: '/home/user/.pi-web-ui/claude-sessions/session-002.jsonl',
        cwd: '/home/user',
        sdkType: 'claude',
        claudeSessionId: 'claude-internal-id-xyz',
        createdAt: new Date(),
        lastActivity: new Date(),
        messageCount: 3,
        firstMessage: 'What can you do?',
        model: 'claude-opus-4-6',
      };

      expect(session.sdkType).toBe('claude');
      expect(session.claudeSessionId).toBe('claude-internal-id-xyz');
      expect(session.model).toBe('claude-opus-4-6');
    });

    it('SessionInfo supports optional model field', () => {
      const withModel: SessionInfo = {
        id: 's1',
        path: '/p',
        cwd: '/c',
        sdkType: 'pi',
        createdAt: new Date(),
        lastActivity: new Date(),
        messageCount: 0,
        firstMessage: '',
        model: 'claude-sonnet-4',
      };

      const withoutModel: SessionInfo = {
        id: 's2',
        path: '/p2',
        cwd: '/c2',
        sdkType: 'pi',
        createdAt: new Date(),
        lastActivity: new Date(),
        messageCount: 0,
        firstMessage: '',
      };

      expect(withModel.model).toBe('claude-sonnet-4');
      expect(withoutModel.model).toBeUndefined();
    });
  });

  // ─── ClaudeSessionInfo ────────────────────────────────────────────────────

  describe('ClaudeSessionInfo', () => {
    it('ClaudeSessionInfo has required fields', () => {
      const info: ClaudeSessionInfo = {
        id: 'our-uuid-123',
        claudeSessionId: 'claude-code-session-456',
        cwd: '/home/user/projects/myapp',
        model: 'opus',
        createdAt: new Date(),
        lastActivity: new Date(),
        messageCount: 10,
        firstMessage: 'Build me a REST API',
        status: 'idle',
      };

      expect(info.id).toBe('our-uuid-123');
      expect(info.claudeSessionId).toBe('claude-code-session-456');
      expect(info.model).toBe('opus');
      expect(info.status).toBe('idle');
    });

    it('ClaudeSessionInfo status can be running or error', () => {
      const running: ClaudeSessionInfo['status'] = 'running';
      const error: ClaudeSessionInfo['status'] = 'error';

      expect(running).toBe('running');
      expect(error).toBe('error');
    });
  });
});
