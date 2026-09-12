import { describe, it, expect } from 'vitest';

// RED: module does not exist yet.
import {
  createPiDelivery,
  createClaudeDelivery,
  createAntigravityDelivery,
  createNullDelivery,
} from '../../../src/talker/delivery.js';

describe('Pi delivery (existing path until H2 lands)', () => {
  it('steers a busy worker via the existing path and discloses that H2 is not wired', async () => {
    const calls: string[] = [];
    const delivery = createPiDelivery({
      isBusy: () => true,
      steer: async (_id, text) => { calls.push(`steer:${text}`); },
      prompt: async () => { calls.push('prompt'); },
    });
    const result = await delivery.deliver({ workerSessionId: 'pi-1', text: 'hold phase 3' });
    expect(result).toEqual({
      outcome: 'delivered',
      mechanism: 'steer',
      disclosure: expect.stringContaining('existing steer path'),
    });
    expect(calls).toEqual(['steer:hold phase 3']);
  });

  it('prompts an idle worker through the existing prompt path', async () => {
    const calls: string[] = [];
    const delivery = createPiDelivery({
      isBusy: () => false,
      steer: async () => { calls.push('steer'); },
      prompt: async (_id, text) => { calls.push(`prompt:${text}`); },
    });
    const result = await delivery.deliver({ workerSessionId: 'pi-1', text: 'hold phase 3' });
    expect(result.outcome).toBe('delivered');
    expect(result).toMatchObject({ mechanism: 'prompt' });
    expect(calls).toEqual(['prompt:hold phase 3']);
  });

  it('refuses honestly when the underlying path throws (never claims success)', async () => {
    const delivery = createPiDelivery({
      isBusy: () => true,
      steer: async () => { throw new Error('session gone'); },
      prompt: async () => { throw new Error('unreachable'); },
    });
    const result = await delivery.deliver({ workerSessionId: 'pi-1', text: 'x' });
    expect(result.outcome).toBe('refused');
    expect((result as { reason: string }).reason).toContain('session gone');
  });
});

describe('Claude delivery (SDK backend only)', () => {
  const sdkDeps = (overrides: Partial<Parameters<typeof createClaudeDelivery>[0]> = {}) => ({
    getBackendMode: () => 'sdk' as const,
    isRunning: () => true,
    steer: () => true,
    followUp: () => true,
    sendPrompt: async () => {},
    ...overrides,
  });

  it('refuses honestly on a non-SDK backend — never silently degrades', async () => {
    const delivery = createClaudeDelivery(sdkDeps({ getBackendMode: () => 'other' }));
    const result = await delivery.deliver({ workerSessionId: 'c-1', text: 'x' });
    expect(result.outcome).toBe('refused');
    expect((result as { reason: string }).reason).toMatch(/SDK backend/);
  });

  it('refuses honestly when the backend cannot be proven', async () => {
    const delivery = createClaudeDelivery(sdkDeps({ getBackendMode: () => 'unknown' }));
    const result = await delivery.deliver({ workerSessionId: 'c-1', text: 'x' });
    expect(result.outcome).toBe('refused');
  });

  it('steers a running SDK session', async () => {
    const delivery = createClaudeDelivery(sdkDeps());
    const result = await delivery.deliver({ workerSessionId: 'c-1', text: 'x' });
    expect(result).toMatchObject({ outcome: 'delivered', mechanism: 'steer' });
  });

  it('falls back to follow-up (queued) when steer is not accepted mid-run', async () => {
    const delivery = createClaudeDelivery(sdkDeps({ steer: () => false }));
    const result = await delivery.deliver({ workerSessionId: 'c-1', text: 'x' });
    expect(result).toMatchObject({ outcome: 'queued', mechanism: 'follow_up' });
  });

  it('prompts an idle SDK session', async () => {
    const delivery = createClaudeDelivery(sdkDeps({ isRunning: () => false }));
    const result = await delivery.deliver({ workerSessionId: 'c-1', text: 'x' });
    expect(result).toMatchObject({ outcome: 'delivered', mechanism: 'prompt' });
  });
});

describe('Antigravity delivery (follow-up only)', () => {
  it('queues behind the current turn as a first-class outcome', async () => {
    const delivery = createAntigravityDelivery({ followUp: async () => true });
    const result = await delivery.deliver({ workerSessionId: 'a-1', text: 'x' });
    expect(result).toMatchObject({ outcome: 'queued', mechanism: 'follow_up' });
    expect((result as { disclosure: string }).disclosure).toMatch(/after this turn/i);
  });

  it('refuses honestly when no turn is running (the talker never starts turns)', async () => {
    const delivery = createAntigravityDelivery({ followUp: async () => false });
    const result = await delivery.deliver({ workerSessionId: 'a-1', text: 'x' });
    expect(result.outcome).toBe('refused');
    expect((result as { reason: string }).reason).toMatch(/follow-up only/i);
  });
});

describe('Null delivery (harness runner/tests)', () => {
  it('records the verbatim text it would have delivered', async () => {
    const delivery = createNullDelivery();
    await delivery.deliver({ workerSessionId: 'w', text: 'verbatim instruction' });
    const result = await delivery.deliver({ workerSessionId: 'w', text: 'second' });
    expect(result).toMatchObject({ outcome: 'delivered', mechanism: 'prompt' });
    expect(delivery.deliveredTexts()).toEqual(['verbatim instruction', 'second']);
  });
});
