import { describe, it, expect } from 'vitest';
import { resolveExecutionInstanceId } from '../../../src/internal-api/execution-instance.js';

describe('resolveExecutionInstanceId', () => {
  it('uses the configured Claude profile id when one is present', () => {
    expect(resolveExecutionInstanceId({ sdkType: 'claude', claudeProfileId: 'glm52-claude-sdk' })).toBe('glm52-claude-sdk');
  });

  it('uses a stable Claude default when no profile id is recorded', () => {
    expect(resolveExecutionInstanceId({ sdkType: 'claude' })).toBe('claude-default');
  });

  it.each([
    ['pi', 'pi-local-default'],
    ['opencode', 'opencode-default'],
    ['antigravity', 'antigravity-default'],
  ] as const)('uses the static %s instance id for non-Claude runtimes', (runtime, expected) => {
    expect(resolveExecutionInstanceId({ sdkType: runtime })).toBe(expected);
  });
});
