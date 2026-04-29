import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/config.js', () => ({
  config: {
    dictationOpenaiApiKey: 'test-key',
  },
}));

import { getSharedOpenAIClient, isWarmedUp, warmupConnections, resetForTesting } from '../../../src/dictation/connectionPool.js';

describe('Connection Pool', () => {
  beforeEach(() => {
    resetForTesting();
  });

  it('should create an OpenAI client lazily', () => {
    expect(isWarmedUp()).toBe(false);
    const client = getSharedOpenAIClient();
    expect(client).toBeDefined();
  });

  it('should return the same client on subsequent calls', () => {
    const a = getSharedOpenAIClient();
    const b = getSharedOpenAIClient();
    expect(a).toBe(b);
  });

  it('should mark as warmed up after warmupConnections', async () => {
    expect(isWarmedUp()).toBe(false);
    await warmupConnections();
    expect(isWarmedUp()).toBe(true);
  });

  it('should reset client for testing', () => {
    getSharedOpenAIClient();
    resetForTesting();
    const client = getSharedOpenAIClient();
    expect(client).toBeDefined();
  });
});
