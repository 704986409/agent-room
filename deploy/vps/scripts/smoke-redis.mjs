import assert from 'node:assert/strict';

const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const privateKey = `agent-room:smoke:private:${stamp}`;
const webKey = `agent-room:smoke:web:${stamp}`;
const proxyKey = `agent-room:smoke:proxy:${stamp}`;
const deniedPipelineKey = `agent-room:smoke:denied:${stamp}`;

async function post(baseUrl, token, path, body) {
  const target = new URL(`${baseUrl.replace(/\/+$/, '')}${path === '/' ? '/' : path}`);
  const response = await fetch(target, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { response, parsed, text };
}

function resultOf(reply) {
  assert.equal(reply.response.ok, true, `HTTP ${reply.response.status}`);
  assert.equal(typeof reply.parsed, 'object');
  return reply.parsed.result;
}

function pipelineResults(reply) {
  assert.equal(reply.response.ok, true, `HTTP ${reply.response.status}`);
  const items = Array.isArray(reply.parsed) ? reply.parsed : reply.parsed?.result;
  assert.ok(Array.isArray(items), 'pipeline response must contain command results');
  return items.map(item => item.result);
}

async function setGet(baseUrl, token, key, label) {
  const set = await post(baseUrl, token, '/', ['SET', key, label, 'EX', 60]);
  assert.equal(resultOf(set), 'OK');
  const get = await post(baseUrl, token, '/', ['GET', key]);
  assert.equal(resultOf(get), label);
}

async function run() {
  const privateUrl = process.env.UPSTASH_REDIS_REST_URL;
  const privateToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const webUrl = process.env.SRH_WEB_URL;
  const webToken = process.env.SRH_WEB_TOKEN;
  const proxyToken = process.env.WEB_PROXY_TOKEN;
  assert.ok(privateUrl && privateToken && webUrl && webToken && proxyToken, 'proxy environment is incomplete');

  await setGet(privateUrl, privateToken, privateKey, 'private');
  const privatePipeline = await post(privateUrl, privateToken, '/pipeline', [
    ['SET', `${privateKey}:pipeline`, 'private-pipeline', 'EX', 60],
    ['GET', `${privateKey}:pipeline`],
  ]);
  assert.deepEqual(pipelineResults(privatePipeline), ['OK', 'private-pipeline']);
  process.stdout.write('SRH private SET/GET and pipeline: PASS\n');

  await setGet(webUrl, webToken, webKey, 'web');
  const webPipeline = await post(webUrl, webToken, '/pipeline', [
    ['SET', `${webKey}:pipeline`, 'web-pipeline', 'EX', 60],
    ['GET', `${webKey}:pipeline`],
  ]);
  assert.deepEqual(pipelineResults(webPipeline), ['OK', 'web-pipeline']);
  process.stdout.write('SRH web SET/GET and pipeline: PASS\n');

  const proxyBase = 'http://127.0.0.1:3000/redis';
  await setGet(proxyBase, proxyToken, proxyKey, 'browser-proxy');
  process.stdout.write('/redis command proxy: PASS\n');

  const proxyPipeline = await post(proxyBase, proxyToken, '/pipeline', [
    ['SET', `${proxyKey}:pipeline`, 'proxy-pipeline', 'EX', 60],
    ['GET', `${proxyKey}:pipeline`],
  ]);
  assert.deepEqual(pipelineResults(proxyPipeline), ['OK', 'proxy-pipeline']);
  process.stdout.write('/redis pipeline: PASS\n');

  const dangerous = await post(proxyBase, proxyToken, '/', ['FLUSHALL']);
  assert.equal(dangerous.response.status, 403);
  const dangerousPipeline = await post(proxyBase, proxyToken, '/pipeline', [
    ['SET', deniedPipelineKey, 'must-not-run'],
    ['CONFIG', 'GET', '*'],
  ]);
  assert.equal(dangerousPipeline.response.status, 403);
  const deniedKey = await post(privateUrl, privateToken, '/', ['GET', deniedPipelineKey]);
  assert.equal(resultOf(deniedKey), null, 'a rejected pipeline must not execute its allowed prefix');
  process.stdout.write('/redis dangerous command and pipeline rejection: PASS\n');

  const webEvalKeys = await post(webUrl, webToken, '/', [
    'EVAL', "return redis.call('KEYS','*')", 0,
  ]);
  const webEvalReply = `${webEvalKeys.text} ${JSON.stringify(webEvalKeys.parsed)}`;
  assert.match(webEvalReply, /(?:NOPERM|ACL failure in script)/i, 'web ACL allowed a Lua script to call KEYS');
  process.stdout.write('web ACL EVAL KEYS denial: PASS\n');

  for (const key of [privateKey, `${privateKey}:pipeline`, webKey, `${webKey}:pipeline`, proxyKey, `${proxyKey}:pipeline`]) {
    await post(privateUrl, privateToken, '/', ['DEL', key]);
  }
  process.stdout.write('Redis/SRH smoke checks: PASS\n');
}

run().catch(error => {
  process.stderr.write(`Redis/SRH smoke checks: FAIL (${error instanceof Error ? error.message : 'unknown error'})\n`);
  process.exitCode = 1;
});
