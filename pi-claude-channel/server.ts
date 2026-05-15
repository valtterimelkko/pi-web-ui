import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const WS_PORT = parseInt(process.env.CLAUDE_CHANNEL_WS_PORT || "3100");
const HOOK_PORT = parseInt(process.env.CLAUDE_CHANNEL_HOOK_PORT || "3101");

interface WSData {
  sessionId: string;
}

const sessionClients = new Map<string, Set<Bun.ServerWebSocket<WSData>>>();
const sessionHistory = new Map<string, Array<Record<string, unknown>>>();
const sessionModels = new Map<string, string>();
const sessionStatusMap = new Map<string, string>();
const sessionLastDisconnect = new Map<string, number>();
const pendingPermissions = new Map<
  string,
  {
    resolve: (value: { allowed: boolean }) => void;
    reject: (reason?: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

function broadcast(
  sessionId: string,
  event: Record<string, unknown>,
  addToHistory = true,
) {
  const clients = sessionClients.get(sessionId);
  if (clients) {
    const data = JSON.stringify(event);
    for (const client of clients) {
      client.send(data);
    }
  }
  if (addToHistory) {
    const h = sessionHistory.get(sessionId) || [];
    h.push(event);
    sessionHistory.set(sessionId, h);
  }
}

function setStatus(sessionId: string, status: string) {
  sessionStatusMap.set(sessionId, status);
  broadcast(sessionId, { type: "session_status", sessionId, status }, false);
}

function pushNotification(params: Record<string, unknown>) {
  Promise.resolve(
    mcpServer.notification({
      method: "notifications/message",
      params,
    }),
  ).catch(() => {});
}

// ── MCP Server (stdio) ──────────────────────────────────────────────────────

const mcpServer = new Server(
  { name: "pi-claude-channel", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description: "Send a reply to the Pi Web UI client",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string", description: "Session ID" },
          text: { type: "string", description: "Reply text" },
        },
        required: ["chat_id", "text"],
      },
    },
    {
      name: "status",
      description: "Update session status in Pi Web UI",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string", description: "Session ID" },
          status: { type: "string", description: "Status string" },
          detail: { type: "string", description: "Optional detail" },
        },
        required: ["chat_id", "status"],
      },
    },
    {
      name: "fetch_history",
      description: "Fetch buffered history for a session",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: { type: "string", description: "Session ID" },
          limit: { type: "number", description: "Max events to return" },
        },
        required: ["session_id"],
      },
    },
    {
      name: "request_permission",
      description: "Request permission from the user via Pi Web UI",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string", description: "Session ID" },
          request_id: { type: "string", description: "Unique request ID" },
          tool_name: {
            type: "string",
            description: "Tool requesting permission",
          },
          description: {
            type: "string",
            description: "What the tool will do",
          },
          args: { description: "Tool arguments" },
        },
        required: ["chat_id", "request_id", "tool_name", "description"],
      },
    },
    {
      name: "send_event",
      description: "Send a generic event to Pi Web UI",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string", description: "Session ID" },
          event_type: { type: "string", description: "Event type" },
          event_data: {
            type: "object",
            description: "Event payload",
          },
        },
        required: ["chat_id", "event_type", "event_data"],
      },
    },
  ],
}));

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "reply": {
      if (!args) throw new Error("Missing arguments");
      const { chat_id, text } = args as { chat_id: string; text: string };
      const msgId = crypto.randomUUID();
      broadcast(chat_id, {
        type: "message_start",
        sessionId: chat_id,
        message: { id: msgId, role: "assistant" },
      });
      broadcast(chat_id, {
        type: "message_update",
        sessionId: chat_id,
        message: { id: msgId },
        assistantMessageEvent: { type: "text_delta", delta: text },
      });
      broadcast(chat_id, {
        type: "message_end",
        sessionId: chat_id,
        message: { id: msgId },
      });
      return { content: [{ type: "text", text: "Reply sent" }] };
    }

    case "status": {
      if (!args) throw new Error("Missing arguments");
      const { chat_id, status, detail } = args as {
        chat_id: string;
        status: string;
        detail?: string;
      };
      broadcast(
        chat_id,
        { type: "status", sessionId: chat_id, status, detail },
        false,
      );
      return { content: [{ type: "text", text: "Status updated" }] };
    }

    case "fetch_history": {
      if (!args) throw new Error("Missing arguments");
      const { session_id, limit } = args as {
        session_id: string;
        limit?: number;
      };
      const history = sessionHistory.get(session_id) || [];
      const events = limit ? history.slice(-limit) : history;
      return {
        content: [{ type: "text", text: JSON.stringify(events) }],
      };
    }

    case "request_permission": {
      if (!args) throw new Error("Missing arguments");
      const { chat_id, request_id, tool_name, description, args: toolArgs } =
        args as {
          chat_id: string;
          request_id: string;
          tool_name: string;
          description: string;
          args?: unknown;
        };
      broadcast(
        chat_id,
        {
          type: "permission_request",
          sessionId: chat_id,
          requestId: request_id,
          toolName: tool_name,
          description,
          args: toolArgs,
        },
        false,
      );
      return new Promise<{
        content: Array<{ type: string; text: string }>;
      }>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingPermissions.delete(request_id);
          reject(new Error("Permission request timed out"));
        }, 120_000);
        pendingPermissions.set(request_id, {
          resolve: (result) => {
            clearTimeout(timer);
            resolve({
              content: [{ type: "text", text: JSON.stringify(result) }],
            });
          },
          reject: (reason) => {
            clearTimeout(timer);
            reject(reason);
          },
          timer,
        });
      });
    }

    case "send_event": {
      if (!args) throw new Error("Missing arguments");
      const { chat_id, event_type, event_data } = args as {
        chat_id: string;
        event_type: string;
        event_data: Record<string, unknown>;
      };
      broadcast(chat_id, {
        type: event_type,
        sessionId: chat_id,
        ...event_data,
      });
      return { content: [{ type: "text", text: "Event sent" }] };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// ── WebSocket Server (port 3100) ────────────────────────────────────────────

function handleWSMessage(
  ws: Bun.ServerWebSocket<WSData>,
  msg: Record<string, unknown>,
) {
  const { type } = msg;

  switch (type) {
    case "prompt": {
      const { sessionId, content, cwd } = msg as {
        sessionId: string;
        content: string;
        cwd?: string;
      };
      setStatus(sessionId, "streaming");
      broadcast(sessionId, {
        type: "agent_start",
        sessionId,
        timestamp: Date.now(),
      });
      pushNotification({
        level: "info",
        data: { type: "prompt", content, sessionId, cwd },
      });
      break;
    }

    case "abort": {
      const { sessionId } = msg as { sessionId: string };
      pushNotification({
        level: "info",
        data: { type: "abort", sessionId },
      });
      break;
    }

    case "permission_response": {
      const { requestId, allowed } = msg as {
        requestId: string;
        allowed: boolean;
      };
      const pending = pendingPermissions.get(requestId);
      if (pending) {
        pendingPermissions.delete(requestId);
        pending.resolve({ allowed });
      }
      break;
    }

    case "fetch_history": {
      const { sessionId, limit } = msg as {
        sessionId: string;
        limit?: number;
      };
      const history = sessionHistory.get(sessionId) || [];
      const events = limit ? history.slice(-limit) : history;
      ws.send(JSON.stringify({ type: "history", sessionId, events }));
      break;
    }

    case "set_model": {
      const { sessionId, model } = msg as {
        sessionId: string;
        model: string;
      };
      sessionModels.set(sessionId, model);
      break;
    }
  }
}

const wsServer = Bun.serve<WSData>({
  port: WS_PORT,
  hostname: "127.0.0.1",
  fetch(req, server) {
    const url = new URL(req.url);
    const sessionId = url.searchParams.get("session") || "default";
    if (server.upgrade(req, { data: { sessionId } })) return;
    return new Response("WebSocket expected", { status: 400 });
  },
  websocket: {
    open(ws) {
      const { sessionId } = ws.data;
      if (!sessionClients.has(sessionId))
        sessionClients.set(sessionId, new Set());
      sessionClients.get(sessionId)!.add(ws);
      sessionLastDisconnect.delete(sessionId);
      const status = sessionStatusMap.get(sessionId) || "idle";
      ws.send(
        JSON.stringify({ type: "session_status", sessionId, status }),
      );
    },
    message(ws, raw) {
      try {
        const msg = JSON.parse(raw as string);
        handleWSMessage(ws, msg);
      } catch {
        // ignore malformed messages
      }
    },
    close(ws) {
      const { sessionId } = ws.data;
      const clients = sessionClients.get(sessionId);
      if (clients) {
        clients.delete(ws);
        if (clients.size === 0) {
          sessionClients.delete(sessionId);
          sessionLastDisconnect.set(sessionId, Date.now());
        }
      }
    },
  },
});

// ── HTTP Hook Receiver (port 3101) ──────────────────────────────────────────

const hookServer = Bun.serve({
  port: HOOK_PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method !== "POST" || !url.pathname.startsWith("/hook/")) {
      return new Response("Not found", { status: 404 });
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    const hook = url.pathname.slice(6);

    switch (hook) {
      case "session-start": {
        const { session_id, model, cwd, tools, timestamp } = body as {
          session_id: string;
          model: string;
          cwd: string;
          tools: string[];
          timestamp: number;
        };
        if (model) sessionModels.set(session_id, model);
        broadcast(session_id, {
          type: "session_init",
          sessionId: session_id,
          model,
          cwd,
          tools,
          timestamp,
        });
        setStatus(session_id, "idle");
        break;
      }

      case "post-tool-use": {
        const {
          session_id,
          tool_name,
          tool_input,
          tool_output,
          tool_call_id,
          tool_error,
          timestamp,
        } = body as {
          session_id: string;
          tool_name: string;
          tool_input: unknown;
          tool_output?: unknown;
          tool_call_id?: string;
          tool_error?: string;
          timestamp: number;
        };
        const tcId = tool_call_id || crypto.randomUUID();
        if (tool_output !== undefined && !tool_error) {
          broadcast(session_id, {
            type: "tool_execution_start",
            sessionId: session_id,
            toolCallId: tcId,
            toolName: tool_name,
            args: tool_input,
            timestamp,
          });
        }
        broadcast(session_id, {
          type: "tool_execution_end",
          sessionId: session_id,
          toolCallId: tcId,
          result: tool_error || tool_output,
          isError: !!tool_error,
          timestamp,
        });
        break;
      }

      case "stop": {
        const { session_id, usage, stop_reason, timestamp } = body as {
          session_id: string;
          usage: {
            input_tokens: number;
            output_tokens: number;
            cache_read: number;
            cache_write: number;
          };
          stop_reason: string;
          timestamp: number;
        };
        broadcast(session_id, {
          type: "agent_end",
          sessionId: session_id,
          result: stop_reason,
          usage,
          timestamp,
        });
        setStatus(session_id, "idle");
        break;
      }

      case "user-prompt": {
        const { session_id, prompt_text, timestamp } = body as {
          session_id: string;
          prompt_text: string;
          timestamp: number;
        };
        broadcast(session_id, {
          type: "agent_start",
          sessionId: session_id,
          timestamp,
        });
        const msgId = crypto.randomUUID();
        broadcast(session_id, {
          type: "message_start",
          sessionId: session_id,
          message: { id: msgId, role: "user" },
        });
        broadcast(session_id, {
          type: "message_update",
          sessionId: session_id,
          message: { id: msgId },
          assistantMessageEvent: { type: "text_delta", delta: prompt_text },
        });
        broadcast(session_id, {
          type: "message_end",
          sessionId: session_id,
          message: { id: msgId },
        });
        break;
      }
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  },
});

// ── Idle Session Pruning ────────────────────────────────────────────────────

setInterval(() => {
  const now = Date.now();
  const toDelete: string[] = [];
  for (const [sessionId, ts] of sessionLastDisconnect) {
    if (!sessionClients.has(sessionId) && now - ts > 30 * 60 * 1000) {
      toDelete.push(sessionId);
    }
  }
  for (const id of toDelete) {
    sessionHistory.delete(id);
    sessionModels.delete(id);
    sessionStatusMap.delete(id);
    sessionLastDisconnect.delete(id);
  }
}, 5 * 60 * 1000);

// ── Startup ─────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  console.error(
    `pi-claude-channel: ws=${WS_PORT} hooks=${HOOK_PORT} mcp=stdio`,
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
