import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClaudeService } from '../../../src/claude/claude-service.js';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('ClaudeService backward compatibility (sessions without profiles)', () => {
  let tmpDir: string;
  let svc: ClaudeService;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'claude-bw-compat-'));
    svc = new ClaudeService({
      claudeSessionDir: join(tmpDir, 'sessions'),
      registryPath: join(tmpDir, 'registry.json'),
      useChannel: false,
      useSdk: false, // No SDK — pure legacy mode
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('createSession works without profileId (legacy)', async () => {
    const { sessionId, claudeSessionId } = await svc.createSession('/tmp/bw-compat-test', 'sonnet');
    expect(sessionId).toBeDefined();
    expect(claudeSessionId).toBeDefined();

    // Session should be in the registry
    const entry = await svc.getSession(sessionId);
    expect(entry).toBeDefined();
    expect(entry?.sdkType).toBe('claude');
    expect(entry?.model).toBe('sonnet');

    // No profile metadata should be set
    expect(entry?.claudeProfileId).toBeUndefined();
    expect(entry?.claudeProfileBackend).toBeUndefined();
  });

  it('createSession with thinkingLevel works without profile', async () => {
    const { sessionId } = await svc.createSession('/tmp/bw-compat-thinking', 'opus', 'high');
    const entry = await svc.getSession(sessionId);
    expect(entry?.model).toBe('opus');
    expect(entry?.thinkingLevel).toBe('high');
  });

  it('hasSession returns true for created legacy sessions', async () => {
    const { sessionId } = await svc.createSession('/tmp/bw-compat-has', 'sonnet');
    expect(svc.hasSession(sessionId)).toBe(true);
  });

  it('pinSession/unpinSession works for legacy sessions', async () => {
    const { sessionId } = await svc.createSession('/tmp/bw-compat-pin', 'sonnet');
    expect(svc.pinSession(sessionId)).toBe(true);
    expect(svc.isSessionPinned(sessionId)).toBe(true);
    expect(svc.unpinSession(sessionId)).toBe(true);
    expect(svc.isSessionPinned(sessionId)).toBe(false);
  });

  it('getBackendMode returns direct when no SDK and no channel', async () => {
    const mode = await svc.getBackendMode();
    expect(mode).toBe('direct');
  });

  it('getProfiles returns empty when no profileManager', () => {
    expect(svc.getProfiles()).toEqual([]);
    expect(svc.getProfileManager()).toBeNull();
  });

  it('isRunning returns false for newly created legacy session', async () => {
    const { sessionId } = await svc.createSession('/tmp/bw-compat-running', 'sonnet');
    expect(svc.isRunning(sessionId)).toBe(false);
  });
});
