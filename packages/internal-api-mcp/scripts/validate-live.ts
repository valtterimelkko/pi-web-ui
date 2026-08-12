import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { request } from 'node:http';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { assertSameIdentity, assertSecureSocketPath, readSecureToken } from '../src/config.js';
import { chooseValidationModel, containsAssistantMarker, parseValidationArgs, type ValidationTarget } from '../src/validation-safety.js';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '../../..');
const packageDir = path.resolve(import.meta.dirname, '..');
const compiledEntry = path.join(packageDir, 'dist', 'index.js');
const POLL_INTERVAL_MS = 500;
const STABLE_GRACE_MS = 750;
const DEFAULT_DEADLINE_MS = 180_000;
const TERMINAL_FAILURES = new Set(['failed', 'cancelled', 'interrupted']);

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

interface ToolEnvelope {
  ok: boolean;
  tool: string;
  data?: Record<string, unknown>;
  error?: { code?: string; message?: string };
}

function textOf(result: ToolResult): string {
  const item = result.content.at(0);
  return item?.type === 'text' ? item.text ?? '' : '';
}

function parseEnvelope(result: ToolResult): ToolEnvelope {
  const text = textOf(result);
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new Error('MCP returned non-JSON tool content');
  }
  if (!envelope || typeof envelope !== 'object') throw new Error('MCP returned an invalid tool envelope');
  const value = envelope as ToolEnvelope;
  if (!value.ok || result.isError) {
    throw new Error(`MCP tool ${value.tool || 'unknown'} failed: ${value.error?.code ?? 'UNKNOWN_ERROR'}`);
  }
  const data = value.data;
  if (!data || typeof data !== 'object') throw new Error('MCP tool returned no structured data');
  return { ...value, data };
}

function remainingDeadlineMs(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('MCP live validation deadline exceeded');
  return remaining;
}

async function callData(client: Client, name: string, args: Record<string, unknown>, deadline?: number): Promise<Record<string, unknown>> {
  const remaining = deadline === undefined ? undefined : remainingDeadlineMs(deadline);
  const result = await client.callTool(
    { name, arguments: args },
    undefined,
    remaining === undefined ? undefined : {
      timeout: Math.min(15_000, remaining),
      maxTotalTimeout: remaining,
    },
  ) as ToolResult;
  return parseEnvelope(result).data as Record<string, unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function uuidLike(value: unknown): value is string {
  // Pi currently emits UUIDv7 ids; the Internal API contract does not limit
  // canonical ids to the older v1-v5 UUID versions.
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function waitForExit(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await sleep(25);
    } catch {
      return;
    }
  }
  throw new Error('MCP child did not exit within the cleanup deadline');
}

