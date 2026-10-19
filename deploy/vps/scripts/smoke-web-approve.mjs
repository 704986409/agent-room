import assert from 'node:assert/strict';
import { createClient } from '@agent-room/upstash-client';

const redisUrl = process.env.VITE_UPSTASH_REDIS_REST_URL;
const token = process.env.VITE_UPSTASH_REDIS_REST_TOKEN ?? process.env.WEB_PROXY_TOKEN;
assert.ok(redisUrl && token, 'set VITE_UPSTASH_REDIS_REST_URL and VITE_UPSTASH_REDIS_REST_TOKEN (or WEB_PROXY_TOKEN)');

const proxyUrl = new URL(redisUrl);
assert.match(proxyUrl.pathname.replace(/\/+$/, ''), /\/redis$/, 'this check must target the app /redis proxy');
const webOrigin = process.env.WEB_ORIGIN ?? proxyUrl.origin;
const client = createClient({ url: redisUrl, token });

async function run() {
  const preflight = await fetch(proxyUrl, {
    method: 'OPTIONS',
    headers: {
      Origin: webOrigin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type',
    },
    cache: 'no-store',
  });
  assert.equal(preflight.status, 204, `POST /redis preflight returned HTTP ${preflight.status}`);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  const allowedHeaders = new Set(
    (preflight.headers.get('access-control-allow-headers') ?? '').toLowerCase().split(',').map(x => x.trim()),
  );
  assert.ok(allowedHeaders.has('authorization') && allowedHeaders.has('content-type'), 'proxy CORS allowlist is missing browser headers');

  const readyResponse = await fetch(new URL('/readyz', proxyUrl), { cache: 'no-store' });
  const readiness = await readyResponse.json().catch(() => ({}));
  assert.equal(readyResponse.status, 200, `/readyz returned HTTP ${readyResponse.status}: ${JSON.stringify(readiness)}`);
  assert.equal(readiness.ready, true, `/readyz reports an unavailable Redis upstream: ${JSON.stringify(readiness)}`);
  assert.equal(await client.command(['PING']), 'PONG', '/redis PING failed');
  await assert.rejects(
    () => client.command(['SET', 'agent-room:smoke:web-approve', 'nope', 'EX', 60]),
    /403|redis_command_not_allowed|not_allowed/,
    'the web proxy must reject writes',
  );
  await assert.rejects(
    () => client.command(['EVAL', 'return 1', 0]),
    /403|redis_command_not_allowed|not_allowed/,
    'the web proxy must reject EVAL',
  );

  process.stdout.write(`${JSON.stringify({
    preflightStatus: preflight.status,
    ready: readiness,
    redisPing: 'PONG',
    writesRejected: true,
  }, null, 2)}\n`);
}

run().catch(error => {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
  process.stderr.write(`Web Approve smoke check: FAIL (${message})\n`);
  process.exitCode = 1;
});
