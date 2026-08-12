import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { McpConfig } from './config.js';
import { InternalApiClient, InternalApiClientError } from './internal-api-client.js';
import {
  isOrdinaryRuntime,
  projectCapabilities,
  projectCreateSession,
  projectDispatch,
  projectModels,
  projectRun,
  projectSessions,
  projectTranscript,
} from './projections.js';
import {
  createSessionSchema,
  dispatchPromptSchema,
  getCapabilitiesSchema,
  getRunSchema,
  getTranscriptSchema,
  listModelsSchema,
  listSessionsSchema,
  type DispatchPromptInput as ToolDispatchPromptInput,
  type GetRunInput,
  type GetTranscriptInput,
  type ListModelsInput,
} from './tool-schemas.js';
import type { CreateSessionInput as ApiCreateSessionInput, DispatchPromptInput as ApiDispatchPromptInput } from './internal-api-types.js';

export const TOOL_NAMES = [
  'pi_web_ui_get_capabilities',
  'pi_web_ui_list_models',
  'pi_web_ui_list_sessions',
  'pi_web_ui_create_session',
  'pi_web_ui_dispatch_prompt',
  'pi_web_ui_get_run',
  'pi_web_ui_get_transcript',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export interface ToolClient {
  getCapabilities(signal?: AbortSignal): ReturnType<InternalApiClient['getCapabilities']>;
  listModels(runtime?: ListModelsInput['runtime'], signal?: AbortSignal): ReturnType<InternalApiClient['listModels']>;
  listSessions(signal?: AbortSignal): ReturnType<InternalApiClient['listSessions']>;
  createSession(input: ApiCreateSessionInput, signal?: AbortSignal): ReturnType<InternalApiClient['createSession']>;
  dispatchPrompt(sessionId: string, input: ApiDispatchPromptInput, signal?: AbortSignal): ReturnType<InternalApiClient['dispatchPrompt']>;
  getRun(runId: string, signal?: AbortSignal): ReturnType<InternalApiClient['getRun']>;
  getTranscript(sessionId: string, scope: GetTranscriptInput['scope'], signal?: AbortSignal): ReturnType<InternalApiClient['getTranscript']>;
}

export interface ToolDependencies {
  client: ToolClient;
  config: McpConfig;
}

export type ToolHandler<TInput extends Record<string, unknown>> = (input: TInput, signal?: AbortSignal) => Promise<CallToolResult>;

export interface ToolHandlers {
  pi_web_ui_get_capabilities: ToolHandler<Record<string, never>>;
  pi_web_ui_list_models: ToolHandler<ListModelsInput>;
  pi_web_ui_list_sessions: ToolHandler<Record<string, never>>;
  pi_web_ui_create_session: ToolHandler<import('./tool-schemas.js').CreateSessionInput>;
  pi_web_ui_dispatch_prompt: ToolHandler<ToolDispatchPromptInput>;
  pi_web_ui_get_run: ToolHandler<GetRunInput>;
  pi_web_ui_get_transcript: ToolHandler<GetTranscriptInput>;
}

function serializeEnvelope(envelope: Record<string, unknown>): string {
  return JSON.stringify(envelope);
}

function errorEnvelope(tool: ToolName, error: unknown): Record<string, unknown> {
  if (error instanceof InternalApiClientError) {
    return {
      ok: false,
      tool,
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
        ...(error.hint === undefined ? {} : { hint: error.hint }),
        ...(error.docs === undefined ? {} : { docs: error.docs }),
      },
    };
  }
  return {
    ok: false,
    tool,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'The tool request failed.',
      retryable: false,
    },
  };
}

function wireByteCount(envelope: Record<string, unknown>): number {
  const serialized = serializeEnvelope(envelope);
  return Buffer.byteLength(serialized, 'utf8') * 2;
}

