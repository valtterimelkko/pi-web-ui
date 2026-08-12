import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, type McpConfig } from './config.js';
import { InternalApiClient } from './internal-api-client.js';
import { registerMcpTools, type ToolDependencies } from './tools.js';

export const MCP_SERVER_NAME = 'pi-web-ui-internal-api-mcp';
export const MCP_SERVER_VERSION = '0.1.0';

export interface RunningMcpServer {
  server: McpServer;
  transport: StdioServerTransport;
  close(): Promise<void>;
}

export function createMcpServer(dependencies: ToolDependencies): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { capabilities: { tools: { listChanged: false } } },
  );
  registerMcpTools(server, dependencies);
  return server;
}

export async function startMcpServer(config: McpConfig = loadConfig()): Promise<RunningMcpServer> {
  const client = new InternalApiClient(config);
  const server = createMcpServer({ client, config });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return {
    server,
    transport,
    async close() {
      await server.close();
    },
  };
}
