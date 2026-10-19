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
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  applyMemoryMigrations,
  PostgresMemoryRepository,
  RedisUrlCommandClient,
} from '@agent-room/memory';
import { createRemoteRoomClient } from './_mcpRoomClient.js';
import { callTool, listTools } from './_mcpTools.js';
import { createMemoryTestDependencies } from './_memoryTools.js';

const REDIS_BASE = 'https://smoke.upstash.invalid';
const initialMemoryEnabled = process.env.MEMORY_ENABLED;
const initialMemoryDatabaseUrl = process.env.MEMORY_DATABASE_URL;
const initialJevApiKey = process.env.JEV_API_KEY;
const initialDedupVerifier = process.env.MEMORY_DEDUP_VERIFIER;
const initialJevReview = process.env.MEMORY_JEV_REVIEW;
process.env.UPSTASH_REDIS_REST_URL = REDIS_BASE;
process.env.UPSTASH_REDIS_REST_TOKEN = 'smoke-token';
process.env.SRH_WEB_URL = REDIS_BASE;
process.env.SRH_WEB_TOKEN = 'smoke-token';
process.env.MCP_ROOM_CREATE_ENABLED = 'true';

/**
 * A one-time agent invite for a NEW MCP agent seat, written straight into the
 * fake Redis (host-key checks for createAgentInvite are covered in agentInvite.test.ts).
 * role/personaId mirror what the join sends, so seats keep their old identity.
 */
let inviteCounter = 0;
function mintInvite(code: string, role = '', personaId?: string, roleProfile?: string): string {
  inviteCounter += 1;
  const inviteCode = `AI-SMOKE-${String(inviteCounter).padStart(4, '0')}`;
  const hash = createHash('sha256').update(inviteCode, 'utf8').digest('hex');
  const now = Date.now();
  smokeKv.set(`room:${code}:agent-invite:${hash}`, JSON.stringify({
    code, role, ...(personaId ? { personaId } : {}), ...(roleProfile ? { roleProfile } : {}), createdAt: now, expiresAt: now + 300_000, used: false,
  }));
  return inviteCode;
}

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
      case 'SET': {
        // NX is how an agent invite code is spent exactly once.
        if (cmd.slice(3).map(c => String(c).toUpperCase()).includes('NX') && kv.has(key)) return null;
        kv.set(key, String(cmd[2]));
        return 'OK';
      }
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
  delete process.env.MEMORY_ENABLED;
  delete process.env.MEMORY_DATABASE_URL;
  // Smoke coverage exercises storage and routing; all Jev behavior uses mocked fetch tests.
  process.env.JEV_API_KEY = '';
  process.env.MEMORY_DEDUP_VERIFIER = 'off';
  process.env.MEMORY_JEV_REVIEW = 'off';
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
  if (initialMemoryEnabled === undefined) delete process.env.MEMORY_ENABLED;
  else process.env.MEMORY_ENABLED = initialMemoryEnabled;
  if (initialMemoryDatabaseUrl === undefined) delete process.env.MEMORY_DATABASE_URL;
  else process.env.MEMORY_DATABASE_URL = initialMemoryDatabaseUrl;
  if (initialJevApiKey === undefined) delete process.env.JEV_API_KEY;
  else process.env.JEV_API_KEY = initialJevApiKey;
  if (initialDedupVerifier === undefined) delete process.env.MEMORY_DEDUP_VERIFIER;
  else process.env.MEMORY_DEDUP_VERIFIER = initialDedupVerifier;
  if (initialJevReview === undefined) delete process.env.MEMORY_JEV_REVIEW;
  else process.env.MEMORY_JEV_REVIEW = initialJevReview;
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

function parsed(value: unknown): Record<string, any> {
  const content = (value as { content?: unknown })?.content as { type: string; text: string }[];
  return JSON.parse(content[0]!.text);
}

/**
 * The one official ruling, as opposed to the board's other events. create and
 * submit now post their own sys lines (the owner's assignment, the verifier's
 * review request), so "a sys message naming this task" no longer identifies a
 * verdict — 验收通过 / 验收未通过 does.
 */
