/** In-process poll load model. Never opens a socket and never talks to production. */

const PRODUCTION = /(^|\.)agent-room\.com$|upstash\.io/i;

export function assertLocalTarget(baseUrl) {
  let url;
  try { url = new URL(baseUrl); } catch { throw new Error('invalid_base_url'); }
  if (PRODUCTION.test(url.hostname) || url.hostname === 'agent-room.com') {
    throw new Error('refusing_production_target');
  }
  if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname) && url.protocol !== 'http:') {
    throw new Error('refusing_non_local_target');
  }
  return url;
}

export function percentile(samples, p) {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

/**
 * Simulates devices polling one in-process handler.
 * On 5xx the device backs off (capped at 60s) instead of retrying in lockstep.
 * `nextPollMs` from the handler lengthens the next wait.
 */
export async function runPollLoad(options) {
  const devices = options.devices ?? 4;
  const roomsPerDevice = options.roomsPerDevice ?? 2;
  const rounds = options.rounds ?? 3;
  const handler = options.handler;
  const sleeps = [];
  const latencies = [];
  let errors = 0;
  let requests = 0;
  const nextAt = Array.from({ length: devices }, () => 0);
  let clock = 0;
  for (let round = 0; round < rounds; round += 1) {
    const due = nextAt.map((at, index) => ({ at, index })).filter(item => item.at <= clock);
    await Promise.all(due.map(async item => {
      const started = clock;
      requests += 1;
      let status = 200;
      let nextPollMs = 5_000;
      let latencyMs = resultLatency(options, item.index);
      try {
        const result = await handler({ device: item.index, rooms: roomsPerDevice, clock });
        status = result.status ?? 200;
        nextPollMs = result.nextPollMs ?? 5_000;
        if (typeof result.latencyMs === 'number') latencyMs = result.latencyMs;
      } catch {
        status = 500;
      }
      latencies.push(Math.max(0, latencyMs));
      if (status >= 500) {
        errors += 1;
        const streak = Math.min(4, round);
        const wait = Math.min(60_000, Math.round(5_000 * 2 ** streak * (0.9 + ((item.index % 5) / 25))));
        nextAt[item.index] = started + wait;
      } else {
        nextAt[item.index] = started + nextPollMs;
      }
      sleeps.push(nextAt[item.index] - started);
    }));
    const upcoming = Math.min(...nextAt);
    clock = Math.max(clock + 1, upcoming);
  }
  return {
    devices,
    roomsPerDevice,
    requests,
    errors,
    latency: { p50: percentile(latencies, 50), p99: percentile(latencies, 99) },
    waits: sleeps,
    maxWait: sleeps.reduce((max, value) => Math.max(max, value), 0),
  };
}

function resultLatency(options, device) {
  const base = options.latencyMs ?? 1;
  return base + (device % 3);
}
