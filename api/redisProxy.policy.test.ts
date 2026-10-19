import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { commandExposesSensitiveKey, isSensitiveRedisKey } from '../deploy/vps/redisProxyPolicy.js';

process.env.WEB_PROXY_TOKEN = 'proxy-token';
process.env.SRH_WEB_URL = 'https://proxy-upstream.invalid';
process.env.SRH_WEB_TOKEN = 'upstream-token';
process.env.UPSTASH_REDIS_REST_URL ??= 'https://routes.upstash.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN ??= 'routes-token';

const { createVpsApp } = await import('../deploy/vps/server.js');

describe('sensitive key prefixes', () => {
  it('matches the account, guest, invite, device, and wake prefixes', () => {
    for (const key of ['user:abc', 'user-by-name:ada', 'user-sessions:1', 'session:abc', 'guest:abc', 'invite:abc', 'device:abc', 'wake-evt:1', 'seat-bind:1', 'ratelimit:ip:1', 'audit:1']) {
      expect(isSensitiveRedisKey(key), key).toBe(true);
    }
    expect(isSensitiveRedisKey('room:ABC-DEF-GHJ')).toBe(false);
    expect(commandExposesSensitiveKey(['GET', 'session:abc'])).toBe('session:abc');
    expect(commandExposesSensitiveKey(['GET', 'room:ABC'])).toBeNull();
  });
});

describe('redis proxy HTTP', () => {
  let base = '';
  let close: (() => Promise<void>) | undefined;
  const upstreamCalls: unknown[] = [];
  const realFetch = globalThis.fetch.bind(globalThis);

  beforeAll(async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith('https://proxy-upstream.invalid')) {
        upstreamCalls.push(JSON.parse(String(init?.body ?? 'null')));
        return new Response(JSON.stringify({ result: 'PONG' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return realFetch(input, init);
    }) as typeof fetch;
    const app = createVpsApp({ host: '127.0.0.1', port: 0 });
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    close = () => app.close();
  });

  afterAll(async () => {
    await close?.();
    globalThis.fetch = realFetch;
  });

  async function proxy(body: unknown) {
    upstreamCalls.length = 0;
    const response = await fetch(`${base}/redis`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer proxy-token' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json(), upstreamCalls: [...upstreamCalls] };
  }

  it('rejects sensitive prefixes and still forwards an ordinary room read', async () => {
    for (const key of ['user:1', 'session:1', 'guest:1', 'invite:1', 'device:1', 'wake-evt:1']) {
      const denied = await proxy(['GET', key]);
      expect(denied.status, key).toBe(403);
      expect(denied.body).toEqual({ error: 'redis_key_not_allowed' });
      expect(denied.upstreamCalls).toHaveLength(0);
    }
    const allowed = await proxy(['GET', 'room:ABC-DEF-GHJ']);
    expect(allowed.status).toBe(200);
    expect(allowed.upstreamCalls).toEqual([['GET', 'room:ABC-DEF-GHJ']]);
  });
});