function isReviewNotice(message: { type: string; text: string }): boolean {
  return message.type === 'sys' && message.text.includes('验收');
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

  it('hides room_create by default and returns clear error when called', async () => {
    delete process.env.MCP_ROOM_CREATE_ENABLED;
    try {
      const mcp = await connect();
      const listedTools = (await mcp.listTools()).tools;
      const tools = listedTools.map(t => t.name);
      expect(tools).not.toContain('room_create');
      expect(tools).toHaveLength(9);
      const res = await mcp.callTool({
        name: 'room_create', arguments: { topic: 'test room' },
      });
      expect(res.isError).toBe(true);
      expect(parsed(res)).toMatchObject({
        error: 'room_create_disabled',
        message: 'Rooms can only be created by a signed-in user in the web UI.',
      });
    } finally {
      process.env.MCP_ROOM_CREATE_ENABLED = 'true';
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
      name: 'room_join', arguments: { code, name: 'Guest', inviteCode: mintInvite(code) },
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

    await mcp.callTool({ name: 'room_join', arguments: { code, name: 'Follow-up Agent', inviteCode: mintInvite(code) } });
    await mcp.callTool({ name: 'room_join', arguments: { code, name: 'Other Agent', inviteCode: mintInvite(code) } });
    await mcp.callTool({ name: 'room_join', arguments: { code, name: 'Producer', inviteCode: mintInvite(code) } });
    await mcp.callTool({ name: 'room_join', arguments: { code, name: 'Verifier', inviteCode: mintInvite(code) } });
    await mcp.callTool({ name: 'room_join', arguments: { code, name: 'Producer 2', inviteCode: mintInvite(code) } });

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
    expect((noPrematureNotice.messages as { type: string; text: string }[]).some(isReviewNotice)).toBe(false);

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
    const notices = (listened.messages as { type: string; text: string }[]).filter(isReviewNotice);
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
    // Two tasks now add owner-assignment and verifier-request events, in
    // addition to the two official rulings. The rulings remain exactly one
    // per successful verify.
    const rulings = systemNotices.filter(isReviewNotice);
    expect(systemNotices).toHaveLength(6);
    expect(rulings).toHaveLength(2);
    expect(rulings[1]!.text).toContain('验收通过');
    expect(rulings[1]!.text).not.toContain('审核意见：');
    expect(rulings[1]!.text).not.toContain('后续处理：');
  }, 20_000);

  it('wakes task owners and reviewers, and keeps board work in quiet listen results', async () => {
    const roomClient = createRemoteRoomClient(undefined);
    const invoke = async (name: string, args: Record<string, unknown>) =>
      parsed(await callTool(roomClient, 'full', name, args));
    const host = await invoke('room_create', { topic: 'task lifecycle wakeups', name: 'Wake Host' });
    const code = String(host.code);
    await invoke('room_join', { code, name: 'Worker', inviteCode: mintInvite(code) });
    await invoke('room_join', { code, name: 'Reviewer', inviteCode: mintInvite(code) });
    await invoke('room_join', { code, name: 'Other', inviteCode: mintInvite(code) });

    const ownerCursor = Number((await invoke('room_listen', { code, name: 'Worker', since: 0, timeoutMs: 0 })).cursor);
    const createStarted = Date.now();
    const ownerListenPromise = invoke('room_listen', {
      code, name: 'Worker', since: ownerCursor, timeoutMs: 8_000, wakeOn: 'addressed',
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    const created = await invoke('room_task', {
      code, name: 'Reviewer', action: 'create', title: 'Lifecycle wake fixture',
      owner: 'Worker', verifier: 'Reviewer', dod: 'A fixture for task wakeup coverage.',
    });
    const taskId = String((created.task as { id: string }).id);
    const ownerWoken = await ownerListenPromise;
    expect(Date.now() - createStarted).toBeLessThan(3_000);
    expect(ownerWoken.nextAction).toMatchObject({ kind: 'task_work', action: 'claim', arguments: { id: taskId } });

    await invoke('room_task', { code, name: 'Worker', action: 'claim', id: taskId });
    const quietOwner = await invoke('room_listen', {
      code, name: 'Worker', since: Number(ownerWoken.cursor), timeoutMs: 1_000,
    });
    expect(quietOwner.messages).toEqual([]);
    expect(quietOwner.nextAction).toMatchObject({ kind: 'task_work', action: 'execute_task', taskId });

    const reviewerCursor = Number((await invoke('room_listen', {
      code, name: 'Reviewer', since: 0, timeoutMs: 0,
    })).cursor);
    const submitStarted = Date.now();
    const reviewerListenPromise = invoke('room_listen', {
      code, name: 'Reviewer', since: reviewerCursor, timeoutMs: 8_000, wakeOn: 'addressed',
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    await invoke('room_task', {
      code, name: 'Worker', action: 'submit', id: taskId,
      fileListing: 'src/example.ts', fileExcerpt: 'Lifecycle wake fixture',
      checks: 'The task is ready for review.',
    });
    const reviewerWoken = await reviewerListenPromise;
    expect(Date.now() - submitStarted).toBeLessThan(3_000);
    expect(reviewerWoken.nextAction).toMatchObject({ kind: 'task_review', taskId });

    const ownerAfterSubmitCursor = Number((await invoke('room_listen', {
      code, name: 'Worker', since: Number(ownerWoken.cursor), timeoutMs: 0,
    })).cursor);
    const rejectedOwnerListenPromise = invoke('room_listen', {
      code, name: 'Worker', since: ownerAfterSubmitCursor, timeoutMs: 8_000,
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    await invoke('room_task', {
      code, name: 'Reviewer', action: 'verify', id: taskId,
      verdict: 'rejected', note: 'Please fix the failing check.',
    });
    const rejectedOwner = await rejectedOwnerListenPromise;
    expect(rejectedOwner.cursor).toBeGreaterThan(ownerAfterSubmitCursor);
    expect((rejectedOwner.messages as { type: string; text: string }[]).some(isReviewNotice)).toBe(true);
    expect(rejectedOwner.nextAction).toMatchObject({ kind: 'task_work', action: 'execute_task', taskId });

    await invoke('room_task', { code, name: 'Reviewer', action: 'reopen', id: taskId, state: 'in_progress' });
    const reopenedOwner = await invoke('room_listen', {
      code, name: 'Worker', since: Number(rejectedOwner.cursor), timeoutMs: 1_000,
    });
    expect(reopenedOwner.messages).toEqual([]);
    expect(reopenedOwner.nextAction).toMatchObject({ kind: 'task_work', action: 'execute_task', taskId });

    const unassigned = await invoke('room_task', {
      code, name: 'Reviewer', action: 'create', title: 'Reassignment wake fixture', verifier: 'Reviewer',
    });
    const reassignedTaskId = String((unassigned.task as { id: string }).id);
    const otherCursor = Number((await invoke('room_listen', {
      code, name: 'Other', since: 0, timeoutMs: 0,
    })).cursor);
    const reassignmentListenPromise = invoke('room_listen', {
      code, name: 'Other', since: otherCursor, timeoutMs: 8_000, wakeOn: 'addressed',
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    await invoke('room_task', {
      code, name: 'Reviewer', action: 'reassign', id: reassignedTaskId, owner: 'Other',
    });
    const reassignedOwner = await reassignmentListenPromise;
    expect(reassignedOwner.nextAction).toMatchObject({
      kind: 'task_work', action: 'claim', arguments: { id: reassignedTaskId },
    });
  }, 20_000);

  it('does not address a suffixed cc seat from the host mention in a review notice', async () => {
    const mcp = await connect();
    const created = parsed(await mcp.callTool({
      name: 'room_create', arguments: { topic: 'addressed review notice', name: 'Alex' },
    }));
    const code = created.code as string;
    const joined = parsed(await mcp.callTool({
      name: 'room_join', arguments: { code, name: 'Alex (2)', inviteCode: mintInvite(code) },
    }));
    expect(joined.assignedName).toBe('Alex (2)');

    await mcp.callTool({ name: 'room_join', arguments: { code, name: 'Producer', inviteCode: mintInvite(code) } });
    await mcp.callTool({ name: 'room_join', arguments: { code, name: 'Reviewer', inviteCode: mintInvite(code) } });
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
    await mcp.callTool({ name: 'room_join', arguments: { code, name: 'Producer', inviteCode: mintInvite(code) } });
    await mcp.callTool({ name: 'room_join', arguments: { code, name: 'Reviewer', inviteCode: mintInvite(code) } });
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
    // Taken here, not before the task: the join greetings, the owner's
    // assignment event and the verifier's review-request event are all legal
    // traffic. What must add nothing to the room is a REFUSED verify.
    const baseCursor = (parsed(await mcp.callTool({
      name: 'room_listen', arguments: { code, since: 0, timeoutMs: 0 },
    })).cursor as number);

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
      name: 'room_join', arguments: { code, name: 'SSE Guest', inviteCode: mintInvite(code) },
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

  it('runs seat-bound memory end to end through api/_mcpTools.callTool', async () => {
    const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL?.trim();
    const redisUrl = process.env.MEMORY_TEST_REDIS_URL?.trim();
    if (!databaseUrl) throw new Error('MEMORY_TEST_DATABASE_URL is required; MCP memory integration does not skip.');
    if (!redisUrl) throw new Error('MEMORY_TEST_REDIS_URL is required; MCP memory integration does not skip.');

    const previousMemoryEnabled = process.env.MEMORY_ENABLED;
    const previousMemoryDatabaseUrl = process.env.MEMORY_DATABASE_URL;
    const admin = new Pool({ connectionString: databaseUrl });
    const schema = `memory_mcp_${process.pid}_${Date.now().toString(36)}`;
    let scoped: Pool | undefined;
    try {
      const version = await admin.query<{ server_version_num: string }>('SHOW server_version_num');
      const versionNumber = Number(version.rows[0]?.server_version_num);
      if (versionNumber < 170000 || versionNumber >= 180000) {
        throw new Error(`MEMORY_TEST_DATABASE_URL must point to PostgreSQL 17.x; found ${String(version.rows[0]?.server_version_num)}.`);
      }
      await admin.query(`CREATE SCHEMA ${schema}`);
      scoped = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
      await applyMemoryMigrations(scoped);
      const dependencies = createMemoryTestDependencies(
        () => PostgresMemoryRepository.fromPool(scoped!),
        new RedisUrlCommandClient(redisUrl),
      );
      delete process.env.MEMORY_ENABLED;
      delete process.env.MEMORY_DATABASE_URL;
      expect(listTools('full').some(tool => tool.name.startsWith('memory_'))).toBe(false);
      const roomClient = createRemoteRoomClient(undefined);
      const disabledRoom = parsed(await callTool(roomClient, 'full', 'room_create', {
        topic: 'Memory disabled join', name: 'Host',
      }));
      const disabledJoin = parsed(await callTool(roomClient, 'full', 'room_join', {
        code: String(disabledRoom.code), name: 'Guest', inviteCode: mintInvite(String(disabledRoom.code)),
      }));
      expect(disabledJoin.memoryNote).toBeUndefined();
      // A brand-new agent seat without (or with a wrong) invite code is refused with a Chinese hint.
      const noCode = parsed(await callTool(roomClient, 'full', 'room_join', { code: String(disabledRoom.code), name: 'No Code' }));
      expect(noCode).toMatchObject({ error: 'invite_code_required', code: 'invite_code_required' });
      expect(String(noCode.hint)).toContain('邀请码');
      const wrongCode = parsed(await callTool(roomClient, 'full', 'room_join', {
        code: String(disabledRoom.code), name: 'No Code', inviteCode: 'AI-WRONG-CODE',
      }));
      expect(wrongCode).toMatchObject({ error: 'invite_code_invalid' });
      process.env.MEMORY_ENABLED = 'true';
      process.env.MEMORY_DATABASE_URL = databaseUrl;
      const listedMemoryTools = listTools('full').filter(tool => tool.name.startsWith('memory_'));
      expect(listedMemoryTools).toHaveLength(8);
      for (const tool of listedMemoryTools) {
        const properties = (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
        expect(properties).not.toHaveProperty('name');
        expect(properties).not.toHaveProperty('role');
        expect(properties).not.toHaveProperty('personaId');
      }

      const schemaByTool = new Map(listedMemoryTools.map(tool => [tool.name, tool.outputSchema]));
      const invoke = async (name: string, args: Record<string, unknown>) => {
        const result = await callTool(roomClient, 'full', name, args, undefined, dependencies);
        const body = parsed(result);
        if (name.startsWith('memory_')) {
          // Declared outputSchema is { type: 'object' }: structuredContent must be present,
          // a plain object, and identical to the text payload on success and error paths.
          expect(schemaByTool.get(name)).toMatchObject({ type: 'object' });
          expect(result.structuredContent).toBeDefined();
          expect(typeof result.structuredContent).toBe('object');
          expect(Array.isArray(result.structuredContent)).toBe(false);
          expect(result.structuredContent).toEqual(body);
        }
        return body;
      };
      const host = await invoke('room_create', { topic: 'Memory isolation integration', name: 'Host' });
      const code = String(host.code);
      const hostSeatKey = String(host.seatKey);
      expect(hostSeatKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const agentA = await invoke('room_join', {
        code, name: 'Agent A', personaId: 'persona-alpha', role: 'builder',
        inviteCode: mintInvite(code, 'builder', 'persona-alpha'),
      });
      if (typeof agentA.memoryBrief === 'string' && agentA.memoryBrief.trim()) {
        expect(agentA.memoryNote).toBeUndefined();
      } else {
        expect(agentA.memoryNote).toContain('memory_write scope room');
      }
      let seatA = String(agentA.seatKey);
      expect(agentA.memoryBriefEstimated).toBe(true);

      const storedRoom = JSON.parse(smokeKv.get(`room:${code}`)!) as {
        participants: { name: string; seatKeyHash?: string; memoryPersonaId?: string }[];
        roomInstanceId?: string;
      };
      const storedA = storedRoom.participants.find(participant => participant.name === 'Agent A')!;
      expect(storedRoom.roomInstanceId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(storedA.seatKeyHash).toBe(createHash('sha256').update(seatA).digest('hex'));
      expect(JSON.stringify(storedA)).not.toContain(seatA);
      expect(storedA.memoryPersonaId).toBe('persona-alpha');

      const privateWriteArgs = {
        code, seatKey: seatA, scope: 'persona', title: 'Private alpha fact', preview: 'Alpha preview',
        content: 'The private fact belongs to persona alpha.', searchText: 'alpha-private-fact',
        requestId: `persona-write-${randomUUID()}`,
      };
      const privateWrite = await invoke('memory_write', privateWriteArgs);
      expect(privateWrite.status).toBe('created');
      const privateId = String(privateWrite.id);
      const replay = await invoke('memory_write', privateWriteArgs);
      expect(replay.id).toBe(privateId);

      const ageSeat = (seatName: string, roomCode: string = code) => {
        const raw = JSON.parse(smokeKv.get(`room:${roomCode}`)!) as { participants: Record<string, unknown>[] };
        for (const p of raw.participants) {
          if (p.name === seatName) {
            p.lastSeenAt = Date.now() - 121_000;
            delete p.listenUntil;
            delete p.listenLeases;
          }
        }
        smokeKv.set(`room:${roomCode}`, JSON.stringify(raw));
      };
      const seatNames = () => (JSON.parse(smokeKv.get(`room:${code}`)!) as { participants: { name: string }[] })
        .participants.map(p => p.name);
      // Same Persona, no seatKey, while its seat is online: refused, never evicted, no "(2)" seat.
      const busy = await invoke('room_join', {
        code, name: 'Agent A new seat', personaId: 'persona-alpha', role: 'builder',
      });
      expect(busy).toMatchObject({ error: 'SEAT_IN_USE', code: 'SEAT_IN_USE' });
      expect(seatNames().filter(n => n.startsWith('Agent A'))).toEqual(['Agent A']);
      // Plant an orphaned offline seat of the same Persona (as left by an earlier key-less join).
      const planted = JSON.parse(smokeKv.get(`room:${code}`)!) as { participants: Record<string, unknown>[] };
      planted.participants.push({
        name: 'Agent A (2)', role: 'builder', color: '#000000', initials: 'AA', client: 'cc',
        joinedAt: Date.now() - 600_000, lastSeenAt: Date.now() - 600_000, canSpeak: true,
        seatKeyHash: 'a'.repeat(64), memoryIdentityType: 'persona', memoryPersonaId: 'persona-alpha',
        memoryPrincipalId: randomUUID(),
      });
      smokeKv.set(`room:${code}`, JSON.stringify(planted));
      // Once the seat is offline (>120s, no listen lease) the same Persona reclaims it under the same name.
      ageSeat('Agent A');
      const samePersonaSeat = await invoke('room_join', {
        code, name: 'Agent A new seat', personaId: 'persona-alpha', role: 'builder',
      });
      expect(samePersonaSeat.assignedName).toBe('Agent A');
      const samePersonaKey = String(samePersonaSeat.seatKey);
      expect(samePersonaKey).not.toBe(seatA);
      expect(await invoke('memory_list', { code, seatKey: seatA, scope: 'persona' })).toMatchObject({ code: 'FORBIDDEN' });
      expect(seatNames().filter(n => n.startsWith('Agent A'))).toEqual(['Agent A']);
      seatA = samePersonaKey;
      expect((await invoke('memory_read', { code, seatKey: samePersonaKey, id: privateId })).content)
        .toContain('private fact belongs to persona alpha');
      const otherPersonaSeat = await invoke('room_join', {
        code, name: 'Agent B', personaId: 'persona-beta', role: 'reviewer',
        inviteCode: mintInvite(code, 'reviewer', 'persona-beta'),
      });
      const otherPersonaKey = String(otherPersonaSeat.seatKey);
      expect(otherPersonaSeat.memoryBrief).not.toContain(privateId);
      const analyst = await invoke('room_join', {
        code, name: 'Project Analyst', personaId: 'persona-reviewer', role: 'project-analyst',
        inviteCode: mintInvite(code, 'project-analyst', 'persona-reviewer'),
      });
      const analystKey = String(analyst.seatKey);
      expect(await invoke('memory_read', {
        code, seatKey: otherPersonaKey, id: privateId, personaId: 'persona-alpha', name: 'Agent A', role: 'project-analyst',
      })).toMatchObject({ code: 'NOT_FOUND' });
      expect(await invoke('memory_list', { code, seatKey: otherPersonaKey, scope: 'persona' }))
        .toMatchObject({ items: [] });
      expect(await invoke('memory_read', { code, seatKey: 'invalid-seat-key', id: privateId }))
        .toMatchObject({ code: 'FORBIDDEN' });

      const otherRoomHost = await invoke('room_create', { topic: 'Different Room', name: 'Other Host' });
      const otherRoomCode = String(otherRoomHost.code);
      const samePersonaOtherRoom = await invoke('room_join', {
        code: otherRoomCode, name: 'Agent A', personaId: 'persona-alpha',
        inviteCode: mintInvite(otherRoomCode, '', 'persona-alpha'),
      });
      const storedOtherRoom = JSON.parse(smokeKv.get(`room:${otherRoomCode}`)!) as { roomInstanceId?: string };
      expect(storedOtherRoom.roomInstanceId).not.toBe(storedRoom.roomInstanceId);
      expect(await invoke('memory_read', {
        code: otherRoomCode, seatKey: String(samePersonaOtherRoom.seatKey), id: privateId,
      })).toMatchObject({ code: 'NOT_FOUND' });

      // Invite role profile: returned at join, saved as Persona memory, upserted (unchanged / updated), listed in a new session's Brief.
      const profileRoom = await invoke('room_create', { topic: 'Role profile', name: 'Profile Host' });
      const profileCode = String(profileRoom.code);
      const profiled = await invoke('room_join', {
        code: profileCode, name: 'Profiled', sessionId: 'profile-session-1',
        inviteCode: mintInvite(profileCode, '测试工程师', '测试工程师', '负责回归测试，只用 vitest。'),
      });
      expect(profiled.roleProfile).toBe('负责回归测试，只用 vitest。');
      expect(profiled.roleProfileMemory).toMatchObject({ status: 'created' });
      expect(String(profiled.memoryBrief)).toContain('职业设定与技能：测试工程师');
      ageSeat('Profiled', profileCode);
      const sameProfile = await invoke('room_join', {
        code: profileCode, name: 'Profiled', sessionId: 'profile-session-2',
        inviteCode: mintInvite(profileCode, '测试工程师', '测试工程师', '负责回归测试，只用 vitest。'),
      });
      expect(sameProfile.assignedName).toBe('Profiled');
      expect(sameProfile.roleProfileMemory).toMatchObject({ status: 'unchanged' });
      ageSeat('Profiled', profileCode);
      const changedProfile = await invoke('room_join', {
        code: profileCode, name: 'Profiled', sessionId: 'profile-session-3',
        inviteCode: mintInvite(profileCode, '测试工程师', '测试工程师', '负责回归测试，只用 vitest 和 Playwright。'),
      });
      expect(changedProfile.roleProfile).toBe('负责回归测试，只用 vitest 和 Playwright。');
      expect(changedProfile.roleProfileMemory).toMatchObject({ status: 'updated', id: (profiled.roleProfileMemory as { id: string }).id });
      expect(String(sameProfile.memoryBrief)).toContain('职业设定与技能：测试工程师');
      const profileList = await invoke('memory_list', { code: profileCode, seatKey: String(changedProfile.seatKey), scope: 'persona' });
      expect((profileList.items as { title: string }[]).filter(i => i.title === '职业设定与技能：测试工程师')).toHaveLength(1);

      // A proposal has to reach the reviewer through the room, not only through
      // the proposer's tool result — an analyst sitting in room_listen is the
      // normal case, and polling memory_review is not.
      const roomNotices = async () => ((await invoke('room_listen', {
        code, name: 'Host', since: 0, timeoutMs: 0,
      })).messages as { text: string }[]).filter(message => message.text.includes('Memory review needed'));
      const cursorBeforeProposal = Number((await invoke('room_listen', {
        code, name: 'Project Analyst', since: 0, timeoutMs: 0,
      })).cursor);
      const sharedWrite = await invoke('memory_write', {
        code, seatKey: seatA, scope: 'room', title: 'Shared decision', preview: 'Shared preview',
        content: 'The Room decided to retain the shared index.', searchText: 'shared-index-decision',
        sourceMessageId: 'message-17', requestId: `shared-write-${randomUUID()}`,
      });
      expect(sharedWrite.code).toBe('PENDING_REVIEW');
      expect(sharedWrite.notification).toMatchObject({
        kind: 'mention', recipient: { type: 'persona', id: 'persona-reviewer' },
      });
      expect(sharedWrite.notificationDelivered).toBe(true);
      const proposalId = String(sharedWrite.proposalId);
      expect(await roomNotices()).toHaveLength(1);
      const woken = await invoke('room_listen', {
        code, name: 'Project Analyst', since: cursorBeforeProposal, timeoutMs: 1500, wakeOn: 'addressed',
      });
      expect(woken.addressedYou).toBe(true);
      const heardText = (woken.messages as { text: string }[]).map(message => message.text).join('\n');
      expect(heardText).toContain(proposalId);
      expect(heardText).toContain('@Project Analyst');
      expect(heardText).toContain('(create)');
      expect(heardText).toContain('memory_review({ action: "approve"');
      expect(heardText).toContain('"无关记忆" | "重复记忆" | "格式不合规"');
      expect(heardText).not.toContain(seatA);
      expect(heardText).not.toContain('The Room decided to retain the shared index.');
      // Identical normalized content from another seat with a new requestId reuses the pending proposal.
      const duplicateWrite = await invoke('memory_write', {
        code, seatKey: otherPersonaKey, scope: 'room', title: '  shared DECISION ', preview: 'Shared preview',
        content: 'The Room decided to retain the shared index.', searchText: 'shared-index-decision',
        sourceMessageId: 'message-17', requestId: `shared-write-dup-${randomUUID()}`,
      });
      expect(duplicateWrite).toMatchObject({ code: 'PENDING_REVIEW', proposalId, duplicateOf: proposalId });
      expect(duplicateWrite.notificationDelivered).toBeUndefined();
      expect(await roomNotices()).toHaveLength(1);
      const chineseProposal = await invoke('memory_write', {
        code, seatKey: seatA, scope: 'room', title: 'Shell 规则一', preview: '脚本规则',
        content: '这个仓库中的所有 shell 脚本都必须在第二行写 set -euo pipefail。',
        searchText: 'shell set-euo-pipefail', requestId: `near-shell-a-${randomUUID()}`,
      });
      expect(chineseProposal.code).toBe('PENDING_REVIEW');
      const noticeCountAfterChineseCreate = (await roomNotices()).length;
      const chineseVariant = await invoke('memory_write', {
        code, seatKey: otherPersonaKey, scope: 'room', title: 'Shell 规则二', preview: '脚本规则',
        content: '每个仓库脚本的第二行都必须是 set -euo pipefail。',
        searchText: 'shell set-euo-pipefail', requestId: `near-shell-b-${randomUUID()}`,
      });
      expect(chineseVariant).toMatchObject({ code: 'PENDING_REVIEW' });
      expect(chineseVariant.proposalId).not.toBe(chineseProposal.proposalId);
      expect(chineseVariant).not.toHaveProperty('duplicateOf');
      expect(await roomNotices()).toHaveLength(noticeCountAfterChineseCreate + 1);
      expect(await invoke('memory_review', { code, seatKey: hostSeatKey, action: 'list' }))
        .toMatchObject({ code: 'FORBIDDEN' });
      expect(await invoke('memory_review', {
        code, seatKey: seatA, action: 'approve', proposalId, requestId: `self-review-${randomUUID()}`,
      })).toMatchObject({ code: 'FORBIDDEN' });
      const pending = await invoke('memory_review', { code, seatKey: analystKey, action: 'list' });
      expect(pending.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: proposalId })]));
      const approved = await invoke('memory_review', {
        code, seatKey: analystKey, action: 'approve', proposalId, requestId: `review-create-${randomUUID()}`,
      });
      expect(approved.status).toBe('approved');
      const sharedListed = await invoke('memory_search', {
        code, seatKey: otherPersonaKey, keywords: ['shared-index-decision'], requestId: `search-shared-${randomUUID()}`,
      });
      expect(sharedListed.found).toBe(true);
      const storedSharedId = String((sharedListed.results as { id: string }[])[0]!.id);
      expect(storedSharedId).toBeTruthy();

      const noticeCountBeforeApprovedDuplicate = (await roomNotices()).length;
      const approvedDuplicate = await invoke('memory_write', {
        code, seatKey: otherPersonaKey, scope: 'room', title: 'Shared decision', preview: 'Shared preview',
        content: 'The Room decided to retain the shared index.', searchText: 'shared-index-decision',
        requestId: `approved-shared-write-dup-${randomUUID()}`,
      });
      expect(approvedDuplicate).toMatchObject({
        code: 'DUPLICATE', duplicateOf: storedSharedId, duplicateKind: 'memory',
        existing: { id: storedSharedId, content: 'The Room decided to retain the shared index.' },
      });
      expect(approvedDuplicate.notificationDelivered).toBeUndefined();
      expect(await roomNotices()).toHaveLength(noticeCountBeforeApprovedDuplicate);

      const updateProposal = await invoke('memory_update', {
        code, seatKey: seatA, scope: 'room', id: storedSharedId, preview: 'Updated shared preview',
        content: 'The Room decided to retain the shared index after review.',
        searchText: 'shared-index-decision updated-shared-index', requestId: `shared-update-${randomUUID()}`,
      });
      expect(updateProposal.code).toBe('PENDING_REVIEW');
      const updateDecision = await invoke('memory_review', {
        code, seatKey: analystKey, action: 'approve', proposalId: String(updateProposal.proposalId),
        requestId: `review-update-${randomUUID()}`,
      });
      expect(updateDecision.status).toBe('approved');

      const deleteProposal = await invoke('memory_delete', {
        code, seatKey: seatA, scope: 'room', id: storedSharedId, requestId: `shared-delete-${randomUUID()}`,
      });
      expect(deleteProposal.code).toBe('PENDING_REVIEW');
      const deleteDecision = await invoke('memory_review', {
        code, seatKey: analystKey, action: 'approve', proposalId: String(deleteProposal.proposalId),
        requestId: `review-delete-${randomUUID()}`,
      });
      expect(deleteDecision.status).toBe('approved');

      // Multiple reviewers: every online project-analyst seat may review and is notified; first review wins.
      const analystTwo = await invoke('room_join', {
        code, name: 'Analyst Two', personaId: 'persona-reviewer-2', role: 'project-analyst',
        inviteCode: mintInvite(code, 'project-analyst', 'persona-reviewer-2'),
      });
      const analystTwoKey = String(analystTwo.seatKey);
      const proposeShared = async (title: string) => invoke('memory_write', {
        code, seatKey: seatA, scope: 'room', title, preview: `${title} preview`,
        content: `${title} content`, searchText: title.toLowerCase(), requestId: `multi-${randomUUID()}`,
      });
      const recipients = (result: Record<string, any>) =>
        (result.notifications as { recipient: { type: string; id: string } }[]).map(n => `${n.recipient.type}:${n.recipient.id}`).sort();
      const twoOnline = await proposeShared('Two reviewers online');
      expect(twoOnline.code).toBe('PENDING_REVIEW');
      expect(recipients(twoOnline)).toEqual(['persona:persona-reviewer', 'persona:persona-reviewer-2']);
      expect(twoOnline.reviewCode).toBeUndefined();
      const firstWins = await invoke('memory_review', {
        code, seatKey: analystTwoKey, action: 'approve', proposalId: String(twoOnline.proposalId), requestId: `mr-${randomUUID()}`,
      });
      expect(firstWins.status).toBe('approved');
      expect(await invoke('memory_review', {
        code, seatKey: analystKey, action: 'approve', proposalId: String(twoOnline.proposalId), requestId: `mr-${randomUUID()}`,
      })).toMatchObject({ code: 'CONFLICT' });
      expect(await invoke('memory_review', {
        code, seatKey: analystKey, action: 'reject', proposalId: String(twoOnline.proposalId), requestId: `mr-${randomUUID()}`,
        reason: '重复记忆',
      })).toMatchObject({ code: 'CONFLICT' });

      // A stale reviewer seat is skipped for notification and told it is unavailable.
      ageSeat('Analyst Two');
      const oneStale = await proposeShared('One reviewer stale');
      expect(recipients(oneStale)).toEqual(['persona:persona-reviewer']);
      expect(await invoke('memory_review', {
        code, seatKey: analystTwoKey, action: 'approve', proposalId: String(oneStale.proposalId), requestId: `mr-${randomUUID()}`,
      })).toMatchObject({ code: 'REVIEWER_UNAVAILABLE' });
      expect(await invoke('memory_review', {
        code, seatKey: hostSeatKey, action: 'approve', proposalId: String(oneStale.proposalId), requestId: `mr-${randomUUID()}`,
      })).toMatchObject({ code: 'FORBIDDEN' });
      expect((await invoke('memory_review', {
        code, seatKey: analystKey, action: 'approve', proposalId: String(oneStale.proposalId), requestId: `mr-${randomUUID()}`,
      })).status).toBe('approved');

      // All reviewers offline: owner fallback is notified with REVIEWER_UNAVAILABLE and may review.
      ageSeat('Project Analyst');
      const allOffline = await proposeShared('All reviewers offline');
      expect(allOffline.reviewCode).toBe('REVIEWER_UNAVAILABLE');
      expect(recipients(allOffline)).toEqual([`room_owner:${storedRoom.roomInstanceId}`]);
      // The owner fallback is a web host, so the notice has to be addressed by name in the room.
      expect(allOffline.notificationDelivered).toBe(true);
      const ownerNotice = (await roomNotices()).at(-1)!.text;
      expect(ownerNotice).toContain(String(allOffline.proposalId));
      expect(ownerNotice).toContain('@Host');
      expect(ownerNotice).toContain('No reviewer seat is online');
      expect(await invoke('memory_review', {
        code, seatKey: analystKey, action: 'approve', proposalId: String(allOffline.proposalId), requestId: `mr-${randomUUID()}`,
      })).toMatchObject({ code: 'REVIEWER_UNAVAILABLE' });
      expect(await invoke('memory_review', {
        code, seatKey: seatA, action: 'approve', proposalId: String(allOffline.proposalId), requestId: `mr-${randomUUID()}`,
      })).toMatchObject({ code: 'FORBIDDEN' });
      expect((await invoke('memory_review', {
        code, seatKey: hostSeatKey, action: 'approve', proposalId: String(allOffline.proposalId), requestId: `mr-${randomUUID()}`,
      })).status).toBe('approved');

      const reconnect = await invoke('room_join', {
        code, name: 'Agent A', seatKey: seatA, personaId: 'persona-alpha', role: 'builder',
      });
      const rotatedKey = String(reconnect.seatKey);
      expect(rotatedKey).not.toBe(seatA);
      expect(reconnect.memoryBrief).toContain(privateId);
      expect(reconnect.memoryNote).toBeUndefined();
      expect(await invoke('memory_read', { code, seatKey: seatA, id: privateId }))
        .toMatchObject({ code: 'FORBIDDEN' });
      expect(await invoke('memory_brief', { code, seatKey: rotatedKey })).toMatchObject({ loaded: false });
      expect((await invoke('room_listen', { code, name: 'Agent A', since: 0, timeoutMs: 0 })).memoryBrief).toBeUndefined();

      // Chat sessionId: the first join from a session gets the Brief; the same session rejoining does not.
      const chatSession = `chat-${randomUUID()}`;
      const sessionJoin = await invoke('room_join', {
        code, name: 'Agent A', seatKey: rotatedKey, personaId: 'persona-alpha', role: 'builder', sessionId: chatSession,
      });
      expect(sessionJoin.memoryBrief).toContain(privateId);
      expect(sessionJoin.memoryBriefSkipped).toBeUndefined();
      const sameSession = await invoke('room_join', {
        code, name: 'Agent A', seatKey: String(sessionJoin.seatKey), personaId: 'persona-alpha', role: 'builder', sessionId: chatSession,
      });
      expect(sameSession.memoryBrief).toBeUndefined();
      expect(sameSession.memoryBriefSkipped).toBe('already_read_this_session');
      expect(sameSession.memoryNote).toBeUndefined();
      expect(await invoke('memory_brief', { code, seatKey: String(sameSession.seatKey) }))
        .toMatchObject({ loaded: false, skipped: 'already_read_this_session' });
      const newSession = await invoke('room_join', {
        code, name: 'Agent A', seatKey: String(sameSession.seatKey), personaId: 'persona-alpha', role: 'builder', sessionId: `chat-${randomUUID()}`,
      });
      expect(newSession.memoryBrief).toContain(privateId);
      expect(newSession.memoryBriefSkipped).toBeUndefined();
      const noSession = await invoke('room_join', {
        code, name: 'Agent A', seatKey: String(newSession.seatKey), personaId: 'persona-alpha', role: 'builder',
      });
      expect(noSession.memoryBrief).toContain(privateId);
      expect(await invoke('room_join', {
        code, name: 'Agent A', seatKey: String(noSession.seatKey), personaId: 'persona-alpha', sessionId: 'x'.repeat(257),
      })).toMatchObject({ error: 'invalid_session_id' });

      const firstMiss = await invoke('memory_search', {
        code, seatKey: otherPersonaKey, keywords: ['no-such-memory-term'], requestId: `miss-one-${randomUUID()}`,
      });
      expect(firstMiss).toMatchObject({ code: 'NOT_FOUND', retryAllowed: true });
      const secondMiss = await invoke('memory_search', {
        code, seatKey: otherPersonaKey, keywords: ['still-no-such-term'],
        searchSessionId: String(firstMiss.searchSessionId), requestId: `miss-two-${randomUUID()}`,
      });
      expect(secondMiss).toMatchObject({ code: 'NOT_FOUND', retryAllowed: false });
      const thirdMiss = await invoke('memory_search', {
        code, seatKey: otherPersonaKey, keywords: ['third-attempt'],
        searchSessionId: String(firstMiss.searchSessionId), requestId: `miss-three-${randomUUID()}`,
      });
      expect(thirdMiss).toMatchObject({ code: 'CONFLICT' });

      const failedDependencies = createMemoryTestDependencies(
        async () => { throw new Error('private database connection detail'); },
        dependencies.redis,
      );
      const storageFailure = parsed(await callTool(
        roomClient, 'full', 'memory_read', { code, seatKey: String(noSession.seatKey), id: privateId }, undefined, failedDependencies,
      ));
      expect(storageFailure).toMatchObject({ code: 'STORAGE_ERROR' });
      expect(JSON.stringify(storageFailure)).not.toContain('private database connection detail');
    } finally {
      if (previousMemoryEnabled === undefined) delete process.env.MEMORY_ENABLED;
      else process.env.MEMORY_ENABLED = previousMemoryEnabled;
      if (previousMemoryDatabaseUrl === undefined) delete process.env.MEMORY_DATABASE_URL;
      else process.env.MEMORY_DATABASE_URL = previousMemoryDatabaseUrl;
      await scoped?.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  }, 120_000);
});
