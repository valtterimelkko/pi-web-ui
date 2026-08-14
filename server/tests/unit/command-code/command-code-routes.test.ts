import { mkdtemp, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { AdmissionController } from '../../../src/internal-api/admission-controller.js';
import { RunReceiptManager } from '../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../../../src/internal-api/run-receipts/run-receipt-store.js';
import { createSessionRoutes } from '../../../src/internal-api/routes/sessions.js';
import { CommandCodeService } from '../../../src/command-code/command-code-service.js';
import { createCommandCodeRoleAttestation } from '../../../src/command-code/command-code-role-attestation.js';
import type { CommandCodeProcessRunInput, CommandCodeProcessRunResult } from '../../../src/command-code/command-code-process-runner.js';
import { setLogTap, type LogRecord } from '../../../src/logging/logger.js';

function req(body: unknown): any {
  const value = Readable.from([Buffer.from(JSON.stringify(body))]) as any;
  value.headers = {};
  value.method = 'POST';
  value.url = '/api/v1/sessions';
  return value;
}
function res(): any {
  const chunks: Buffer[] = [];
  const value = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } }) as any;
  value.statusCode = 200;
  value.headersSent = false;
  value.writeHead = vi.fn((status: number) => { value.statusCode = status; value.headersSent = true; return value; });
  value.setHeader = vi.fn();
  value.end = vi.fn((chunk?: string) => { if (chunk) chunks.push(Buffer.from(chunk)); value.body = Buffer.concat(chunks).toString(); return value; });
  value.getHeader = vi.fn();
  return value;
}

class Runner {
  inputs: CommandCodeProcessRunInput[] = [];
  async run(input: CommandCodeProcessRunInput): Promise<CommandCodeProcessRunResult> {
    this.inputs.push(input);
    return {
      exitCode: 0, signal: null, stderrTail: '',
      parsed: {
        events: [
          { event: { type: 'message_start' }, lineNumber: 1 },
          { event: { type: 'text_delta', delta: 'route-ok' }, lineNumber: 2 },
          { event: { type: 'message_end' }, lineNumber: 3 },
          { event: { type: 'turn_end' }, lineNumber: 4 },
        ],
        terminal: { type: 'result', subtype: 'success', sessionId: 'native-route-1', effort: 'low', finalText: 'route-ok', usage: { input: 13, output: 8, total: 21 } },
        unknownEventTypes: [], suppressedDuplicateCount: 0, bytes: 1, lineCount: 5,
      },
    };
  }
  async abort() {}
  async shutdown() {}
  isRunning() { return false; }
}