function failureResult(tool: ToolName, error: unknown, maxBytes: number): CallToolResult {
  let envelope = errorEnvelope(tool, error);
  if (wireByteCount(envelope) > maxBytes) {
    const originalError = envelope.error as Record<string, unknown>;
    envelope = {
      ok: false,
      tool,
      error: {
        code: typeof originalError.code === 'string' ? originalError.code : 'INTERNAL_ERROR',
        message: 'The tool request failed; diagnostic details were omitted to respect the output limit.',
        retryable: originalError.retryable === true,
      },
    };
  }
  return {
    isError: true,
    structuredContent: envelope,
    content: [{ type: 'text', text: serializeEnvelope(envelope) }],
  };
}

function successResult(tool: ToolName, data: Record<string, unknown>, maxBytes: number): CallToolResult {
  const envelope = { ok: true, tool, data };
  const text = serializeEnvelope(envelope);
  const textBytes = Buffer.byteLength(text, 'utf8');
  const structuredBytes = Buffer.byteLength(serializeEnvelope(envelope), 'utf8');
  const projectedByteCount = textBytes + structuredBytes;
  if (projectedByteCount <= maxBytes) {
    return { structuredContent: envelope, content: [{ type: 'text', text }] };
  }
  const boundedError = {
    ok: false,
    tool,
    error: {
      code: 'TOOL_OUTPUT_TOO_LARGE',
      message: 'The projected tool result exceeded the configured output limit.',
      retryable: false,
      projectedByteCount,
    },
  };
  return {
    isError: true,
    structuredContent: boundedError,
    content: [{ type: 'text', text: serializeEnvelope(boundedError) }],
  };
}

function invoke(
  tool: ToolName,
  maxBytes: number,
  operation: () => Promise<Record<string, unknown>>,
): Promise<CallToolResult> {
  return operation().then((data) => successResult(tool, data, maxBytes)).catch((error: unknown) => failureResult(tool, error, maxBytes));
}

export function createToolHandlers({ client, config }: ToolDependencies): ToolHandlers {
  return {
    pi_web_ui_get_capabilities: (_input, signal) => invoke('pi_web_ui_get_capabilities', config.maxToolOutputBytes, async () => ({
      ...projectCapabilities(await client.getCapabilities(signal)),
    })),

    pi_web_ui_list_models: (input, signal) => invoke('pi_web_ui_list_models', config.maxToolOutputBytes, async () => ({
      ...projectModels(await client.listModels(input.runtime, signal)),
    })),

    pi_web_ui_list_sessions: (_input, signal) => invoke('pi_web_ui_list_sessions', config.maxToolOutputBytes, async () => ({
      ...projectSessions(await client.listSessions(signal)),
    })),

    pi_web_ui_create_session: (input, signal) => invoke('pi_web_ui_create_session', config.maxToolOutputBytes, async () => {
      const request: ApiCreateSessionInput = { runtime: input.runtime };
      if (input.model !== undefined) request.model = input.model;
      if (config.defaultCwd !== undefined) request.cwd = config.defaultCwd;
      return projectCreateSession(await client.createSession(request, signal));
    }),

    pi_web_ui_dispatch_prompt: (input, signal) => invoke('pi_web_ui_dispatch_prompt', config.maxToolOutputBytes, async () => {
      const session = (await client.listSessions(signal)).sessions.find((candidate) => candidate.sessionId === input.sessionId);
      if (!session) {
        throw new InternalApiClientError('SESSION_NOT_FOUND', 'The requested session was not found in the ordinary runtime session index.');
      }
      if (!isOrdinaryRuntime(session.runtime)) {
        throw new InternalApiClientError('UNSUPPORTED_RUNTIME', 'The requested session belongs to a runtime excluded from the MCP adapter.');
      }
      const idempotencyKey = input.idempotencyKey ?? randomUUID();
      return {
        ...projectDispatch(await client.dispatchPrompt(input.sessionId, { message: input.message, idempotencyKey }, signal)),
        idempotencyKey,
      };
    }),

    pi_web_ui_get_run: (input, signal) => invoke('pi_web_ui_get_run', config.maxToolOutputBytes, async () => ({
      ...projectRun(await client.getRun(input.runId, signal)),
    })),

    pi_web_ui_get_transcript: (input, signal) => invoke('pi_web_ui_get_transcript', config.maxToolOutputBytes, async () => ({
      // Reserve space for the MCP adapter envelope so the structured result,
      // not only the transcript data object, remains below the tool ceiling.
      ...projectTranscript(
        await client.getTranscript(input.sessionId, input.scope, signal),
        Math.max(512, Math.floor((config.maxToolOutputBytes - 512) / 2)),
      ),
    })),
  };
}

