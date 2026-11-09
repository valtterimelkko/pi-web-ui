import { describe, it, expect } from 'vitest';
import {
  ALL_THINKING_LEVELS,
  LEGACY_THINKING_LEVELS,
  claudeAvailableThinkingLevels,
} from '../../../src/lib/claudeThinkingLevels';

describe('claudeAvailableThinkingLevels', () => {
  it('grants max to Fable by claudeModel on a profile entry', () => {
    const profiles = [{ id: 'profile:claude-fable-sdk', claudeModel: 'fable', provider: 'anthropic' }];
    expect(claudeAvailableThinkingLevels('profile:claude-fable-sdk', profiles)).toEqual(ALL_THINKING_LEVELS);
  });

  it('grants max to a resolved Fable model id on the session', () => {
    expect(claudeAvailableThinkingLevels('claude-fable-5-2', [])).toEqual(ALL_THINKING_LEVELS);
  });

  it('keeps Haiku on the legacy ceiling', () => {
    const profiles = [{ id: 'profile:claude-haiku-sdk', claudeModel: 'haiku', provider: 'anthropic' }];
    expect(claudeAvailableThinkingLevels('profile:claude-haiku-sdk', profiles)).toEqual(LEGACY_THINKING_LEVELS);
  });
});
