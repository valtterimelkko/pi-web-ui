import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OpenCodeClient } from '../../../src/opencode/opencode-client.js';
import { OpenCodeEventAdapter } from '../../../src/opencode/opencode-event-adapter.js';
import { opencodeMessagesToReplayEvents } from '../../../src/opencode/opencode-history-replay.js';
import { MockOpenCodeServer } from '../../helpers/mock-opencode-server.js';

let portCounter = 14200;

function nextPort() {
  return portCounter++;
}

describe('OpenCode Integration — Session Lifecycle', () => {
  let mockServer: MockOpenCodeServer;
  let client: OpenCodeClient;
  let port: number;

  beforeEach(async () => {
    port = nextPort();
    mockServer = new MockOpenCodeServer({ port });
    await mockServer.start();
    client = new OpenCodeClient(`http://127.0.0.1:${port}`, {});
  });

  afterEach(async () => {
    await new Promise(r => setTimeout(r, 50));
    await mockServer.stop();
  });

  it('creates a session via HTTP API', async () => {
    const session = await client.createSession('/tmp');
    expect(session.id).toBeDefined();
    expect(session.id).toMatch(/^oc-mock-/);
  });

  it('lists sessions after creation', async () => {
    await client.createSession('/tmp');
    await client.createSession('/tmp');

    const sessions = await client.listSessions();
    expect(sessions.length).toBeGreaterThanOrEqual(2);
  });

  it('gets a specific session by ID', async () => {
    const session = await client.createSession('/tmp');
    const fetched = await client.getSession(session.id);
    expect(fetched.id).toBe(session.id);
  });

  it('sends a prompt via prompt_async and verifies messages are stored', async () => {
    const session = await client.createSession('/tmp');

    await client.promptAsync(session.id, '/tmp', 'hello integration test');

    await new Promise(r => setTimeout(r, 300));

    const messages = await client.getMessages(session.id, '/tmp');
    expect(messages.length).toBeGreaterThanOrEqual(2);

    const roles = messages.map(m => m.info.role);
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');
  });

  it('aborts a running session', async () => {
    const session = await client.createSession('/tmp');

    await client.promptAsync(session.id, '/tmp', 'long running task');
    await client.abort(session.id, '/tmp');

    const requests = mockServer.getRequests();
    const abortReq = requests.find(r => r.url.includes('/abort'));
    expect(abortReq).toBeDefined();
    expect(abortReq!.method).toBe('POST');
  });

  it('sends a synchronous message and gets a response', async () => {
    const session = await client.createSession('/tmp');

    await client.sendMessage(session.id, 'sync hello');

    const messages = await client.getMessages(session.id, '/tmp');
    expect(messages.length).toBeGreaterThanOrEqual(2);
    const userMsg = messages.find(m => m.info.role === 'user');
    const assistantMsg = messages.find(m => m.info.role === 'assistant');
    expect(userMsg).toBeDefined();
    expect(assistantMsg).toBeDefined();
  });
});

describe('OpenCode Integration — History Replay', () => {
  it('converts messages to replay events preserving order', async () => {
    const port = nextPort();
    const mockServer = new MockOpenCodeServer({ port });
    await mockServer.start();
    const client = new OpenCodeClient(`http://127.0.0.1:${port}`, {});

    const session = await client.createSession('/tmp');
    await client.sendMessage(session.id, 'test replay');

    const messages = await client.getMessages(session.id, '/tmp');
    const events = opencodeMessagesToReplayEvents(messages, 'pi-session-1');

    expect(events.length).toBeGreaterThan(0);

    const types = events.map(e => e.type as string);
    expect(types).toContain('message_start');
    expect(types).toContain('message_end');

    await mockServer.stop();
  });

  it('handles empty message list gracefully', () => {
    const events = opencodeMessagesToReplayEvents([], 'pi-session-1');
    expect(events).toEqual([]);
  });

  it('replay events contain user and assistant messages', async () => {
    const port = nextPort();
    const mockServer = new MockOpenCodeServer({ port });
    await mockServer.start();
    const client = new OpenCodeClient(`http://127.0.0.1:${port}`, {});

    const session = await client.createSession('/tmp');
    await client.sendMessage(session.id, 'multi-turn 1');

    const messages = await client.getMessages(session.id, '/tmp');
    const events = opencodeMessagesToReplayEvents(messages, 'pi-session-1');

    const startEvents = events.filter(e => e.type === 'message_start');
    const roles = startEvents.map(e => (e.message as Record<string, unknown>)?.role);
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');

    await mockServer.stop();
  });
});

