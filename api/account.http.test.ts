import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { MemoryRedis, installFetchRedis } from './_memoryRedis.js';
import { createUser } from './_accounts.js';

const REDIS = 'https://accounts.upstash.invalid';
process.env.UPSTASH_REDIS_REST_URL = REDIS;
process.env.UPSTASH_REDIS_REST_TOKEN = 'accounts-token';

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
  await createUser(store, { username: 'Ada', password: 'admin-password', role: 'admin' });
  await createUser(store, { username: 'Bea', password: 'user-password-1', role: 'user' });
});

afterAll(async () => {
  await close?.();
  restoreFetch();
});

function cookieFrom(response: Response): string {
  const raw = response.headers.get('set-cookie') ?? '';
  const pair = raw.split(';', 1)[0] ?? '';
  return pair;
}

async function login(username: string, password: string, ip = '203.0.113.10') {
  return fetch(`${base}/api/account/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ username, password }),
  });
}

describe('account HTTP', () => {
  it('has no public registration route', async () => {
    const response = await fetch(`${base}/api/account/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(404);
    const router = readFileSync(new URL('../apps/web/src/router.tsx', import.meta.url), 'utf8');
    expect(router).not.toContain("'/register'");
    expect(router).not.toContain('"/register"');
  });

  it('logs in with an HttpOnly Secure SameSite cookie and rejects a bad password the same way as an unknown user', async () => {
    const ok = await login('Ada', 'admin-password', '203.0.113.20');
    expect(ok.status).toBe(200);
    const setCookie = ok.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/ar_session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    const body = await ok.json() as { user: { username: string; role: string } };
    expect(body.user).toMatchObject({ username: 'Ada', role: 'admin' });
    expect(JSON.stringify(body)).not.toContain('admin-password');

    const missing = await login('nobody', 'admin-password', '203.0.113.21');
    const wrong = await login('Ada', 'not-the-password', '203.0.113.22');
    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(await missing.json()).toEqual(await wrong.json());
  });

  it('serves the personal center and lets an admin disable a user', async () => {
    const ada = await login('Ada', 'admin-password', '203.0.113.30');
    const adaCookie = cookieFrom(ada);
    const me = await fetch(`${base}/api/account/me`, { headers: { cookie: adaCookie } });
    expect(me.status).toBe(200);
    const devices = await fetch(`${base}/api/account/devices`, { headers: { cookie: adaCookie } });
    expect(await devices.json()).toMatchObject({ devices: [], available: false });

    const bea = await login('Bea', 'user-password-1', '203.0.113.31');
    const beaCookie = cookieFrom(bea);
    const forbidden = await fetch(`${base}/api/admin/users`, { headers: { cookie: beaCookie } });
    expect(forbidden.status).toBe(403);

    const created = await fetch(`${base}/api/admin/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adaCookie },
      body: JSON.stringify({ username: 'Cara', password: 'cara-password', role: 'user' }),
    });
    expect(created.status).toBe(201);
    const cara = (await created.json() as { user: { id: string } }).user;
    const caraLogin = await login('Cara', 'cara-password', '203.0.113.32');
    expect(caraLogin.status).toBe(200);
    const disabled = await fetch(`${base}/api/admin/users/disable`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adaCookie },
      body: JSON.stringify({ userId: cara.id }),
    });
    expect(disabled.status).toBe(200);
    const caraCookie = cookieFrom(caraLogin);
    const after = await fetch(`${base}/api/account/me`, { headers: { cookie: caraCookie } });
    expect(after.status).toBe(401);
    const audits = await store.command<string[]>(['SMEMBERS', 'audit:index']);
    expect(audits.length).toBeGreaterThan(0);
  });
});
