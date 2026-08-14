import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { buildCommandCodeArgs } from '../../../src/command-code/command-code-config.js';
import { commandCodeEffortSpec } from '../../../src/command-code/command-code-model-catalog.js';
import { CommandCodeService } from '../../../src/command-code/command-code-service.js';
import type { CommandCodeProcessRunInput, CommandCodeProcessRunResult } from '../../../src/command-code/command-code-process-runner.js';
import { createSessionRoutes } from '../../../src/internal-api/routes/sessions.js';
import { AdmissionController } from '../../../src/internal-api/admission-controller.js';
import { RunReceiptManager } from '../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../../../src/internal-api/run-receipts/run-receipt-store.js';

const CONTAINMENT_TOKENS = ['bwrap', 'slirp4netns', '--unshare-net', '--yolo'];

/** Argv shape comparison ignores per-session resume ids and per-request effort values. */
function argvShape(args: string[]): string[] {
  let shape = args;
  for (const flag of ['--resume', '--effort']) {
    const index = shape.indexOf(flag);
    if (index !== -1) shape = [...shape.slice(0, index), ...shape.slice(index + 2)];
  }
  return shape;
}

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

class RecordingRunner {
  inputs: CommandCodeProcessRunInput[] = [];
  async run(input: CommandCodeProcessRunInput): Promise<CommandCodeProcessRunResult> {
    this.inputs.push(input);
    return {
      exitCode: 0, signal: null, stderrTail: '',
      parsed: {
        events: [
          { event: { type: 'message_start' }, lineNumber: 1 },
          { event: { type: 'text_delta', delta: 'one-process-ok' }, lineNumber: 2 },
          { event: { type: 'message_end' }, lineNumber: 3 },
          { event: { type: 'turn_end' }, lineNumber: 4 },
        ],
        terminal: { type: 'result', subtype: 'success', sessionId: `native-${this.inputs.length}`, finalText: 'one-process-ok', usage: { input: 1, output: 1, total: 2 } },
        unknownEventTypes: [], suppressedDuplicateCount: 0, bytes: 1, lineCount: 5,
      },
    };
  }
  async abort() {}
  async shutdown() {}
  isRunning() { return false; }
}