describe('Command Code Internal API lifecycle', () => {
  it('uses standard create, prompt, receipt, evidence, transcript, and delete endpoints', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'command-code-routes-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const runner = new Runner();
    const commandCodeService = new CommandCodeService({
      config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir: root, expectedVersion: '1.19.0' },
      runner,
      discover: async () => ({
        version: '1.19.0',
        models: ['qwen/qwen3.8-max', 'meta/muse-spark-1.2-contributor'],
        ambiguous: [],
        effortCapabilities: {
          'qwen/qwen3.8-max': { supportsEffort: true, effortLevels: ['low', 'medium', 'xhigh'], defaultEffort: 'medium', status: 'adjustable', source: 'live-preflight', capabilityHash: 'a'.repeat(64) },
          'meta/muse-spark-1.2-contributor': { supportsEffort: false, effortLevels: [], status: 'unavailable', source: 'live-preflight', capabilityHash: 'b'.repeat(64) },
        },
      }),
      checkExecutable: false,
    });
    commandCodeService.setRoleAttestationSecret('route-secret');
    const attestation = createCommandCodeRoleAttestation('route-secret', {
      role: 'conductor-root', model: 'qwen/qwen3.8-max', effort: 'xhigh', cwd, worktreeRoot: cwd,
      leaseId: 'route-test-lease', issuedAt: new Date().toISOString(),
    });
    const registry = { get: vi.fn().mockResolvedValue(undefined), listAll: vi.fn().mockResolvedValue([]) } as any;
    const receipts = new RunReceiptManager({ store: new RunReceiptStore(path.join(root, 'receipts')), turnIdleTimeoutMs: 10_000, turnMaxMs: 10_000 });
    const admission = new AdmissionController({ maxActiveTurns: 2, interactiveReserve: 0, minimumHeadroomBytes: 1, hostMinimumHeadroomBytes: 1, reservedBytesPerTurn: 1, memory: () => ({ currentBytes: 1, limitBytes: 1_000_000 }), readPids: () => ({} as any), host: () => ({ memAvailableBytes: 1_000_000 } as any) });
    const routes = createSessionRoutes({
      claudeService: {} as any, opencodeService: {} as any, antigravityService: {} as any,
      multiSessionManager: {} as any, sessionRegistry: registry, piService: {} as any,
      internalClientId: 'test', watchDir: path.join(root, 'watches'), pinDir: path.join(root, 'pins'),
      runReceiptManager: receipts, admissionController: admission, commandCodeService,
    });
    await routes.ready;

    const rejectedResponse = res();
    await routes.handleCreateSession(req({ runtime: 'commandcode', cwd, model: 'qwen/qwen3.8-max', invocationRole: 'conductor-root', commandCodeAttestation: { ...attestation, signature: '0'.repeat(64) } }), rejectedResponse);
    expect(rejectedResponse.statusCode).toBe(403);
    expect(JSON.parse(rejectedResponse.body).code).toBe('COMMANDCODE_ROLE_REFUSED');

    const batchRejectedResponse = res();
    await routes.handleBatchCreate(req({ sessions: [{ runtime: 'commandcode', cwd, model: 'qwen/qwen3.8-max', invocationRole: 'conductor-root', commandCodeAttestation: { ...attestation, signature: '0'.repeat(64) } }] }), batchRejectedResponse);
    const batchRejected = JSON.parse(batchRejectedResponse.body);
    expect(batchRejected.createdCount).toBe(0);
    expect(batchRejected.created[0].error.code).toBe('COMMANDCODE_ROLE_REFUSED');

    const defaultAttestation = createCommandCodeRoleAttestation('route-secret', {
      role: 'conductor-root', model: 'qwen/qwen3.8-max', effort: 'medium', cwd, worktreeRoot: cwd,
      leaseId: 'route-default-lease', issuedAt: new Date().toISOString(),
    });
    const defaultCreateResponse = res();
    await routes.handleCreateSession(req({ runtime: 'commandcode', cwd, model: 'qwen/qwen3.8-max', invocationRole: 'conductor-root', commandCodeAttestation: defaultAttestation }), defaultCreateResponse);
    expect(defaultCreateResponse.statusCode).toBe(201);
    const defaultCreated = JSON.parse(defaultCreateResponse.body);
    expect(defaultCreated).toMatchObject({ effort: 'medium', acceptedEffort: 'medium', effortSource: 'default', defaultEffort: 'medium' });
    expect(defaultCreated.requestedEffort).toBeUndefined();

    const createResponse = res();
    await routes.handleCreateSession(req({ runtime: 'commandcode', cwd, model: 'qwen/qwen3.8-max', effort: 'xhigh', invocationRole: 'conductor-root', commandCodeAttestation: attestation, retention: { mode: 'resident', ttlSeconds: 900, ownerId: 'route-test' } }), createResponse);
    expect(createResponse.statusCode).toBe(201);
    const created = JSON.parse(createResponse.body);
    expect(created.runtime).toBe('commandcode');
    expect(created.effort).toBe('xhigh');
    expect(created.acceptedEffort).toBe('xhigh');
    expect(created.requestedEffort).toBe('xhigh');

    const controlResponse = res();
    await routes.handleSessionControl(req({ action: 'set_effort', effort: 'low' }), controlResponse, created.sessionId);
    expect(controlResponse.statusCode).toBe(200);
    expect(JSON.parse(controlResponse.body)).toMatchObject({
      success: true,
      action: 'set_effort',
      effort: 'low',
      requestedEffort: 'low',
      acceptedEffort: 'low',
      effortSource: 'explicit',
      effortCapabilityHash: created.effortCapabilityHash,
    });

    const promptResponse = res();
    const logs: LogRecord[] = [];
    setLogTap((record) => logs.push(record));
    try {
      await routes.handleSendPrompt(req({ message: 'say route-ok' }), promptResponse, created.sessionId);
    } finally {
      setLogTap(null);
    }
    expect(promptResponse.statusCode, promptResponse.body).toBe(200);
    expect(JSON.parse(promptResponse.body).content).toBe('route-ok');
    expect(runner.inputs[0]?.nativeSessionId).toBeUndefined();
    expect(runner.inputs[0]?.effort).toBe('low');
    const lifecycle = logs.filter((record) => record.msg.includes('Prompt dispatched') || record.msg.includes('Prompt turn complete'));
    expect(lifecycle.some((record) => record.msg.includes('Prompt dispatched'))).toBe(true);
    expect(lifecycle.length).toBeGreaterThan(0);
    expect(lifecycle.every((record) => record.requestId && record.runId && record.sessionId === created.sessionId && record.runtime === 'commandcode' && record.executionInstanceId === 'commandcode-default')).toBe(true);

    const receiptResponse = res();
    await routes.handleGetRunReceipt(req({}), receiptResponse, JSON.parse(promptResponse.body).runId);
    expect(JSON.parse(receiptResponse.body)).toMatchObject({
      status: 'completed',
      effort: 'low',
      requestedEffort: 'low',
      acceptedEffort: 'low',
      effectiveEffort: 'low',
      effortEvidenceMethod: 'provider-result',
      tokenUsage: { scope: 'run', source: 'commandcode-terminal-result-v1', input: 13, output: 8, total: 21 },
    });

    const infoResponse = res();
    await routes.handleGetSessionInfo(req({}), infoResponse, created.sessionId);
    expect(JSON.parse(infoResponse.body)).toMatchObject({
      runtime: 'commandcode',
      tokenUsage: { scope: 'run', source: 'commandcode-terminal-result-v1', input: 13, output: 8, total: 21 },
    });

    const evidenceResponse = res();
    await routes.handleGetSessionEvidence(req({}), evidenceResponse, created.sessionId, new URLSearchParams('expand=transcript,screen'));
    expect(JSON.parse(evidenceResponse.body)).toMatchObject({
      runtime: 'commandcode',
      effort: 'low',
      requestedEffort: 'low',
      acceptedEffort: 'low',
      effectiveEffort: 'low',
      effortEvidenceMethod: 'provider-result',
      tokenUsage: { scope: 'run', source: 'commandcode-terminal-result-v1', input: 13, output: 8, total: 21 },
    });
    expect(JSON.parse(evidenceResponse.body).transcript.items.some((item: any) => item.text === 'route-ok')).toBe(true);
    expect(JSON.parse(evidenceResponse.body).screen.screenView.items.some((item: any) => item.kind === 'assistant' && item.text === 'route-ok')).toBe(true);
    expect(JSON.parse(evidenceResponse.body).screen.screenView.items.some((item: any) => item.kind === 'user' && item.text === 'say route-ok')).toBe(true);

    const releaseRetentionResponse = res();
    await routes.handleSessionControl(req({ action: 'release_retention', retentionLeaseId: created.retention.leaseId, ownerId: 'route-test' }), releaseRetentionResponse, created.sessionId);
    expect(releaseRetentionResponse.statusCode).toBe(200);
    expect(JSON.parse(releaseRetentionResponse.body)).toMatchObject({ success: true, action: 'release_retention' });
    expect(await readdir(path.join(root, 'pins'))).toEqual([]);

    const acquireRetentionResponse = res();
    await routes.handleSessionControl(req({ action: 'acquire_retention', retention: { mode: 'durable', ownerId: 'route-test-2', ttlSeconds: 900 } }), acquireRetentionResponse, created.sessionId);
    expect(acquireRetentionResponse.statusCode).toBe(200);
    const acquiredRetention = JSON.parse(acquireRetentionResponse.body);
    expect(acquiredRetention).toMatchObject({ success: true, action: 'acquire_retention', retention: { mode: 'durable', ownerId: 'route-test-2' } });

    const renewRetentionResponse = res();
    await routes.handleSessionControl(req({ action: 'renew_retention', retentionLeaseId: acquiredRetention.retention.leaseId, ownerId: 'route-test-2', pinTtlSeconds: 900 }), renewRetentionResponse, created.sessionId);
    expect(renewRetentionResponse.statusCode).toBe(200);
    expect(JSON.parse(renewRetentionResponse.body)).toMatchObject({ success: true, action: 'renew_retention', retention: { leaseId: acquiredRetention.retention.leaseId, mode: 'durable', ownerId: 'route-test-2' } });

    const releaseDurableRetentionResponse = res();
    await routes.handleSessionControl(req({ action: 'release_retention', retentionLeaseId: acquiredRetention.retention.leaseId, ownerId: 'route-test-2' }), releaseDurableRetentionResponse, created.sessionId);
    expect(releaseDurableRetentionResponse.statusCode).toBe(200);

    const transcriptResponse = res();
    await routes.handleSessionTranscript(req({}), transcriptResponse, created.sessionId, new URLSearchParams());
    expect(JSON.parse(transcriptResponse.body).runtime).toBe('commandcode');

    vi.spyOn(receipts, 'markStarted').mockRejectedValueOnce(new Error('receipt persistence failure'));
    const failedStartResponse = res();
    await routes.handleSendPrompt(req({ message: 'receipt failure must release admission' }), failedStartResponse, created.sessionId);
    expect(failedStartResponse.statusCode).toBe(500);
    expect(admission.snapshot().activeTurns).toBe(0);

    const deleteResponse = res();
    await routes.handleDeleteSession(req({}), deleteResponse, created.sessionId);
    expect(JSON.parse(deleteResponse.body).success).toBe(true);
    expect(await commandCodeService.getSession(created.sessionId)).toBeUndefined();
    expect(await readdir(path.join(root, 'pins'))).toEqual([]);
    await routes.shutdown();
  });
});
