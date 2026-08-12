import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createMcpServer, MCP_SERVER_NAME, MCP_SERVER_VERSION } from '../src/server.js';
import type { McpConfig } from '../src/config.js';

const config: McpConfig = {
  socketPath: '/tmp/socket',
  tokenPath: '/tmp/token',
  timeoutMs: 1000,
  maxResponseBytes: 4096,
  maxToolOutputBytes: 4096,
};

const client = {
  getCapabilities: async () => ({ contract: { name: 'pi-web-ui-internal-api', routePrefix: '/api/v1', majorVersion: 'v1', contractVersion: '1.19.0' }, runtimes: {} }),
  listModels: async () => ({ models: {} }),
  listSessions: async () => ({ sessions: [] }),
  createSession: async () => ({ sessionId: '11111111-1111-4111-8111-111111111111', runtime: 'pi' }),
  dispatchPrompt: async () => ({ sessionId: '11111111-1111-4111-8111-111111111111', runId: '22222222-2222-4222-8222-222222222222', detached: true }),
  getRun: async () => ({ runId: '22222222-2222-4222-8222-222222222222', sessionId: '11111111-1111-4111-8111-111111111111', runtime: 'pi', status: 'completed' }),
  getTranscript: async () => ({ sessionId: '11111111-1111-4111-8111-111111111111', runtime: 'pi', items: [] }),
};

describe('MCP server construction', () => {
  it('constructs the named server and registers the locked tools', async () => {
    const server = createMcpServer({ client: client as never, config });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: 'server-test-client', version: '1.0.0' }, { capabilities: {} });
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    expect(mcpClient.getServerVersion()).toEqual({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });
    expect((await mcpClient.listTools()).tools).toHaveLength(7);
    await mcpClient.close();
    await server.close();
  });
});
