import { afterEach, describe, expect, it, vi } from 'vitest';

const originalPayloadMaxBytes = process.env.INTERNAL_API_EVENT_PAYLOAD_MAX_BYTES;
const originalRateLimit = process.env.INTERNAL_API_EVENT_RATE_LIMIT_PER_SEC;

async function loadConfig() {
  vi.resetModules();
  return (await import('../../../src/config.js')).config;
}

afterEach(() => {
  if (originalPayloadMaxBytes === undefined) delete process.env.INTERNAL_API_EVENT_PAYLOAD_MAX_BYTES;
  else process.env.INTERNAL_API_EVENT_PAYLOAD_MAX_BYTES = originalPayloadMaxBytes;
  if (originalRateLimit === undefined) delete process.env.INTERNAL_API_EVENT_RATE_LIMIT_PER_SEC;
  else process.env.INTERNAL_API_EVENT_RATE_LIMIT_PER_SEC = originalRateLimit;
  vi.resetModules();
});

describe('Internal API event payload configuration', () => {
  it('defaults payload budget to 256 KiB and rate limit to 200 events per second', async () => {
    delete process.env.INTERNAL_API_EVENT_PAYLOAD_MAX_BYTES;
    delete process.env.INTERNAL_API_EVENT_RATE_LIMIT_PER_SEC;

    const config = await loadConfig();

    expect(config.internalApiEventPayloadMaxBytes).toBe(256 * 1024);
    expect(config.internalApiEventRateLimitPerSec).toBe(200);
  });

  it('accepts a disabled payload budget and a positive configured rate limit', async () => {
    process.env.INTERNAL_API_EVENT_PAYLOAD_MAX_BYTES = '0';
    process.env.INTERNAL_API_EVENT_RATE_LIMIT_PER_SEC = '25';

    const config = await loadConfig();

    expect(config.internalApiEventPayloadMaxBytes).toBe(0);
    expect(config.internalApiEventRateLimitPerSec).toBe(25);
  });

  it('rejects negative payload budgets and non-positive rate limits', async () => {
    process.env.INTERNAL_API_EVENT_PAYLOAD_MAX_BYTES = '-1';
    await expect(loadConfig()).rejects.toThrow(/INTERNAL_API_EVENT_PAYLOAD_MAX_BYTES.*non-negative/i);

    process.env.INTERNAL_API_EVENT_PAYLOAD_MAX_BYTES = '1024';
    process.env.INTERNAL_API_EVENT_RATE_LIMIT_PER_SEC = '0';
    await expect(loadConfig()).rejects.toThrow(/INTERNAL_API_EVENT_RATE_LIMIT_PER_SEC.*positive integer/i);
  });
});
