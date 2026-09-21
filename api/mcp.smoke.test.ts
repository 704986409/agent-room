// End-to-end smoke test for the hosted MCP endpoint (`api/mcp.ts`).
//
// Boots a real HTTP server around the actual handler and drives it with the
// official MCP SDK client over Streamable HTTP — the same wire path a real
// `claude mcp add --transport http` client uses. That is the point: the parts
// most likely to break here are transport negotiation and the adapter seam,
// and neither shows up in a unit test that calls `callTool` directly.
//
// Storage is an in-memory stand-in for the Upstash REST API. Only requests to
// the configured Upstash base URL are intercepted; the MCP client's own HTTP
// to our local server goes through the real fetch, or the test would be
// talking to itself.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { parse as parseUrl } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createVpsApp, type VpsApp } from '../deploy/vps/server.js';

const REDIS_BASE = 'https://smoke.upstash.invalid';
process.env.UPSTASH_REDIS_REST_URL = REDIS_BASE;
process.env.UPSTASH_REDIS_REST_TOKEN = 'smoke-token';
process.env.SRH_WEB_URL = REDIS_BASE;
process.env.SRH_WEB_TOKEN = 'smoke-token';

/** Minimal Redis, covering exactly the commands this path issues. */
function installFakeRedis(): Map<string, string> {
  const kv = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const realFetch = globalThis.fetch;

  const run = (cmd: (string | number)[]): unknown => {
    const [op, key] = [String(cmd[0]).toUpperCase(), String(cmd[1])];
    switch (op) {
      case 'GET': return kv.has(key) ? kv.get(key) : null;
      case 'PING': return 'PONG';
      case 'SET': kv.set(key, String(cmd[2])); return 'OK';
      case 'DEL': return kv.delete(key) ? 1 : 0;
      case 'INCR': {
        const next = Number(kv.get(key) ?? 0) + 1;
        kv.set(key, String(next));
        return next;
      }
      case 'RPUSH': {
        const list = lists.get(key) ?? [];
        for (const v of cmd.slice(2)) list.push(String(v));
        lists.set(key, list);
        return list.length;
      }
      case 'LLEN': return (lists.get(key) ?? []).length;
      case 'LRANGE': {
        const list = lists.get(key) ?? [];
        const start = Number(cmd[2]);
        const stop = Number(cmd[3]);
        const from = start < 0 ? Math.max(list.length + start, 0) : start;
        const to = stop < 0 ? list.length + stop : stop;
        return list.slice(from, to + 1);
      }
      case 'LTRIM': return 'OK';
      case 'EXPIRE': case 'EXPIREAT': case 'PEXPIRE': return 1;
      case 'EVAL': {
        if (String(cmd[1]).includes('AR11 listen-presence CAS')) {
          const evalKey = String(cmd[3]);
          const expected = String(cmd[4]);
          const next = String(cmd[5]);
          if (kv.get(evalKey) === expected) { kv.set(evalKey, next); return 1; }
          return 0;
        }
        if (String(cmd[2]) === '4') {
          const [boardKey, listKey, countKey, roomKey] = cmd.slice(3, 7).map(String);
          const [mode, expected, next, _expireAt, message, maxMessages] = cmd.slice(7).map(String);
          const cur = kv.get(boardKey!);
          if (mode === 'absent' ? cur !== undefined : cur !== expected) return 0;
          if (!kv.has(roomKey!)) return -1;
          const list = lists.get(listKey!) ?? [];
          const previousListLength = list.length;
          list.push(message!);
          if (list.length > Number(maxMessages)) list.splice(0, list.length - Number(maxMessages));
          lists.set(listKey!, list);
          const previousCount = kv.has(countKey!) ? Number(kv.get(countKey!)) : previousListLength;
          kv.set(countKey!, String(previousCount + 1));
          kv.set(boardKey!, next!);
          return 1;
        }
        // The CAS script: EVAL <src> 1 <key> <'absent'|'present'> <expected> <next> [ttl]
        const evalKey = String(cmd[3]);
        const mode = String(cmd[4]);
        const expected = cmd[5] === undefined ? undefined : String(cmd[5]);
        const next = String(cmd[6]);
        const cur = kv.get(evalKey);
        const ok = mode === 'absent' ? cur === undefined : cur === expected;
        if (ok) { kv.set(evalKey, next); return 1; }
        return 0;
      }
      default: return null;
    }
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    if (!url.startsWith(REDIS_BASE)) return realFetch(input as never, init);
    const body = JSON.parse(String(init?.body ?? '[]'));
    const result = url.endsWith('/pipeline')
      ? (body as (string | number)[][]).map(c => ({ result: run(c) }))
      : { result: run(body as (string | number)[]) };
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return kv;
}

let server: http.Server;
let port = 0;
let smokeKv: Map<string, string>;
let vpsApp: VpsApp;
let vpsPort = 0;
const clients: Client[] = [];

beforeAll(async () => {
  smokeKv = installFakeRedis();
  const mcpHandler = (await import('./mcp.js')).default;

  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: unknown;
    if (raw && String(req.headers['content-type'] ?? '').includes('application/json')) {
      try { body = JSON.parse(raw); } catch { body = raw; }
    }
    const { pathname, query } = parseUrl(req.url ?? '/', true);
    const vreq = Object.assign(req, { body, query, cookies: {} });
    const vres = Object.assign(res, {
      status(code: number) { res.statusCode = code; return vres; },
      json(obj: unknown) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); return vres; },
      send(data: string) { res.end(data); return vres; },
    });
    if (pathname === '/mcp') return void await mcpHandler(vreq as never, vres as never);
    vres.status(404).json({ error: 'not_found' });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;

  vpsApp = createVpsApp({ host: '127.0.0.1', port: 0, sseHeartbeatMs: 25, maxSseSessions: 2 });
  await new Promise<void>(r => vpsApp.server.listen(0, '127.0.0.1', r));
  vpsPort = (vpsApp.server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const c of clients) await c.close().catch(() => {});
  await vpsApp.close();
  await new Promise<void>(r => server.close(() => r()));
});

