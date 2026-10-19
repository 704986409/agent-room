import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Message } from '@agent-room/shared';
import { MAX_WAIT_MS, messageEvent, type ManagedSeat } from './_wakeCore.js';
import { EVENT_CAS_SCRIPT, HANDOFF_SCRIPT, RedisWakeStore, wakeKeys } from './_wakeRedis.js';
import { WakeTestRedis } from './_wakeTestRedis.js';

const seat: ManagedSeat = { roomInstanceId: 'ri', seatId: 'st', name: 'bot', facts: { sole: false, humanBroadcastsToMe: false } };
const expires = 700_000_000;
const message = (id = 7, text = '@bot work'): Message => ({ id, type: 'msg', name: 'sender', client: 'cc', text, initials: 'S', color: '#000', role: '', time: 0 });
const event = (index = 184) => messageEvent(seat, index, message(), 1_000, expires);
const claim = { kind: 'claim', claimId: 'c', deviceId: 'd', wakeRunId: 'r' } as const;
function fixture() {
  const redis = new WakeTestRedis();
  const store = new RedisWakeStore(redis);
  redis.values.set('room:ABC', JSON.stringify({ code: 'ABC', roomInstanceId: 'ri', status: 'active', createdAt: 0,
    participants: [{ client: 'cc', name: 'bot', seatId: 'st', seatKeyHash: createHash('sha256').update('key').digest('hex') },
      { client: 'cc', name: 'other', seatId: 'st2', seatKeyHash: createHash('sha256').update('other-key').digest('hex') }] }));
  redis.values.set('room-msg-count:ABC', '200');
  return { redis, store };
}
const batch = { since: 183, cursor: 187, timeoutMs: 0, delivered: [{ index: 184, message: message() }, { index: 186, message: message() }] };

