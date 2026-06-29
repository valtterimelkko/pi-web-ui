import { describe, it, expect } from 'vitest';
import {
  CLAUDE_AUTH_EXPIRED_CODE,
  isClaudeAuthError,
  buildReauthMessage,
  reauthContextFromProfile,
  DEFAULT_REAUTH_MESSAGE,
} from '../../../src/claude/claude-auth-errors.js';

describe('isClaudeAuthError', () => {
  it('matches the native PTY / CLI auth phrasings (case-insensitive)', () => {
    for (const msg of [
      'Please run /login to authenticate',
      'Run `claude auth login` on the server',
      'Invalid authentication credentials',
      'API Error: 401',
      'invalid_api_key',
      'authentication_error: x',
      'OAuth token has expired',
      '401 Unauthorized',
    ]) {
      expect(isClaudeAuthError(msg), msg).toBe(true);
    }
  });

  it('does not match transient capacity / generic failures', () => {
    for (const msg of [
      'Overloaded',
      'API Error: 529 {"type":"overloaded_error"}',
      'Claude returned an empty response (no output, 0 tokens)',
      'socket hang up',
      'Claude process exited with code=1',
    ]) {
      expect(isClaudeAuthError(msg), msg).toBe(false);
    }
  });

  it('handles null / undefined / empty input', () => {
    expect(isClaudeAuthError(undefined)).toBe(false);
    expect(isClaudeAuthError(null)).toBe(false);
    expect(isClaudeAuthError('')).toBe(false);
  });
});

describe('reauthContextFromProfile', () => {
  it('returns native (not token-backed) when no profile is given', () => {
    expect(reauthContextFromProfile(undefined)).toEqual({ tokenBacked: false });
    expect(reauthContextFromProfile(null)).toEqual({ tokenBacked: false });
  });

  it('treats a profile with no baseUrl/token as native subscription', () => {
    expect(
      reauthContextFromProfile({ id: 'native', label: 'Native Claude' }),
    ).toEqual({ tokenBacked: false });
  });

  it('treats a profile with a provider baseUrl + token env as token-backed', () => {
    const ctx = reauthContextFromProfile({
      id: 'glm52',
      label: 'GLM 5.2',
      baseUrl: 'https://api.z.ai/api/anthropic',
      authTokenEnv: 'GLM_CODING_PLAN_TOKEN',
    });
    expect(ctx.tokenBacked).toBe(true);
    expect(ctx.profileLabel).toBe('GLM 5.2');
    expect(ctx.authTokenEnv).toBe('GLM_CODING_PLAN_TOKEN');
    expect(ctx.providerLabel).toBe('Z.ai');
  });

  it('falls back to id when label is missing', () => {
    const ctx = reauthContextFromProfile({ id: 'glm52', authTokenEnv: 'X' });
    expect(ctx.profileLabel).toBe('glm52');
  });
});

describe('buildReauthMessage', () => {
  it('produces native-subscription remediation for native context', () => {
    const msg = buildReauthMessage();
    expect(msg).toMatch(/claude auth login/i);
    expect(msg).not.toMatch(/token/i);
  });

  it('produces token-refresh remediation for token-backed context', () => {
    const msg = buildReauthMessage({
      tokenBacked: true,
      profileLabel: 'GLM 5.2',
      authTokenEnv: 'GLM_CODING_PLAN_TOKEN',
      providerLabel: 'Z.ai',
    });
    expect(msg).toMatch(/Z\.ai/);
    expect(msg).toMatch(/GLM 5\.2/);
    expect(msg).toMatch(/GLM_CODING_PLAN_TOKEN/);
    expect(msg).toMatch(/refresh/i);
    expect(msg).not.toMatch(/claude auth login/i);
  });

  it('does not mention "Claude Direct" in any variant (legacy wording removed)', () => {
    expect(buildReauthMessage()).not.toMatch(/Claude Direct/i);
    expect(buildReauthMessage({ tokenBacked: true, authTokenEnv: 'X' })).not.toMatch(/Claude Direct/i);
  });

  it('exports a stable error code and default fallback message', () => {
    expect(CLAUDE_AUTH_EXPIRED_CODE).toBe('CLAUDE_AUTH_EXPIRED');
    expect(DEFAULT_REAUTH_MESSAGE).toMatch(/re-?authenticate/i);
  });
});
