import assert from 'node:assert/strict';
import { generateCode } from '@agent-room/shared';
import {
  claimTask,
  createClient,
  createRoom,
  createTask,
  getTaskBoard,
  listMessages,
  submitTask,
  verifyTask,
} from '@agent-room/upstash-client';

const redisUrl = process.env.VITE_UPSTASH_REDIS_REST_URL;
const token = process.env.VITE_UPSTASH_REDIS_REST_TOKEN ?? process.env.WEB_PROXY_TOKEN;
assert.ok(redisUrl && token, 'set VITE_UPSTASH_REDIS_REST_URL and VITE_UPSTASH_REDIS_REST_TOKEN (or WEB_PROXY_TOKEN)');

const proxyUrl = new URL(redisUrl);
assert.match(proxyUrl.pathname.replace(/\/+$/, ''), /\/redis$/, 'this check must target the app /redis proxy');
const webOrigin = process.env.WEB_ORIGIN ?? proxyUrl.origin;
const client = createClient({ url: redisUrl, token });
const code = generateCode();
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const hostName = `M08 smoke host ${suffix}`;
const owner = { name: `M08 smoke owner ${suffix}`, client: 'web' };
const verifier = { name: `M08 smoke reviewer ${suffix}`, client: 'web' };
let roomCreated = false;

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

  await createRoom(client, { code, topic: `M08 Web Approve smoke ${suffix}`, createdBy: hostName });
  roomCreated = true;
  const { task } = await createTask(client, code, {
    title: `M08 Web Approve smoke ${suffix}`,
    owner: owner.name,
    ownerClient: owner.client,
    verifier: verifier.name,
    verifierClient: verifier.client,
    dod: 'Web proxy approval reaches done and emits one AR-06 system notification.',
    createdBy: hostName,
  });

  await claimTask(client, code, task.id, owner);
  const submitted = await submitTask(client, code, task.id, owner, {
    fileListing: 'Temporary smoke fixture stored in Redis only.',
    fileExcerpt: 'M08 Web Approve smoke fixture.',
    checks: 'Temporary end-to-end smoke fixture for the Web /redis proxy.',
  });
  assert.equal(submitted.task.state, 'awaiting_review', 'task did not enter awaiting_review before approval');

  const before = await listMessages(client, code, 0);
  const notificationForTask = message => message.type === 'sys'
    && message.metadata?.eventType === 'task_update'
    && message.metadata?.taskId === task.id;
  assert.equal(before.filter(notificationForTask).length, 0, 'a verification notification existed before approval');

  const verified = await verifyTask(client, code, task.id, verifier, 'done', 'M08 Web Approve smoke passed.');
  assert.equal(verified.task.state, 'done', 'Web verifyTask did not return done');
  const board = await getTaskBoard(client, code);
  const finalTask = board?.tasks.find(item => item.id === task.id);
  assert.equal(finalTask?.state, 'done', 'persisted task state is not done');

  const messages = await listMessages(client, code, 0);
  const notifications = messages.filter(notificationForTask);
  assert.equal(notifications.length, 1, 'AR-06 must append exactly one task verification system notification');
  assert.ok(notifications[0]?.metadata?.eventId, 'verification notification is missing its eventId');

  process.stdout.write(`${JSON.stringify({
    preflightStatus: preflight.status,
    ready: readiness,
    redisPing: 'PONG',
    roomCode: code,
    taskId: task.id,
    stateBeforeApproval: submitted.task.state,
    stateAfterApproval: finalTask.state,
    systemNotificationCount: notifications.length,
    eventId: notifications[0].metadata.eventId,
  }, null, 2)}\n`);
}

run().catch(error => {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
  process.stderr.write(`Web Approve smoke check: FAIL (${message})\n`);
  process.exitCode = 1;
}).finally(async () => {
  if (!roomCreated) return;
  await client.command(['DEL', `room:${code}`, `task-board:${code}`, `room-msgs:${code}`, `room-msg-count:${code}`]).catch(() => {});
  await client.command(['SREM', 'task-board:rooms', code]).catch(() => {});
});
