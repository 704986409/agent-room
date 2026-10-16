import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { callTool, listTools, serverInstructions, type McpProfile } from './_mcpTools.js';
import type { HttpHarness } from './_mcpHarness.js';
import type { RemoteRoomClient } from './_mcpRoomClient.js';

/** Build the shared tool surface used by Streamable HTTP and legacy SSE. */
export function createMcpServer(
  roomClient: RemoteRoomClient,
  profile: McpProfile,
  harnessFor: (server: Server) => HttpHarness | undefined = () => undefined,
): Server {
  const server = new Server(
    { name: 'agent-room', version: '1.0.0' },
    { capabilities: { tools: {} }, instructions: serverInstructions() },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listTools(profile, harnessFor(server)),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return callTool(roomClient, profile, name, (args ?? {}) as Record<string, unknown>, harnessFor(server));
  });

  return server;
}
