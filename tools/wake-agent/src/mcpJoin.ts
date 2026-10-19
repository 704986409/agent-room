import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export interface RoomJoinResult {
  seatKey: string;
  cursor: number;
  name?: string;
  yourName?: string;
}

export interface RoomJoinInput {
  server: string;
  code: string;
  name: string;
  inviteCode: string;
}

export type RoomJoin = (input: RoomJoinInput) => Promise<RoomJoinResult>;

function mcpUrl(server: string): URL {
  const base = server.endsWith('/') ? server : `${server}/`;
  return new URL('mcp', base);
}

function textContent(result: unknown): string {
  if (!result || typeof result !== 'object' || !('content' in result)) return '';
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  for (const item of content) {
    if (item && typeof item === 'object' && (item as { type?: string }).type === 'text') {
      const text = (item as { text?: unknown }).text;
      if (typeof text === 'string') return text;
    }
  }
  return '';
}

/** Join over the hosted MCP endpoint. Tests inject a fake instead of calling this. */
export async function joinRoomOverMcp(input: RoomJoinInput): Promise<RoomJoinResult> {
  const client = new Client({ name: 'agent-room-daemon', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(mcpUrl(input.server));
  await client.connect(transport);
  try {
    const result = await client.callTool({
      name: 'room_join',
      arguments: { code: input.code, name: input.name, inviteCode: input.inviteCode },
    });
    let parsed: { seatKey?: unknown; cursor?: unknown; name?: unknown; yourName?: unknown };
    try {
      parsed = JSON.parse(textContent(result)) as { seatKey?: unknown; cursor?: unknown; name?: unknown; yourName?: unknown };
    } catch {
      throw new Error('join_failed');
    }
    if (typeof parsed.seatKey !== 'string' || !parsed.seatKey || typeof parsed.cursor !== 'number') {
      throw new Error('join_failed');
    }
    return {
      seatKey: parsed.seatKey,
      cursor: parsed.cursor,
      name: typeof parsed.name === 'string' ? parsed.name : undefined,
      yourName: typeof parsed.yourName === 'string' ? parsed.yourName : undefined,
    };
  } finally {
    await client.close();
  }
}