async function connect(asClient?: string): Promise<Client> {
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  const client = new Client({ name: asClient ?? 'smoke-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(
    url,
    asClient ? { requestInit: { headers: { 'user-agent': `${asClient}/1.0` } } } : undefined,
  ));
  clients.push(client);
  return client;
}

function parsed(r: { content?: unknown }): Record<string, any> {
  const content = r.content as { type: string; text: string }[];
  return JSON.parse(content[0]!.text);
}

async function openRawSse(): Promise<{
  response: Response;
  endpoint: URL;
  sessionId: string;
  close(): Promise<void>;
}> {
  const controller = new AbortController();
  const url = new URL(`http://127.0.0.1:${vpsPort}/sse`);
  const response = await fetch(url, {
    headers: { accept: 'text/event-stream' },
    signal: controller.signal,
  });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let match: RegExpMatchArray | null = null;
  while (!match) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error('SSE stream ended before endpoint event.');
    buffer += decoder.decode(chunk.value, { stream: true });
    match = buffer.match(/event: endpoint\r?\ndata: ([^\r\n]+)/);
  }
  const endpoint = new URL(match[1]!, url);
  const sessionId = endpoint.searchParams.get('sessionId') ?? '';
  return {
    response,
    endpoint,
    sessionId,
    async close() {
      controller.abort();
      await reader.cancel().catch(() => {});
    },
  };
}

