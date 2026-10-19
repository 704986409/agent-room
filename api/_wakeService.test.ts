import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Message, Participant, Room } from '@agent-room/shared';
import { MapDeviceAuthenticator, RedisDeviceAuthenticator, deviceCredentialHash } from './_wakeDevice.js';
import { markRebindRequired, removeManagedSeat, POLL_SNAPSHOT_SCRIPT } from './_wakeBind.js';
import { generateForCommittedMessage, WakeService } from './_wakeService.js';
import { WakeTestRedis } from './_wakeTestRedis.js';

const CODE = 'ABC-DEF-GHJ';
const KEY = 'seat-key';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function participant(name: string, seatId: string, key: string): Participant {
  return {
    name, seatId, seatKeyHash: hash(key), role: '', color: '#111', initials: 'CC',
    client: 'cc', joinedAt: 1, lastSeenAt: 1,
  };
}

function room(extra: Partial<Room> = {}, people: Participant[] = [participant('codex-a', 'st_a', KEY), participant('codex-b', 'st_b', 'other')]): Room {
  return {
    code: CODE, topic: 't', createdAt: Date.now(), createdBy: 'host', status: 'active', version: 1,
    roomInstanceId: 'ri_1', replyMode: 'open', participants: people, ...extra,
  };
}

function message(text: string, id = 184): Message {
  return { id, type: 'msg', name: 'codex-b', initials: 'CB', color: '#222', role: '', text, client: 'cc', time: id };
}

function seed(redis: WakeTestRedis, value: Room, messages: Message[] = [], total = messages.length) {
  redis.values.set(`room:${CODE}`, JSON.stringify(value));
  redis.lists.set(`room-msgs:${CODE}`, messages.map(item => JSON.stringify(item)));
  redis.values.set(`room-msg-count:${CODE}`, String(total));
}

function service(redis: WakeTestRedis, now = () => Date.now()) {
  let n = 0;
  const auth = new MapDeviceAuthenticator(new Map([['token-a', 'dev-a'], ['token-b', 'dev-b']]));
  return new WakeService(redis, { authenticator: auth, now, ids: () => `id${++n}` });
}

describe('device credentials', () => {
  it('rejects missing, unknown, and revoked credentials', async () => {
    const redis = new WakeTestRedis();
    const auth = new RedisDeviceAuthenticator(redis);
    expect(await auth.authenticate(undefined)).toBeNull();
    expect(await auth.authenticate('Bearer nope')).toBeNull();
    redis.values.set(`device-cred:${deviceCredentialHash('good')}`, JSON.stringify({ deviceId: 'dev-1' }));
    redis.values.set(`device-cred:${deviceCredentialHash('dead')}`, JSON.stringify({ deviceId: 'dev-1', revoked: true }));
    expect(await auth.authenticate('Bearer good')).toEqual({ deviceId: 'dev-1' });
    expect(await auth.authenticate('Bearer dead')).toBeNull();
  });

  it('rejects a paired credential when the device or user is inactive, and touches lastSeenAt at most once a minute', async () => {
    const redis = new WakeTestRedis();
    let now = 1_000_000;
    const auth = new RedisDeviceAuthenticator(redis, () => now);
    const token = 'ard_paired';
    const deviceId = 'dev_aaaaaaaaaaaaaaaaaaaaaaaa';
    const userId = 'usr_1';
    const hash = deviceCredentialHash(token);
    redis.values.set(`device-cred:${hash}`, JSON.stringify({ deviceId, userId }));
    expect(await auth.authenticate(`Bearer ${token}`)).toBeNull();

    const record = { deviceId, userId, name: 'laptop', platform: 'linux', createdAt: 1, lastSeenAt: now, credHash: hash };
    redis.values.set(`device:${deviceId}`, JSON.stringify(record));
    redis.values.set(`user:${userId}`, JSON.stringify({ id: userId, disabled: false }));
    expect(await auth.authenticate(`Bearer ${token}`)).toEqual({ deviceId });
    expect(JSON.parse(redis.values.get(`device:${deviceId}`)!).lastSeenAt).toBe(now);

    now += 60_000;
    expect(await auth.authenticate(`Bearer ${token}`)).toEqual({ deviceId });
    expect(JSON.parse(redis.values.get(`device:${deviceId}`)!).lastSeenAt).toBe(now);

    redis.values.set(`device:${deviceId}`, JSON.stringify({ ...record, lastSeenAt: now, revokedAt: now }));
    expect(await auth.authenticate(`Bearer ${token}`)).toBeNull();

    redis.values.set(`device:${deviceId}`, JSON.stringify({ ...record, lastSeenAt: now }));
    redis.values.set(`user:${userId}`, JSON.stringify({ id: userId, disabled: true }));
    expect(await auth.authenticate(`Bearer ${token}`)).toBeNull();

    redis.values.set(`user:${userId}`, JSON.stringify({ id: userId, disabled: false }));
    now += 60_000;
    const flaky = {
      async command<T>(command: readonly (string | number)[]): Promise<T> {
        if (String(command[0]).toUpperCase() === 'SET') throw new Error('write failed');
        return redis.command(command);
      },
    };
    const shaky = new RedisDeviceAuthenticator(flaky, () => now);
    expect(await shaky.authenticate(`Bearer ${token}`)).toEqual({ deviceId });
    expect(JSON.parse(redis.values.get(`device:${deviceId}`)!).lastSeenAt).toBe(now - 60_000);
  });
});

