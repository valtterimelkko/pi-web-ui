import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { Writable } from 'stream';
import { DevinAcpClient } from '../../../src/devin/devin-acp-client.js';

/**
 * Controllable fake `devin acp` child. Tests drive stdout lines and inspect
 * stdin writes. No real devin process is spawned in this suite. Wire shapes
 * mirrored from /root/devin-trial/acp-*.jsonl. The fake answers the client's
 * LAST request id automatically (client ids are namespaced strings), so tests
 * stay readable without hard-coding ids.
 */
class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdinWrites: string[] = [];
  readonly signals: string[] = [];
  readonly spawnEnv: NodeJS.ProcessEnv;
  readonly stdin: Writable;
  /** id of the most recent client→agent request (initialize, session/new, …). */
  lastRequestId: string | number | undefined;

  constructor(env: NodeJS.ProcessEnv) {
    super();
    this.spawnEnv = env;
    const writes = this.stdinWrites;
    this.stdin = new Writable({
      write(chunk: Buffer, _enc, cb) { writes.push(chunk.toString()); cb(); },
      final(cb) { writes.push('__END__'); cb(); },
    }) as Writable;
  }

  writeStdout(obj: unknown): void {
    this.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n'));
  }

  /** Answer the client's last request with a result. */
  respondLast(result: unknown): void {
    expect(this.lastRequestId).toBeDefined();
    this.writeStdout({ jsonrpc: '2.0', id: this.lastRequestId, result });
  }

  /** All client→agent messages parsed. */
  sent(): Array<{ method?: string; id?: string | number; params?: any; result?: unknown; error?: { code?: number } }> {
    return this.stdinWrites.filter((w) => w !== '__END__').map((w) => JSON.parse(w));
  }

  kill(signal: string): void { this.signals.push(signal); }
  /** Emit what the real child_process emits on termination. */
  close(code = 0): void { this.emit('exit', code, null); }
}

function makeClient(opts: { resumeId?: string; cwd?: string } = {}) {
  const children: FakeChild[] = [];
  const client = new DevinAcpClient({
    cwd: opts.cwd ?? '/ws',
    devinHome: '/throwaway-home',
    executablePath: '/root/.local/bin/devin',
    ...(opts.resumeId ? { resumeNativeSessionId: opts.resumeId } : {}),
    spawnFn: ((file: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      const child = new FakeChild(options.env ?? {});
      // Wrap stdin writes to record the last request id.
      const innerWrite = child.stdin.write.bind(child.stdin);
      (child.stdin as unknown as { write: (c: string) => boolean }).write = (chunk: string) => {
        try {
          const parsed = JSON.parse(chunk);
          if (parsed && parsed.method && parsed.id !== undefined) child.lastRequestId = parsed.id;
        } catch { /* not JSON — not a client request */ }
        return innerWrite(chunk);
      };
      void file; void args;
      children.push(child);
      return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
    }) as unknown as typeof import('node:child_process').spawn,
  });
  return { client, children };
}

/** Drive a client through initialize + session/new (or session/load),
 *  answering every follow-up request (bypass-mode set) as it appears. */
