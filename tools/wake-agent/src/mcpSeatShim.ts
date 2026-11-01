/**
 * Managed-seat MCP shim: stdio JSON-RPC proxy → hosted Streamable HTTP MCP.
 *
 * Codex (and other HTTP-MCP clients) often send `managed: {}` because tool
 * descriptions say seatKey is "not typed by the agent" / "don't post secrets".
 * Without a real seatKey the server never takes the Quiet→room_sleep path.
 *
 * This process inherits AGENT_ROOM_SEAT_KEY from the managed CLI and fills it
 * into room_listen.managed.seatKey / room_sleep.seatKey when missing.
 */
import { createInterface } from 'node:readline';

const LISTEN_TIMEOUT_MS = 300_000;

export function mcpHttpUrl(server: string): string {
  const base = server.trim().replace(/\/+$/, '');
  return `${base}/mcp`;
}

/** True when managed is present but seatKey is missing/blank (incl. `{}`). */
export function managedMissingSeatKey(managed: unknown): boolean {
  if (managed === undefined || managed === null) return true;
  if (typeof managed !== 'object' || Array.isArray(managed)) return true;
  const seatKey = (managed as { seatKey?: unknown }).seatKey;
  return typeof seatKey !== 'string' || !seatKey.trim();
}

/**
 * Fill seatKey from AGENT_ROOM_SEAT_KEY when managed/host seat identity is blank.
 * Only when AGENT_ROOM_MANAGED=1 (or seat key env is set for sleep).
 */
export function injectSeatKeyArgs(
  toolName: string,
  args: Record<string, unknown> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(args ?? {}) };
  const seatKey = env.AGENT_ROOM_SEAT_KEY?.trim();
  if (!seatKey) return next;
  const managed = env.AGENT_ROOM_MANAGED === '1';

  if (toolName === 'room_listen') {
    if (!managed) return next;
    if (managedMissingSeatKey(next.managed)) {
      const prev = next.managed && typeof next.managed === 'object' && !Array.isArray(next.managed)
        ? { ...(next.managed as Record<string, unknown>) }
        : {};
      next.managed = { ...prev, seatKey };
    }
    return next;
  }

  if (toolName === 'room_sleep') {
    const existing = next.seatKey;
    if (typeof existing !== 'string' || !existing.trim()) {
      next.seatKey = seatKey;
    }
    return next;
  }

  return next;
}

type JsonRpcIncoming = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

async function forwardHttp(
  url: string,
  method: string,
  params: unknown,
  timeoutMs: number,
): Promise<{ result?: unknown; error?: unknown }> {
  const body = {
    jsonrpc: '2.0',
    id: Date.now(),
    method,
    ...(params !== undefined ? { params } : {}),
  };
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    return { error: { code: -32000, message: `mcp_http_${response.status}` } };
  }
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream')) {
    const text = await response.text();
    const dataLines = text.split(/\r?\n/).filter((line) => line.startsWith('data:'));
    for (let i = dataLines.length - 1; i >= 0; i -= 1) {
      const raw = dataLines[i]!.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      try {
        const parsed = JSON.parse(raw) as { result?: unknown; error?: unknown };
        if (parsed.error || parsed.result !== undefined) return parsed;
      } catch { /* keep looking */ }
    }
    return { error: { code: -32000, message: 'mcp_sse_unparsed' } };
  }
  const json = await response.json() as { result?: unknown; error?: unknown };
  return json;
}

function writeMessage(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/**
 * Stdio MCP server: newline-delimited JSON-RPC ↔ hosted `/mcp`.
 * Notifications (no id) are forwarded without waiting for a reply body shape.
 */
export async function runMcpSeatShim(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const server = (env.AGENT_ROOM_SERVER || env.AGENT_ROOM_BASE_URL || '').trim();
  if (!server) {
    process.stderr.write('mcp-shim: AGENT_ROOM_SERVER / AGENT_ROOM_BASE_URL required\n');
    process.exitCode = 1;
    return;
  }
  const url = mcpHttpUrl(server);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg: JsonRpcIncoming;
    try {
      msg = JSON.parse(trimmed) as JsonRpcIncoming;
    } catch {
      continue;
    }

    // Client → server notification (e.g. notifications/initialized): forward, no response.
    if (msg.method && (msg.id === undefined || msg.id === null)) {
      void forwardHttp(url, msg.method, msg.params, 30_000).catch(() => {});
      continue;
    }

    if (!msg.method || msg.id === undefined || msg.id === null) continue;

    let params = msg.params;
    let timeoutMs = 60_000;
    if (msg.method === 'tools/call' && params && typeof params === 'object') {
      const call = params as { name?: unknown; arguments?: unknown };
      const toolName = typeof call.name === 'string' ? call.name : '';
      const args = call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments)
        ? call.arguments as Record<string, unknown>
        : {};
      const injected = injectSeatKeyArgs(toolName, args, env);
      params = { ...call, arguments: injected };
      if (toolName === 'room_listen') timeoutMs = LISTEN_TIMEOUT_MS;
    }

    try {
      const forwarded = await forwardHttp(url, msg.method, params, timeoutMs);
      if (forwarded.error) {
        writeMessage({ jsonrpc: '2.0', id: msg.id, error: forwarded.error });
      } else {
        writeMessage({ jsonrpc: '2.0', id: msg.id, result: forwarded.result ?? {} });
      }
    } catch (error) {
      writeMessage({
        jsonrpc: '2.0',
        id: msg.id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
}