describe('Command Code simplicity gates', () => {
  it('buildCommandCodeArgs never emits containment tokens for any model', () => {
    const models = [
      'qwen/qwen3.8-max',
      'deepseek/deepseek-v4-flash',
      'moonshotai/kimi-k3',
      'unknown/new-model',
    ];
    for (const model of models) {
      const spec = commandCodeEffortSpec(model);
      for (const effort of [undefined, ...spec.effortLevels]) {
        const args = buildCommandCodeArgs({ executablePath: '/opt/bin/cmd', model, maxTurns: 8, effort });
        const joined = args.join(' ');
        for (const token of CONTAINMENT_TOKENS) {
          expect(joined, `${model} ${effort ?? 'no-effort'}`).not.toContain(token);
        }
      }
    }
    expect(buildCommandCodeArgs({ executablePath: '/opt/bin/cmd', model: 'qwen/qwen3.8-max', maxTurns: 8 })).toEqual([
      '-p', '--output-format', 'json', '--model', 'qwen/qwen3.8-max',
      '--max-turns', '8', '--trust', '--skip-onboarding', '--no-auto-update', '--plan',
    ]);
    expect(buildCommandCodeArgs({ executablePath: '/opt/bin/cmd', model: 'qwen/qwen3.8-max', maxTurns: 8, effort: 'xhigh' })).toEqual([
      '-p', '--output-format', 'json', '--model', 'qwen/qwen3.8-max',
      '--max-turns', '8', '--trust', '--skip-onboarding', '--no-auto-update', '--plan',
      '--effort', 'xhigh',
    ]);
    expect(buildCommandCodeArgs({ executablePath: '/opt/bin/cmd', model: 'qwen/qwen3.8-max', maxTurns: 8, nativeSessionId: 'native-9' })).toContain('--resume');
  });

  it('a browser create and an Internal API create each spawn exactly one process with the same argv shape', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'command-code-simplicity-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-simplicity-cwd-'));
    const runner = new RecordingRunner();
    const service = new CommandCodeService({
      config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir: root, allowedCwdRoots: [cwd] },
      runner,
      discover: async () => ({
        version: '1.23.2',
        models: ['qwen/qwen3.8-max', 'deepseek/deepseek-v4-flash'],
        ambiguous: [],
      }),
      checkExecutable: false,
    });

    // Browser leg: the direct service path the WebSocket connection uses.
    const browserSession = await service.createSession({ cwd, model: 'qwen/qwen3.8-max', effort: 'medium' });
    await service.sendPrompt(browserSession.sessionId, 'browser turn', () => undefined);

    // Internal API leg: the full HTTP route path.
    const registry = { get: vi.fn().mockResolvedValue(undefined), listAll: vi.fn().mockResolvedValue([]) } as any;
    const receipts = new RunReceiptManager({ store: new RunReceiptStore(path.join(root, 'receipts')), turnIdleTimeoutMs: 10_000, turnMaxMs: 10_000 });
    const admission = new AdmissionController({ maxActiveTurns: 2, interactiveReserve: 0, minimumHeadroomBytes: 1, hostMinimumHeadroomBytes: 1, reservedBytesPerTurn: 1, memory: () => ({ currentBytes: 1, limitBytes: 1_000_000 }), readPids: () => ({} as any), host: () => ({ memAvailableBytes: 1_000_000 } as any) });
    const routes = createSessionRoutes({
      claudeService: {} as any, opencodeService: {} as any, antigravityService: {} as any,
      multiSessionManager: {} as any, sessionRegistry: registry, piService: {} as any,
      internalClientId: 'test', watchDir: path.join(root, 'watches'), pinDir: path.join(root, 'pins'),
      runReceiptManager: receipts, admissionController: admission, commandCodeService: service,
    });
    await routes.ready;

    const createResponse = res();
    await routes.handleCreateSession(req({ runtime: 'commandcode', cwd, model: 'qwen/qwen3.8-max', effort: 'low' }), createResponse);
    expect(createResponse.statusCode, createResponse.body).toBe(201);
    const created = JSON.parse(createResponse.body);
    const promptResponse = res();
    await routes.handleSendPrompt(req({ message: 'api turn' }), promptResponse, created.sessionId);
    expect(promptResponse.statusCode, promptResponse.body).toBe(200);

    // Exactly one subprocess per turn — no sandbox helper, no egress helper.
    expect(runner.inputs).toHaveLength(2);
    const [browserTurn, apiTurn] = runner.inputs;
    expect((browserTurn as Record<string, unknown>).browserAuthFd).toBeUndefined();
    expect((apiTurn as Record<string, unknown>).browserAuthFd).toBeUndefined();
    expect((browserTurn as Record<string, unknown>).permissionProfile).toBeUndefined();
    expect((apiTurn as Record<string, unknown>).permissionProfile).toBeUndefined();

    const browserArgv = buildCommandCodeArgs({
      executablePath: '/opt/bin/cmd', model: browserTurn.model, maxTurns: browserTurn.maxTurns,
      effort: browserTurn.effort, nativeSessionId: browserTurn.nativeSessionId,
    });
    const apiArgv = buildCommandCodeArgs({
      executablePath: '/opt/bin/cmd', model: apiTurn.model, maxTurns: apiTurn.maxTurns,
      effort: apiTurn.effort, nativeSessionId: apiTurn.nativeSessionId,
    });
    // Same argv shape modulo the per-session --resume identity and effort value.
    expect(argvShape(browserArgv)).toEqual(argvShape(apiArgv));
    for (const argv of [browserArgv, apiArgv]) {
      for (const token of CONTAINMENT_TOKENS) expect(argv.join(' ')).not.toContain(token);
    }
    await routes.shutdown();
    await service.shutdown();
  });
});
