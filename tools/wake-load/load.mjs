#!/usr/bin/env node
/**
 * Wake poll load generator.
 *
 * Do NOT point this at production, the public site, or the Redis already
 * running on a shared machine. It does not start Redis or the VPS.
 *
 * Self-check (no network):
 *   node tools/wake-load/load.mjs --self-test
 *
 * Disposable local API only, after you have started one yourself:
 *   node tools/wake-load/load.mjs --base-url http://127.0.0.1:3000 --devices 10 --rounds 2
 *
 * Record p50/p99 from the printed JSON. A real 3000-device run belongs on a
 * disposable Redis, and its numbers go in the design doc appendix — not here.
 */
import { assertLocalTarget, runPollLoad } from './harness.mjs';

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  return process.argv[index + 1];
}

if (process.argv.includes('--self-test')) {
  const report = await runPollLoad({
    devices: 8,
    roomsPerDevice: 2,
    rounds: 4,
    latencyMs: 2,
    handler: async ({ clock }) => ({ status: clock > 10_000 ? 200 : 503, nextPollMs: 5_000 }),
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.errors < 1 || report.maxWait < 5_000) {
    process.stderr.write('self-test did not observe backoff\n');
    process.exitCode = 1;
  }
} else if (process.argv.includes('--run-local')) {
  const baseUrl = assertLocalTarget(arg('--base-url', ''));
  const devices = Number(arg('--devices', '10'));
  const rounds = Number(arg('--rounds', '2'));
  const token = process.env.AGENT_ROOM_DEVICE_TOKEN ?? '';
  if (!token) {
    process.stderr.write('Set AGENT_ROOM_DEVICE_TOKEN to a disposable local credential. This script does not mint one.\n');
    process.exitCode = 1;
  } else {
    const report = await runPollLoad({
      devices, rounds, roomsPerDevice: 2,
      handler: async () => {
        const started = Date.now();
        const response = await fetch(new URL('/api/wake', baseUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ action: 'poll' }),
        });
        const body = await response.json().catch(() => ({}));
        return { status: response.status, nextPollMs: body.nextPollMs ?? 5_000, latencyMs: Date.now() - started };
      },
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
  }
} else {
  process.stderr.write('Pass --self-test, or --run-local --base-url http://127.0.0.1:<port> for a disposable local server.\n');
  process.exitCode = 1;
}