describe('POST /api/wake', () => {
  it('requires a cursor and an absolute count, and keeps a legacy seatId once issued', async () => {
    const redis = new WakeTestRedis();
    const api = service(redis);
    const legacy = room({}, [{ ...participant('codex-a', 'st_a', KEY), seatId: undefined }]);
    seed(redis, legacy, [], 0);
    redis.values.delete(`room-msg-count:${CODE}`);
    expect((await api.handle('Bearer token-a', { action: 'register', code: CODE, name: 'codex-a', seatKey: KEY, cursor: 0 })).body)
      .toMatchObject({ error: 'absolute_count_required' });
    seed(redis, legacy, [], 4);
    expect((await api.handle('Bearer token-a', { action: 'register', code: CODE, name: 'codex-a', seatKey: KEY })).body)
      .toMatchObject({ error: 'cursor_required' });
    const registered = await api.handle('Bearer token-a', { action: 'register', code: CODE, name: 'codex-a', seatKey: KEY, cursor: 4 });
    expect(registered.body).toMatchObject({ roomInstanceId: 'ri_1', scanFrom: 4 });
    const seatId = (registered.body as { seatId: string }).seatId;
    expect(seatId).toMatch(/^st_[a-f0-9]{8}$/);
    const again = await api.handle('Bearer token-a', { action: 'register', code: CODE, name: 'codex-a', seatKey: KEY, cursor: 4 });
    expect(again.body).toMatchObject({ seatId });
    expect((await api.handle('Bearer token-a', { action: 'register', code: CODE, name: 'codex-a', seatKey: 'nope', cursor: 4 })).status).toBe(403);
  });

  it('polls registered seats in one snapshot and does not read the Room when nothing is new', async () => {
    const redis = new WakeTestRedis();
    const api = service(redis);
    seed(redis, room(), [], 3);
    await api.handle('Bearer token-a', { action: 'register', code: CODE, name: 'codex-a', seatKey: KEY, cursor: 3 });
    redis.commands.length = 0;
    const polled = await api.handle('Bearer token-a', { action: 'poll' });
    expect(polled.body).toMatchObject({ nextPollMs: 5000, seats: [{ seatId: 'st_a', status: 'active', pending: [] }] });
    expect(redis.commands.filter(command => command[0] === 'EVAL' && command[1] === POLL_SNAPSHOT_SCRIPT)).toHaveLength(1);
    expect(redis.commands.some(command => command[0] === 'GET' && String(command[1]).startsWith('room:'))).toBe(false);
  });

  it('dedupes send-path and scan events, then surfaces a trim gap', async () => {
    const redis = new WakeTestRedis();
    const api = service(redis);
    const kept = [message('noise', 30), message('@codex-a look', 31)];
    seed(redis, room(), kept, 5);
    await api.handle('Bearer token-a', { action: 'register', code: CODE, name: 'codex-a', seatKey: KEY, cursor: 0 });
    await generateForCommittedMessage(redis, CODE, 4, message('@codex-a look', 31));
    const polled = await api.handle('Bearer token-a', { action: 'poll' });
    const seat = (polled.body as { seats: { pending: { eventId: string }[]; failed: { reason?: string; gap?: number[] }[] }[] }).seats[0]!;
    const addressed = seat.pending.filter(event => event.eventId === 'wk:ri_1:4:st_a');
    expect(addressed).toHaveLength(1);
    expect(seat.failed.some(event => event.reason === 'messages_trimmed')).toBe(true);
    expect(redis.lists.get(`room-msgs:${CODE}`)?.some(row => row.includes('未送达：codex-a') && !row.includes('@codex-a'))).toBe(true);
  });

  it('claims one run, returns readFrom, and rejects a second device until rebind', async () => {
    const redis = new WakeTestRedis();
    let now = 10_000;
    const api = service(redis, () => now);
    const msg = message('@codex-a look', 10);
    seed(redis, room(), [msg], 1);
    await api.handle('Bearer token-a', { action: 'register', code: CODE, name: 'codex-a', seatKey: KEY, cursor: 0 });
    await api.handle('Bearer token-a', { action: 'poll' });
    const claimed = await api.handle('Bearer token-a', { action: 'claim', eventIds: ['wk:ri_1:0:st_a'] });
    const claimBody = claimed.body as { wakeRunId: string; readFrom: number; claims: { claimId: string }[] };
    expect(claimBody.readFrom).toBe(0);
    expect(claimBody.wakeRunId).toMatch(/^id/);
    const claimId = claimBody.claims[0]!.claimId;
    const progress = await api.handle('Bearer token-a', {
      action: 'progress', claims: [{ claimId, status: 'succeeded' }],
    });
    expect(progress.status).toBe(400);
    const started = await api.handle('Bearer token-a', {
      action: 'progress', claims: [{ claimId, status: 'resume_started' }],
    });
    expect(started.body).toMatchObject({ updated: [{ state: 'WAITING_ACK' }] });
    expect(JSON.stringify(started.body)).not.toContain('SUCCEEDED');
    const other = await api.handle('Bearer token-b', { action: 'register', code: CODE, name: 'codex-a', seatKey: KEY, cursor: 0 });
    expect(other.status).toBe(200);
    const released = await api.store.get('wk:ri_1:0:st_a');
    expect(released?.state).toBe('PENDING');
    expect(released?.attempts).toBe(1);
  });

  it('rolls an expired lease back once and then fails', async () => {
    const redis = new WakeTestRedis();
    let now = 20_000;
    const api = service(redis, () => now);
    seed(redis, room(), [message('@codex-a look', 1)], 1);
    await api.register('dev-a', { code: CODE, name: 'codex-a', seatKey: KEY, cursor: 0 });
    await api.poll('dev-a');
    await api.claim('dev-a', { eventIds: ['wk:ri_1:0:st_a'] });
    now += 61_000;
    await api.poll('dev-a');
    expect((await api.store.get('wk:ri_1:0:st_a'))?.state).toBe('PENDING');
    await api.claim('dev-a', { eventIds: ['wk:ri_1:0:st_a'] });
    now += 61_000;
    await api.poll('dev-a');
    expect((await api.store.get('wk:ri_1:0:st_a'))?.state).toBe('FAILED');
  });

  it('cancels on unregister and removal, marks rebind, and revokes a device', async () => {
    const redis = new WakeTestRedis();
    const api = service(redis);
    seed(redis, room(), [message('@codex-a look', 1)], 1);
    await api.register('dev-a', { code: CODE, name: 'codex-a', seatKey: KEY, cursor: 0 });
    await api.poll('dev-a');
    await markRebindRequired(redis, 'st_a');
    expect((await api.poll('dev-a')).seats).toMatchObject([{ seatId: 'st_a', status: 'rebind_required' }]);
    expect((await api.store.get('wk:ri_1:0:st_a'))?.state).toBe('PENDING');
    await api.register('dev-a', { code: CODE, name: 'codex-a', seatKey: KEY, cursor: 0 });
    await api.claim('dev-a', { eventIds: ['wk:ri_1:0:st_a'] });
    await api.revoke('dev-a');
    expect((await api.poll('dev-a')).seats).toMatchObject([{ status: 'revoked' }]);
    expect((await api.store.get('wk:ri_1:0:st_a'))?.state).toBe('PENDING');
    await api.register('dev-a', { code: CODE, name: 'codex-a', seatKey: KEY, cursor: 1 });
    await removeManagedSeat(redis, 'ri_1', 'st_a', 'seat_removed', Date.now());
    expect((await api.poll('dev-a')).seats).toEqual([]);
    expect((await api.store.get('wk:ri_1:0:st_a'))?.state).toBe('CANCELLED');
  });

  it('lets two concurrent claims succeed only once', async () => {
    const redis = new WakeTestRedis();
    const api = service(redis);
    seed(redis, room(), [message('@codex-a look', 1)], 1);
    await api.register('dev-a', { code: CODE, name: 'codex-a', seatKey: KEY, cursor: 0 });
    await api.poll('dev-a');
    const settled = await Promise.allSettled([
      api.claim('dev-a', { eventIds: ['wk:ri_1:0:st_a'] }),
      api.claim('dev-a', { eventIds: ['wk:ri_1:0:st_a'] }),
    ]);
    const claims = settled.flatMap(result => result.status === 'fulfilled' ? result.value.claims : []);
    const thrown = settled.filter(result => result.status === 'rejected');
    const succeeded = claims.filter(claim => claim.claimId);
    const conflicts = claims.filter(claim => claim.error).length + thrown.length;
    expect(succeeded).toHaveLength(1);
    expect(conflicts).toBe(1);
  });

  it('generates a send-path event at the committed absolute index', async () => {
    const redis = new WakeTestRedis();
    seed(redis, room(), [], 0);
    const api = service(redis);
    await api.register('dev-a', { code: CODE, name: 'codex-a', seatKey: KEY, cursor: 0 });
    await generateForCommittedMessage(redis, CODE, 7, message('@codex-a later', 70));
    expect((await api.store.get('wk:ri_1:7:st_a'))?.state).toBe('PENDING');
    await generateForCommittedMessage(redis, CODE, 7, message('@codex-a later', 70));
    expect(await api.store.list({ roomInstanceId: 'ri_1', seatId: 'st_a' })).toHaveLength(1);
  });
});
