import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Message, Participant, Room } from '@agent-room/shared';
import { callTool } from './_mcpTools.js';
import type { RemoteRoomClient } from './_mcpRoomClient.js';
import { managedObjectMissingSeatKey, settleManagedRead } from './_wakeListen.js';
import { RedisWakeStore } from './_wakeRedis.js';
import { WakeTestRedis } from './_wakeTestRedis.js';

const CODE = 'ABC-DEF-GHJ';
const KEY = 'seat-key';

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function person(name: string, seatId: string, key: string): Participant {
  return {
    name, seatId, seatKeyHash: hash(key), role: '', color: '#111', initials: 'CC',
    client: 'cc', joinedAt: 1, lastSeenAt: 1,
  };
}

function message(id: number, text: string, name = 'host'): Message {
  return { id, type: 'msg', name, initials: 'HH', color: '#111', role: '', text, client: 'web', time: id };
}

function seed(redis: WakeTestRedis, messages: Message[], total = messages.length) {
  const value: Room = {
    code: CODE, topic: 't', createdAt: Date.now(), createdBy: 'host', status: 'active', version: 1,
    roomInstanceId: 'ri_1', replyMode: 'open',
    participants: [person('codex-a', 'st_a', KEY), person('codex-b', 'st_b', 'other-key')],
  };
  redis.values.set(`room:${CODE}`, JSON.stringify(value));
  redis.lists.set(`room-msgs:${CODE}`, messages.map(item => JSON.stringify(item)));
  redis.values.set(`room-msg-count:${CODE}`, String(total));
}

async function pending(redis: WakeTestRedis, index: number, id: number) {
  const store = new RedisWakeStore(redis);
  const room = JSON.parse(redis.values.get(`room:${CODE}`)!) as Room;
  await store.generate([{
    roomInstanceId: 'ri_1', seatId: 'st_a', name: 'codex-a',
    facts: { sole: false, humanBroadcastsToMe: true },
  }], index, message(id, '@codex-a work'), Date.now(), room.createdAt + 86_400_000);
}