async function startChild(opts: { resumeId?: string } = {}): Promise<{ client: DevinAcpClient; child: FakeChild }> {
  const { client, children } = makeClient(opts);
  const startPromise = client.start();
  await Promise.resolve();
  const child = children[0]!;
  const initId = child.lastRequestId;
  child.writeStdout({ jsonrpc: '2.0', id: initId, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  // initialize resolution → session/new|session/load write (next microtask)
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  child.writeStdout({ jsonrpc: '2.0', id: child.lastRequestId, result: NEW_RESULT });
  // session resolution → bypass-mode set write (next microtask)
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const bypassId = child.lastRequestId;
  child.writeStdout({ jsonrpc: '2.0', id: bypassId, result: {} });
  await startPromise;
  return { client, child };
}

const NEW_RESULT = {
  sessionId: 'brass-akubra',
  modes: { currentModeId: 'accept-edits', availableModes: [{ id: 'bypass', name: 'Bypass Permissions' }] },
  configOptions: [{ id: 'model', name: 'Model', type: 'select', currentValue: 'swe-2-flash-medium', options: [] }],
};

describe('devin ACP client', () => {
  it('spawns `devin acp` with the allow-listed env and answers initialize then session/new', async () => {
    const { client, children } = makeClient();
    const startPromise = client.start();
    await Promise.resolve();
    expect(children.length).toBe(1);
    const child = children[0]!;
    // D2: never the server env; HOME is the throwaway.
    expect(child.spawnEnv.HOME).toBe('/throwaway-home');
    expect(child.spawnEnv.ANTHROPIC_API_KEY).toBeUndefined();
    const args = client.lastSpawnArgs;
    expect(args[0]).toBe('acp');
    expect(args).not.toContain('--model'); // the flag LOSES to the config file (plan §2)

    child.writeStdout({ jsonrpc: '2.0', id: child.lastRequestId, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(JSON.parse(child.stdinWrites[0]!).method).toBe('initialize');

    child.writeStdout({ jsonrpc: '2.0', id: child.lastRequestId, result: NEW_RESULT });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    // bypass-mode set fires right after session/new; answer it.
    child.respondLast({});
    const started = await startPromise;
    expect(started.nativeSessionId).toBe('brass-akubra');
    expect(JSON.parse(child.stdinWrites[1]!).method).toBe('session/new');
    // D6: children run bypass mode — set right after session/new.
    const bypass = child.sent().find((m) => m.method === 'session/set_config_option');
    expect(bypass?.params).toMatchObject({ sessionId: 'brass-akubra', configId: 'mode', value: 'bypass' });
  });

  it('resume path uses session/load instead of session/new', async () => {
    const { client, child } = await startChild({ resumeId: 'brass-akubra' });
    expect(client.nativeSessionId).toBe('brass-akubra');
    const methods = child.sent().map((m) => m.method);
    expect(methods).toContain('session/load');
    expect(methods).not.toContain('session/new');
    const load = child.sent().find((m) => m.method === 'session/load');
    expect(load?.params).toMatchObject({ sessionId: 'brass-akubra', cwd: '/ws', mcpServers: [] });
  });

  it('prompt resolves with the terminal result (stopReason + usage) and feeds session/update notifications', async () => {
    const { client, child } = await startChild();
    const updates: unknown[] = [];
    client.onSessionUpdate((u) => updates.push(u));
    const promptPromise = client.prompt('Reply READY.');
    await Promise.resolve();
    const req = child.sent().find((m) => m.method === 'session/prompt');
    expect(req?.params.prompt).toEqual([{ type: 'text', text: 'Reply READY.' }]);
    expect(req?.params.sessionId).toBe('brass-akubra');

    // streamed chunk then result
    child.writeStdout({
      jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: 'brass-akubra', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'READY' } } },
    });
    child.respondLast({ stopReason: 'end_turn', usage: { totalTokens: 14390, inputTokens: 14362, outputTokens: 28 } });
    const result = await promptPromise;
    expect(result.stopReason).toBe('end_turn');
    expect(result.usage.input).toBe(14362);
    expect(result.usage.output).toBe(28);
    expect(updates.length).toBe(1);
  });

  it('answers session/request_permission by policy: select the allow option (plan D6)', async () => {
    const { child } = await startChild();
    child.writeStdout({
      jsonrpc: '2.0', id: '9a51af06', method: 'session/request_permission',
      params: {
        sessionId: 'brass-akubra',
        toolCall: { toolCallId: 'call_9041' },
        options: [
          { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
          { optionId: 'deny_once', name: 'Reject', kind: 'reject_once' },
        ],
      },
    });
    await Promise.resolve();
    const answer = child.sent().find((m) => m.id === '9a51af06' && m.method === undefined);
    expect(answer).toBeDefined();
    expect(answer!.result).toMatchObject({ outcome: { outcome: 'selected', optionId: 'allow_once' } });
  });

  it('answers any other agent→client request with method-not-found', async () => {
    const { child } = await startChild();
    child.writeStdout({ jsonrpc: '2.0', id: 'x1', method: 'fs/read_text_file', params: { path: '/etc/passwd' } });
    await Promise.resolve();
    const answer = child.sent().find((m) => m.id === 'x1' && m.method === undefined);
    expect(answer?.error?.code).toBe(-32601);
  });

  it('cancel sends session/cancel and the pending prompt resolves as cancelled', async () => {
    const { client, child } = await startChild();
    const promptPromise = client.prompt('Run `sleep 60`.');
    await Promise.resolve();
    client.cancel();
    const req = child.sent().find((m) => m.method === 'session/cancel');
    expect(req?.params).toEqual({ sessionId: 'brass-akubra' });
    child.respondLast({ stopReason: 'cancelled', usage: { inputTokens: 14433, outputTokens: 123 } });
    const result = await promptPromise;
    expect(result.stopReason).toBe('cancelled');
    expect(result.cancelled).toBe(true);
  });

  it('exit while idle marks the client dead; a rejected prompt after exit does not hang', async () => {
    const { client, child } = await startChild();
    child.close(1);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(client.hasExited).toBe(true);
    await expect(client.prompt('nope')).rejects.toThrow(/exited/);
  });

  it('review fix 1: session/update notifications during session/load are dropped (replay never reaches the live handler)', async () => {
    const { client, children } = makeClient({ resumeId: 'brass-akubra' });
    const updates: unknown[] = [];
    client.onSessionUpdate((u) => updates.push(u));
    const startPromise = client.start();
    await Promise.resolve();
    const child = children[0]!;
    child.writeStdout({ jsonrpc: '2.0', id: child.lastRequestId, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    // Replay chunks stream in BEFORE the session/load response (real shape:
    // /root/devin-trial/acp-resume.jsonl — user chunk, agent chunks, tool calls).
    child.writeStdout({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'brass-akubra', update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old question' } } } });
    child.writeStdout({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'brass-akubra', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old reply' } } } });
    child.writeStdout({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'brass-akubra', update: { sessionUpdate: 'tool_call', toolCallId: 'call_old', title: 'Listed ./', kind: 'execute' } } });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    child.writeStdout({ jsonrpc: '2.0', id: child.lastRequestId, result: NEW_RESULT });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    child.respondLast({});
    await startPromise;
    // The live handler saw NOTHING from the replay window.
    expect(updates).toEqual([]);
    // ...and a post-handshake update still reaches the handler:
    child.writeStdout({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'brass-akubra', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'live chunk' } } } });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(updates.length).toBe(1);
  });

  it('setConfigOption writes session/set_config_option with the right params', async () => {
    const { client, child } = await startChild();
    const setPromise = client.setConfigOption('model', 'swe-2-flash-high');
    await Promise.resolve();
    const lastId = child.lastRequestId;
    child.writeStdout({ jsonrpc: '2.0', id: lastId, result: {} });
    await expect(setPromise).resolves.toBeUndefined();
    const set = child.sent().find((m) => m.method === 'session/set_config_option' && m.params?.configId === 'model');
    expect(set?.params).toMatchObject({ sessionId: 'brass-akubra', configId: 'model', value: 'swe-2-flash-high' });
  });
});
