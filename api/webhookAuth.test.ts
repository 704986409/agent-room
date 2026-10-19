import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { MemoryRedis, installFetchRedis } from './_memoryRedis.js';
import { createRemoteRoomClient } from './_mcpRoomClient.js';

const REDIS = 'https://webhook-auth.upstash.invalid';
process.env.UPSTASH_REDIS_REST_URL = REDIS;
process.env.UPSTASH_REDIS_REST_TOKEN = 'webhook-token';

const store = new MemoryRedis();
const restore = installFetchRedis(REDIS, store);
const CODE = 'ABC-DEF-GHJ';
const SEAT_KEY = 'seat-key-for-webhook-test-0123456789abcd';
const seatKeyHash = createHash('sha256').update(SEAT_KEY, 'utf8').digest('hex');

await store.command(['SET', `room:${CODE}`, JSON.stringify({
  code: CODE,
  topic: 'hooks',
  createdAt: Date.now(),
  createdBy: 'Host',
  status: 'active',
  version: 1,
  participants: [{
    name: 'Host',
    role: '',
    color: '#000',
    initials: 'HO',
    client: 'cc',
    joinedAt: 1,
    lastSeenAt: 1,
    seatKeyHash,
  }],
})]);

afterAll(() => restore());

describe('webhook seatKey (R11)', () => {
  const client = createRemoteRoomClient(undefined);

  it('rejects register and delete without a matching seatKey, and list hides the secret', async () => {
    await expect(client.post({ action: 'webhookSet', code: CODE, requesterName: 'Host', url: 'https://hooks.example/room' }))
      .rejects.toMatchObject({ status: 400, code: 'bad_request' });
    await expect(client.post({
      action: 'webhookSet', code: CODE, requesterName: 'Host', seatKey: 'wrong-seat-key-not-the-real-one', url: 'https://hooks.example/room',
    })).rejects.toMatchObject({ status: 403, code: 'seat_key_invalid' });

    const registered = await client.post<{ webhook: { id: string; hasSecret: boolean; secret?: string } }>({
      action: 'webhookSet',
      code: CODE,
      requesterName: 'Host',
      seatKey: SEAT_KEY,
      url: 'https://hooks.example/room',
      secret: 'super-secret-value',
    });
    expect(registered.webhook.hasSecret).toBe(true);
    expect(registered.webhook).not.toHaveProperty('secret');

    const listed = await client.post<{ webhooks: Array<{ hasSecret: boolean; secret?: string }> }>({
      action: 'webhookList',
      code: CODE,
    });
    expect(listed.webhooks).toHaveLength(1);
    expect(listed.webhooks[0]!.hasSecret).toBe(true);
    expect(JSON.stringify(listed)).not.toContain('super-secret-value');

    await expect(client.post({ action: 'webhookDelete', code: CODE, requesterName: 'Host', id: registered.webhook.id }))
      .rejects.toMatchObject({ status: 400 });
    const removed = await client.post<{ removed: boolean }>({
      action: 'webhookDelete',
      code: CODE,
      requesterName: 'Host',
      seatKey: SEAT_KEY,
      id: registered.webhook.id,
    });
    expect(removed.removed).toBe(true);
  });
});