describe('managed room_listen and room_sleep', () => {
  it('acknowledges a timeoutMs 0 read only when the seatKey and the trigger message match', async () => {
    const redis = new WakeTestRedis();
    const messages = [message(10, 'earlier'), message(11, '@codex-a work')];
    seed(redis, messages);
    await pending(redis, 1, 11);
    const client = { store: redis, post: async () => { throw new Error('no board'); } } as unknown as RemoteRoomClient;
    const ignored = await callTool(client, 'core', 'room_listen', { code: CODE, name: 'codex-a', since: 0, timeoutMs: 0 });
    expect(JSON.stringify(ignored)).not.toContain('SUCCEEDED');
    expect((await new RedisWakeStore(redis).get('wk:ri_1:1:st_a'))?.state).toBe('PENDING');

    const wrong = await settleManagedRead(redis, {
      code: CODE, name: 'codex-a', managed: { seatKey: 'other-key' }, since: 0, messages, timeoutMs: 0,
    });
    expect(wrong).toBeNull();
    const skipped = await settleManagedRead(redis, {
      code: CODE, name: 'codex-a', managed: { seatKey: KEY, wakeRunId: 'wr' }, since: 2, messages: [], timeoutMs: 0,
    });
    expect(skipped?.acked).toEqual([]);
    expect((await new RedisWakeStore(redis).get('wk:ri_1:1:st_a'))?.state).toBe('PENDING');

    const read = await callTool(client, 'core', 'room_listen', {
      code: CODE, name: 'codex-a', since: 0, timeoutMs: 0, managed: { seatKey: KEY, wakeRunId: 'wr', eventIds: ['wk:ri_1:1:st_a'] },
    });
    expect(read.isError).toBeFalsy();
    const event = await new RedisWakeStore(redis).get('wk:ri_1:1:st_a');
    expect(event?.state).toBe('SUCCEEDED');
    expect(event?.receipt).toMatchObject({ receiptKind: 'managed_read', wakeRunId: 'wr' });
  });

  it('does not ack or reply for a later-page mention on the first timeoutMs 0 page', async () => {
    const redis = new WakeTestRedis();
    const mention = '@codex-a work';
    const messages: Message[] = Array.from({ length: 25 }, (_, index) => (
      index === 22
        ? message(1000 + index, mention)
        : { id: 1000 + index, type: 'msg', name: 'Other', initials: 'OT', color: '#333', role: '', text: `page-${index}`, client: 'cc', time: index }
    ));
    seed(redis, messages);
    await pending(redis, 22, 1022);
    const client = { store: redis, post: async () => { throw new Error('no board'); } } as unknown as RemoteRoomClient;
    const managed = { seatKey: KEY, wakeRunId: 'wr' };
    const body = (res: { content: { text?: string }[] }) => JSON.parse(res.content[0]!.text as string);

    const first = await callTool(client, 'core', 'room_listen', {
      code: CODE, name: 'codex-a', since: 0, timeoutMs: 0, managed,
    });
    expect(first.isError).toBeFalsy();
    const page1 = body(first);
    expect(page1.more).toBe(true);
    expect(page1.cursor).toBe(20);
    expect(page1.messages).toHaveLength(20);
    expect(page1.messages[0]).toMatchObject({ text: 'page-0', name: 'Other', cursor: 0 });
    expect(page1.messages[19]).toMatchObject({ text: 'page-19', cursor: 19 });
    expect(page1.messages.map((item: { text: string }) => item.text)).not.toContain(mention);
    expect(page1.nextAction.tool).toBe('room_listen');
    expect(page1.nextAction.arguments.since).toBe(page1.cursor);
    expect(page1.nextAction.arguments.since).toBe(20);
    expect((await new RedisWakeStore(redis).get('wk:ri_1:22:st_a'))?.state).toBe('PENDING');

    const second = await callTool(client, 'core', 'room_listen', {
      code: CODE, name: 'codex-a', since: page1.cursor, timeoutMs: 0, managed,
    });
    expect(second.isError).toBeFalsy();
    const page2 = body(second);
    expect(page2.more).toBeUndefined();
    expect(page2.cursor).toBe(25);
    expect(page2.messages).toHaveLength(5);
    expect(page2.messages[0]).toMatchObject({ text: 'page-20', name: 'Other', cursor: 20 });
    expect(page2.messages[2]).toMatchObject({ text: mention, name: 'host', cursor: 22 });
    expect(page2.messages[4].cursor).toBe(24);
    expect(page2.nextAction.tool).toBe('room_send');
    const acked = await new RedisWakeStore(redis).get('wk:ri_1:22:st_a');
    expect(acked?.state).toBe('SUCCEEDED');
    expect(acked?.receipt).toMatchObject({ receiptKind: 'managed_read', wakeRunId: 'wr' });
  });

  it('mints a listenEpoch for an authenticated long poll and still ignores a skipped trigger', async () => {
    const redis = new WakeTestRedis();
    const messages = [message(11, '@codex-a work')];
    seed(redis, messages);
    await pending(redis, 0, 11);
    const settled = await settleManagedRead(redis, {
      code: CODE, name: 'codex-a', managed: { seatKey: KEY }, since: 0, messages, timeoutMs: 30_000,
    });
    expect(settled?.listenEpoch).toBe(1);
    expect((await new RedisWakeStore(redis).get('wk:ri_1:0:st_a'))?.receipt).toMatchObject({
      receiptKind: 'managed_listen', listenEpoch: 1,
    });
  });

  it('rejects room_sleep without the seat or past the absolute count', async () => {
    const redis = new WakeTestRedis();
    seed(redis, [message(1, 'hi')], 2);
    const client = { store: redis, post: async () => { throw new Error('no'); } } as unknown as RemoteRoomClient;
    const ahead = await callTool(client, 'core', 'room_sleep', { code: CODE, name: 'codex-a', seatKey: KEY, cursor: 9 });
    expect(JSON.parse(ahead.content[0]!.text as string)).toMatchObject({ slept: false, error: 'cursor_ahead' });
    const ok = await callTool(client, 'core', 'room_sleep', { code: CODE, name: 'codex-a', seatKey: KEY, cursor: 2 });
    expect(JSON.parse(ok.content[0]!.text as string)).toMatchObject({ slept: true, seatId: 'st_a', cursor: 2 });
    const impersonated = await callTool(client, 'core', 'room_sleep', { code: CODE, name: 'codex-a', seatKey: 'other-key', cursor: 2 });
    expect(JSON.parse(impersonated.content[0]!.text as string).slept).toBe(false);
  });

  it('does not acknowledge from join, send, or presence paths', () => {
    const tools = readFileSync(new URL('./_mcpTools.ts', import.meta.url), 'utf8');
    const send = readFileSync(new URL('./_mcpSendTool.ts', import.meta.url), 'utf8');
    const room = readFileSync(new URL('./_mcpRoomClient.ts', import.meta.url), 'utf8');
    expect(tools.match(/await settleManagedRead/g)).toHaveLength(2);
    expect(send).not.toContain('settleManagedRead');
    expect(room).not.toContain('confirmRead');
  });
});

describe('managedObjectMissingSeatKey', () => {
  it('is true only when managed object lacks a non-empty seatKey', () => {
    expect(managedObjectMissingSeatKey(undefined)).toBe(false);
    expect(managedObjectMissingSeatKey(null)).toBe(false);
    expect(managedObjectMissingSeatKey('x')).toBe(false);
    expect(managedObjectMissingSeatKey({})).toBe(true);
    expect(managedObjectMissingSeatKey({ seatKey: '' })).toBe(true);
    expect(managedObjectMissingSeatKey({ seatKey: '  ' })).toBe(true);
    expect(managedObjectMissingSeatKey({ seatKey: 'sk' })).toBe(false);
  });
});
