/**
 * Devin ACP wire framing — JSON-RPC 2.0 over stdio, ONE JSON object per line
 * (live-validated against `devin acp`, v3000.12.28, ACP protocol 1; see
 * /root/devin-trial/acp-probe.mjs and docs/DEVIN-INTEGRATION.md).
 *
 * Pure module: no I/O. `parseAcpLine` never throws — the stdout line reader
 * feeds it every line and must survive garbage (the agent also writes to its
 * stdout only valid JSON-RPC, but a hostile/updated CLI must not crash us).
 */

export interface AcpMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type ParsedAcpLine =
  | { kind: 'message'; message: AcpMessage }
  | { kind: 'invalid'; reason: string };

function safeJsonParse(line: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  try {
    return { ok: true, value: JSON.parse(line) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'json parse failed' };
  }
}

/** Parse one newline-delimited JSON-RPC line. Returns a discriminant result
 *  instead of throwing so the stream reader can log-and-continue on garbage. */
export function parseAcpLine(line: string): ParsedAcpLine {
  const trimmed = line.trim();
  if (!trimmed) return { kind: 'invalid', reason: 'empty line' };
  const json = safeJsonParse(trimmed);
  if (!json.ok) return { kind: 'invalid', reason: json.reason };
  if (typeof json.value !== 'object' || json.value === null || Array.isArray(json.value)) {
    return { kind: 'invalid', reason: 'line is not a JSON object' };
  }
  const record = json.value as Record<string, unknown>;
  const hasMethod = typeof record.method === 'string';
  const hasResponseShape = record.id !== undefined && ('result' in record || 'error' in record);
  if (!hasMethod && !hasResponseShape) {
    return { kind: 'invalid', reason: 'line is neither a request, notification nor response' };
  }
  return { kind: 'message', message: json.value as unknown as AcpMessage };
}

/** True for agent→client requests: the agent called US and expects an answer
 *  (session/request_permission, fs/read_text_file, …). Notifications have no
 *  id; responses have id but no method. */
export function isAgentToClientRequest(message: AcpMessage): boolean {
  return typeof message.method === 'string' && message.id !== undefined;
}

/** Client→agent request ids live in a string range that can never collide
 *  with the agent's numeric ids or string request ids (permission requests
 *  arrive with UUID ids). Monotonic so debugging is easy. */
let lastRequestId = 0;

export function nextRequestId(): string {
  lastRequestId += 1;
  return String(lastRequestId);
}

/** Reset the counter (tests). */
export function resetRequestIds(): void {
  lastRequestId = 0;
}
