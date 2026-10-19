import { describe, expect, it } from 'vitest';
import { assertLocalTarget, percentile, runPollLoad } from '../tools/wake-load/harness.mjs';

describe('wake load harness', () => {
  it('refuses production hosts and models 5xx backoff', async () => {
    expect(() => assertLocalTarget('https://www.agent-room.com/api/wake')).toThrow(/refusing_production_target/);
    expect(() => assertLocalTarget('https://example.upstash.io')).toThrow(/refusing_production_target/);
    expect(assertLocalTarget('http://127.0.0.1:9').hostname).toBe('127.0.0.1');
    const report = await runPollLoad({
      devices: 4,
      roomsPerDevice: 2,
      rounds: 3,
      latencyMs: 3,
      handler: async ({ clock }) => ({ status: clock < 20_000 ? 503 : 200, nextPollMs: 8_000 }),
    });
    expect(report.requests).toBeGreaterThan(0);
    expect(report.errors).toBeGreaterThan(0);
    expect(report.maxWait).toBeGreaterThanOrEqual(5_000);
    expect(report.maxWait).toBeLessThanOrEqual(60_000);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
  });
});