describe('Redis wake event CAS', () => {
  it('creates NX with seat index and absolute retention, preserving evolved state on duplicates', async () => {
    const { redis, store } = fixture();
    expect(await store.create(event(), 1_000)).toBe(true);
    await store.apply(event().eventId, claim, 1_001);
    expect(await store.create(event(), 2_000)).toBe(false);
    expect((await store.get(event().eventId))?.state).toBe('CLAIMED');
    expect(await store.list(seat)).toHaveLength(1);
    expect(redis.expires.get(wakeKeys.event(event().eventId))).toBe(expires + MAX_WAIT_MS);
    expect(redis.sets.get(wakeKeys.seat(seat))?.size).toBe(1);
    expect(redis.commands.every(c => !String(c[3] ?? '').startsWith('room-msgs:'))).toBe(true);
  });
  it('admits only one concurrent claim and rejects renew from stale claims', async () => {
    const { store } = fixture();
    await store.create(event(), 1_000);
    const results = await Promise.all([store.apply(event().eventId, claim, 1_001),
      store.apply(event().eventId, { ...claim, claimId: 'other' }, 1_001)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = (await store.get(event().eventId))!;
    expect(await store.apply(event().eventId, { kind: 'renew', claimId: 'wrong', deviceId: 'd' }, 1_002)).toBeNull();
    await store.maintain(seat, true, 0, winner.leaseUntil!);
    expect(await store.get(event().eventId)).toMatchObject({ state: 'PENDING', attempts: 1 });
    await store.apply(event().eventId, { ...claim, claimId: 'new' }, 70_000);
    expect(await store.apply(event().eventId, { kind: 'renew', claimId: winner.claimId!, deviceId: 'd' }, 70_001)).toBeNull();
  });
  it('bounds CAS contention rather than spinning forever', async () => {
    const { redis, store } = fixture();
    await store.create(event(), 1_000);
    redis.beforeEval = (script, keys) => {
      if (script === EVENT_CAS_SCRIPT) {
        const current = JSON.parse(redis.values.get(keys[0]!)!);
        redis.values.set(keys[0]!, JSON.stringify({ ...current, updatedAt: current.updatedAt + 1 }));
      }
    };
    await expect(store.apply(event().eventId, claim, 2_000)).rejects.toThrow('wake_cas_contention');
  });
});

describe('durable generation and scan recovery', () => {
  it('replays a crashed scan; send generation and overlapping patrol/poll deduplicate', async () => {
    const { redis, store } = fixture();
    await store.initializeScan(seat, 184, 187, expires);
    const load = async (from: number) => ({ total: 187, oldestRetained: 180,
      messages: [184, 185, 186].filter(i => i >= from).map(index => ({ index, message: message(index) })) });
    redis.failCreateAt = 2;
    await expect(store.scan(seat, load, 1_000, expires)).rejects.toThrow('injected_write_failure');
    expect(redis.values.get(wakeKeys.scan(seat))).toBe('184');
    expect(await store.list(seat)).toHaveLength(1);
    redis.failCreateAt = undefined;
    await store.generate([seat], 184, message(184), 1_000, expires);
    await Promise.all([store.scan(seat, load, 1_001, expires), store.scan(seat, load, 1_001, expires)]);
    expect(redis.values.get(wakeKeys.scan(seat))).toBe('187');
    expect(await store.list(seat)).toHaveLength(3);
    expect(await store.advanceScan(seat, 184, 186)).toBe(false);
    expect(await store.advanceScan(seat, 187, 186)).toBe(false);
    expect(await store.advanceScan(seat, 187, 187)).toBe(false);
    expect(redis.values.get(wakeKeys.scan(seat))).toBe('187');
  });
  it('fails incomplete scan snapshots without advancing and never overwrites a registered cursor', async () => {
    const { redis, store } = fixture();
    await expect(store.initializeScan(seat, undefined, 200, expires)).rejects.toThrow('cursor_required');
    await store.initializeScan(seat, 184, 200, expires);
    expect(await store.initializeScan(seat, 180, 200, expires)).toBe(184);
    for (const indexes of [[184], [184, 186, 185]]) {
      await expect(store.scan(seat, async () => ({ total: 187, oldestRetained: 0,
        messages: indexes.map(index => ({ index, message: message() })) }), 1_000, expires)).rejects.toThrow('incomplete_scan_snapshot');
    }
    expect(redis.values.get(wakeKeys.scan(seat))).toBe('184');
  });
  it('records gaps, continues retained scanning, and fails lost trigger/expired room events visibly', async () => {
    const { redis, store } = fixture();
    await store.initializeScan(seat, 100, 187, expires);
    await store.create(event(120), 1_000);
    const load = async () => ({ total: 187, oldestRetained: 185,
      messages: [185, 186].map(index => ({ index, message: message(index) })) });
    expect(await store.patrol([{ seat, roomExpiresAt: expires, load }], 1_001)).toEqual([]);
    expect(redis.values.get(wakeKeys.scan(seat))).toBe('187');
    expect(await store.get('wk:ri:gap:100-185:st')).toMatchObject({ state: 'FAILED', reason: 'messages_trimmed' });
    expect(await store.get(event(120).eventId)).toMatchObject({ state: 'FAILED', reason: 'messages_trimmed' });
    await store.patrol([{ seat, roomExpiresAt: expires, load: async () => null }], 1_002);
    expect(await store.get(event(186).eventId)).toMatchObject({ state: 'FAILED', reason: 'room_expired' });
  });
  it('isolates patrol seat failures and leaves messages alone', async () => {
    const { redis, store } = fixture();
    await store.create(event(), 1_000);
    redis.values.set('room-msgs:ABC', 'untouched');
    const result = await store.patrol([
      { seat: { ...seat, seatId: 'broken' }, roomExpiresAt: expires, load: async () => { throw new Error('unavailable'); } },
      { seat, roomExpiresAt: expires, load: async () => null },
    ], 2_000);
    expect(result).toHaveLength(1);
    expect(await store.get(event().eventId)).toMatchObject({ state: 'FAILED', reason: 'room_expired' });
    expect(redis.values.get('room-msgs:ABC')).toBe('untouched');
  });
});

describe('seatKey verified receipts', () => {
  it('confirms all covered events including pending events outside a supplied run', async () => {
    const { redis, store } = fixture();
    await store.create(event(), 1_000); await store.create(event(186), 1_000);
    const other = messageEvent({ ...seat, seatId: 'st2' }, 184, message(), 1_000, expires);
    await store.create(other, 1_000);
    expect(await store.confirmRead('ABC', 'bot', { seatKey: 'key', wakeRunId: 'r' }, batch, 2_000))
      .toEqual([event().eventId, event(186).eventId]);
    expect(await store.get(other.eventId)).toMatchObject({ state: 'PENDING' });
    expect(redis.expires.get(wakeKeys.event(event().eventId))).toBe(2_000 + MAX_WAIT_MS);
    expect(await store.confirmRead('ABC', 'bot', { seatKey: 'key' }, batch, 2_001)).toEqual([]);
  });
  it('rejects ordinary reads, wrong seat keys, wrong names, stale room instances and skipped triggers', async () => {
    const { redis, store } = fixture();
    await store.create(event(), 1_000);
    for (const managed of [undefined, { seatKey: 'wrong' }, { seatKey: 'other-key' }])
      expect(await store.confirmRead('ABC', 'bot', managed, batch, 2_000)).toEqual([]);
    expect(await store.confirmRead('ABC', 'other', { seatKey: 'key' }, batch, 2_000)).toEqual([]);
    expect(await store.confirmRead('ABC', 'bot', { seatKey: 'key' }, { ...batch, since: 185 }, 2_000)).toEqual([]);
    expect(await store.confirmRead('ABC', 'bot', { seatKey: 'key' }, { ...batch, delivered: [] }, 2_000)).toEqual([]);
    redis.values.set('room:ABC', redis.values.get('room:ABC')!.replace('"ri"', '"new-ri"'));
    expect(await store.confirmRead('ABC', 'bot', { seatKey: 'key' }, batch, 2_000)).toEqual([]);
    expect(await store.get(event().eventId)).toMatchObject({ state: 'PENDING' });
  });
  it('requires matching Message.id despite duplicate timestamps at other absolute indexes', async () => {
    const { store } = fixture(); await store.create(event(), 1_000);
    expect(await store.confirmRead('ABC', 'bot', { seatKey: 'key' }, { ...batch,
      delivered: [{ index: 184, message: message(999) }, { index: 185, message: message() }] }, 2_000)).toEqual([]);
  });
  it('records monotonic epochs only for authenticated listeners and supports long-poll receipts', async () => {
    const { store } = fixture(); await store.create(event(), 1_000);
    expect(await store.beginListen('ABC', 'bot', 'wrong')).toBeNull();
    expect(await store.beginListen('ABC', 'bot', 'key')).toBe(1);
    const epoch = await store.beginListen('ABC', 'bot', 'key'); expect(epoch).toBe(2);
    expect(await store.confirmRead('ABC', 'bot', { seatKey: 'key' }, { ...batch, timeoutMs: 30_000, listenEpoch: epoch! }, 2_000)).toHaveLength(1);
    expect((await store.get(event().eventId))?.receipt).toMatchObject({ receiptKind: 'managed_listen', listenEpoch: 2 });
  });
  it('accepts a late read after takeover without modifying any other event lease', async () => {
    const { store } = fixture();
    await store.create(event(), 1_000); await store.create(event(186), 1_000);
    await store.apply(event().eventId, claim, 1_001);
    await store.apply(event().eventId, { kind: 'release' }, 1_002);
    await store.apply(event().eventId, { ...claim, claimId: 'new', wakeRunId: 'new-run' }, 1_003);
    await store.apply(event(186).eventId, claim, 1_004);
    const otherBefore = await store.get(event(186).eventId);
    await store.confirmRead('ABC', 'bot', { seatKey: 'key', wakeRunId: 'old-run' }, { ...batch, cursor: 185 }, 2_000);
    expect((await store.get(event().eventId))?.receipt?.wakeRunId).toBe('old-run');
    expect(await store.get(event(186).eventId)).toEqual(otherBefore);
  });
  it('atomically rejects authorization invalidated between verification and receipt CAS', async () => {
    const { redis, store } = fixture(); await store.create(event(), 1_000);
    redis.beforeEval = script => { if (script === EVENT_CAS_SCRIPT) redis.values.delete('room:ABC'); };
    expect(await store.confirmRead('ABC', 'bot', { seatKey: 'key' }, batch, 2_000)).toEqual([]);
    expect((await store.get(event().eventId))?.state).toBe('PENDING');
  });
});

describe('room_sleep handoff', () => {
  it('stores an authenticated absolute cursor used by registration, with room lifetime TTL', async () => {
    const { redis, store } = fixture();
    expect(await store.sleep('ABC', 'bot', 'key', 183, 2_000)).toEqual({ roomInstanceId: 'ri', seatId: 'st' });
    expect(await store.handoff(seat)).toEqual({ cursor: 183, at: 2_000 });
    expect(await store.initializeScan(seat, 190, 200, expires)).toBe(183);
    expect(redis.expires.get(wakeKeys.handoff(seat))).toBe(7 * 86_400_000);
  });
  it('rejects invalid, future, impersonated and unreliable cursors without saving', async () => {
    const { redis, store } = fixture();
    for (const cursor of [-1, 1.1, NaN]) await expect(store.sleep('ABC', 'bot', 'key', cursor, 2_000)).rejects.toThrow('invalid_cursor');
    await expect(store.sleep('ABC', 'bot', 'other-key', 183, 2_000)).rejects.toThrow('seat_unauthorized');
    await expect(store.sleep('ABC', 'bot', 'key', 201, 2_000)).rejects.toThrow('cursor_ahead');
    redis.values.delete('room-msg-count:ABC');
    await expect(store.sleep('ABC', 'bot', 'key', 183, 2_000)).rejects.toThrow('absolute_count_required');
    expect(await store.handoff(seat)).toBeNull();
  });
  it('checks room and total count at the atomic write boundary', async () => {
    const { redis, store } = fixture();
    redis.beforeEval = script => { if (script === HANDOFF_SCRIPT) redis.values.set('room-msg-count:ABC', '100'); };
    await expect(store.sleep('ABC', 'bot', 'key', 183, 2_000)).rejects.toThrow('cursor_ahead');
    redis.beforeEval = script => { if (script === HANDOFF_SCRIPT) redis.values.set('room:ABC', '{}'); };
    await expect(store.sleep('ABC', 'bot', 'key', 100, 2_000)).rejects.toThrow('seat_changed');
    expect(await store.handoff(seat)).toBeNull();
  });
});


describe('atomic absolute message snapshots', () => {
  it('maps trimmed retained messages to absolute indexes and gives the absolute end cursor', async () => {
    const { redis, store } = fixture();
    redis.values.set('room-msg-count:ABC', '1200');
    redis.lists.set('room-msgs:ABC', Array.from({ length: 1000 }, (_, i) => JSON.stringify(message(i + 200))));
    const snapshot = await store.loadMessages('ABC', 100);
    expect(snapshot).toMatchObject({ total: 1200, oldestRetained: 200 });
    expect(snapshot?.messages).toHaveLength(1000);
    expect(snapshot?.messages[0]).toMatchObject({ index: 200, message: { id: 200 } });
    expect(snapshot?.messages.at(-1)).toMatchObject({ index: 1199, message: { id: 1199 } });
    expect((await store.loadMessages('ABC', 1199))?.messages).toHaveLength(1);
    expect((await store.loadMessages('ABC', 1200))?.messages).toEqual([]);
    expect((await store.loadMessages('ABC', 1300))?.messages).toEqual([]);
  });
  it('distinguishes expired rooms, legacy rooms, and inconsistent absolute counts', async () => {
    const { redis, store } = fixture();
    expect(await store.loadMessages('missing', 0)).toBeNull();
    redis.values.delete('room-msg-count:ABC');
    await expect(store.loadMessages('ABC', 0)).rejects.toThrow('absolute_count_required');
    redis.values.set('room-msg-count:ABC', '0');
    redis.lists.set('room-msgs:ABC', [JSON.stringify(message())]);
    await expect(store.loadMessages('ABC', 0)).rejects.toThrow('invalid absolute message count');
  });
});
