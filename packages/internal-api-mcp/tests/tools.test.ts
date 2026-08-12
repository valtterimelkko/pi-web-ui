import { describe, expect, it, vi } from 'vitest';
import {
  TOOL_NAMES,
  createToolHandlers,
  registerMcpTools,
} from '../src/tools.js';
import {
  createSessionSchema,
  dispatchPromptSchema,
  getCapabilitiesSchema,
  getRunSchema,
  getTranscriptSchema,
  listModelsSchema,
  listSessionsSchema,
} from '../src/tool-schemas.js';
import type { InternalApiClient } from '../src/internal-api-client.js';
import type { McpConfig } from '../src/config.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';
const config: McpConfig = {
  socketPath: '/tmp/socket',
  tokenPath: '/tmp/token',
  timeoutMs: 1000,
  maxResponseBytes: 4096,
  maxToolOutputBytes: 4096,
};

function fakeClient(overrides: Partial<InternalApiClient> = {}): InternalApiClient {
  return {
    getCapabilities: vi.fn(async () => ({
      contract: { name: 'pi-web-ui-internal-api', routePrefix: '/api/v1', majorVersion: 'v1', contractVersion: '1.19.0' },
      runtimes: {},
    })),
    listModels: vi.fn(async () => ({ models: { pi: [{ id: 'model-1' }] } })),
    listSessions: vi.fn(async () => ({ sessions: [{ sessionId, runtime: 'pi', status: 'idle' }] })),
    createSession: vi.fn(async () => ({ sessionId, runtime: 'pi', model: 'model-1', createdAt: '2026-01-01T00:00:00.000Z' })),
    dispatchPrompt: vi.fn(async () => ({ sessionId, runId, detached: true, status: 'accepted' })),
    getRun: vi.fn(async () => ({ runId, sessionId, runtime: 'pi', status: 'completed', outputEvidence: { disposition: 'text' } })),
    getTranscript: vi.fn(async () => ({ sessionId, runtime: 'pi', scope: 'visible_recent', items: [{ kind: 'assistant', text: 'Done.' }] })),
    ...overrides,
  } as unknown as InternalApiClient;
}

