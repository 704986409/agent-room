import { describe, expect, it } from 'vitest';
import type { Message, Participant, Room } from '@agent-room/shared';
import type { UpstashClient } from '@agent-room/upstash-client';
import { createHash } from 'node:crypto';
import {
  completePairing,
  listUserDevices,
  revokeUserDevices,
  startPairing,
} from './_devices.js';
import { MemoryRedis } from './_memoryRedis.js';
import { MapDeviceAuthenticator, deviceCredentialHash } from './_wakeDevice.js';
import { WakeService } from './_wakeService.js';
import { WakeTestRedis } from './_wakeTestRedis.js';

const USER = {
  id: 'usr_1',
  username: 'Bea',
  role: 'user' as const,
  disabled: false,
  createdAt: 1,
  updatedAt: 1,
  password: { algo: 'scrypt', salt: 'aa', hash: 'bb', params: { N: 1, r: 1, p: 1, keylen: 1 } },
};

async function user(redis: MemoryRedis, extra: Record<string, unknown> = {}) {
  await redis.command(['SET', `user:${USER.id}`, JSON.stringify({ ...USER, ...extra })]);
}

describe('device pairing store', () => {
  it('issues a one-time code, strips control characters, and never stores the raw secrets', async () => {
    const redis = new MemoryRedis();
    await user(redis);
    const started = await startPairing(redis, USER.id, 1_000);
    expect(started.pairingCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(started.expiresAt).toBe(1_000 + 300_000);
    expect(redis.dumpStrings().join('\n')).not.toContain(started.pairingCode);

    await expect(completePairing(redis, {
      pairingCode: started.pairingCode,
      deviceName: 'x'.repeat(65),
      platform: 'linux',
    }, 1_000)).rejects.toMatchObject({ status: 400, code: 'invalid_device' });

    const issued = await completePairing(redis, {
      pairingCode: started.pairingCode,
      deviceName: ' lab\u0000top ',
      platform: 'linux\n',
      hostname: 'box\u007f',
    }, 2_000);
    expect(issued).toMatchObject({ userId: USER.id, name: 'labtop', deviceId: expect.stringMatching(/^dev_[a-f0-9]{24}$/) });
    expect(JSON.parse(await redis.command<string>(['GET', `device:${issued.deviceId}`]))).toMatchObject({
      name: 'labtop', platform: 'linux', hostname: 'box',
    });
    expect(issued.deviceCredential).toMatch(/^ard_[A-Za-z0-9_-]{43}$/);
    const stored = redis.dumpStrings().join('\n');
    expect(stored).not.toContain(started.pairingCode);
    expect(stored).not.toContain(issued.deviceCredential);
    expect(JSON.parse(await redis.command<string>(['GET', `device-cred:${deviceCredentialHash(issued.deviceCredential)}`])))
      .toEqual({ deviceId: issued.deviceId, userId: USER.id });

    await expect(completePairing(redis, {
      pairingCode: started.pairingCode,
      deviceName: 'again',
      platform: 'linux',
    }, 2_000)).rejects.toMatchObject({ status: 400, code: 'pairing_code_invalid' });
  });

  it('rejects an expired code and a disabled user', async () => {
    const redis = new MemoryRedis();
    await user(redis);
    const expired = await startPairing(redis, USER.id, 1_000);
    await expect(completePairing(redis, {
      pairingCode: expired.pairingCode, deviceName: 'laptop', platform: 'linux',
    }, 1_000 + 300_000 + 1)).rejects.toMatchObject({ status: 400, code: 'pairing_code_invalid' });

    const fresh = new MemoryRedis();
    await fresh.command(['SET', `user:${USER.id}`, JSON.stringify({ ...USER, disabled: true })]);
    const code = (await startPairing(fresh, USER.id, 5_000)).pairingCode;
    await expect(completePairing(fresh, {
      pairingCode: code, deviceName: 'laptop', platform: 'linux',
    }, 5_000)).rejects.toMatchObject({ status: 403, code: 'user_disabled' });
  });

  it('limits pairing codes to five per window and lists newest non-revoked devices', async () => {
    const redis = new MemoryRedis();
    await user(redis);
    for (let i = 0; i < 5; i++) await startPairing(redis, USER.id, 1_000 + i);
    await expect(startPairing(redis, USER.id, 2_000)).rejects.toMatchObject({ status: 429, code: 'pairing_rate_limited' });

    const listed = new MemoryRedis();
    await user(listed);
    const older = await completePairing(listed, {
      pairingCode: (await startPairing(listed, USER.id, 10_000)).pairingCode,
      deviceName: 'old', platform: 'linux',
    }, 10_000);
    const newer = await completePairing(listed, {
      pairingCode: (await startPairing(listed, USER.id, 20_000)).pairingCode,
      deviceName: 'new', platform: 'mac', hostname: 'studio',
    }, 20_000);
    expect((await listUserDevices(listed, USER.id)).map(device => device.name)).toEqual(['new', 'old']);
    expect((await listUserDevices(listed, USER.id))[0]).toMatchObject({ hostname: 'studio', platform: 'mac' });
    const newerRecord = JSON.parse(await listed.command<string>(['GET', `device:${newer.deviceId}`]));
    await listed.command(['SET', `device:${newer.deviceId}`, JSON.stringify({ ...newerRecord, revokedAt: 30_000 })]);
    expect((await listUserDevices(listed, USER.id)).map(device => device.deviceId)).toEqual([older.deviceId]);
  });

  it('revokes credentials and returns an in-flight wake claim to PENDING', async () => {
    const redis = new WakeTestRedis();
    const code = 'ABC-DEF-GHJ';
    const seatKey = 'seat-key';
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const person: Participant = {
      name: 'codex-a', seatId: 'st_a', seatKeyHash: hash(seatKey), role: '', color: '#111', initials: 'CC',
      client: 'cc', joinedAt: 1, lastSeenAt: 1,
    };
    const room: Room = {
      code, topic: 't', createdAt: Date.now(), createdBy: 'host', status: 'active', version: 1,
      roomInstanceId: 'ri_1', replyMode: 'open', participants: [person],
    };
    const message: Message = { id: 1, type: 'msg', name: 'codex-b', initials: 'CB', color: '#222', role: '', text: '@codex-a look', client: 'cc', time: 1 };
    redis.values.set(`room:${code}`, JSON.stringify(room));
    redis.lists.set(`room-msgs:${code}`, [JSON.stringify(message)]);
    redis.values.set(`room-msg-count:${code}`, '1');
    const cred = 'ard_secret';
    const credHash = deviceCredentialHash(cred);
    redis.values.set(`device-cred:${credHash}`, JSON.stringify({ deviceId: 'dev-a', userId: 'usr_1' }));
    redis.values.set('device:dev-a', JSON.stringify({
      deviceId: 'dev-a', userId: 'usr_1', name: 'laptop', platform: 'linux', createdAt: 1, lastSeenAt: 1, credHash,
    }));
    redis.sets.set('device-user:usr_1', new Set(['dev-a']));
    const api = new WakeService(redis, { authenticator: new MapDeviceAuthenticator(new Map([['token-a', 'dev-a']])) });
    await api.register('dev-a', { code, name: 'codex-a', seatKey, cursor: 0 });
    await api.poll('dev-a');
    await api.claim('dev-a', { eventIds: ['wk:ri_1:0:st_a'] });
    expect((await api.store.get('wk:ri_1:0:st_a'))?.state).toBe('CLAIMED');

    await revokeUserDevices(redis as unknown as UpstashClient, 'usr_1');
    expect(redis.values.get(`device-cred:${credHash}`)).toBeUndefined();
    expect(redis.values.get('device:dev-a')).toBeUndefined();
    expect((await api.poll('dev-a')).seats).toMatchObject([{ status: 'revoked' }]);
    expect((await api.store.get('wk:ri_1:0:st_a'))?.state).toBe('PENDING');
  });
});
