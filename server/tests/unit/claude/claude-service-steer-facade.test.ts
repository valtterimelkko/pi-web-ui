import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const { mockSdkSteer, mockSdkFollowUp } = vi.hoisted(() => ({
  mockSdkSteer: vi.fn(),
  mockSdkFollowUp: vi.fn(),
}));

vi.mock('../../../src/claude/claude-sdk-service.js', () => ({
  ClaudeSdkService: class {
    profiles = {
      getEnabledProfiles: () => [],
      requireProfile: () => { throw new Error('no profile'); },
      getDefaultProfileId: () => undefined,
    };
    steer = mockSdkSteer;
    followUp = mockSdkFollowUp;
    dispose() {}
  },
}));

import { ClaudeService } from '../../../src/claude/claude-service.js';

describe('ClaudeService steer facade', () => {
  let tmpDir: string;
  let svc: ClaudeService;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'claude-service-steer-'));
    const profilesPath = join(tmpDir, 'profiles.json');
    writeFileSync(profilesPath, JSON.stringify({ profiles: [], defaultProfileId: undefined }));
    svc = new ClaudeService({
      claudeSessionDir: join(tmpDir, 'sessions'),
      registryPath: join(tmpDir, 'registry.json'),
      useChannel: false,
      useSdk: true,
      profilesPath,
    });
    mockSdkSteer.mockReset();
    mockSdkFollowUp.mockReset();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('delegates steer to the SDK service and forwards its result', () => {
    mockSdkSteer.mockReturnValue(true);
    expect(svc.steer('session-1', 'pivot')).toBe(true);
    expect(mockSdkSteer).toHaveBeenCalledWith('session-1', 'pivot');
  });

  it('delegates followUp to the SDK service and forwards its result', () => {
    mockSdkFollowUp.mockReturnValue(false);
    expect(svc.followUp('session-1', 'later')).toBe(false);
    expect(mockSdkFollowUp).toHaveBeenCalledWith('session-1', 'later');
  });

  it('returns false when no SDK backend exists', async () => {
    const plain = new ClaudeService({
      claudeSessionDir: join(tmpDir, 'sessions2'),
      registryPath: join(tmpDir, 'registry2.json'),
      useChannel: false,
      useSdk: false,
    });
    expect(plain.steer('session-1', 'pivot')).toBe(false);
    expect(plain.followUp('session-1', 'later')).toBe(false);
  });
});
