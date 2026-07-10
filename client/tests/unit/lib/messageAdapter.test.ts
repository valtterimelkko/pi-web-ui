import { describe, expect, it } from 'vitest';
import { normalizeToolName } from '../../../src/lib/messageAdapter';

describe('normalizeToolName', () => {
  it('routes Pi evaluated_subagent results through the compact subagent card', () => {
    expect(normalizeToolName('evaluated_subagent')).toBe('subagent');
  });
});
