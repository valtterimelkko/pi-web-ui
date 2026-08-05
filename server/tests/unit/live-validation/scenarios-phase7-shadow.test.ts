/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { scenarioRegistry } from '../../../src/live-validation/scenarios.js';

const baseCapabilities = {
  runtimes: {
    pi: { available: true },
    claude: { available: false },
    opencode: { available: false },
    antigravity: { available: false },
  },
} as any;

describe('phase7-pi-shadow live-validation scenario', () => {
  it('checks the durable Pi shadow projection and shared resource truth', async () => {
    const calls: string[] = [];
    const client = {
      async createSession() {
        calls.push('create');
        return { sessionId: 'phase7-live-session', model: 'gpt-test' };
      },
      async promptWithIdempotency() {
        calls.push('prompt');
        return { sessionId: 'phase7-live-session', runId: 'phase7-live-run', content: 'ok', turnComplete: true };
      },
      async getRunReceipt() {
        calls.push('receipt');
        return {
          runId: 'phase7-live-run',
          sessionId: 'phase7-live-session',
          runtime: 'pi',
          executionInstanceId: 'pi-local-default',
          status: 'completed',
          acceptedAt: new Date().toISOString(),
          terminalAt: new Date().toISOString(),
          phase7Shadow: {
            policyVersion: 'phase7-pi-shadow/v1',
            mode: 'shadow',
            profile: 'standard',
            reasonCodes: ['default_standard'],
            affinity: { kind: 'session', sessionId: 'phase7-live-session', ownership: 'server-owned' },
            resourceIdentity: { kind: 'shared-service', boundary: 'pi-control-process', ownership: 'server-owned', sessionScoped: false },
            evidence: { promptBytes: 12, toolEventCount: 0 },
          },
        };
      },
      async getSessionEvidence() {
        calls.push('evidence');
        return {
          receiptSummary: {
            durable: true,
            count: 1,
            latest: await this.getRunReceipt('phase7-live-run'),
          },
          diagnostics: {
            records: [{
              runId: 'phase7-live-run',
              msg: '[Phase7Shadow] phase7-live-run profile=standard',
              phase7PolicyVersion: 'phase7-pi-shadow/v1',
              phase7AffinitySessionId: 'phase7-live-session',
              phase7ResourceIdentity: 'shared-service',
            }],
          },
        };
      },
      async getSessionInfo() {
        return { model: 'gpt-test', executionInstanceId: 'pi-local-default' };
      },
      async deleteSession() {
        calls.push('delete');
      },
    } as any;

    const scenario = scenarioRegistry['phase7-pi-shadow'];
    expect(scenario).toBeDefined();
    const result = await scenario.run({
      client,
      runtime: 'pi',
      capabilities: baseCapabilities,
      cwd: '/tmp/phase7-live',
    });

    expect(result.passed).toBe(true);
    expect(result.runId).toBe('phase7-live-run');
    expect(calls).toEqual(['create', 'prompt', 'receipt', 'evidence', 'receipt', 'delete']);
  });

  it('does not claim coverage for non-Pi runtimes', async () => {
    const scenario = scenarioRegistry['phase7-pi-shadow'];
    expect(scenario).toBeDefined();
    const result = await scenario.run({
      client: {} as any,
      runtime: 'claude',
      capabilities: baseCapabilities,
      cwd: '/tmp/phase7-live',
    });

    expect(result.skipped).toBe(true);
  });
});
