import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRESENCE_DISCONNECTED_MS, PRESENCE_STALE_MS, type Participant } from './index.js';
import { participantPresenceStatus, startListenLease } from './presence.js';

const NOW = 1_800_000_000_000;
const participant = (over: Partial<Participant> = {}): Participant => ({
  name: 'Agent', role: '', color: '#000', initials: 'AG', client: 'cc',
  joinedAt: NOW, lastSeenAt: NOW, ...over,
});

describe('startListenLease', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('stamps a short lease immediately, not the caller full listen window', async () => {
    const stamped: { until: number | null; leaseId: string }[] = [];
    const before = Date.now();
    const stop = startListenLease(async (until, leaseId) => { stamped.push({ until, leaseId }); }, {
      leaseMs: 15_000,
      renewMs: 5_000,
    });
    await vi.waitFor(() => expect(stamped).toHaveLength(1));

    // The old bug: a 270s listen stamped listenUntil 270s into the future once.
    // A lease is bounded by leaseMs regardless of how long the caller intends
    // to poll, so a client that dies mid-listen stops reading as live fast.
    expect(stamped[0]!.until! - before).toBeLessThanOrEqual(15_000 + 1_000);
    expect(stamped[0]!.until).toBeGreaterThan(before);
    await stop();
  });

  it('keeps renewing the lease while the listen is still running', async () => {
    vi.useFakeTimers();
    const stamped: number[] = [];
    const stop = startListenLease(async (until) => { if (until !== null) stamped.push(until); }, {
      leaseMs: 15_000,
      renewMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(16_000);

    // 3 renewals inside one nominal lease length: presence never lapses for an
    // agent that is genuinely sitting in the poll.
    expect(stamped.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < stamped.length; i++) {
      expect(stamped[i]!).toBeGreaterThan(stamped[i - 1]!);
    }
    await stop();
  });

  it('releases the lease on stop so an early return stops reading as Listening', async () => {
    const stamped: (number | null)[] = [];
    const stop = startListenLease(async (until) => { stamped.push(until); });
    await vi.waitFor(() => expect(stamped.length).toBeGreaterThanOrEqual(1));

    await stop();
    const released = stamped[stamped.length - 1];
    // Explicit release clears the current lease immediately.
    expect(released).toBeNull();
  });

  it('stops renewing after stop, even if the caller keeps running', async () => {
    vi.useFakeTimers();
    const stamped: number[] = [];
    const stop = startListenLease(async (until) => { if (until !== null) stamped.push(until); }, {
      leaseMs: 15_000,
      renewMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(6_000);
    await stop();
    const afterStop = stamped.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stamped).toHaveLength(afterStop);
  });

  it('never throws when the presence write fails', async () => {
    const stop = startListenLease(async () => { throw new Error('upstash down'); });
    await expect(stop()).resolves.toBeUndefined();
  });

  it('waits for a slow initial stamp before releasing so the lease cannot be restored afterward', async () => {
    let finishFirst!: () => void;
    const firstWrite = new Promise<void>(resolve => { finishFirst = resolve; });
    const writes: (number | null)[] = [];
    const stop = startListenLease(async until => {
      writes.push(until);
      if (until !== null) await firstWrite;
    });

    await vi.waitFor(() => expect(writes).toHaveLength(1));
    const stopping = stop();
    await Promise.resolve();
    expect(writes).toHaveLength(1);
    finishFirst();
    await stopping;

    expect(writes[0]).toBeTypeOf('number');
    expect(writes[1]).toBeNull();
    await stop();
    expect(writes).toHaveLength(2);
  });

  it('does not overlap slow renewals while presence storage is still writing', async () => {
    vi.useFakeTimers();
    let finishWrite!: () => void;
    const pending = new Promise<void>(resolve => { finishWrite = resolve; });
    const writes: (number | null)[] = [];
    const stop = startListenLease(async until => {
      writes.push(until);
      if (until !== null) await pending;
    }, { leaseMs: 15_000, renewMs: 5_000 });

    await vi.advanceTimersByTimeAsync(20_000);
    expect(writes).toHaveLength(1);
    const stopping = stop();
    finishWrite();
    await stopping;
    expect(writes).toHaveLength(2);
    expect(writes[1]).toBeNull();
  });
});

describe('participantPresenceStatus', () => {
  it('distinguishes a recently active Agent from a listening Agent', () => {
    const recent = participant({ lastSeenAt: NOW - 1000, listenUntil: NOW });
    expect(participantPresenceStatus(recent, NOW)).toBe('recent_activity');
    expect(participantPresenceStatus({ ...recent, listenUntil: NOW + 1 }, NOW)).toBe('listening');
  });

  it('stops showing Listening when the 15-second lease expires', () => {
    const leased = participant({ lastSeenAt: NOW, listenUntil: NOW + 15_000 });
    expect(participantPresenceStatus(leased, NOW + 14_999)).toBe('listening');
    expect(participantPresenceStatus(leased, NOW + 15_000)).toBe('recent_activity');
    expect(participantPresenceStatus(leased, NOW + 25_000)).toBe('recent_activity');
  });

  it('keeps Listening while any overlapping listener lease remains valid', () => {
    const overlapping = participant({
      lastSeenAt: NOW,
      listenUntil: NOW + 15_000,
      listenLeases: { older: NOW + 15_000, newer: NOW + 16_000 },
    });
    expect(participantPresenceStatus(overlapping, NOW + 15_000)).toBe('listening');
    expect(participantPresenceStatus(overlapping, NOW + 16_000)).toBe('recent_activity');
  });

  it('keeps Web Online semantics on its heartbeat and ignores Agent listen leases', () => {
    const web = participant({ client: 'web', lastSeenAt: NOW - 1000, listenUntil: NOW + 10_000 });
    expect(participantPresenceStatus(web, NOW)).toBe('online');
  });

  it('moves an inactive Agent from not listening to idle and then disconnected', () => {
    const agent = participant({ lastSeenAt: NOW - PRESENCE_STALE_MS - 1, listenUntil: NOW });
    expect(participantPresenceStatus(agent, NOW)).toBe('idle');
    expect(participantPresenceStatus({ ...agent, lastSeenAt: NOW - PRESENCE_DISCONNECTED_MS - 1 }, NOW))
      .toBe('disconnected');
  });

  it('does not trust non-finite or missing leases', () => {
    expect(participantPresenceStatus(participant({ listenUntil: Number.NaN, lastSeenAt: NOW }), NOW))
      .toBe('recent_activity');
  });
});
