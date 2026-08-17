import { mkdtemp, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { AdmissionController } from '../../../src/internal-api/admission-controller.js';
import { RunReceiptManager } from '../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../../../src/internal-api/run-receipts/run-receipt-store.js';
import { createSessionRoutes } from '../../../src/internal-api/routes/sessions.js';
import { createModelsRoutes } from '../../../src/internal-api/routes/models.js';
import { CommandCodeService } from '../../../src/command-code/command-code-service.js';
import type { CommandCodeProcessRunInput, CommandCodeProcessRunResult } from '../../../src/command-code/command-code-process-runner.js';
import { ADVERTISED_IDS, COMMAND_CODE_EXCLUDED_IDS } from './command-code-fixture.js';

function req(body: unknown, url = '/api/v1/sessions'): any {
  const value = Readable.from([Buffer.from(JSON.stringify(body ?? {}))]) as any;
  value.headers = {};
  value.method = 'POST';
  value.url = url;
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

async function buildHarness() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-code-routes-'));
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-routes-cwd-'));
  const runner = new Runner();
  const commandCodeService = new CommandCodeService({
    config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir: root, allowedCwdRoots: [cwd] },
    runner,
    discover: async () => ({ version: '1.23.2', models: [...ADVERTISED_IDS], ambiguous: [] }),
    checkExecutable: false,
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
  return { root, cwd, runner, commandCodeService, routes, admission };
}

describe('Command Code Internal API lifecycle', () => {
  it('lists the 35 eligible models with effort metadata and no catalogue envelope', async () => {
    const { commandCodeService } = await buildHarness();
    const modelsRoutes = createModelsRoutes({
      piService: {} as any, claudeService: {} as any, opencodeService: {} as any, antigravityService: {} as any,
      commandCodeService,
    });
    const modelsResponse = res();
    await modelsRoutes.handleListModels(req(undefined, '/api/v1/models?runtime=commandcode'), modelsResponse);
    expect(modelsResponse.statusCode, modelsResponse.body).toBe(200);
    const body = JSON.parse(modelsResponse.body);
    expect(body.models.commandcode).toHaveLength(35);
    for (const excluded of COMMAND_CODE_EXCLUDED_IDS) {
      expect(body.models.commandcode.map((model: { id: string }) => model.id)).not.toContain(excluded);
    }
    const qwen = body.models.commandcode.find((model: { id: string }) => model.id === 'qwen/qwen3.8-max');
    expect(qwen).toMatchObject({ effortLevels: ['low', 'medium', 'xhigh'], defaultEffort: 'medium' });
    expect(body.catalogueMetadata).toBeUndefined();
  });

  it('creates without any attestation; excluded models and unsupported efforts are rejected before spawn', async () => {
    const { cwd, runner, routes } = await buildHarness();

    const excludedResponse = res();
    await routes.handleCreateSession(req({ runtime: 'commandcode', cwd, model: 'claude-opus-5' }), excludedResponse);
    expect(excludedResponse.statusCode).toBe(400);
    expect(JSON.parse(excludedResponse.body).code).toBe('COMMANDCODE_PLAN_INELIGIBLE');

    const effortResponse = res();
    await routes.handleCreateSession(req({ runtime: 'commandcode', cwd, model: 'qwen/qwen3.8-max', effort: 'max' }), effortResponse);
    expect(effortResponse.statusCode).toBe(400);
    expect(JSON.parse(effortResponse.body).code).toBe('COMMANDCODE_EFFORT_UNSUPPORTED');
    expect(runner.inputs).toHaveLength(0);

    const createResponse = res();
    await routes.handleCreateSession(req({ runtime: 'commandcode', cwd, model: 'qwen/qwen3.8-max', effort: 'xhigh' }), createResponse);
    expect(createResponse.statusCode, createResponse.body).toBe(201);
    const created = JSON.parse(createResponse.body);
    expect(created).toMatchObject({ runtime: 'commandcode', model: 'qwen/qwen3.8-max', effort: 'xhigh' });

    // Legacy Agent OS callers may still send role fields; they are accepted and ignored.
    const shimResponse = res();
    await routes.handleCreateSession(req({
      runtime: 'commandcode', cwd, model: 'deepseek/deepseek-v4-flash',
      invocationRole: 'conductor-root', commandCodeAttestation: { junk: true },
    }), shimResponse);
    expect(shimResponse.statusCode, shimResponse.body).toBe(201);

    await routes.shutdown();
  });

  it('prompt returns a terminal receipt and transcript carrying the exact model; delete releases the process', async () => {
    const { root, cwd, runner, commandCodeService, routes, admission } = await buildHarness();

    const createResponse = res();
    await routes.handleCreateSession(req({ runtime: 'commandcode', cwd, model: 'deepseek/deepseek-v4-flash' }), createResponse);
    expect(createResponse.statusCode, createResponse.body).toBe(201);
    const created = JSON.parse(createResponse.body);

    const promptResponse = res();
    await routes.handleSendPrompt(req({ message: 'say route-ok' }), promptResponse, created.sessionId);
    expect(promptResponse.statusCode, promptResponse.body).toBe(200);
    expect(JSON.parse(promptResponse.body).content).toBe('route-ok');
    expect(runner.inputs[0]?.model).toBe('deepseek/deepseek-v4-flash');

    const receiptResponse = res();
    await routes.handleGetRunReceipt(req({}), receiptResponse, JSON.parse(promptResponse.body).runId);
    expect(JSON.parse(receiptResponse.body)).toMatchObject({
      status: 'completed',
      runtime: 'commandcode',
      model: 'deepseek/deepseek-v4-flash',
    });

    const evidenceResponse = res();
    await routes.handleGetSessionEvidence(req({}), evidenceResponse, created.sessionId, new URLSearchParams('expand=transcript'));
    const evidence = JSON.parse(evidenceResponse.body);
    expect(evidence.runtime).toBe('commandcode');
    expect(evidence.model).toBe('deepseek/deepseek-v4-flash');
    expect(evidence.transcript.items.some((item: { text?: string }) => item.text === 'route-ok')).toBe(true);

    const deleteResponse = res();
    await routes.handleDeleteSession(req({}), deleteResponse, created.sessionId);
    expect(JSON.parse(deleteResponse.body).success).toBe(true);
    expect(await commandCodeService.getSession(created.sessionId)).toBeUndefined();
    expect(admission.snapshot().activeTurns).toBe(0);
    expect(await readdir(path.join(root, 'pins'))).toEqual([]);
    await routes.shutdown();
  });

  it('serves Command Code sessions on GET /sessions/:id and /sessions/:id/info like every other runtime', async () => {
    const { cwd, routes } = await buildHarness();

    const createResponse = res();
    await routes.handleCreateSession(req({ runtime: 'commandcode', cwd, model: 'qwen/qwen3.8-max' }), createResponse);
    expect(createResponse.statusCode, createResponse.body).toBe(201);
    const created = JSON.parse(createResponse.body);

    const getResponse = res();
    await routes.handleGetSession(req({}), getResponse, created.sessionId);
    expect(getResponse.statusCode, getResponse.body).toBe(200);
    expect(JSON.parse(getResponse.body)).toMatchObject({
      sessionId: created.sessionId,
      runtime: 'commandcode',
      backendMode: 'subprocess',
    });

    const infoResponse = res();
    await routes.handleGetSessionInfo(req({}), infoResponse, created.sessionId);
    expect(infoResponse.statusCode, infoResponse.body).toBe(200);
    expect(JSON.parse(infoResponse.body)).toMatchObject({
      sessionId: created.sessionId,
      runtime: 'commandcode',
      messageCount: expect.any(Number),
    });

    await routes.shutdown();
  });
});
