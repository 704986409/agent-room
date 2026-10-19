import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { createUser } from './_accounts.js';
import { MemoryRedis, installFetchRedis } from './_memoryRedis.js';

const REDIS = 'https://web-writes.upstash.invalid';
process.env.UPSTASH_REDIS_REST_URL = REDIS;
process.env.UPSTASH_REDIS_REST_TOKEN = 'web-writes-token';
process.env.WEB_PROXY_TOKEN = 'proxy-token';
process.env.SRH_WEB_URL = REDIS;
process.env.SRH_WEB_TOKEN = 'web-writes-token';

const store = new MemoryRedis();
const restoreFetch = installFetchRedis(REDIS, store);
const { createVpsApp } = await import('../deploy/vps/server.js');

let base = '';
let close: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const app = createVpsApp({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  close = () => app.close();
  await createUser(store, { username: 'Ada', password: 'password-ok', role: 'user' });
  await createUser(store, { username: 'Bea', password: 'password-ok', role: 'user' });
});

afterAll(async () => {
  await close?.();
  restoreFetch();
});

function cookieFrom(response: Response, name: string): string {
  const all = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie') ?? ''];
  const raw = all.find(item => item.startsWith(`${name}=`)) ?? '';
  return raw.split(';', 1)[0] ?? '';
}

async function login(username: string, ip: string) {
  const response = await fetch(`${base}/api/account/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ username, password: 'password-ok' }),
  });
  expect(response.status).toBe(200);
  return cookieFrom(response, 'ar_session');
}

async function post(path: string, body: unknown, cookie = '') {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

async function proxy(body: unknown, cookie = '') {
  return fetch(`${base}/redis`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer proxy-token',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('web writes and room access', () => {
  it('authenticates writes, scopes guests to one room, and keeps the proxy read-only', async () => {
    expect((await post('/api/web/chat-send', { code: 'ABC-DEF-GHJ', text: 'hi' })).status).toBe(401);

    const ada = await login('Ada', '203.0.113.40');
    const created = await post('/api/web/room-create', { topic: 'Planning', displayName: 'Ada' }, ada);
    expect(created.status).toBe(201);
    const room = await created.json() as { code: string; name: string };
    expect(room.name).toBe('Ada');
    expect(typeof (room as { hostKey?: string }).hostKey).toBe('string');

    expect((await post('/api/web/chat-send', { code: room.code, text: 'hello', id: 11 }, ada)).status).toBe(200);
    const adaId = (await (await fetch(`${base}/api/account/me`, { headers: { cookie: ada } })).json() as { user: { id: string } }).user.id;
    const sessionHash = (await store.command<string[]>(['SMEMBERS', `user-sessions:${adaId}`]))[0] ?? '';
    const beforeExpiry = JSON.parse(await store.command<string>(['GET', `session:${sessionHash}`]) ?? '{}').expiresAt as number;
    expect((await post('/api/web/presence', { code: room.code }, ada)).status).toBe(200);
    const afterExpiry = JSON.parse(await store.command<string>(['GET', `session:${sessionHash}`]) ?? '{}').expiresAt as number;
    expect(afterExpiry).toBeGreaterThan(beforeExpiry);
    expect((await post('/api/web/typing', { code: room.code, active: true }, ada)).status).toBe(200);

    const bea = await login('Bea', '203.0.113.41');
    expect((await post('/api/web/task', { code: room.code, op: 'create', title: 'Do it' }, bea)).status).toBe(401);

    const memberInvite = await post('/api/web/invite', { code: room.code, maxUses: 1 }, ada);
    expect(memberInvite.status).toBe(201);
    const memberInviteBody = await memberInvite.json() as { token: string };
    const joined = await post('/api/web/invite-accept', { token: memberInviteBody.token }, bea);
    expect(joined.status).toBe(200);
    expect(await joined.json()).toMatchObject({ role: 'member', code: room.code });
    expect((await post('/api/web/task', { code: room.code, op: 'create', title: 'Do it' }, bea)).status).toBe(403);
    expect((await post('/api/web/invite-accept', { token: memberInviteBody.token, displayName: 'Second' })).status).toBe(403);

    const guestInviteResponse = await post('/api/web/invite', { code: room.code }, ada);
    const guestInvite = await guestInviteResponse.json() as { token: string; inviteId: string };
    const guest = await post('/api/web/invite-accept', { token: guestInvite.token, displayName: 'Visitor' });
    expect(guest.status).toBe(200);
    const guestCookie = cookieFrom(guest, 'ar_guest');
    expect(guestCookie).toMatch(/^ar_guest=/);
    expect(guest.headers.get('set-cookie')).toMatch(/HttpOnly/);
    expect((await post('/api/web/chat-send', { code: room.code, text: 'from guest' }, guestCookie)).status).toBe(200);
    expect((await post('/api/web/host', { code: room.code, op: 'end' }, guestCookie)).status).toBe(403);

    const other = await post('/api/web/room-create', { topic: 'Other', displayName: 'Ada' }, ada);
    const otherCode = (await other.json() as { code: string }).code;
    const cross = await fetch(`${base}/api/web/whoami?code=${encodeURIComponent(otherCode)}`, { headers: { cookie: guestCookie } });
    expect(cross.status).toBe(401);

    const revoked = await post('/api/web/invite', { code: room.code }, ada);
    const revokedBody = await revoked.json() as { token: string; inviteId: string };
    expect((await post('/api/web/invite-revoke', { code: room.code, inviteId: revokedBody.inviteId }, ada)).status).toBe(200);
    expect((await post('/api/web/invite-accept', { token: revokedBody.token, displayName: 'Late' })).status).toBe(403);

    expect((await post('/api/web/host', { code: room.code, op: 'remove', name: 'Visitor', client: 'web' }, ada)).status).toBe(200);
    expect((await post('/api/web/chat-send', { code: room.code, text: 'after kick' }, guestCookie)).status).toBe(401);

    for (const command of [['SET', `room:${room.code}`, 'x'], ['SADD', `room-msgs:${room.code}`, 'x'], ['DEL', `room:${room.code}`], ['LPUSH', `room-msgs:${room.code}`, 'x'], ['EVAL', 'return 1', '0'], ['EVALSHA', 'abc', '0']]) {
      const denied = await proxy(command, ada);
      expect(denied.status, JSON.stringify(command)).toBe(403);
      expect(await denied.json()).toEqual({ error: 'redis_command_not_allowed' });
    }
    expect(await (await proxy(['GET', 'session:abc'], ada)).json()).toEqual({ error: 'redis_key_not_allowed' });
    expect((await proxy(['GET', `room:${room.code}`])).status).toBe(403);
    const allowed = await proxy(['GET', `room:${room.code}`], ada);
    expect(allowed.status).toBe(200);
    const stored = await allowed.json() as { result: string };
    expect(JSON.parse(stored.result).code).toBe(room.code);

    const router = readFileSync(new URL('../apps/web/src/router.tsx', import.meta.url), 'utf8');
    expect(router).toContain("'/i/:token'");
    expect(router).not.toContain("'/register'");
    const join = readFileSync(new URL('../apps/web/src/screens/Join.tsx', import.meta.url), 'utf8');
    expect(join).not.toContain('joinRoom(');
    const mcp = readFileSync(new URL('./_mcpTools.ts', import.meta.url), 'utf8');
    expect(mcp).toContain('room_join');
    expect(mcp).not.toContain('MCP_ROOM_CREATE_ENABLED');
  });
});