async function deleteDisposableSession(target: ValidationTarget, sessionId: string): Promise<void> {
  const socketIdentity = await assertSecureSocketPath(target.socketPath);
  const token = await readSecureToken(target.tokenPath);
  const body = await new Promise<{ status: number }>((resolve, reject) => {
    const req = request({
      socketPath: target.socketPath,
      path: `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
      method: 'DELETE',
      headers: { Host: 'localhost', Accept: 'application/json', Authorization: `Bearer ${token}` },
      timeout: 15_000,
    }, (res) => {
      res.resume();
      res.once('end', () => resolve({ status: res.statusCode ?? 0 }));
      res.once('error', reject);
    });
    req.once('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error('disposable session cleanup timed out')));
    req.end();
  });
  const after = await assertSecureSocketPath(target.socketPath);
  assertSameIdentity(socketIdentity, after, 'Disposable Internal API socket');
  if (body.status < 200 || body.status >= 300) throw new Error('disposable session cleanup was rejected');
}

function deadlineMs(): number {
  const raw = process.env.PI_WEB_UI_MCP_LIVE_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_DEADLINE_MS;
  if (!/^\d+$/.test(raw)) throw new Error('PI_WEB_UI_MCP_LIVE_TIMEOUT_MS must be an integer');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 5_000 || value > 900_000) throw new Error('PI_WEB_UI_MCP_LIVE_TIMEOUT_MS is outside its safe range');
  return value;
}

async function run(target: ValidationTarget): Promise<void> {
  if (target.runtime === 'antigravity') throw new Error('Antigravity is not disposable-safe and is refused by the MCP live validator');
  const deadline = Date.now() + deadlineMs();
  await execFileAsync('npm', ['run', 'build', '--workspace=@pi-web-ui/internal-api-mcp'], {
    cwd: rootDir,
    timeout: Math.min(120_000, remainingDeadlineMs(deadline)),
  });

  const stderr: string[] = [];
  let transport: StdioClientTransport | undefined;
  let client: Client | undefined;
  let pid: number | undefined;
  let sessionId: string | undefined;
  let runId: string | undefined;
  let cleanupError: unknown;
  let primaryError: unknown;
  let successReport: string | undefined;

  try {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [compiledEntry],
      stderr: 'pipe',
      env: {
        HOME: os.homedir(),
        PATH: process.env.PATH ?? '',
        PI_WEB_UI_MCP_SOCKET_PATH: target.socketPath,
        PI_WEB_UI_MCP_TOKEN_PATH: target.tokenPath,
        PI_WEB_UI_MCP_TIMEOUT_MS: '15000',
        PI_WEB_UI_MCP_MAX_RESPONSE_BYTES: '1048576',
        PI_WEB_UI_MCP_MAX_TOOL_OUTPUT_BYTES: '131072',
      },
      cwd: packageDir,
    });
    transport.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')));
    client = new Client({ name: 'pi-web-ui-mcp-live-validator', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport, {
      timeout: Math.min(15_000, remainingDeadlineMs(deadline)),
      maxTotalTimeout: remainingDeadlineMs(deadline),
    });
    pid = transport.pid ?? undefined;
    if (!pid) throw new Error('compiled MCP process did not expose a pid');

    const capabilities = await callData(client, 'pi_web_ui_get_capabilities', {}, deadline);
    const contract = capabilities.contract as Record<string, unknown> | undefined;
    if (contract?.name !== 'pi-web-ui-internal-api' || contract.majorVersion !== 'v1') throw new Error('disposable Internal API contract identity was not confirmed');
    const runtimes = capabilities.runtimes as Record<string, Record<string, unknown>> | undefined;
    const runtimeCapability = runtimes?.[target.runtime];
    if (!runtimeCapability?.available || runtimeCapability.enabled === false) throw new Error(`selected disposable runtime is unavailable: ${target.runtime}`);

    const modelsData = await callData(client, 'pi_web_ui_list_models', { runtime: target.runtime }, deadline);
    const models = (modelsData.models as Record<string, Array<Record<string, unknown>>> | undefined)?.[target.runtime] ?? [];
    const selectedModel = chooseValidationModel(target.runtime, models);
    const createArgs: Record<string, unknown> = { runtime: target.runtime };
    if (selectedModel) createArgs.model = selectedModel;
    const created = await callData(client, 'pi_web_ui_create_session', createArgs, deadline);
    sessionId = created.sessionId as string;
    if (!uuidLike(sessionId)) throw new Error('MCP create-session did not return a canonical UUID');

    const marker = `MCP_LIVE_OK_${crypto.randomUUID()}`;
    const dispatched = await callData(client, 'pi_web_ui_dispatch_prompt', {
      sessionId,
      message: `Reply with this unique marker and no other required content: ${marker}`,
    }, deadline);
    runId = dispatched.runId as string;
    if (!uuidLike(runId) || dispatched.detached !== true) throw new Error('MCP dispatch was not accepted as a detached run');

    let receipt: Record<string, unknown> | undefined;
    while (Date.now() < deadline) {
      receipt = await callData(client, 'pi_web_ui_get_run', { runId }, deadline);
      const status = receipt.status;
      if (typeof status === 'string' && TERMINAL_FAILURES.has(status)) throw new Error(`disposable run ended with ${status}`);
      if (status === 'completed') break;
      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    }
    if (!receipt || receipt.status !== 'completed') throw new Error('disposable run did not reach completed receipt state before the deadline');
    const outputEvidence = receipt.outputEvidence as Record<string, unknown> | undefined;
    if (outputEvidence?.disposition !== 'text') throw new Error(`disposable run output evidence was ${String(outputEvidence?.disposition ?? 'missing')}`);
    if (target.runtime === 'pi' && typeof receipt.agentEndAt !== 'string') throw new Error('Pi receipt completed without agent_end evidence');

    const transcript = await callData(client, 'pi_web_ui_get_transcript', { sessionId, scope: 'visible_full' }, deadline);
    if (!containsAssistantMarker(transcript, marker)) throw new Error('unique marker was absent from assistant output in the first MCP transcript read');
    const firstReceiptHash = hashJson(receipt);
    const firstTranscriptHash = hashJson(transcript);
    await sleep(STABLE_GRACE_MS);
    const repeatedReceipt = await callData(client, 'pi_web_ui_get_run', { runId }, deadline);
    const repeatedTranscript = await callData(client, 'pi_web_ui_get_transcript', { sessionId, scope: 'visible_full' }, deadline);
    if (!containsAssistantMarker(repeatedTranscript, marker)) throw new Error('unique marker was absent from assistant output in the repeated MCP transcript read');
    if (hashJson(repeatedReceipt) !== firstReceiptHash || hashJson(repeatedTranscript) !== firstTranscriptHash) throw new Error('receipt/transcript evidence changed during bounded stable readback');

    if (stderr.join('').includes('Bearer ')) throw new Error('MCP stderr contained a bearer header');
    const modelLabel = selectedModel ?? 'runtime-default';
    successReport = [
      '✅ MCP LIVE-VALIDATED',
      'Ran on: disposable Pi Web UI validation server (production service/socket/session state untouched; real provider auth/model resources may be used)',
      'MCP transport: compiled stdio process + official SDK client',
      `Contract: pi-web-ui-internal-api / v1 / ${String(contract.contractVersion ?? 'unknown')}`,
      `Runtime/model: ${target.runtime} / ${modelLabel}`,
      `Session: ${sessionId}`,
      `Run: ${runId}`,
      'Dispatch: detached accepted',
      `Receipt: completed, outputEvidence=text, agent_end=${String(receipt.agentEndAt ?? 'not-reported')}`,
      'Transcript assertion: unique marker observed and stable across bounded repeat read',
    ].join('\n');
  } catch (error) {
    primaryError = error;
  } finally {
    if (sessionId) {
      try {
        await deleteDisposableSession(target, sessionId);
      } catch (error) {
        cleanupError = error;
      }
    }
    try {
      await client?.close();
    } catch (error) {
      cleanupError ??= error;
    }
    try {
      await transport?.close();
    } catch (error) {
      cleanupError ??= error;
    }
    try {
      if (pid) await waitForExit(pid);
    } catch (error) {
      cleanupError ??= error;
    }
  }
  if (cleanupError) throw new Error(`MCP live cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : 'unknown error'}`);
  if (primaryError) throw primaryError;
  if (successReport) console.log(successReport);
}

const target = (() => {
  try {
    return parseValidationArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`❌ MCP LIVE VALIDATION BLOCKED: ${error instanceof Error ? error.message : 'invalid target'}`);
    process.exit(2);
    throw error;
  }
})();

run(target).catch((error: unknown) => {
  console.error(`❌ MCP LIVE VALIDATION FAILED: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
});
