import {
  LISTEN_LEASE_MS,
  LISTEN_LEASE_RENEW_MS,
  PRESENCE_DISCONNECTED_MS,
  PRESENCE_STALE_MS,
} from './constants.js';
import type { Participant } from './types.js';

export type ParticipantPresenceStatus = 'listening' | 'online' | 'recent_activity' | 'idle' | 'disconnected';

/** The Agent state is listening only while the current, finite lease is live. */
export function hasActiveListenLease(participant: Participant, now: number = Date.now()): boolean {
  if (participant.client !== 'cc') return false;
  const legacyUntil = participant.listenUntil;
  if (typeof legacyUntil === 'number' && Number.isFinite(legacyUntil) && legacyUntil > now) return true;
  const leases = participant.listenLeases;
  return !!leases && typeof leases === 'object'
    && Object.values(leases).some(until => typeof until === 'number' && Number.isFinite(until) && until > now);
}

/**
 * Separate a Web heartbeat from Agent listening. Agent activity timestamps
 * are useful for recency, but do not prove that an MCP call is still running.
 */
export function participantPresenceStatus(
  participant: Participant,
  now: number = Date.now(),
): ParticipantPresenceStatus {
  if (hasActiveListenLease(participant, now)) return 'listening';

  const lastSeenAt = Number.isFinite(participant.lastSeenAt) ? participant.lastSeenAt : 0;
  const age = now - lastSeenAt;
  if (participant.client === 'web') {
    if (age <= PRESENCE_STALE_MS) return 'online';
  } else if (age <= PRESENCE_STALE_MS) {
    return 'recent_activity';
  }

  if (age > PRESENCE_DISCONNECTED_MS) return 'disconnected';
  return 'idle';
}

/**
 * Keeps a participant's `listenUntil` lease alive for as long as the caller is
 * actually sitting inside room_listen.
 *
 * The bug this exists to kill: `listenUntil` used to be stamped ONCE, at the
 * start of a listen, with the caller's full intended window (up to 270s on the
 * local MCP). Nothing ever wrote it again — not on early return, not on error,
 * not on process death — so a client that returned after 2s, or died outright,
 * kept reading "Listening" in the room for the rest of that window. Presence
 * was recording intent, not liveness.
 *
 * A lease fixes that without adding any new transport: stamp a SHORT window and
 * keep renewing it. Renewal only happens while the poll loop is genuinely
 * running, so every way a listen can end — return, throw, kill -9 — stops the
 * renewals and the lease lapses on its own within LISTEN_LEASE_MS.
 *
 * `stop()` additionally releases the lease immediately on the paths we can
 * observe (normal return / error), which is the common case and makes the room
 * accurate within one round-trip rather than one lease.
 *
 * @param stamp writes `listenUntil` for this participant; failures are ignored
 *   because presence must never break the listen it is describing.
 * @returns a stop function; call it in a `finally`.
 */
export function startListenLease(
  stamp: (until: number | null, leaseId: string) => Promise<void>,
  opts?: { leaseMs?: number; renewMs?: number },
): () => Promise<void> {
  const leaseMs = opts?.leaseMs ?? LISTEN_LEASE_MS;
  const renewMs = opts?.renewMs ?? LISTEN_LEASE_RENEW_MS;
  const leaseId = globalThis.crypto.randomUUID();
  let stopped = false;
  let inFlight: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;

  const renew = (): void => {
    // Do not pile up writes when Redis is slow. The active lease naturally
    // expires if one renewal takes longer than its window.
    if (stopped || inFlight) return;
    const write = Promise.resolve()
      .then(() => stamp(Date.now() + leaseMs, leaseId))
      .catch(() => { /* presence is non-essential — never break the listen */ });
    inFlight = write;
    void write.finally(() => {
      if (inFlight === write) inFlight = undefined;
    });
  };

  // Start polling immediately; presence writes stay asynchronous.
  renew();
  const timer = setInterval(() => { void renew(); }, renewMs);
  // Don't hold the process open just to advertise presence.
  (timer as unknown as { unref?: () => void }).unref?.();

  return async () => {
    if (stopping) return stopping;
    stopped = true;
    clearInterval(timer);
    // An in-flight stamp must finish before release, otherwise a delayed write
    // can restore Listening after this call has ended. The lease ID also fences
    // this release from a newer overlapping room_listen call for the same seat.
    stopping = (async () => {
      try { await inFlight; } catch { /* renew already absorbs errors */ }
      try { await stamp(null, leaseId); } catch { /* presence is non-essential */ }
    })();
    return stopping;
  };
}
