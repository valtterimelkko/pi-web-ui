import { describe, it, expect } from 'vitest';
import { parseAcpLine, nextRequestId, isAgentToClientRequest, type AcpMessage } from '../../../src/devin/devin-acp-protocol.js';

/**
 * Shapes are mirrored from the live-validated probe transcripts
 * (/root/devin-trial/acp-*.jsonl, devin CLI v3000.12.28, ACP protocol 1):
 * `devin acp` speaks JSON-RPC 2.0 over stdio, ONE JSON object per line.
 * Content below is synthetic; shapes are faithful to the wire.
 */

describe('devin ACP protocol framing', () => {
  it('parses a client→agent request line (initialize)', () => {
    const line = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'pi-web-ui', version: '1.0.0' },
      },
    });
    const parsed = parseAcpLine(line);
    expect(parsed.kind).toBe('message');
    if (parsed.kind !== 'message') return;
    const msg = parsed.message as AcpMessage;
    expect(msg.method).toBe('initialize');
    expect(msg.id).toBe(1);
  });

  it('parses an agent→client notification (session/update)', () => {
    const line = JSON.stringify({
      jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: 'brass-akubra', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'CAPTURED' } } },
    });
    const parsed = parseAcpLine(line);
    expect(parsed.kind).toBe('message');
    if (parsed.kind !== 'message') return;
    expect(parsed.message.method).toBe('session/update');
  });

  it('parses a response to a client request', () => {
    const line = JSON.stringify({
      jsonrpc: '2.0', id: 3,
      result: { stopReason: 'end_turn', usage: { totalTokens: 14329, inputTokens: 14292, outputTokens: 37 } },
    });
    const parsed = parseAcpLine(line);
    expect(parsed.kind).toBe('message');
    if (parsed.kind !== 'message') return;
    expect(parsed.message.id).toBe(3);
    expect((parsed.message.result as { stopReason?: string }).stopReason).toBe('end_turn');
  });

  it('never throws on garbage; returns invalid with a reason', () => {
    expect(parseAcpLine('not json at all').kind).toBe('invalid');
    expect(parseAcpLine('{"jsonrpc":"2.0"}').kind).toBe('invalid'); // neither method nor id+result
    expect(parseAcpLine('').kind).toBe('invalid');
    // A JSON array is not a valid JSON-RPC message on this wire.
    expect(parseAcpLine('[1,2]').kind).toBe('invalid');
  });

  it('classifies agent→client requests (server-initiated, has method+id)', () => {
    expect(isAgentToClientRequest({ jsonrpc: '2.0', id: '9a51af06', method: 'session/request_permission', params: {} })).toBe(true);
    expect(isAgentToClientRequest({ jsonrpc: '2.0', method: '_cognition.ai/output', params: {} })).toBe(false);
    expect(isAgentToClientRequest({ jsonrpc: '2.0', id: 5, result: {} })).toBe(false);
  });

  it('mints monotonically increasing request ids starting above the reserved range', () => {
    const a = nextRequestId();
    const b = nextRequestId();
    expect(Number(b)).toBeGreaterThan(Number(a));
  });
});
