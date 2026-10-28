import { readOrCreateMachineId } from './machineId.js';

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
  /** Test override. Production reads the shared machine-id file. */
  machineId?: string;
}

export type RoomJoin = (input: RoomJoinInput) => Promise<RoomJoinResult>;

function mcpUrl(server: string): string {
  const base = server.endsWith('/') ? server : `${server}/`;
  return new URL('mcp', base).toString();
}

function normalizeJoinCode(code: string): string {
  const trimmed = code.trim();
  const fromUrl = trimmed.match(/\/(?:j|r)\/([^/?#\s]+)/i);
  return fromUrl ? fromUrl[1]! : trimmed;
}

type JoinPayload = {
  seatKey?: unknown;
  cursor?: unknown;
  name?: unknown;
  yourName?: unknown;
  assignedName?: unknown;
  error?: unknown;
};

function payloadFromToolResult(result: unknown): JoinPayload {
  if (!result || typeof result !== 'object') return {};
  const record = result as { structuredContent?: unknown; content?: unknown };
  if (record.structuredContent && typeof record.structuredContent === 'object') {
    return record.structuredContent as JoinPayload;
  }
  if (Array.isArray(record.content)) {
    for (const item of record.content) {
      if (item && typeof item === 'object' && (item as { type?: string }).type === 'text') {
        const text = (item as { text?: unknown }).text;
        if (typeof text === 'string') {
          try { return JSON.parse(text) as JoinPayload; } catch { /* keep looking */ }
        }
      }
    }
  }
  return {};
}

async function mcpCall(url: string, method: string, params?: Record<string, unknown>): Promise<unknown> {
  const body = { jsonrpc: '2.0', id: Date.now(), method, ...(params ? { params } : {}) };
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error('join_failed');
  const json = await response.json() as { result?: unknown; error?: unknown };
  if (json.error) throw new Error('join_failed');
  return json.result;
}

/** Join over the hosted MCP endpoint. Tests inject a fake instead of calling this. */
export async function joinRoomOverMcp(input: RoomJoinInput): Promise<RoomJoinResult> {
  const url = mcpUrl(input.server);
  const machineId = input.machineId ?? await readOrCreateMachineId().catch(() => undefined);
  await mcpCall(url, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'agent-room-daemon', version: '0.0.0' },
  });
  const result = await mcpCall(url, 'tools/call', {
    name: 'room_join',
    arguments: {
      code: normalizeJoinCode(input.code),
      name: input.name,
      inviteCode: input.inviteCode,
      ...(machineId ? { machineId } : {}),
    },
  });
  const parsed = payloadFromToolResult(result);
  if (parsed.error || typeof parsed.seatKey !== 'string' || !parsed.seatKey || typeof parsed.cursor !== 'number') {
    throw new Error('join_failed');
  }
  const assigned = typeof parsed.assignedName === 'string' ? parsed.assignedName
    : typeof parsed.name === 'string' ? parsed.name
      : undefined;
  return {
    seatKey: parsed.seatKey,
    cursor: parsed.cursor,
    name: assigned,
    yourName: typeof parsed.yourName === 'string' ? parsed.yourName : assigned,
  };
}


export interface RoomLeaveInput {
  server: string;
  code: string;
  name: string;
  seatKey?: string;
}

export type RoomLeave = (input: RoomLeaveInput) => Promise<void>;

/** Leave over the hosted MCP endpoint. Tests inject a fake instead of calling this. */
export async function leaveRoomOverMcp(input: RoomLeaveInput): Promise<void> {
  const url = mcpUrl(input.server);
  // Same initialize + tools/call shape as joinRoomOverMcp (stateless MCP).
  await mcpCall(url, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'agent-room-daemon', version: '0.0.0' },
  });
  const args: Record<string, unknown> = {
    code: normalizeJoinCode(input.code),
    name: input.name,
  };
  if (input.seatKey) args.seatKey = input.seatKey;
  await mcpCall(url, 'tools/call', {
    name: 'room_leave',
    arguments: args,
  });
}