describe('MCP tool schemas and handlers', () => {
  it('exposes exactly the seven locked tool names', () => {
    expect(TOOL_NAMES).toEqual([
      'pi_web_ui_get_capabilities',
      'pi_web_ui_list_models',
      'pi_web_ui_list_sessions',
      'pi_web_ui_create_session',
      'pi_web_ui_dispatch_prompt',
      'pi_web_ui_get_run',
      'pi_web_ui_get_transcript',
    ]);
  });

  it('uses strict schemas and rejects unknown keys', () => {
    expect(getCapabilitiesSchema.safeParse({ extra: true }).success).toBe(false);
    expect(listSessionsSchema.safeParse({ extra: true }).success).toBe(false);
    expect(listModelsSchema.safeParse({ runtime: 'commandcode' }).success).toBe(false);
    expect(createSessionSchema.safeParse({ runtime: 'pi', cwd: '/tmp' }).success).toBe(false);
    expect(dispatchPromptSchema.safeParse({ sessionId, message: 'hi', raw: true }).success).toBe(false);
    expect(getRunSchema.safeParse({ runId, extra: true }).success).toBe(false);
    expect(getTranscriptSchema.safeParse({ sessionId, scope: 'screen' }).success).toBe(false);
  });

  it('enforces bounded ids, model selectors, messages, and idempotency keys', () => {
    expect(createSessionSchema.safeParse({ runtime: 'pi', model: 'x'.repeat(201) }).success).toBe(false);
    expect(dispatchPromptSchema.safeParse({ sessionId, message: '' }).success).toBe(false);
    expect(dispatchPromptSchema.safeParse({ sessionId, message: 'x'.repeat(16001) }).success).toBe(false);
    expect(dispatchPromptSchema.safeParse({ sessionId, message: 'ok', idempotencyKey: 'x'.repeat(129) }).success).toBe(false);
    expect(dispatchPromptSchema.safeParse({ sessionId: 'not-a-uuid', message: 'ok' }).success).toBe(false);
    expect(getRunSchema.safeParse({ runId: 'not-a-uuid' }).success).toBe(false);
  });

  it('constructs fixed create and detached dispatch calls and returns generated idempotency keys', async () => {
    const client = fakeClient();
    const handlers = createToolHandlers({ client, config });
    await handlers.pi_web_ui_get_capabilities({});
    await handlers.pi_web_ui_list_models({});
    await handlers.pi_web_ui_list_sessions({});
    const created = await handlers.pi_web_ui_create_session({ runtime: 'pi' });
    const dispatched = await handlers.pi_web_ui_dispatch_prompt({ sessionId, message: 'Reply with marker.' });

    expect(created.isError).not.toBe(true);
    expect(dispatched.isError).not.toBe(true);
    expect(client.createSession).toHaveBeenCalledWith({ runtime: 'pi' }, undefined);
    expect(client.dispatchPrompt).toHaveBeenCalledWith(
      sessionId,
      { message: 'Reply with marker.', idempotencyKey: expect.any(String) },
      undefined,
    );
    const data = JSON.parse(dispatched.content[0]!.text).data;
    expect(data.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(data.detached).toBe(true);
  });

  it('uses the fixed process cwd only and does not expose cwd/control/retention inputs', async () => {
    const client = fakeClient();
    const handlers = createToolHandlers({ client, config: { ...config, defaultCwd: '/tmp/fixed-worktree' } });
    await handlers.pi_web_ui_create_session({ runtime: 'pi', model: 'model-1' });
    expect(client.createSession).toHaveBeenCalledWith({ runtime: 'pi', model: 'model-1', cwd: '/tmp/fixed-worktree' }, undefined);
  });

  it('marks read tools read-only and create/dispatch as writes with dispatch destructive', () => {
    const registered: Array<{ name: string; config: Record<string, unknown> }> = [];
    const fakeServer = {
      registerTool(name: string, toolConfig: Record<string, unknown>) {
        registered.push({ name, config: toolConfig });
      },
    };
    registerMcpTools(fakeServer as never, { client: fakeClient(), config });

    expect(registered).toHaveLength(7);
    for (const tool of registered.slice(0, 3).concat(registered.slice(5))) {
      expect(tool.config.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    }
    expect(registered[3]!.config.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(registered[4]!.config.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
  });

  it('refuses dispatch to a session belonging to an excluded runtime', async () => {
    const client = fakeClient({
      listSessions: vi.fn(async () => ({ sessions: [{ sessionId, runtime: 'commandcode' }] })),
    });
    const handlers = createToolHandlers({ client, config });
    const result = await handlers.pi_web_ui_dispatch_prompt({ sessionId, message: 'do not dispatch' });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text).error.code).toBe('UNSUPPORTED_RUNTIME');
    expect(client.dispatchPrompt).not.toHaveBeenCalled();
  });

  it('returns stable bounded errors instead of throwing raw client errors', async () => {
    const client = fakeClient({
      getRun: vi.fn(async () => {
        throw Object.assign(new Error('Bearer sentinel-token cookie=secret'), { code: 'SESSION_NOT_FOUND', status: 404 });
      }),
    });
    const handlers = createToolHandlers({ client, config });
    const result = await handlers.pi_web_ui_get_run({ runId });
    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0]!.text);
    expect(envelope).toEqual({
      ok: false,
      tool: 'pi_web_ui_get_run',
      error: { code: 'INTERNAL_ERROR', message: 'The tool request failed.', retryable: false },
    });
    expect(result.content[0]!.text).not.toContain('sentinel-token');
    expect(result.content[0]!.text).not.toContain('secret');
  });

  it('keeps structured and text error representations within the output ceiling', async () => {
    const client = fakeClient({
      getRun: vi.fn(async () => {
        throw new (await import('../src/errors.js')).InternalApiClientError('UPSTREAM_ERROR', 'upstream failed', {
          hint: 'h'.repeat(512),
          docs: 'd'.repeat(512),
          retryable: true,
        });
      }),
    });
    const handlers = createToolHandlers({ client, config: { ...config, maxToolOutputBytes: 1024 } });
    const result = await handlers.pi_web_ui_get_run({ runId });
    const textBytes = Buffer.byteLength(result.content[0]!.text, 'utf8');
    const structuredBytes = Buffer.byteLength(JSON.stringify(result.structuredContent), 'utf8');
    expect(textBytes + structuredBytes).toBeLessThanOrEqual(1024);
  });

  it('returns explicit transcript truncation as valid structured JSON', async () => {
    const client = fakeClient({
      getTranscript: vi.fn(async () => ({ sessionId, runtime: 'pi', scope: 'visible_full', items: [{ kind: 'assistant', text: '🙂'.repeat(500) }] })),
    });
    const handlers = createToolHandlers({ client, config: { ...config, maxToolOutputBytes: 1200 } });
    const result = await handlers.pi_web_ui_get_transcript({ sessionId, scope: 'visible_full' });
    expect(result.isError).not.toBe(true);
    const envelope = JSON.parse(result.content[0]!.text);
    expect(envelope.data.outputTruncated).toBe(true);
    expect(envelope.data.projectedByteCount).toBeGreaterThan(600);
    const textBytes = Buffer.byteLength(result.content[0]!.text, 'utf8');
    const structuredBytes = Buffer.byteLength(JSON.stringify(result.structuredContent), 'utf8');
    expect(textBytes + structuredBytes).toBeLessThanOrEqual(1200);
  });
});