interface ToolDefinition {
  name: ToolName;
  title: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  annotations: ToolAnnotations;
  handler: (input: Record<string, unknown>, signal: AbortSignal) => Promise<CallToolResult>;
}

const READ_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const WRITE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

const DISPATCH_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

export function registerMcpTools(server: McpServer, dependencies: ToolDependencies): void {
  const handlers = createToolHandlers(dependencies);
  const registrar = server as unknown as {
    registerTool: (
      name: string,
      config: { title: string; description: string; inputSchema: z.ZodTypeAny; annotations: ToolAnnotations },
      callback: (input: unknown, extra: { signal: AbortSignal }) => Promise<CallToolResult>,
    ) => unknown;
  };
  const definitions: ToolDefinition[] = [
    {
      name: 'pi_web_ui_get_capabilities',
      title: 'Pi Web UI capabilities',
      description: 'Read the four ordinary Pi Web UI runtime capabilities and automation provider policy.',
      inputSchema: getCapabilitiesSchema,
      annotations: READ_ANNOTATIONS,
      handler: (input, signal) => handlers.pi_web_ui_get_capabilities(input as Record<string, never>, signal),
    },
    {
      name: 'pi_web_ui_list_models',
      title: 'Pi Web UI models',
      description: 'Read currently advertised models, optionally for one ordinary runtime.',
      inputSchema: listModelsSchema,
      annotations: READ_ANNOTATIONS,
      handler: (input, signal) => handlers.pi_web_ui_list_models(input as ListModelsInput, signal),
    },
    {
      name: 'pi_web_ui_list_sessions',
      title: 'Pi Web UI sessions',
      description: 'Read bounded metadata for ordinary Pi Web UI sessions.',
      inputSchema: listSessionsSchema,
      annotations: READ_ANNOTATIONS,
      handler: (input, signal) => handlers.pi_web_ui_list_sessions(input as Record<string, never>, signal),
    },
    {
      name: 'pi_web_ui_create_session',
      title: 'Create Pi Web UI session',
      description: 'Create one ordinary Pi Web UI runtime session using an advertised model selector.',
      inputSchema: createSessionSchema,
      annotations: WRITE_ANNOTATIONS,
      handler: (input, signal) => handlers.pi_web_ui_create_session(input as import('./tool-schemas.js').CreateSessionInput, signal),
    },
    {
      name: 'pi_web_ui_dispatch_prompt',
      title: 'Dispatch detached Pi Web UI prompt',
      description: 'Potentially destructive: dispatch a detached prompt that may modify files, call tools, or incur provider usage.',
      inputSchema: dispatchPromptSchema,
      annotations: DISPATCH_ANNOTATIONS,
      handler: (input, signal) => handlers.pi_web_ui_dispatch_prompt(input as ToolDispatchPromptInput, signal),
    },
    {
      name: 'pi_web_ui_get_run',
      title: 'Read Pi Web UI run receipt',
      description: 'Read a bounded payload-free durable run receipt and its completion evidence.',
      inputSchema: getRunSchema,
      annotations: READ_ANNOTATIONS,
      handler: (input, signal) => handlers.pi_web_ui_get_run(input as GetRunInput, signal),
    },
    {
      name: 'pi_web_ui_get_transcript',
      title: 'Read Pi Web UI transcript',
      description: 'Read bounded runtime-neutral visible session output; transcript content may be sensitive and is not sanitized.',
      inputSchema: getTranscriptSchema,
      annotations: READ_ANNOTATIONS,
      handler: (input, signal) => handlers.pi_web_ui_get_transcript(input as GetTranscriptInput, signal),
    },
  ];

  for (const definition of definitions) {
    registrar.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
        annotations: definition.annotations,
      },
      (input, extra) => definition.handler(input as Record<string, unknown>, extra.signal),
    );
  }
}