async function waitForSseSessionCount(count: number): Promise<void> {
  for (let attempt = 0; attempt < 50 && vpsApp.getSseSessionCount() !== count; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(vpsApp.getSseSessionCount()).toBe(count);
}

describe('hosted MCP endpoint', () => {
  it('serves the configured deployment URLs on the browser landing page', async () => {
    const previousPublicBaseUrl = process.env.PUBLIC_BASE_URL;
    process.env.PUBLIC_BASE_URL = 'https://ai-room.pupgo.top/';

    try {
      const url = `http://127.0.0.1:${port}/mcp`;
      const response = await fetch(url, { headers: { accept: 'text/html' } });
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(html).toContain('https://ai-room.pupgo.top/mcp');
      expect(html).toContain('https://ai-room.pupgo.top/docs/mcp');
      expect(html).not.toContain('<your-deployment>');

      const head = await fetch(url, { method: 'HEAD', headers: { accept: 'text/html' } });
      expect(head.status).toBe(200);
      expect(head.headers.get('content-type')).toContain('text/html');
      expect(await head.text()).toBe('');
    } finally {
      if (previousPublicBaseUrl === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = previousPublicBaseUrl;
    }
  });

  it('serves the ten-tool surface, without the hosted-only two', async () => {
    const mcp = await connect();
    const listedTools = (await mcp.listTools()).tools;
    const tools = listedTools.map(t => t.name);

    expect(tools).toHaveLength(10);
    for (const name of [
      'room_create', 'room_join', 'room_send', 'room_listen', 'room_minutes',
      'room_leave', 'room_end', 'room_task', 'room_admin', 'room_webhook',
    ]) {
      expect(tools).toContain(name);
    }
    // These need accounts / Projects, which this deployment does not have.
    expect(tools).not.toContain('room_playbook');
    expect(tools).not.toContain('project_memory');

    const taskTool = listedTools.find(tool => tool.name === 'room_task')!;
    expect(taskTool.description).toContain('Do not repeat the ruling with room_send');
    expect(JSON.stringify(taskTool.inputSchema)).toContain('verify only; optional action request, not a second report');
    expect(JSON.stringify(taskTool.inputSchema)).toContain('Exact room participant display name');
    expect(JSON.stringify(taskTool.inputSchema)).toContain('required when verdict is rejected');
    expect(JSON.stringify(taskTool.inputSchema)).toContain('additionalProperties');
    expect(taskTool.outputSchema).toMatchObject({ type: 'object', additionalProperties: true });

    expect(mcp.getInstructions()).toContain('room_listen');
  });

  it('runs a room over the wire: create, join, send, listen', async () => {
    const mcp = await connect();

    const created = parsed(await mcp.callTool({
      name: 'room_create', arguments: { topic: 'smoke probe', name: 'Host' },
    }));
    // No account gate here — creating a room needs no sign-in on this
    // deployment, which is the point of stripping the hosted auth layer.
    expect(created.code).toMatch(/^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/);
    expect(typeof created.hostKey).toBe('string');
    const code = created.code as string;

    const joined = parsed(await mcp.callTool({
      name: 'room_join', arguments: { code, name: 'Guest' },
    }));
    expect(joined.assignedName).toBe('Guest');
    expect(joined.participants.map((p: { name: string }) => p.name)).toContain('Host');

    const sent = parsed(await mcp.callTool({
      name: 'room_send', arguments: { code, name: 'Guest', text: 'hello over http' },
    }));
    expect(sent.sent).toBe(true);

    const listed = parsed(await mcp.callTool({
      name: 'room_listen', arguments: { code, since: 0, name: 'Guest', timeoutMs: 1_000 },
    }));
    expect(listed.messages.some((m: { text: string }) => m.text === 'hello over http')).toBe(true);
    // The listen loop contract rides on every result; without it an agent has
    // nothing telling it to call again.
    expect(listed.listenStatus).toBe('active');
    expect(listed.nextAction).toMatchObject({ required: true, tool: 'room_listen' });
    expect(listed.hint).toContain('room_listen');

    const storedRoom = JSON.parse(smokeKv.get(`room:${code}`)!) as {
      participants: { name: string; listenUntil?: number; listenLeases?: Record<string, number> }[];
    };
    const guest = storedRoom.participants.find(p => p.name === 'Guest')!;
    expect(guest.listenUntil).toBeLessThanOrEqual(Date.now());
    expect(guest.listenLeases).toBeUndefined();
  }, 20_000);

  it('carries the room policy contract, which needs the ported shared module', async () => {
    const mcp = await connect();
    const created = parsed(await mcp.callTool({
      name: 'room_create', arguments: { topic: 'policy probe', name: 'Host' },
    }));
    const code = created.code as string;
    parsed(await mcp.callTool({ name: 'room_send', arguments: { code, name: 'Host', text: 'first' } }));

    const listed = parsed(await mcp.callTool({
      name: 'room_listen', arguments: { code, since: 0, name: 'Host', timeoutMs: 0 },
    }));
    // room_listen returns history without a policy brief; the board-carrying
    // fields are what matter here — policy rides on blocking listens.
    expect(listed.cursor).toBeGreaterThan(0);
  }, 20_000);

  it('verifies a room task through MCP and exposes the single persisted event to room_listen', async () => {
    const mcp = await connect();
    const created = parsed(await mcp.callTool({
      name: 'room_create', arguments: { topic: 'task verification smoke', name: 'Web Host' },
    }));
    const code = created.code as string;

    await mcp.callTool({ name: 'room_join', arguments: { code, name: 'Follow-up Agent' } });
    await mcp.callTool({ name: 'room_join', arguments: { code, name: 'Other Agent' } });
    await mcp.callTool({ name: 'room_join', arguments: { code, name: 'Producer' } });
    await mcp.callTool({ name: 'room_join', arguments: { code, name: 'Verifier' } });
    await mcp.callTool({ name: 'room_join', arguments: { code, name: 'Producer 2' } });

    const taskResult = parsed(await mcp.callTool({
      name: 'room_task',
      arguments: {
        code,
        name: 'Producer',
        action: 'create',
        title: 'MCP notification smoke',
        owner: 'Producer',
        verifier: 'Verifier',
        dod: 'The reviewer can observe the result message.',
      },
    }));
    const taskId = (taskResult.task as { id: string }).id;
    await mcp.callTool({ name: 'room_task', arguments: { code, name: 'Producer', action: 'claim', id: taskId } });
    await mcp.callTool({
      name: 'room_task',
      arguments: {
        code,
        name: 'Producer',
        action: 'submit',
        id: taskId,
        fileListing: 'README.md',
        fileExcerpt: 'Task verification smoke fixture',
        checks: 'The fixture was reviewed through the MCP task flow.',
      },
    });
    const invalidFollowUp = parsed(await mcp.callTool({
      name: 'room_task',
      arguments: {
        code,
        name: 'Verifier',
        action: 'verify',
        id: taskId,
        verdict: 'done',
        followUp: { target: 'Missing Participant', request: 'Please respond.' },
      },
    }));
    expect(invalidFollowUp.error).toBe('bad_request');
    expect(invalidFollowUp.message).toContain('not a participant');
    const pending = parsed(await mcp.callTool({ name: 'room_task', arguments: { code, name: 'Verifier', action: 'list' } }));
    expect((pending.board as { tasks: { state: string }[] }).tasks[0]!.state).toBe('awaiting_review');
    const noPrematureNotice = parsed(await mcp.callTool({
      name: 'room_listen', arguments: { code, since: 0, timeoutMs: 0 },
    }));
    expect((noPrematureNotice.messages as { type: string; text: string }[]).some(
      message => message.type === 'sys' && message.text.includes('MCP notification smoke'),
    )).toBe(false);

    const verifyResult = await mcp.callTool({
      name: 'room_task',
      arguments: {
        code,
        name: 'Verifier',
        action: 'verify',
        id: taskId,
        verdict: 'done',
        note: 'Independent review passed.',
        followUp: {
          target: 'Follow-up Agent',
          request: 'Please confirm whether the rollout window works for you.',
        },
      },
    });
    const verified = parsed(verifyResult);
    expect((verified.task as { state: string }).state).toBe('done');
    expect(verified).toMatchObject({
      verified: true,
      notificationSent: true,
      followUpRecorded: true,
      nextAction: 'no_duplicate_report',
    });
    expect(verified.hint).toContain('Do not repeat the ruling with room_send');
    expect(verifyResult.structuredContent).toMatchObject({
      verified: true,
      notificationSent: true,
      followUpRecorded: true,
    });

    const listened = parsed(await mcp.callTool({
      name: 'room_listen', arguments: { code, name: 'Follow-up Agent', since: 0, timeoutMs: 1000, wakeOn: 'addressed' },
    }));
    const notices = (listened.messages as { type: string; text: string }[])
      .filter(message => message.type === 'sys' && message.text.includes('MCP notification smoke'));
    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toContain('@Follow-up Agent Please confirm whether the rollout window works for you.');
    expect(notices[0]!.text).toContain('验收通过');
    expect(listened.addressedYou).toBe(true);

    const otherListen = parsed(await mcp.callTool({
      name: 'room_listen', arguments: { code, name: 'Other Agent', since: 0, timeoutMs: 1000, wakeOn: 'addressed' },
    }));
    expect(otherListen.addressedYou).toBeUndefined();

    const legacyTaskResult = parsed(await mcp.callTool({
      name: 'room_task',
      arguments: {
        code,
        name: 'Producer 2',
        action: 'create',
        title: 'Legacy verify compatibility',
        owner: 'Producer 2',
        verifier: 'Verifier',
      },
    }));
    const legacyTaskId = (legacyTaskResult.task as { id: string }).id;
    await mcp.callTool({ name: 'room_task', arguments: { code, name: 'Producer 2', action: 'claim', id: legacyTaskId } });
    await mcp.callTool({
      name: 'room_task',
      arguments: {
        code, name: 'Producer 2', action: 'submit', id: legacyTaskId,
        fileListing: 'README.md', fileExcerpt: 'legacy compatibility fixture',
        checks: 'Reviewed using the original verify parameters.',
      },
    });
    const legacyVerified = parsed(await mcp.callTool({
      name: 'room_task',
      arguments: { code, name: 'Verifier', action: 'verify', id: legacyTaskId, verdict: 'done' },
    }));
    expect(legacyVerified).toMatchObject({ verified: true, notificationSent: true, followUpRecorded: false });
    const allNotices = parsed(await mcp.callTool({
      name: 'room_listen', arguments: { code, name: 'Follow-up Agent', since: 0, timeoutMs: 0 },
    }));
    const systemNotices = (allNotices.messages as { type: string; text: string }[]).filter(message => message.type === 'sys');
    expect(systemNotices).toHaveLength(2);
    expect(systemNotices[1]!.text).toContain('验收通过');
    expect(systemNotices[1]!.text).not.toContain('审核意见：');
    expect(systemNotices[1]!.text).not.toContain('后续处理：');
  }, 20_000);

  it('does not address a suffixed cc seat from the host mention in a review notice', async () => {
    const mcp = await connect();
    const created = parsed(await mcp.callTool({
      name: 'room_create', arguments: { topic: 'addressed review notice', name: 'Alex' },
    }));
    const code = created.code as string;
    const joined = parsed(await mcp.callTool({
      name: 'room_join', arguments: { code, name: 'Alex (2)' },
    }));
    expect(joined.assignedName).toBe('Alex (2)');

    await mcp.callTool({ name: 'room_join', arguments: { code, name: 'Producer' } });
    await mcp.callTool({ name: 'room_join', arguments: { code, name: 'Reviewer' } });
    const taskResult = parsed(await mcp.callTool({
      name: 'room_task',
      arguments: {
        code, name: 'Producer', action: 'create',
        title: 'Review notice should not wake a suffix seat', owner: 'Producer', verifier: 'Reviewer',
      },
    }));
    const taskId = (taskResult.task as { id: string }).id;
    await mcp.callTool({ name: 'room_task', arguments: { code, name: 'Producer', action: 'claim', id: taskId } });
    await mcp.callTool({
      name: 'room_task',
      arguments: {
        code, name: 'Producer', action: 'submit', id: taskId,
        fileListing: 'README.md', fileExcerpt: 'addressed notice fixture',
        checks: 'The fixture is available to the verifier.',
      },
    });
    const verified = parsed(await mcp.callTool({
      name: 'room_task',
      arguments: { code, name: 'Reviewer', action: 'verify', id: taskId, verdict: 'done' },
    }));
    expect(verified).toMatchObject({ verified: true, notificationSent: true });

    const addressedListen = parsed(await mcp.callTool({
      name: 'room_listen',
      arguments: { code, name: 'Alex (2)', since: 0, timeoutMs: 1000, wakeOn: 'addressed' },
    }));
    expect(addressedListen.addressedYou).toBeUndefined();
    expect((addressedListen.messages as { type: string; text: string }[]).some(
      message => message.type === 'sys' && message.text.includes('主持人：@Alex'),
    )).toBe(true);

    const anyListen = parsed(await mcp.callTool({
      name: 'room_listen',
      arguments: { code, name: 'Alex (2)', since: 0, timeoutMs: 0, wakeOn: 'any' },
    }));
    expect(anyListen.addressedYou).toBeUndefined();
    expect((anyListen.messages as { text: string }[]).some(message => message.text.includes('主持人：@Alex'))).toBe(true);
  }, 20_000);

  it('rejects MCP rejections without a visible reason and allows one valid boundary retry', async () => {
    const mcp = await connect();
    const created = parsed(await mcp.callTool({
      name: 'room_create', arguments: { topic: 'rejection reason validation', name: 'Host' },
    }));
    const code = created.code as string;
    await mcp.callTool({ name: 'room_join', arguments: { code, name: 'Producer' } });
    await mcp.callTool({ name: 'room_join', arguments: { code, name: 'Reviewer' } });
    // Task roles must be seated agents; their join greetings precede the checks below.
    const baseCursor = (parsed(await mcp.callTool({
      name: 'room_listen', arguments: { code, since: 0, timeoutMs: 0 },
    })).cursor as number);
    const taskResult = parsed(await mcp.callTool({
      name: 'room_task',
      arguments: {
        code, name: 'Producer', action: 'create', title: 'Reason validation',
        owner: 'Producer', verifier: 'Reviewer',
      },
    }));
    const taskId = (taskResult.task as { id: string }).id;
    await mcp.callTool({ name: 'room_task', arguments: { code, name: 'Producer', action: 'claim', id: taskId } });
    await mcp.callTool({
      name: 'room_task',
      arguments: {
        code, name: 'Producer', action: 'submit', id: taskId,
        fileListing: 'README.md', fileExcerpt: 'reason validation fixture',
        checks: 'The task is ready for the required review.',
      },
    });

    const invalidReasons: Array<{ label: string; note?: string }> = [
      { label: 'missing' },
      { label: 'empty', note: '' },
      { label: 'whitespace', note: '  \t  ' },
      { label: 'control-only', note: '\n\r\u0000\u007f' },
      { label: 'overlong', note: 'x'.repeat(601) },
    ];
    for (const { label, note } of invalidReasons) {
      const result = parsed(await mcp.callTool({
        name: 'room_task',
        arguments: {
          code, name: 'Reviewer', action: 'verify', id: taskId, verdict: 'rejected',
          ...(note !== undefined ? { note } : {}),
        },
      }));
      expect(result.error, label).toBe('bad_request');
      expect(result.message, label).toContain('1–600 visible characters');
      expect(result.verified, label).toBeUndefined();
      expect(result.notificationSent, label).toBeUndefined();
      const board = parsed(await mcp.callTool({ name: 'room_task', arguments: { code, name: 'Reviewer', action: 'list' } }));
      const pending = (board.board as { tasks: { state: string; verdict?: unknown }[] }).tasks[0]!;
      expect(pending.state).toBe('awaiting_review');
      expect(pending.verdict).toBeUndefined();
      const listen = parsed(await mcp.callTool({
        name: 'room_listen', arguments: { code, since: baseCursor, timeoutMs: 0 },
      }));
      expect(listen.messages, label).toEqual([]);
      expect(listen.cursor, label).toBe(baseCursor);
    }

    const boundaryReason = 'x'.repeat(600);
    const verified = parsed(await mcp.callTool({
      name: 'room_task',
      arguments: {
        code, name: 'Reviewer', action: 'verify', id: taskId, verdict: 'rejected', note: boundaryReason,
      },
    }));
    expect(verified).toMatchObject({ verified: true, notificationSent: true, nextAction: 'no_duplicate_report' });
    expect((verified.task as { verdict: { note: string } }).verdict.note).toBe(boundaryReason);
    const notices = parsed(await mcp.callTool({
      name: 'room_listen', arguments: { code, since: baseCursor, timeoutMs: 0 },
    }));
    expect(notices.messages as { type: string; text: string }[]).toHaveLength(1);
    expect((notices.messages as { type: string; text: string }[])[0]!.text).toContain(`原因：${boundaryReason}`);
    expect(notices.cursor).toBe(baseCursor + 1);
  }, 20_000);

  it('holds an identified weak client to its safe listen window', async () => {
    const mcp = await connect('Antigravity');
    const listen = (await mcp.listTools()).tools.find(t => t.name === 'room_listen')!;

    // The ported harness has to be wired in, not just present in the tree.
    expect(listen.description).toContain('max 45000 on Antigravity');
    expect(listen.description).not.toContain('max 240000');
  });

  it('refuses a webhook URL aimed at the deployment’s own network', async () => {
    const mcp = await connect();
    const created = parsed(await mcp.callTool({
      name: 'room_create', arguments: { topic: 'ssrf probe', name: 'Host' },
    }));
    const code = created.code as string;

    // upstash-client's registerRoomWebhook accepts any string; the guard lives
    // at this seam. Without it, a room code would be enough to make the server
    // POST chat content at cloud metadata.
    for (const url of ['http://169.254.169.254/latest/meta-data/', 'https://localhost/hook', 'https://127.0.0.1/hook']) {
      const res = parsed(await mcp.callTool({
        name: 'room_webhook', arguments: { code, name: 'Host', action: 'register', url },
      }));
      expect(res.registered).toBeFalsy();
    }

    const listed = parsed(await mcp.callTool({
      name: 'room_webhook', arguments: { code, name: 'Host', action: 'list' },
    }));
    expect(listed.webhooks ?? []).toHaveLength(0);
  }, 20_000);

  it('serves the SSE endpoint event, bounds sessions, rejects unknown IDs, and cleans disconnects', async () => {
    const first = await openRawSse();
    const second = await openRawSse();
    expect(first.response.status).toBe(200);
    expect(first.response.headers.get('content-type')).toContain('text/event-stream');
    expect(first.response.headers.get('cache-control')).toContain('no-transform');
    expect(first.response.headers.get('x-accel-buffering')).toBe('no');
    expect(first.endpoint.pathname).toBe('/sse/messages');
    expect(first.sessionId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(second.sessionId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(vpsApp.getSseSessionCount()).toBe(2);

    const capped = await fetch(`http://127.0.0.1:${vpsPort}/sse`, {
      headers: { accept: 'text/event-stream' },
    });
    expect(capped.status).toBe(503);
    expect((await capped.json()).error).toBe('sse_session_limit_reached');

    const unknown = await fetch(`http://127.0.0.1:${vpsPort}/sse/messages?sessionId=unknown-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('content-type')).toContain('application/json');
    expect((await unknown.json()).error).toBe('unknown_sse_session');

    const duplicateSessionIds = await fetch(
      `http://127.0.0.1:${vpsPort}/sse/messages?sessionId=${first.sessionId}&sessionId=${second.sessionId}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
    );
    expect(duplicateSessionIds.status).toBe(400);
    expect((await duplicateSessionIds.json()).error).toBe('invalid_session_id');

    const health = await fetch(`http://127.0.0.1:${vpsPort}/healthz`);
    expect(health.status).toBe(200);
    const ready = await fetch(`http://127.0.0.1:${vpsPort}/readyz`);
    expect(ready.status).toBe(200);

    const oldMcpGet = await fetch(`http://127.0.0.1:${vpsPort}/mcp`, {
      headers: { accept: 'text/event-stream' },
    });
    expect(oldMcpGet.status).toBe(200);
    expect(oldMcpGet.headers.get('content-type')).toContain('text/event-stream');
    expect(oldMcpGet.headers.get('mcp-session-id')).toBeNull();
    await oldMcpGet.body?.cancel();

    await Promise.all([first.close(), second.close()]);
    await waitForSseSessionCount(0);

    const reconnected = new Client({ name: 'legacy-sse-reconnected', version: '1.0.0' });
    clients.push(reconnected);
    await reconnected.connect(new SSEClientTransport(new URL(`http://127.0.0.1:${vpsPort}/sse`)));
    expect(vpsApp.getSseSessionCount()).toBe(1);
    expect((await reconnected.listTools()).tools).toHaveLength(10);
    const reconnectedRoom = parsed(await reconnected.callTool({
      name: 'room_create', arguments: { topic: 'legacy SSE reconnect', name: 'Reconnect Host' },
    }));
    expect(reconnectedRoom.code).toMatch(/^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/);
    const minutes = parsed(await reconnected.callTool({
      name: 'room_minutes', arguments: { code: reconnectedRoom.code },
    }));
    expect(minutes.topic).toBe('legacy SSE reconnect');
    await reconnected.close();
    await waitForSseSessionCount(0);

    const invalidBodySession = await openRawSse();
    const invalidBody = await fetch(invalidBodySession.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    expect(invalidBody.status).toBe(400);
    expect((await invalidBody.json()).error).toBe('invalid_json');
    await waitForSseSessionCount(0);
    await invalidBodySession.close();
  });

  it('uses the official legacy SSE client for isolated sessions and room tool calls', async () => {
    const base = `http://127.0.0.1:${vpsPort}`;
    const first = new Client({ name: 'legacy-sse-one', version: '1.0.0' });
    const second = new Client({ name: 'legacy-sse-two', version: '1.0.0' });
    clients.push(first, second);
    await Promise.all([
      first.connect(new SSEClientTransport(new URL(`${base}/sse`), {
        requestInit: { headers: { 'user-agent': 'Antigravity/1.0' } },
      })),
      second.connect(new SSEClientTransport(new URL(`${base}/sse`), {
        requestInit: { headers: { 'user-agent': 'Antigravity/1.0' } },
      })),
    ]);
    expect(vpsApp.getSseSessionCount()).toBe(2);

    const firstTools = (await first.listTools()).tools.map(tool => tool.name);
    const secondTools = (await second.listTools()).tools.map(tool => tool.name);
    expect(firstTools).toHaveLength(10);
    expect(secondTools).toEqual(firstTools);
    // The comment heartbeat is deliberately not a JSON-RPC event.
    await new Promise(resolve => setTimeout(resolve, 70));
    expect((await first.listTools()).tools).toHaveLength(10);

    const hostRoom = parsed(await first.callTool({
      name: 'room_create', arguments: { topic: 'legacy SSE E2E', name: 'SSE Host' },
    }));
    const isolatedRoom = parsed(await second.callTool({
      name: 'room_create', arguments: { topic: 'second session', name: 'Second Host' },
    }));
    expect(hostRoom.code).not.toBe(isolatedRoom.code);
    const code = hostRoom.code as string;

    const joined = parsed(await second.callTool({
      name: 'room_join', arguments: { code, name: 'SSE Guest' },
    }));
    expect(joined.assignedName).toBe('SSE Guest');
    const sent = parsed(await second.callTool({
      name: 'room_send', arguments: { code, name: 'SSE Guest', text: 'hello from legacy SSE' },
    }));
    expect(sent.sent).toBe(true);
    const listened = parsed(await first.callTool({
      name: 'room_listen', arguments: { code, name: 'SSE Host', since: 0, timeoutMs: 0 },
    }));
    expect(listened.messages.filter((message: { text: string }) => message.text === 'hello from legacy SSE')).toHaveLength(1);

    await Promise.all([first.close(), second.close()]);
    await waitForSseSessionCount(0);
  }, 20_000);

  it('keeps VPS /mcp Streamable HTTP intact and makes serverless /sse explicitly unsupported', async () => {
    const streamable = new Client({ name: 'vps-mcp-regression', version: '1.0.0' });
    clients.push(streamable);
    await streamable.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${vpsPort}/mcp`)));
    expect((await streamable.listTools()).tools).toHaveLength(10);
    const created = parsed(await streamable.callTool({
      name: 'room_create', arguments: { topic: 'mcp remains streamable', name: 'MCP Host' },
    }));
    expect(created.code).toMatch(/^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/);

    const serverless = await fetch(`http://127.0.0.1:${port}/mcp?legacySse=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(serverless.status).toBe(501);
    expect((await serverless.json()).error).toBe('legacy_sse_requires_vps');
  }, 20_000);
});
