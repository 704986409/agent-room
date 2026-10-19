import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import type { Participant, Room } from '@agent-room/shared';
import { createUser } from './_accounts.js';
import { MemoryRedis, installFetchRedis } from './_memoryRedis.js';
import { deviceCredentialHash } from './_wakeDevice.js';

const REDIS = 'https://devices.upstash.invalid';
process.env.UPSTASH_REDIS_REST_URL = REDIS;
process.env.UPSTASH_REDIS_REST_TOKEN = 'devices-token';

const store = new MemoryRedis();
const restoreFetch = installFetchRedis(REDIS, store);
const { createVpsApp } = await import('../deploy/vps/server.js');

let base = '';
let close: (() => Promise<void>) | undefined;
let adaId = '';
let beaId = '';

beforeAll(async () => {
  const app = createVpsApp({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  close = () => app.close();
  adaId = (await createUser(store, { username: 'Ada', password: 'admin-password', role: 'admin' })).id;
  beaId = (await createUser(store, { username: 'Bea', password: 'user-password-1', role: 'user' })).id;
  await createUser(store, { username: 'Dee', password: 'user-password-2', role: 'user' });
});

afterAll(async () => {
  await close?.();
  restoreFetch();
});

function cookieFrom(response: Response): string {
  return (response.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '';
}

async function login(username: string, password: string) {
  const response = await fetch(`${base}/api/account/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.50' },
    body: JSON.stringify({ username, password }),
  });
  return cookieFrom(response);
}

async function post(path: string, body: unknown, cookie?: string, extra: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...extra,
    },
    body: JSON.stringify(body),
  });
}

describe('device pairing HTTP', () => {
  it('requires a logged-in session and rejects a guest cookie', async () => {
    const missing = await post('/api/device/pair-start', {});
    expect(missing.status).toBe(401);
    const guest = await post('/api/device/pair-start', {}, 'ar_guest=not-a-session');
    expect(guest.status).toBe(401);
  });

  it('pairs once, authenticates wake, and revokes the credential and binding', async () => {
    const bea = await login('Bea', 'user-password-1');
    const ada = await login('Ada', 'admin-password');
    const dee = await login('Dee', 'user-password-2');
    const started = await post('/api/device/pair-start', {}, bea);
    expect(started.status).toBe(201);
    const pairing = await started.json() as { pairingCode: string; expiresAt: number };
    expect(pairing.pairingCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pairing.expiresAt).toBeGreaterThan(Date.now() + 290_000);
    expect(store.dumpStrings().join('\n')).not.toContain(pairing.pairingCode);

    const completed = await post('/api/device/pair-complete', {
      pairingCode: pairing.pairingCode,
      deviceName: ' Desk ',
      platform: 'linux',
      hostname: 'lab',
    });
    expect(completed.status).toBe(201);
    const issued = await completed.json() as { deviceId: string; deviceCredential: string; userId: string; name: string };
    expect(issued).toMatchObject({ userId: beaId, name: 'Desk' });
    expect(issued.deviceId).toMatch(/^dev_[a-f0-9]{24}$/);
    expect(issued.deviceCredential).toMatch(/^ard_/);
    const dumped = store.dumpStrings().join('\n');
    expect(dumped).not.toContain(pairing.pairingCode);
    expect(dumped).not.toContain(issued.deviceCredential);
    const cred = await store.command<string>(['GET', `device-cred:${deviceCredentialHash(issued.deviceCredential)}`]);
    expect(JSON.parse(cred)).toEqual({ deviceId: issued.deviceId, userId: beaId });

    const again = await post('/api/device/pair-complete', {
      pairingCode: pairing.pairingCode, deviceName: 'Desk', platform: 'linux',
    });
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: 'pairing_code_invalid' });

    const self = await post('/api/device/self', {}, undefined, { authorization: `Bearer ${issued.deviceCredential}` });
    expect(self.status).toBe(200);
    expect(await self.json()).toMatchObject({
      deviceId: issued.deviceId, name: 'Desk', platform: 'linux', userId: beaId, username: 'Bea',
    });

    const listed = await fetch(`${base}/api/account/devices`, { headers: { cookie: bea } });
    expect(await listed.json()).toMatchObject({
      devices: [{ deviceId: issued.deviceId, name: 'Desk', platform: 'linux', hostname: 'lab' }],
    });

    const code = 'ABC-DEF-GHJ';
    const seatKey = 'seat-key';
    const seatKeyHash = createHash('sha256').update(seatKey).digest('hex');
    const participant: Participant = {
      name: 'codex-a', seatId: 'st_http', seatKeyHash, role: '', color: '#111', initials: 'CC',
      client: 'cc', joinedAt: 1, lastSeenAt: 1,
    };
    const room: Room = {
      code, topic: 't', createdAt: Date.now(), createdBy: 'host', status: 'active', version: 1,
      roomInstanceId: 'ri_http', replyMode: 'open', participants: [participant],
    };
    await store.command(['SET', `room:${code}`, JSON.stringify(room)]);
    await store.command(['SET', `room-msg-count:${code}`, '0']);
    const registered = await post('/api/wake', {
      action: 'register', code, name: 'codex-a', seatKey, cursor: 0,
    }, undefined, { authorization: `Bearer ${issued.deviceCredential}` });
    expect(registered.status).toBe(200);
    const seatId = ((await registered.json()) as { seatId: string }).seatId;
    const polled = await post('/api/wake', { action: 'poll' }, undefined, { authorization: `Bearer ${issued.deviceCredential}` });
    expect(polled.status).toBe(200);
    expect(await polled.json()).toMatchObject({ seats: [{ seatId, status: 'active' }] });

    const otherUser = await post('/api/account/devices/revoke', { deviceId: issued.deviceId }, dee);
    expect(otherUser.status).toBe(404);
    const stillThere = await fetch(`${base}/api/account/devices`, { headers: { cookie: bea } });
    expect(await stillThere.json()).toMatchObject({ devices: [{ deviceId: issued.deviceId }] });

    const other = await post('/api/account/devices/revoke', { deviceId: issued.deviceId }, ada);
    expect(other.status).toBe(200);
    const afterOther = await fetch(`${base}/api/account/devices?userId=${encodeURIComponent(beaId)}`, { headers: { cookie: ada } });
    expect(await afterOther.json()).toEqual({ devices: [] });
    const hidden = await fetch(`${base}/api/account/devices?userId=${encodeURIComponent(adaId)}`, { headers: { cookie: bea } });
    expect(hidden.status).toBe(404);

    const binding = JSON.parse(await store.command<string>(['GET', `wake-bind:${seatId}`]));
    expect(binding.status).toBe('revoked');
    const denied = await post('/api/wake', { action: 'poll' }, undefined, { authorization: `Bearer ${issued.deviceCredential}` });
    expect(denied.status).toBe(401);
    expect(store.dumpStrings().join('\n')).not.toContain(issued.deviceCredential);
  });

  it('rejects an expired pairing code', async () => {
    const bea = await login('Bea', 'user-password-1');
    const started = await post('/api/device/pair-start', {}, bea);
    const pairing = await started.json() as { pairingCode: string };
    const key = `device-pair:${createHash('sha256').update(pairing.pairingCode, 'utf8').digest('hex')}`;
    const parsed = JSON.parse(await store.command<string>(['GET', key])) as { userId: string; createdAt: number };
    parsed.createdAt = Date.now() - 301_000;
    await store.command(['SET', key, JSON.stringify(parsed)]);
    const completed = await post('/api/device/pair-complete', {
      pairingCode: pairing.pairingCode, deviceName: 'late', platform: 'linux',
    });
    expect(completed.status).toBe(400);
    expect(await completed.json()).toMatchObject({ error: 'pairing_code_invalid' });
  });

  it('rejects a credential after the owning user is disabled', async () => {
    const ada = await login('Ada', 'admin-password');
    const created = await post('/api/admin/users', { username: 'Cara', password: 'cara-password', role: 'user' }, ada);
    expect(created.status).toBe(201);
    const cara = (await created.json() as { user: { id: string } }).user;
    const caraCookie = await login('Cara', 'cara-password');
    const started = await post('/api/device/pair-start', {}, caraCookie);
    const pairing = await started.json() as { pairingCode: string };
    const completed = await post('/api/device/pair-complete', {
      pairingCode: pairing.pairingCode, deviceName: 'phone', platform: 'ios',
    });
    const issued = await completed.json() as { deviceCredential: string };
    const disabled = await post('/api/admin/users/disable', { userId: cara.id }, ada);
    expect(disabled.status).toBe(200);
    const denied = await post('/api/wake', { action: 'poll' }, undefined, { authorization: `Bearer ${issued.deviceCredential}` });
    expect(denied.status).toBe(401);
  });
});