describe('OpenCode Integration — SSE Event Adapter', () => {
  let adapter: OpenCodeEventAdapter;

  beforeEach(() => {
    adapter = new OpenCodeEventAdapter();
  });

  it('adapts a full prompt turn of SSE events', () => {
    const sessionId = 'oc-sess-1';

    const sseEvents = [
      { type: 'message.updated', properties: { sessionId, info: { id: 'm1', role: 'user' } } },
      { type: 'message.updated', properties: { sessionId, info: { id: 'm1', role: 'user', finish: 'stop' } } },
      { type: 'message.updated', properties: { sessionId, info: { id: 'm2', role: 'assistant' } } },
      { type: 'message.part.delta', properties: { sessionId, messageID: 'm2', field: 'text', delta: 'Hello ' } },
      { type: 'message.part.delta', properties: { sessionId, messageID: 'm2', field: 'text', delta: 'World' } },
      { type: 'message.updated', properties: { sessionId, info: { id: 'm2', role: 'assistant', finish: 'stop' } } },
      { type: 'session.idle', properties: { sessionId } },
    ];

    const allEvents = sseEvents.flatMap(e => adapter.adaptSSEEvent(e as never, 'pi-session-1'));
    const types = allEvents.map(e => e.type);

    expect(types).toContain('message_start');
    expect(types).toContain('message_update');
    expect(types).toContain('message_end');
    expect(types).toContain('agent_end');
  });

  it('adapts tool use events', () => {
    const sessionId = 'oc-sess-1';

    const sseEvents = [
      {
        type: 'message.part.updated',
        properties: {
          sessionId,
          part: { type: 'tool-invocation', id: 'tool-1', toolName: 'bash', args: { command: 'ls' } },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          sessionId,
          part: { type: 'step-finish', id: 'tool-1', reason: 'tool' },
        },
      },
    ];

    const allEvents = sseEvents.flatMap(e => adapter.adaptSSEEvent(e as never, 'pi-session-1'));
    const types = allEvents.map(e => e.type);

    expect(types).toContain('tool_execution_start');
    expect(types).toContain('tool_execution_end');
  });

  it('adapts permission request events', () => {
    const sessionId = 'oc-sess-1';

    const sseEvents = [
      {
        type: 'permission.updated',
        properties: {
          sessionId,
          permission: { id: 'perm-1', status: 'pending', tool: 'bash', metadata: { toolName: 'bash' } },
        },
      },
    ];

    const allEvents = sseEvents.flatMap(e => adapter.adaptSSEEvent(e as never, 'pi-session-1'));
    expect(allEvents.length).toBe(1);
    expect(allEvents[0].type).toBe('permission_request');
    expect(allEvents[0].data).toMatchObject({
      permissionId: 'perm-1',
      toolName: 'bash',
    });
  });
});

describe('OpenCode Integration — Auth', () => {
  it('rejects requests without valid auth when password is set', async () => {
    const port = nextPort();
    const mockServer = new MockOpenCodeServer({ port, password: 'secret123' });
    await mockServer.start();

    const unauthedClient = new OpenCodeClient(`http://127.0.0.1:${port}`, {});
    await expect(unauthedClient.listSessions()).rejects.toThrow('401');

    const authedClient = new OpenCodeClient(`http://127.0.0.1:${port}`, {
      Authorization: `Basic ${Buffer.from(':secret123').toString('base64')}`,
    });
    const sessions = await authedClient.listSessions();
    expect(Array.isArray(sessions)).toBe(true);

    await mockServer.stop();
  });

  it('allows requests without auth when no password is set', async () => {
    const port = nextPort();
    const mockServer = new MockOpenCodeServer({ port });
    await mockServer.start();

    const client = new OpenCodeClient(`http://127.0.0.1:${port}`, {});
    const sessions = await client.listSessions();
    expect(Array.isArray(sessions)).toBe(true);

    await mockServer.stop();
  });
});
